import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreOrchestrator,
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  OrchestrationArtifactStore,
  SandboxValidationRunner,
  createPatchApplySandboxResult,
  createPatchProposalReview,
  createSandboxValidationCommandResult,
  createSandboxValidationFinding,
  createSandboxValidationRequest,
  createSandboxValidationResult,
  createValidationCandidate,
  createValidationCommandPreflight,
  createValidationEnvironmentReadiness,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type PatchApplySandboxResult,
  type ValidationCandidateStatus
} from "../orchestration/index.js";

test("sandbox validation models create request result finding and command result", () => {
  const finding = createSandboxValidationFinding({
    sandbox_validation_id: "sandbox_validation_model",
    run_id: "run_model",
    finding_type: "sandbox_missing",
    severity: "blocking",
    message: "Sandbox missing.",
    refs: []
  });
  const command = createSandboxValidationCommandResult({
    sandbox_validation_id: "sandbox_validation_model",
    run_id: "run_model",
    sandbox_result_id: "sandbox_result_model",
    validation_candidate_id: "candidate_model",
    command: "node -e \"process.exit(0)\"",
    cwd: "sandbox",
    required: true,
    status: "passed",
    started_at: "2026-05-28T00:00:00.000Z",
    finished_at: "2026-05-28T00:00:00.001Z",
    duration_ms: 1,
    summary: "passed"
  });
  const request = createSandboxValidationRequest({
    run_id: "run_model",
    sandbox_result_id: "sandbox_result_model",
    validation_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    review_id: "review_model",
    commands: [{ command: command.command, required: true, cwd: "." }]
  });
  const result = createSandboxValidationResult({
    sandbox_validation_id: "sandbox_validation_model",
    run_id: "run_model",
    sandbox_result_id: "sandbox_result_model",
    validation_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    review_id: "review_model",
    commands: [command.command],
    command_results: [command],
    strict_validation_status: "passed",
    status: "passed",
    required_command_count: 1,
    optional_command_count: 0,
    passed_count: 1,
    failed_count: 0,
    blocked_count: 0,
    skipped_count: 0,
    timed_out_count: 0,
    not_run_count: 0,
    findings: [finding]
  });
  assert.equal(request.validation_candidate_id, "candidate_model");
  assert.equal(result.findings[0]?.finding_type, "sandbox_missing");
  assert.equal(result.command_results[0]?.status, "passed");
});

test("eligible dry-applied sandbox executes allowed command in sandbox and leaves main repo unchanged", async () => {
  const workspace = await fixtureWorkspace("sandbox-validation-pass");
  const sandbox = await fixtureWorkspace("sandbox-validation-pass-sandbox");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const sandboxResult = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_pass",
      requiredCommands: ["node -e \"require('fs').writeFileSync('sandbox-cwd.txt', process.cwd())\""]
    });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    const runner = new SandboxValidationRunner({
      workspacePath: workspace,
      config: config({
        sandbox_validation_mode: "execute_safe_commands",
        safe_commands_allowlist: ["node -e"]
      }),
      artifactStore
    });
    const result = await runner.runValidationForSandboxResult(sandboxResult);
    const after = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    assert.equal(result.status, "passed");
    assert.equal(result.strict_validation_status, "passed");
    assert.equal(result.required_command_count, 1);
    assert.equal(after, before);
    assert.equal(existsSync(path.join(sandbox, "sandbox-cwd.txt")), true);
    assert.equal(existsSync(path.join(workspace, "sandbox-cwd.txt")), false);
    assert.ok(result.artifact_ref && existsSync(result.artifact_ref));
    assert.ok(result.logs_ref && existsSync(result.logs_ref));
  } finally {
    await removeTempDir(workspace);
    await removeTempDir(sandbox);
  }
});

