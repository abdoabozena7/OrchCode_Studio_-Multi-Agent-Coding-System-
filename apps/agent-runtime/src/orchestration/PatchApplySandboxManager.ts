import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readJson } from "../memory/ProjectMemory.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import type { PatchProposalReview } from "./PatchProposalReviewModels.js";
import type { ValidationCandidate } from "./ValidationCandidateModels.js";
import { PatchDryApplyChecker, type MainRepoSnapshot } from "./PatchDryApplyChecker.js";
import {
  createPatchApplySandboxRequest,
  createPatchApplySandboxResult,
  createPatchSandboxBatch,
  createPatchSandboxSummary,
  createPatchUnsafeFinding,
  type PatchApplySandboxResult,
  type PatchApplySandboxStatus,
  type PatchSandboxBatch,
  type PatchSandboxMode
} from "./PatchApplySandboxModels.js";

const execFileAsync = promisify(execFile);

export type PatchApplySandboxManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  checker?: PatchDryApplyChecker;
};

export type PatchApplySandboxBatchOptions = {
  validationCandidateIds?: string[];
};

type Eligibility = {
  eligible: boolean;
  status: PatchApplySandboxStatus;
  reasons: string[];
  proposal?: OneWriterDryRunProposal;
  review?: PatchProposalReview;
};

