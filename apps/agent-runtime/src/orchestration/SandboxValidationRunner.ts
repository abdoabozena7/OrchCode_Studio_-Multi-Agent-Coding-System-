import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { readJson } from "../memory/ProjectMemory.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { PatchApplySandboxResult } from "./PatchApplySandboxModels.js";
import type { ValidationCandidate } from "./ValidationCandidateModels.js";
import type { PatchProposalReview } from "./PatchProposalReviewModels.js";
import { aggregateValidationStatus, type OverallValidationStatus, type ValidationCommandStatus } from "./ValidationSemantics.js";
import { buildSandboxCommandPlan, resolveSandboxCommandCwd, type SandboxValidationCommandPlanEntry } from "./SandboxValidationPolicy.js";
import {
  createSandboxValidationBatch,
  createSandboxValidationCommandResult,
  createSandboxValidationFinding,
  createSandboxValidationRequest,
  createSandboxValidationResult,
  createSandboxValidationSummary,
  type SandboxValidationBatch,
  type SandboxValidationCommandResult,
  type SandboxValidationFinding,
  type SandboxValidationResult,
  type SandboxValidationStatus
} from "./SandboxValidationModels.js";

export type SandboxValidationRunnerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type SandboxValidationBatchOptions = {
  sandboxResultIds?: string[];
};

type Eligibility = {
  eligible: boolean;
  status: SandboxValidationStatus;
  findings: SandboxValidationFinding[];
  candidate?: ValidationCandidate;
  review?: PatchProposalReview;
};