test("dry apply failed, missing sandbox, rejected candidate, and blocked command do not execute commands", async () => {
  const workspace = await fixtureWorkspace("sandbox-validation-blocked");
  const sandbox = await fixtureWorkspace("sandbox-validation-blocked-sandbox");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const runner = new SandboxValidationRunner({
      workspacePath: workspace,
      config: config({
        sandbox_validation_mode: "execute_safe_commands",
        safe_commands_allowlist: ["node -e"]
      }),
      artifactStore
    });
    const dryFailed = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_dry_failed",
      dryApplyStatus: "dry_apply_failed",
      requiredCommands: ["node -e \"process.exit(0)\""]
    });
    assert.equal((await runner.runValidationForSandboxResult(dryFailed)).status, "blocked");
    const missingSandbox = await persistedSandboxFixture(workspace, path.join(sandbox, "missing"), artifactStore, {
      runId: "run_sandbox_validation_missing",
      requiredCommands: ["node -e \"process.exit(0)\""]
    });
    await rm(path.join(sandbox, "missing"), { recursive: true, force: true });
    assert.equal((await runner.runValidationForSandboxResult(missingSandbox)).status, "sandbox_missing");
    const rejected = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_rejected",
      candidateStatus: "rejected",
      requiredCommands: ["node -e \"process.exit(0)\""]
    });
    assert.equal((await runner.runValidationForSandboxResult(rejected)).status, "blocked");
    const blockedCommand = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_blocked_command",
      requiredCommands: ["npm install"],
      commandSafety: "safe"
    });
    const blockedResult = await runner.runValidationForSandboxResult(blockedCommand);
    assert.equal(blockedResult.status, "blocked");
    assert.equal(existsSync(path.join(sandbox, "node_modules")), false);
  } finally {
    await removeTempDir(workspace);
    await removeTempDir(sandbox);
  }
});