export class PatchApplySandboxManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly checker: PatchDryApplyChecker;

  constructor(options: PatchApplySandboxManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "PatchApplySandboxManager" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.checker = options.checker ?? new PatchDryApplyChecker();
  }

  async runDryApplyForValidationCandidate(candidate: ValidationCandidate): Promise<PatchApplySandboxResult> {
    const resultId = `patch_apply_sandbox_${randomUUID()}`;
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "patch_apply_sandbox_started",
      lifecycle_stage: "planning",
      summary: `Patch apply sandbox started for ${candidate.validation_candidate_id}.`,
      artifact_refs: [candidate.artifact_ref, candidate.patch_artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { sandbox_result_id: resultId, validation_candidate_id: candidate.validation_candidate_id, no_validation_run: true, no_patch_applied_to_main_repo: true }
    });

    const eligibility = await this.validateCandidateForDryApply(candidate);
    const mode = this.sandboxMode();
    const request = createPatchApplySandboxRequest({
      run_id: candidate.run_id,
      validation_candidate_id: candidate.validation_candidate_id,
      proposal_id: candidate.proposal_id,
      review_id: candidate.review_id,
      patch_artifact_ref: candidate.patch_artifact_ref,
      sandbox_mode: mode,
      changed_files: eligibility.proposal?.changed_files ?? [],
      allowed_files: eligibility.proposal?.allowed_files ?? [],
      forbidden_files: eligibility.proposal?.forbidden_files ?? [],
      metadata_json: { eligibility_reasons: eligibility.reasons, no_validation_run: true, no_patch_applied: true }
    });

    if (!eligibility.eligible || !eligibility.proposal || mode === "off") {
      const status: PatchApplySandboxStatus = mode === "off" ? "not_required" : eligibility.status;
      const result = createPatchApplySandboxResult({
        sandbox_result_id: resultId,
        run_id: candidate.run_id,
        validation_candidate_id: candidate.validation_candidate_id,
        proposal_id: candidate.proposal_id,
        review_id: candidate.review_id,
        patch_artifact_ref: candidate.patch_artifact_ref,
        sandbox_mode: mode,
        changed_files: eligibility.proposal?.changed_files ?? stringArray(candidate.metadata_json.changed_files),
        dry_apply_status: status,
        conflicts: [],
        failed_hunks: [],
        unsafe_findings: eligibility.reasons.map((reason) => createPatchUnsafeFinding({
          sandbox_result_id: resultId,
          validation_candidate_id: candidate.validation_candidate_id,
          proposal_id: candidate.proposal_id,
          finding_type: findingTypeFromReason(reason),
          severity: "blocking",
          message: reason,
          refs: [candidate.validation_candidate_id]
        })),
        metadata_json: { eligibility_reasons: eligibility.reasons, no_validation_run: true, no_patch_applied: true }
      });
      await this.persistSandboxResult(result, request);
      return result;
    }

    const before = this.checker.snapshotMainRepo(this.workspacePath, eligibility.proposal.changed_files);
    const sandbox = await this.createSandboxWorkspace({
      runId: candidate.run_id,
      resultId,
      mode,
      changedFiles: eligibility.proposal.changed_files
    });
    if (!sandbox.available) {
      const result = createPatchApplySandboxResult({
        sandbox_result_id: resultId,
        run_id: candidate.run_id,
        validation_candidate_id: candidate.validation_candidate_id,
        proposal_id: candidate.proposal_id,
        review_id: candidate.review_id,
        patch_artifact_ref: candidate.patch_artifact_ref,
        sandbox_mode: mode,
        changed_files: eligibility.proposal.changed_files,
        dry_apply_status: "sandbox_unavailable",
        conflicts: [],
        failed_hunks: [],
        unsafe_findings: [createPatchUnsafeFinding({
          sandbox_result_id: resultId,
          validation_candidate_id: candidate.validation_candidate_id,
          proposal_id: candidate.proposal_id,
          finding_type: "sandbox_root_unsafe",
          severity: "blocking",
          message: sandbox.reason ?? "Sandbox workspace unavailable.",
          refs: []
        })],
        metadata_json: { sandbox_reason: sandbox.reason, no_validation_run: true, no_patch_applied: true }
      });
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "patch_apply_sandbox_unavailable",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Patch apply sandbox unavailable.",
        reason: sandbox.reason,
        metadata_json: { sandbox_result_id: resultId }
      });
      await this.persistSandboxResult(result, request, before);
      return result;
    }

    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "patch_apply_sandbox_created",
      lifecycle_stage: "planning",
      summary: `Patch apply sandbox created in ${mode} mode.`,
      artifact_refs: [sandbox.pathRef].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { sandbox_result_id: resultId, sandbox_mode: mode }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "patch_dry_apply_started",
      lifecycle_stage: "planning",
      summary: `Patch dry apply started for ${candidate.validation_candidate_id}.`,
      metadata_json: { sandbox_result_id: resultId, no_validation_run: true }
    });

    const dryApply = await this.applyPatchInSandbox({
      resultId,
      candidate,
      proposal: eligibility.proposal,
      sandboxRoot: sandbox.pathRef ?? this.workspacePath
    });
    const integrity = await this.checkMainRepoUnmodified({
      candidate,
      before,
      changedFiles: eligibility.proposal.changed_files,
      resultId,
      proposalId: eligibility.proposal.proposal_id
    });
    const unsafeFindings = [...dryApply.unsafe_findings, ...integrity.unsafeFindings];
    const status: PatchApplySandboxStatus = unsafeFindings.length
      ? "unsafe_patch"
      : dryApply.conflicts.length
        ? "conflict_detected"
        : dryApply.failed_hunks.length
          ? "dry_apply_failed"
          : "dry_apply_passed";
    const result = createPatchApplySandboxResult({
      sandbox_result_id: resultId,
      run_id: candidate.run_id,
      validation_candidate_id: candidate.validation_candidate_id,
      proposal_id: candidate.proposal_id,
      review_id: candidate.review_id,
      patch_artifact_ref: candidate.patch_artifact_ref,
      sandbox_mode: mode,
      sandbox_path_ref: sandbox.pathRef,
      changed_files: dryApply.changed_files,
      dry_apply_status: status,
      conflicts: dryApply.conflicts,
      failed_hunks: dryApply.failed_hunks,
      unsafe_findings: unsafeFindings,
      metadata_json: { no_validation_run: true, no_patch_applied_to_main_repo: true, main_repo_integrity_ok: integrity.ok }
    });

    await this.emitDryApplyTrace(result);
    const keepSandboxForValidation = Boolean(this.config.enable_sandbox_validation && this.config.sandbox_validation_mode === "execute_safe_commands");
    if (!keepSandboxForValidation && this.config.cleanup_sandbox_after_run !== false && mode !== "simulate_only" && sandbox.pathRef) {
      await rm(sandbox.pathRef, { recursive: true, force: true });
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "patch_apply_sandbox_cleaned",
        lifecycle_stage: "planning",
        summary: "Patch apply sandbox cleaned.",
        metadata_json: { sandbox_result_id: resultId, sandbox_path_ref: sandbox.pathRef }
      });
    }
    await this.persistSandboxResult(result, request, before, integrity.after);
    return result;
  }

  async runDryApplyBatch(runId: string, options: PatchApplySandboxBatchOptions = {}): Promise<PatchSandboxBatch> {
    if (!this.config.enable_patch_apply_sandbox || this.config.patch_apply_sandbox_mode === "off") {
      const summary = this.summarizeSandboxBatch([], runId);
      const batch = createPatchSandboxBatch({
        run_id: runId,
        validation_candidate_ids: [],
        results: [],
        summary,
        metadata_json: { disabled: true, no_validation_run: true, no_patch_applied: true }
      });
      const refs = await this.artifactStore.savePatchApplySandboxBatch(batch);
      batch.artifact_ref = refs.batchRef;
      batch.summary_ref = refs.summaryRef;
      batch.summary.sandbox_summary_ref = refs.summaryRef;
      await this.metadata.recordPatchApplySandboxBatchSaved(batch);
      return batch;
    }

    const candidates = await this.loadCandidatesForRun(runId, options.validationCandidateIds);
    const limit = this.config.max_sandbox_apply_per_run ?? 12;
    const results: PatchApplySandboxResult[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      results.push(await this.runDryApplyForValidationCandidate(candidate));
    }
    const summary = this.summarizeSandboxBatch(results, runId);
    const batch = createPatchSandboxBatch({
      run_id: runId,
      validation_candidate_ids: candidates.slice(0, limit).map((candidate) => candidate.validation_candidate_id),
      results,
      summary,
      metadata_json: { no_validation_run: true, no_patch_applied: true, no_integration_created: true }
    });
    const refs = await this.artifactStore.savePatchApplySandboxBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.sandbox_summary_ref = refs.summaryRef;
    await this.metadata.recordPatchApplySandboxBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "patch_apply_sandbox_batch_completed",
      lifecycle_stage: "planning",
      summary: `Patch apply sandbox batch completed with ${results.length} result(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { ...summary, no_validation_run: true, no_patch_applied: true }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "patch_apply_sandbox_summary_created",
      lifecycle_stage: "planning",
      summary: "Patch apply sandbox summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { summary_id: summary.summary_id }
    });
    return batch;
  }

  async validateCandidateForDryApply(candidate: ValidationCandidate): Promise<Eligibility> {
    const reasons: string[] = [];
    if (!["preflight_passed"].includes(candidate.status)) reasons.push(`Validation candidate status is ${candidate.status}, not preflight_passed.`);
    if (candidate.status === "cancelled" || candidate.status === "rejected") reasons.push("Validation candidate is cancelled or rejected.");
    if (!candidate.patch_artifact_ref || !existsSync(candidate.patch_artifact_ref)) reasons.push("Patch artifact is missing.");
    if (candidate.command_safety_results.some((entry) => entry.required && entry.safety_status !== "safe")) reasons.push("Required validation command preflight is blocked or unsafe.");
    if (this.config.require_clean_main_worktree_for_sandbox && !(await this.isMainWorktreeClean())) reasons.push("Main worktree is not clean enough for configured sandbox policy.");
    const proposal = await this.loadProposal(candidate);
    const review = await this.loadReview(candidate);
    if (!proposal) reasons.push("Patch proposal artifact could not be loaded.");
    if (!review) reasons.push("Patch proposal review artifact could not be loaded.");
    if (review && review.decision !== "accept_for_validation_candidate") reasons.push(`Review decision is ${review.decision}, not accept_for_validation_candidate.`);
    if (review && review.findings.some((finding) => finding.blocking || finding.severity === "critical")) reasons.push("Review contains blocking or critical findings.");
    if (proposal?.scope_check_result?.status !== "passed") reasons.push("Patch proposal scope check has not passed.");
    return {
      eligible: reasons.length === 0,
      status: reasons.length ? "blocked" : "pending",
      reasons,
      proposal,
      review
    };
  }

  async createSandboxWorkspace(input: { runId: string; resultId: string; mode: PatchSandboxMode; changedFiles: string[] }) {
    if (input.mode === "off") return { available: false, reason: "Patch apply sandbox mode is off." };
    if (input.mode === "simulate_only") return { available: true, pathRef: this.workspacePath };
    const configuredRoot = this.config.sandbox_root?.trim();
    const root = path.resolve(configuredRoot || path.join(os.tmpdir(), "hivo_patch_apply_sandbox"));
    const workspaceRelative = path.relative(this.workspacePath, root);
    if (workspaceRelative === "" || (!workspaceRelative.startsWith("..") && !path.isAbsolute(workspaceRelative))) {
      return { available: false, reason: "Sandbox root must not be inside the main workspace." };
    }
    const sandboxPath = path.join(root, sanitizeFilePart(input.runId), sanitizeFilePart(input.resultId));
    await mkdir(sandboxPath, { recursive: true });
    for (const file of input.changedFiles) {
      const normalized = file.replace(/\\/g, "/");
      const source = path.resolve(this.workspacePath, normalized);
      if (!existsSync(source) || !isInside(this.workspacePath, source)) continue;
      const target = path.resolve(sandboxPath, normalized);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    }
    return { available: true, pathRef: sandboxPath };
  }

  async applyPatchInSandbox(input: { resultId: string; candidate: ValidationCandidate; proposal: OneWriterDryRunProposal; sandboxRoot: string }) {
    return this.checker.check({
      workspacePath: this.workspacePath,
      sandboxRoot: input.sandboxRoot,
      resultId: input.resultId,
      validationCandidateId: input.candidate.validation_candidate_id,
      proposal: input.proposal,
      allowedFiles: input.proposal.allowed_files,
      forbiddenFiles: input.proposal.forbidden_files
    });
  }

  async checkMainRepoUnmodified(input: {
    candidate: ValidationCandidate;
    before: MainRepoSnapshot;
    changedFiles: string[];
    resultId: string;
    proposalId: string;
  }) {
    const after = this.checker.snapshotMainRepo(this.workspacePath, input.changedFiles);
    const comparison = this.checker.compareMainRepoSnapshot(input.before, after);
    const unsafeFindings = comparison.modified.map((file) => createPatchUnsafeFinding({
      sandbox_result_id: input.resultId,
      validation_candidate_id: input.candidate.validation_candidate_id,
      proposal_id: input.proposalId,
      finding_type: "main_repo_modified",
      severity: "critical",
      message: `Main repository file changed during sandbox dry apply: ${file}.`,
      path: file,
      refs: [file]
    }));
    await this.traceWriter.write({
      run_id: input.candidate.run_id,
      event_type: "patch_apply_main_repo_integrity_checked",
      lifecycle_stage: comparison.ok ? "planning" : "blocked",
      severity: comparison.ok ? "info" : "critical",
      summary: comparison.ok ? "Main repository integrity check passed." : "Main repository integrity check detected modification.",
      metadata_json: { sandbox_result_id: input.resultId, modified_files: comparison.modified }
    });
    return { ok: comparison.ok, after, unsafeFindings };
  }

  async persistSandboxResult(result: PatchApplySandboxResult, request?: ReturnType<typeof createPatchApplySandboxRequest>, before?: MainRepoSnapshot, after?: MainRepoSnapshot) {
    const refs = await this.artifactStore.savePatchApplySandboxResult({ result, request, mainRepoIntegrity: { before, after, main_repo_modified: false } });
    result.artifact_ref = refs.resultRef;
    result.summary_ref = refs.summaryRef;
    result.sandbox_artifact_ref = refs.resultDir;
    await this.metadata.recordPatchApplySandboxResultSaved(result);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "patch_apply_sandbox_result_persisted",
      lifecycle_stage: "planning",
      summary: `Patch apply sandbox result persisted with status ${result.dry_apply_status}.`,
      artifact_refs: [result.artifact_ref, result.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { sandbox_result_id: result.sandbox_result_id, status: result.dry_apply_status }
    });
    return result;
  }

  summarizeSandboxBatch(results: PatchApplySandboxResult[], runId = results[0]?.run_id ?? "") {
    return createPatchSandboxSummary({
      run_id: runId,
      patch_apply_sandbox_used: results.length > 0,
      sandbox_result_count: results.length,
      dry_apply_passed_count: results.filter((result) => result.dry_apply_status === "dry_apply_passed").length,
      dry_apply_failed_count: results.filter((result) => result.dry_apply_status === "dry_apply_failed").length,
      conflict_count: results.reduce((count, result) => count + result.conflicts.length, 0),
      failed_hunk_count: results.reduce((count, result) => count + result.failed_hunks.length, 0),
      sandbox_unavailable_count: results.filter((result) => result.dry_apply_status === "sandbox_unavailable").length,
      unsafe_patch_count: results.filter((result) => result.dry_apply_status === "unsafe_patch").length,
      blocked_count: results.filter((result) => result.dry_apply_status === "blocked").length,
      main_repo_integrity_ok: results.every((result) => result.main_repo_modified === false),
      metadata_json: { no_validation_run: true, no_patch_applied: true, no_integration_created: true }
    });
  }

  private sandboxMode(): PatchSandboxMode {
    return this.config.patch_apply_sandbox_mode ?? "simulate_only";
  }

  private async emitDryApplyTrace(result: PatchApplySandboxResult) {
    for (const conflictEntry of result.conflicts) {
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "patch_apply_conflict_detected",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: conflictEntry.message,
        metadata_json: { sandbox_result_id: result.sandbox_result_id, conflict_id: conflictEntry.conflict_id, path: conflictEntry.path }
      });
    }
    for (const hunk of result.failed_hunks) {
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "patch_apply_failed_hunk_detected",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: hunk.reason,
        metadata_json: { sandbox_result_id: result.sandbox_result_id, failed_hunk_id: hunk.failed_hunk_id, path: hunk.path }
      });
    }
    for (const finding of result.unsafe_findings) {
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "patch_apply_unsafe_patch_detected",
        lifecycle_stage: "blocked",
        severity: finding.severity === "critical" ? "critical" : "warning",
        summary: finding.message,
        metadata_json: { sandbox_result_id: result.sandbox_result_id, finding_id: finding.finding_id, path: finding.path }
      });
    }
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: result.dry_apply_status === "dry_apply_passed" ? "patch_dry_apply_passed" : "patch_dry_apply_failed",
      lifecycle_stage: result.dry_apply_status === "dry_apply_passed" ? "planning" : "blocked",
      severity: result.dry_apply_status === "dry_apply_passed" ? "info" : "warning",
      summary: `Patch dry apply ${result.dry_apply_status}.`,
      artifact_refs: [result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        sandbox_result_id: result.sandbox_result_id,
        conflict_count: result.conflicts.length,
        failed_hunk_count: result.failed_hunks.length,
        unsafe_finding_count: result.unsafe_findings.length,
        no_validation_run: true
      }
    });
  }

  private async loadCandidatesForRun(runId: string, validationCandidateIds?: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return [];
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = validationCandidateIds?.length
        ? store.all<{ artifact_ref?: string }>(
          `SELECT artifact_ref FROM factory_validation_candidates WHERE run_id = ? AND validation_candidate_id IN (${validationCandidateIds.map(() => "?").join(",")}) ORDER BY created_at`,
          runId,
          ...validationCandidateIds
        )
        : store.all<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_validation_candidates WHERE run_id = ? ORDER BY created_at", runId);
      const candidates: ValidationCandidate[] = [];
      for (const row of rows) {
        if (row.artifact_ref && existsSync(row.artifact_ref)) candidates.push(await readJson<ValidationCandidate>(row.artifact_ref));
      }
      return candidates;
    } finally {
      store.close();
    }
  }

  private async loadProposal(candidate: ValidationCandidate) {
    if (!candidate.patch_artifact_ref || !existsSync(candidate.patch_artifact_ref)) return undefined;
    return readJson<OneWriterDryRunProposal>(candidate.patch_artifact_ref);
  }

  private async loadReview(candidate: ValidationCandidate) {
    const reviewRef = candidate.review_artifact_ref ?? await this.artifactRefFor("factory_patch_proposal_reviews", "review_id", candidate.review_id, "review_artifact_ref");
    if (!reviewRef || !existsSync(reviewRef)) return undefined;
    return readJson<PatchProposalReview>(reviewRef);
  }

  private async artifactRefFor(table: string, idColumn: string, id: string, refColumn: string) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<Record<string, unknown>>(`SELECT ${refColumn} FROM ${table} WHERE ${idColumn} = ?`, id);
      const ref = row?.[refColumn];
      return typeof ref === "string" && ref.length ? ref : undefined;
    } finally {
      store.close();
    }
  }

  private async isMainWorktreeClean() {
    if (!existsSync(path.join(this.workspacePath, ".git"))) return true;
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: this.workspacePath });
      return stdout.trim().length === 0;
    } catch {
      return false;
    }
  }
}

function findingTypeFromReason(reason: string) {
  if (/patch artifact/i.test(reason)) return "missing_patch_artifact";
  if (/scope/i.test(reason)) return "scope_check_failed";
  if (/command/i.test(reason)) return "command_preflight_blocked";
  if (/critical|blocking/i.test(reason)) return "critical_review_blocker";
  if (/cancelled|rejected/i.test(reason)) return "cancelled_or_rejected";
  return "missing_reviewed_validation_candidate";
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "sandbox";
}

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