export class SandboxValidationRunner {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(options: SandboxValidationRunnerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "SandboxValidationRunner" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async runValidationForSandboxResult(sandboxResult: PatchApplySandboxResult): Promise<SandboxValidationResult> {
    const sandboxValidationId = `sandbox_validation_${randomUUID()}`;
    await this.traceWriter.write({
      run_id: sandboxResult.run_id,
      event_type: "sandbox_validation_started",
      lifecycle_stage: "validation",
      summary: `Sandbox validation started for ${sandboxResult.sandbox_result_id}.`,
      artifact_refs: [sandboxResult.artifact_ref, sandboxResult.sandbox_path_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { sandbox_validation_id: sandboxValidationId, sandbox_result_id: sandboxResult.sandbox_result_id, no_main_repo_validation: true }
    });
    const eligibility = await this.validateSandboxResultForValidation(sandboxResult, sandboxValidationId);
    const plan = eligibility.candidate ? this.buildCommandExecutionPlan(eligibility.candidate, sandboxResult) : [];
    const request = createSandboxValidationRequest({
      run_id: sandboxResult.run_id,
      sandbox_result_id: sandboxResult.sandbox_result_id,
      validation_candidate_id: sandboxResult.validation_candidate_id,
      proposal_id: sandboxResult.proposal_id,
      review_id: sandboxResult.review_id,
      sandbox_ref: sandboxResult.sandbox_path_ref,
      commands: plan.map((entry) => ({ command: entry.command, required: entry.required, cwd: entry.cwd })),
      metadata_json: { no_main_repo_validation: true }
    });

    if (!eligibility.eligible || !eligibility.candidate || this.config.sandbox_validation_mode !== "execute_safe_commands") {
      const status = this.config.sandbox_validation_mode === "off" ? "not_required" : eligibility.status;
      if (eligibility.findings.length) {
        await this.traceWriter.write({
          run_id: sandboxResult.run_id,
          event_type: "sandbox_validation_eligibility_failed",
          lifecycle_stage: "blocked",
          severity: "warning",
          summary: "Sandbox validation eligibility failed.",
          metadata_json: { sandbox_validation_id: sandboxValidationId, finding_count: eligibility.findings.length }
        });
      }
      const aggregate = aggregateValidationStatus([], plan.map((entry) => ({
        command: entry.command,
        required: entry.required,
        reason: entry.blocked_reason
      })));
      const result = this.resultFromAggregate({
        sandboxValidationId,
        sandboxResult,
        status,
        commandResults: [],
        aggregateStatus: status === "not_required" ? "not_required" : aggregate.status,
        findings: eligibility.findings,
        logsRef: undefined,
        plan
      });
      await this.persistSandboxValidationResult(result, request, plan);
      return result;
    }

    const commandResults: SandboxValidationCommandResult[] = [];
    for (const command of plan) {
      if (command.safety_status === "blocked") {
        const blocked = await this.blockedCommandResult(sandboxValidationId, sandboxResult, command);
        commandResults.push(blocked);
        await this.emitCommandTrace(blocked);
        continue;
      }
      const executed = await this.executeCommandInSandbox(command, sandboxResult.sandbox_path_ref!, sandboxValidationId, sandboxResult);
      commandResults.push(executed);
      await this.emitCommandTrace(executed);
    }
    const aggregate = this.aggregateSandboxValidationResults(commandResults, plan);
    const result = this.resultFromAggregate({
      sandboxValidationId,
      sandboxResult,
      status: sandboxStatusFromStrict(aggregate.status),
      commandResults,
      aggregateStatus: aggregate.status,
      findings: [],
      logsRef: commandResults.find((entry) => entry.log_ref)?.log_ref,
      plan
    });
    await this.persistSandboxValidationResult(result, request, plan);
    await this.emitAggregateTrace(result);
    return result;
  }

  async runSandboxValidationBatch(runId: string, options: SandboxValidationBatchOptions = {}): Promise<SandboxValidationBatch> {
    if (!this.config.enable_sandbox_validation || this.config.sandbox_validation_mode === "off") {
      const summary = this.summarizeSandboxValidationBatch([], runId);
      const batch = createSandboxValidationBatch({
        run_id: runId,
        sandbox_result_ids: [],
        results: [],
        summary,
        metadata_json: { disabled: true, no_main_repo_validation: true }
      });
      const refs = await this.artifactStore.saveSandboxValidationBatch(batch);
      batch.artifact_ref = refs.batchRef;
      batch.summary_ref = refs.summaryRef;
      batch.summary.sandbox_validation_summary_ref = refs.summaryRef;
      await this.metadata.recordSandboxValidationBatchSaved(batch);
      return batch;
    }
    const sandboxResults = await this.loadSandboxResultsForRun(runId, options.sandboxResultIds);
    const limit = this.config.max_sandbox_validation_per_run ?? 12;
    const results: SandboxValidationResult[] = [];
    for (const sandboxResult of sandboxResults.slice(0, limit)) {
      if (sandboxResult.dry_apply_status !== "dry_apply_passed") continue;
      results.push(await this.runValidationForSandboxResult(sandboxResult));
    }
    const summary = this.summarizeSandboxValidationBatch(results, runId);
    const batch = createSandboxValidationBatch({
      run_id: runId,
      sandbox_result_ids: sandboxResults.slice(0, limit).map((result) => result.sandbox_result_id),
      results,
      summary,
      metadata_json: { no_main_repo_validation: true, no_main_repo_patch_apply: true, no_integration_created: true }
    });
    const refs = await this.artifactStore.saveSandboxValidationBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.sandbox_validation_summary_ref = refs.summaryRef;
    await this.metadata.recordSandboxValidationBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "sandbox_validation_batch_completed",
      lifecycle_stage: "validation",
      summary: `Sandbox validation batch completed with ${results.length} result(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { ...summary, no_main_repo_validation: true }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "sandbox_validation_summary_created",
      lifecycle_stage: "validation",
      summary: "Sandbox validation summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { summary_id: summary.summary_id }
    });
    return batch;
  }

  async validateSandboxResultForValidation(sandboxResult: PatchApplySandboxResult, sandboxValidationId = `sandbox_validation_${randomUUID()}`): Promise<Eligibility> {
    const findings: SandboxValidationFinding[] = [];
    const add = (type: SandboxValidationFinding["finding_type"], message: string, severity: SandboxValidationFinding["severity"] = "blocking") => {
      findings.push(createSandboxValidationFinding({
        sandbox_validation_id: sandboxValidationId,
        run_id: sandboxResult.run_id,
        finding_type: type,
        severity,
        message,
        refs: [sandboxResult.sandbox_result_id]
      }));
    };
    if (sandboxResult.dry_apply_status !== "dry_apply_passed") add("dry_apply_not_passed", `Sandbox dry apply status is ${sandboxResult.dry_apply_status}.`);
    if (!sandboxResult.sandbox_path_ref || !existsSync(sandboxResult.sandbox_path_ref)) add("sandbox_missing", "Sandbox path is missing or unavailable.");
    if (sandboxResult.sandbox_path_ref && path.resolve(sandboxResult.sandbox_path_ref) === this.workspacePath) add("sandbox_missing", "Sandbox validation refuses to run in the main workspace.");
    if (sandboxResult.main_repo_modified !== false) add("main_repo_integrity_failed", "Patch apply sandbox did not prove main repo integrity.");
    const candidate = await this.loadCandidate(sandboxResult);
    const review = candidate ? await this.loadReview(candidate) : undefined;
    if (!candidate) add("candidate_not_preflight_passed", "Validation candidate artifact could not be loaded.");
    if (candidate && candidate.status !== "preflight_passed") add("candidate_not_preflight_passed", `Validation candidate status is ${candidate.status}.`);
    if (candidate && candidate.command_safety_results.some((entry) => entry.required && entry.safety_status !== "safe")) add("command_blocked", "Required command preflight is not safe.");
    if (candidate && !candidate.required_commands.length && !candidate.optional_commands.length) add("missing_validation_commands", "Validation candidate has no commands.", "warning");
    if (!review) add("review_not_accepted", "Patch proposal review artifact could not be loaded.");
    if (review && review.decision !== "accept_for_validation_candidate") add("review_not_accepted", `Review decision is ${review.decision}.`);
    return {
      eligible: findings.every((finding) => finding.severity !== "blocking" && finding.severity !== "critical"),
      status: findings.some((finding) => finding.finding_type === "sandbox_missing") ? "sandbox_missing" : findings.length ? "blocked" : "pending",
      findings,
      candidate,
      review
    };
  }

  buildCommandExecutionPlan(candidate: ValidationCandidate, sandboxResult: PatchApplySandboxResult): SandboxValidationCommandPlanEntry[] {
    return buildSandboxCommandPlan({
      workspacePath: this.workspacePath,
      sandboxPath: sandboxResult.sandbox_path_ref ?? "",
      requiredCommands: candidate.required_commands,
      optionalCommands: candidate.optional_commands,
      allowlist: this.config.safe_commands_allowlist,
      config: this.config
    });
  }

  async executeCommandInSandbox(command: SandboxValidationCommandPlanEntry, sandboxPath: string, sandboxValidationId: string, sandboxResult: PatchApplySandboxResult): Promise<SandboxValidationCommandResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const cwd = resolveSandboxCommandCwd(sandboxPath, command.cwd);
    await this.traceWriter.write({
      run_id: sandboxResult.run_id,
      event_type: "sandbox_validation_command_started",
      lifecycle_stage: "validation",
      summary: `Sandbox validation command started: ${command.command}`,
      metadata_json: { sandbox_validation_id: sandboxValidationId, command: command.command, cwd }
    });
    const output = await spawnWithTimeout(command.command, cwd, this.config.sandbox_validation_command_timeout_ms ?? 30_000, this.config.max_validation_log_size);
    const finished = Date.now();
    const status: ValidationCommandStatus = output.timedOut ? "timed_out" : output.exitCode === 0 ? "passed" : "failed";
    const log = [
      `$ ${command.command}`,
      `cwd: ${cwd}`,
      `status: ${status}`,
      `exit_code: ${output.exitCode ?? ""}`,
      "",
      "stdout:",
      output.stdout,
      "",
      "stderr:",
      output.stderr
    ].join("\n");
    const logRef = await this.artifactStore.saveSandboxValidationLog(sandboxResult.run_id, sandboxValidationId, command.command_id, log);
    return createSandboxValidationCommandResult({
      sandbox_validation_id: sandboxValidationId,
      run_id: sandboxResult.run_id,
      sandbox_result_id: sandboxResult.sandbox_result_id,
      validation_candidate_id: sandboxResult.validation_candidate_id,
      command: command.command,
      cwd,
      required: command.required,
      status,
      exit_code: output.exitCode,
      started_at: startedAt,
      finished_at: new Date(finished).toISOString(),
      duration_ms: finished - started,
      log_ref: logRef,
      summary: output.timedOut ? "Command timed out." : output.exitCode === 0 ? "Command passed." : "Command failed."
    });
  }

  aggregateSandboxValidationResults(results: SandboxValidationCommandResult[], plan: SandboxValidationCommandPlanEntry[] = []) {
    const aggregate = aggregateValidationStatus(results.map((result) => ({
      command: result.command,
      status: result.status,
      required: result.required,
      reason: result.summary,
      log_ref: result.log_ref
    })), plan.map((entry) => ({
      command: entry.command,
      required: entry.required,
      reason: entry.blocked_reason
    })));
    const optionalNonPassing = results.filter((result) => !result.required && result.status !== "passed");
    if (this.config.block_on_optional_command_failure && optionalNonPassing.length && aggregate.status === "passed") {
      return {
        ...aggregate,
        status: "partial" as const,
        fully_passed: false,
        blocking_completion: true,
        run_impact: "prevent_full_success" as const,
        reason: `${aggregate.reason} Optional sandbox validation command failure is blocking by policy.`
      };
    }
    return aggregate;
  }

  async persistSandboxValidationResult(result: SandboxValidationResult, request?: ReturnType<typeof createSandboxValidationRequest>, plan: SandboxValidationCommandPlanEntry[] = []) {
    const refs = await this.artifactStore.saveSandboxValidationResult({ result, request, commandExecutionPlan: plan });
    result.artifact_ref = refs.resultRef;
    result.summary_ref = refs.summaryRef;
    result.logs_ref = refs.logsDir;
    await this.metadata.recordSandboxValidationResultSaved(result);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "sandbox_validation_result_persisted",
      lifecycle_stage: "validation",
      summary: `Sandbox validation result persisted with status ${result.status}.`,
      artifact_refs: [result.artifact_ref, result.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { sandbox_validation_id: result.sandbox_validation_id, strict_validation_status: result.strict_validation_status }
    });
    return result;
  }

  summarizeSandboxValidationBatch(results: SandboxValidationResult[], runId = results[0]?.run_id ?? "") {
    return createSandboxValidationSummary({
      run_id: runId,
      sandbox_validation_used: results.length > 0,
      sandbox_validation_count: results.length,
      sandbox_validation_passed_count: results.filter((result) => result.status === "passed").length,
      sandbox_validation_failed_count: results.filter((result) => result.status === "failed").length,
      sandbox_validation_blocked_count: results.filter((result) => result.status === "blocked" || result.status === "sandbox_missing").length,
      sandbox_validation_partial_count: results.filter((result) => result.status === "partial").length,
      metadata_json: { no_main_repo_validation: true, no_integration_created: true }
    });
  }

  private async blockedCommandResult(sandboxValidationId: string, sandboxResult: PatchApplySandboxResult, command: SandboxValidationCommandPlanEntry) {
    const now = new Date().toISOString();
    await this.traceWriter.write({
      run_id: sandboxResult.run_id,
      event_type: "sandbox_validation_command_blocked",
      lifecycle_stage: "blocked",
      severity: "warning",
      summary: command.blocked_reason ?? `Sandbox validation command blocked: ${command.command}`,
      metadata_json: { sandbox_validation_id: sandboxValidationId, command: command.command }
    });
    const logRef = await this.artifactStore.saveSandboxValidationLog(sandboxResult.run_id, sandboxValidationId, command.command_id, [
      `$ ${command.command}`,
      "status: blocked",
      `reason: ${command.blocked_reason ?? "Command blocked."}`
    ].join("\n"));
    return createSandboxValidationCommandResult({
      sandbox_validation_id: sandboxValidationId,
      run_id: sandboxResult.run_id,
      sandbox_result_id: sandboxResult.sandbox_result_id,
      validation_candidate_id: sandboxResult.validation_candidate_id,
      command: command.command,
      cwd: sandboxResult.sandbox_path_ref ?? "",
      required: command.required,
      status: "blocked",
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      log_ref: logRef,
      summary: command.blocked_reason ?? "Command blocked."
    });
  }

  private resultFromAggregate(input: {
    sandboxValidationId: string;
    sandboxResult: PatchApplySandboxResult;
    status: SandboxValidationStatus;
    commandResults: SandboxValidationCommandResult[];
    aggregateStatus: OverallValidationStatus;
    findings: SandboxValidationFinding[];
    logsRef?: string;
    plan?: SandboxValidationCommandPlanEntry[];
  }) {
    const aggregate = aggregateValidationStatus(input.commandResults.map((result) => ({
      command: result.command,
      status: result.status,
      required: result.required,
      reason: result.summary,
      log_ref: result.log_ref
    })), input.plan?.map((entry) => ({ command: entry.command, required: entry.required, reason: entry.blocked_reason })) ?? []);
    const counts = aggregate;
    return createSandboxValidationResult({
      sandbox_validation_id: input.sandboxValidationId,
      run_id: input.sandboxResult.run_id,
      sandbox_result_id: input.sandboxResult.sandbox_result_id,
      validation_candidate_id: input.sandboxResult.validation_candidate_id,
      proposal_id: input.sandboxResult.proposal_id,
      review_id: input.sandboxResult.review_id,
      patch_artifact_ref: input.sandboxResult.patch_artifact_ref,
      sandbox_ref: input.sandboxResult.sandbox_path_ref,
      commands: input.commandResults.map((result) => result.command),
      command_results: input.commandResults,
      strict_validation_status: input.aggregateStatus,
      status: input.status,
      required_command_count: counts.required_command_count,
      optional_command_count: counts.optional_command_count,
      passed_count: counts.passed_count,
      failed_count: counts.failed_count,
      blocked_count: counts.blocked_count,
      skipped_count: counts.skipped_count,
      timed_out_count: counts.timed_out_count,
      not_run_count: counts.not_run_count,
      findings: input.findings,
      logs_ref: input.logsRef,
      metadata_json: { no_main_repo_validation: true, no_main_repo_patch_apply: true, no_integration_created: true }
    });
  }

  private async emitCommandTrace(result: SandboxValidationCommandResult) {
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: result.status === "timed_out" ? "sandbox_validation_command_timed_out" : result.status === "failed" ? "sandbox_validation_command_failed" : "sandbox_validation_command_completed",
      lifecycle_stage: result.status === "passed" ? "validation" : "blocked",
      severity: result.status === "passed" ? "info" : "warning",
      summary: `Sandbox validation command ${result.status}: ${result.command}`,
      artifact_refs: [result.log_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { sandbox_validation_id: result.sandbox_validation_id, command_result_id: result.command_result_id, cwd: result.cwd }
    });
  }

  private async emitAggregateTrace(result: SandboxValidationResult) {
    const eventType = result.status === "passed" ? "sandbox_validation_completed"
      : result.status === "failed" ? "sandbox_validation_failed"
        : result.status === "partial" ? "sandbox_validation_partial"
          : result.status === "blocked" || result.status === "sandbox_missing" ? "sandbox_validation_blocked"
            : "sandbox_validation_completed";
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: eventType,
      lifecycle_stage: result.status === "passed" ? "validation" : "blocked",
      severity: result.status === "passed" ? "info" : "warning",
      summary: `Sandbox validation ${result.status}.`,
      artifact_refs: [result.artifact_ref, result.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        sandbox_validation_id: result.sandbox_validation_id,
        strict_validation_status: result.strict_validation_status,
        required_command_count: result.required_command_count,
        passed_count: result.passed_count,
        failed_count: result.failed_count,
        blocked_count: result.blocked_count,
        timed_out_count: result.timed_out_count
      }
    });
  }

  private async loadSandboxResultsForRun(runId: string, sandboxResultIds?: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return [];
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = sandboxResultIds?.length
        ? store.all<{ artifact_ref?: string }>(
          `SELECT artifact_ref FROM factory_patch_apply_sandbox_results WHERE run_id = ? AND sandbox_result_id IN (${sandboxResultIds.map(() => "?").join(",")}) ORDER BY created_at`,
          runId,
          ...sandboxResultIds
        )
        : store.all<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_patch_apply_sandbox_results WHERE run_id = ? ORDER BY created_at", runId);
      const results: PatchApplySandboxResult[] = [];
      for (const row of rows) {
        if (row.artifact_ref && existsSync(row.artifact_ref)) results.push(await readJson<PatchApplySandboxResult>(row.artifact_ref));
      }
      return results;
    } finally {
      store.close();
    }
  }

  private async loadCandidate(sandboxResult: PatchApplySandboxResult) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_validation_candidates WHERE validation_candidate_id = ?", sandboxResult.validation_candidate_id);
      return row?.artifact_ref && existsSync(row.artifact_ref) ? readJson<ValidationCandidate>(row.artifact_ref) : undefined;
    } finally {
      store.close();
    }
  }

  private async loadReview(candidate: ValidationCandidate) {
    const ref = candidate.review_artifact_ref;
    return ref && existsSync(ref) ? readJson<PatchProposalReview>(ref) : undefined;
  }
}

function spawnWithTimeout(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const spawnPlan = directNodeEvalSpawnPlan(command);
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd,
      shell: spawnPlan.shell,
      windowsHide: true,
      env: sanitizedEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOutRequested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeoutFallback: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (timeoutFallback) clearTimeout(timeoutFallback);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      resolve({ exitCode, stdout: truncate(stdout, maxOutputBytes), stderr: truncate(stderr, maxOutputBytes), timedOut });
    };
    const timeout = () => {
      if (done) return;
      timedOutRequested = true;
      timeoutFallback = setTimeout(() => finish(null, true), 5_000);
      timeoutFallback.unref?.();
      killProcessTree(child.pid)
        .catch((error: unknown) => {
          stderr = truncate(`${stderr}\nFailed to kill sandbox validation process tree: ${error instanceof Error ? error.message : String(error)}`, maxOutputBytes);
        });
    };
    timer = setTimeout(timeout, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = truncate(stdout + chunk.toString("utf8"), maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = truncate(stderr + chunk.toString("utf8"), maxOutputBytes);
    });
    child.on("error", (error) => {
      stderr = truncate(`${stderr}\n${error.message}`, maxOutputBytes);
      finish(1, false);
    });
    child.on("close", (code) => finish(code, timedOutRequested));
  });
}

function directNodeEvalSpawnPlan(command: string): { command: string; args: string[]; shell: boolean } {
  const match = command.trim().match(/^node\s+-e\s+(["'])([\s\S]*)\1$/);
  if (!match) return { command, args: [], shell: true };
  const quote = match[1];
  const script = match[2].replaceAll(`\\${quote}`, quote);
  return { command: process.execPath, args: ["-e", script], shell: false };
}

function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // taskkill below handles already-exited processes and descendants.
    }
    return new Promise((resolve) => {
      let settled = false;
      let fallback: ReturnType<typeof setTimeout>;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        resolve();
      };
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      fallback = setTimeout(done, 1_500);
      fallback.unref?.();
      killer.once("error", done);
      killer.once("exit", done);
      killer.once("close", done);
    });
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have already exited between timeout and cleanup.
    }
  }
  return Promise.resolve();
}

function sanitizedEnv() {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "TEMP", "TMP", "ComSpec"];
  return Object.fromEntries(keep.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
}

function truncate(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}\n[truncated]`;
}

function sandboxStatusFromStrict(status: OverallValidationStatus): SandboxValidationStatus {
  return status === "passed" ? "passed"
    : status === "failed" ? "failed"
      : status === "blocked" ? "blocked"
        : status === "partial" ? "partial"
          : status === "skipped" ? "skipped"
            : status === "not_required" ? "not_required"
              : "not_run";
}