test("strict semantics map required failure timeout and optional failure correctly", async () => {
  const workspace = await fixtureWorkspace("sandbox-validation-semantics");
  const sandbox = await fixtureWorkspace("sandbox-validation-semantics-sandbox");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const runner = new SandboxValidationRunner({
      workspacePath: workspace,
      config: config({
        sandbox_validation_mode: "execute_safe_commands",
        safe_commands_allowlist: ["node -e"]
      }),
      artifactStore
    });
    const timeoutRunner = new SandboxValidationRunner({
      workspacePath: workspace,
      config: config({
        sandbox_validation_mode: "execute_safe_commands",
        sandbox_validation_command_timeout_ms: 50,
        safe_commands_allowlist: ["node -e"]
      }),
      artifactStore
    });
    const requiredFail = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_fail",
      requiredCommands: ["node -e \"process.exit(1)\""]
    });
    assert.equal((await runner.runValidationForSandboxResult(requiredFail)).status, "failed");
    const timeout = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_timeout",
      requiredCommands: ["node -e \"setTimeout(()=>{},200)\""]
    });
    const timeoutResult = await timeoutRunner.runValidationForSandboxResult(timeout);
    assert.equal(timeoutResult.status, "failed");
    assert.equal(timeoutResult.timed_out_count, 1);
    const optionalFail = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_optional",
      requiredCommands: ["node -e \"process.exit(0)\""],
      optionalCommands: ["node -e \"process.exit(1)\""]
    });
    const optionalResult = await runner.runValidationForSandboxResult(optionalFail);
    assert.equal(optionalResult.status, "passed");
    assert.equal(optionalResult.failed_count, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("timed out sandbox command kills long-lived child process and exits cleanly", async () => {
  const workspace = await fixtureWorkspace("sandbox-validation-timeout-cleanup");
  const sandbox = await fixtureWorkspace("sandbox-validation-timeout-cleanup-sandbox");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const runner = new SandboxValidationRunner({
      workspacePath: workspace,
      config: config({
        sandbox_validation_mode: "execute_safe_commands",
        sandbox_validation_command_timeout_ms: 100,
        safe_commands_allowlist: ["node -e"]
      }),
      artifactStore
    });
    const sandboxResult = await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_timeout_cleanup",
      requiredCommands: ["node -e \"require('fs').writeFileSync('child.pid',String(process.pid)),setInterval(()=>{},1000)\""]
    });
    const started = Date.now();
    const result = await runner.runValidationForSandboxResult(sandboxResult);
    const duration = Date.now() - started;
    const childPid = Number(await readFile(path.join(sandbox, "child.pid"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(result.status, "failed");
    assert.equal(result.timed_out_count, 1);
    assert.equal(duration < 10_000, true);
    assert.equal(isProcessAlive(childPid), false);
  } finally {
    await removeTempDir(workspace);
    await removeTempDir(sandbox);
  }
});

test("batch writes artifacts metadata and trace without validation rows or integration candidates", async () => {
  const workspace = await fixtureWorkspace("sandbox-validation-persist");
  const sandbox = await fixtureWorkspace("sandbox-validation-persist-sandbox");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_batch",
      requiredCommands: ["node -e \"process.exit(0)\""]
    });
    const runner = new SandboxValidationRunner({
      workspacePath: workspace,
      config: config({
        sandbox_validation_mode: "execute_safe_commands",
        safe_commands_allowlist: ["node -e"]
      }),
      artifactStore
    });
    const batch = await runner.runSandboxValidationBatch("run_sandbox_validation_batch");
    assert.equal(batch.summary.sandbox_validation_count, 1);
    assert.equal(batch.summary.sandbox_validation_passed_count, 1);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_validation_results")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_validation_commands")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_validation_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
    } finally {
      store.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_sandbox_validation_batch" });
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_validation_started"));
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_validation_command_completed"));
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_validation_result_persisted"));
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_validation_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("CoreOrchestrator sandbox validation hook respects disabled and enabled behavior", async () => {
  const workspace = await fixtureWorkspace("sandbox-validation-orchestrator");
  const sandbox = await fixtureWorkspace("sandbox-validation-orchestrator-sandbox");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedSandboxFixture(workspace, sandbox, artifactStore, {
      runId: "run_sandbox_validation_orchestrator",
      requiredCommands: ["node -e \"require('fs').writeFileSync('orchestrator-sandbox.txt', process.cwd())\""]
    });
    const disabled = new CoreOrchestrator({
      workspacePath: workspace,
      config: config({ enable_sandbox_validation: false })
    });
    await (disabled as unknown as { runSandboxValidationIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .runSandboxValidationIfAllowed("run_sandbox_validation_orchestrator", true);
    let store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_validation_batches")?.count, 0);
    } finally {
      store.close();
    }
    const enabled = new CoreOrchestrator({
      workspacePath: workspace,
      config: config({
        enable_sandbox_validation: true,
        sandbox_validation_mode: "execute_safe_commands",
        safe_commands_allowlist: ["node -e"]
      })
    });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    await (enabled as unknown as { runSandboxValidationIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .runSandboxValidationIfAllowed("run_sandbox_validation_orchestrator", true);
    const after = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    assert.equal(after, before);
    assert.equal(existsSync(path.join(sandbox, "orchestrator-sandbox.txt")), true);
    assert.equal(existsSync(path.join(workspace, "orchestrator-sandbox.txt")), false);
    store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_validation_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeWorkspaceFile(workspace: string, relative: string, content: string) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    enable_patch_apply_sandbox: true,
    patch_apply_sandbox_mode: "temp_copy",
    cleanup_sandbox_after_run: false,
    enable_sandbox_validation: true,
    sandbox_validation_mode: "report_only",
    verify_main_repo_unmodified: true,
    enable_validation_candidate_gate: false,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    require_environment_readiness: false,
    safe_commands_allowlist: ["node -e"],
    ...overrides
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeTempDir(target: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (lastError && typeof lastError === "object" && "code" in lastError && /^(EBUSY|EPERM)$/.test(String(lastError.code))) {
    return;
  }
  throw lastError;
}

async function persistedSandboxFixture(workspace: string, sandbox: string, artifactStore: OrchestrationArtifactStore, options: {
  runId: string;
  requiredCommands?: string[];
  optionalCommands?: string[];
  candidateStatus?: ValidationCandidateStatus;
  dryApplyStatus?: PatchApplySandboxResult["dry_apply_status"];
  commandSafety?: "safe" | "blocked";
}) {
  await mkdir(sandbox, { recursive: true });
  await writeWorkspaceFile(workspace, "patches/patch.json", "{}\n");
  const review = createPatchProposalReview({
    review_id: `review_${options.runId}`,
    run_id: options.runId,
    proposal_id: `proposal_${options.runId}`,
    preparation_plan_id: `prep_${options.runId}`,
    proposed_node_id: `node_${options.runId}`,
    reviewer_role: "ReviewerAgent",
    reviewer_mode: "deterministic",
    decision: "accept_for_validation_candidate",
    status: "accepted_for_validation_candidate",
    findings: [],
    required_changes: [],
    validation_recommendations: ["Run sandbox validation."],
    integration_risks: [],
    security_risks: [],
    performance_risks: [],
    test_coverage_risks: [],
    confidence: 0.9
  });
  const reviewRefs = await artifactStore.savePatchProposalReviewArtifacts({ review });
  review.review_artifact_ref = reviewRefs.reviewResultRef;
  await new FactoryMetadataAdapter(workspace).recordPatchProposalReviewSaved(review);
  const commands = [...(options.requiredCommands ?? []), ...(options.optionalCommands ?? [])];
  const candidateId = `candidate_${options.runId}`;
  const preflights = commands.map((command) => createValidationCommandPreflight({
    validation_candidate_id: candidateId,
    command,
    required: (options.requiredCommands ?? []).includes(command),
    purpose: "Sandbox validation.",
    expected_output: "Command result artifact.",
    fallback_behavior: "Record not_run.",
    safety_status: options.commandSafety ?? "safe",
    risk: "safe",
    allowlisted: true,
    inventory_present: true,
    inventory_match: true,
    future_semantics_status: "not_run"
  }));
  const candidate = createValidationCandidate({
    validation_candidate_id: candidateId,
    run_id: options.runId,
    proposal_id: review.proposal_id,
    review_id: review.review_id,
    preparation_plan_id: review.preparation_plan_id,
    proposed_node_id: review.proposed_node_id,
    patch_artifact_ref: path.join(workspace, "patches", "patch.json"),
    review_artifact_ref: review.review_artifact_ref,
    validation_plan_ref: `validation_plan_${options.runId}`,
    required_commands: options.requiredCommands ?? [],
    optional_commands: options.optionalCommands ?? [],
    command_safety_results: preflights,
    environment_readiness: createValidationEnvironmentReadiness({
      validation_candidate_id: candidateId,
      status: "ready",
      workspace_path_known: true,
      command_inventory_available: true,
      validation_runner_available: true,
      required_artifacts_exist: true,
      patch_apply_strategy: "prepare_only",
      findings: []
    }),
    expected_validation_outputs: ["Command result artifact."],
    strict_validation_semantics_ref: "ValidationSemantics.aggregateValidationStatus:v1",
    status: options.candidateStatus ?? "preflight_passed"
  });
  const candidateRefs = await artifactStore.saveValidationCandidateArtifacts({ candidate });
  candidate.artifact_ref = candidateRefs.candidateRef;
  candidate.command_preflight_ref = candidateRefs.commandPreflightRef;
  candidate.environment_preflight_ref = candidateRefs.environmentPreflightRef;
  await new FactoryMetadataAdapter(workspace).recordValidationCandidateSaved(candidate);
  const sandboxResult = createPatchApplySandboxResult({
    sandbox_result_id: `sandbox_result_${options.runId}`,
    run_id: options.runId,
    validation_candidate_id: candidate.validation_candidate_id,
    proposal_id: candidate.proposal_id,
    review_id: candidate.review_id,
    patch_artifact_ref: candidate.patch_artifact_ref,
    sandbox_mode: "temp_copy",
    sandbox_path_ref: sandbox,
    changed_files: ["src/runtime.ts"],
    dry_apply_status: options.dryApplyStatus ?? "dry_apply_passed",
    conflicts: [],
    failed_hunks: [],
    unsafe_findings: []
  });
  const refs = await artifactStore.savePatchApplySandboxResult({ result: sandboxResult });
  sandboxResult.artifact_ref = refs.resultRef;
  sandboxResult.summary_ref = refs.summaryRef;
  await new FactoryMetadataAdapter(workspace).recordPatchApplySandboxResultSaved(sandboxResult);
  return sandboxResult;
}
