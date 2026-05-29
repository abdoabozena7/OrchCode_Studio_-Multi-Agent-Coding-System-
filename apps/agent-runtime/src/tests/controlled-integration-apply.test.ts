import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ControlledIntegrationApplyManager,
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  OrchestrationArtifactStore,
  StructuredPatchControlledApplyAdapter,
  createControlledApplyBatch,
  createControlledApplyBlocker,
  createControlledApplySummary,
  createControlledIntegrationApplyResult,
  createControlledIntegrationApplyRequest,
  createIntegrationApplyApproval,
  createIntegrationApplyScope,
  createPatchProposal,
  createPatchProposalFileChange,
  createPostIntegrationValidationPlan,
  createRollbackRequirements,
  createSandboxValidatedIntegrationCandidate,
  createWorktreeSafetyCheck,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type IntegrationApplyApproval,
  type PatchProposalChangeType,
  type SandboxValidatedIntegrationCandidate
} from "../orchestration/index.js";

const execFileAsync = promisify(execFile);

test("controlled apply models create result request blocker summary and batch", () => {
  const request = createControlledIntegrationApplyRequest({
    run_id: "run_model",
    integration_candidate_id: "candidate_model",
    integration_apply_approval_id: "approval_model",
    requested_by: "test"
  });
  const blocker = createControlledApplyBlocker({
    controlled_apply_id: "controlled_model",
    run_id: "run_model",
    integration_candidate_id: "candidate_model",
    blocker_type: "approval_missing",
    severity: "blocking",
    reason: "Missing approval.",
    refs: []
  });
  const result = createControlledIntegrationApplyResult({
    controlled_apply_id: "controlled_model",
    run_id: "run_model",
    integration_candidate_id: "candidate_model",
    integration_apply_approval_id: "approval_model",
    proposal_id: "proposal_model",
    changed_files: ["src/runtime.ts"],
    acquired_lock_refs: [],
    apply_adapter: "fake",
    apply_status: "not_run",
    applied_files: [],
    failed_files: [],
    strict_validation_status: "passed",
    status: "blocked",
    blockers: [blocker]
  });
  const summary = createControlledApplySummary({
    run_id: "run_model",
    controlled_apply_used: true,
    controlled_apply_count: 1,
    applied_count: 0,
    post_validation_passed_count: 0,
    post_validation_failed_count: 0,
    rolled_back_count: 0,
    rollback_failed_count: 0,
    lock_failed_count: 0,
    blocked_count: 1
  });
  const batch = createControlledApplyBatch({ run_id: "run_model", integration_candidate_ids: ["candidate_model"], results: [result], summary });
  assert.equal(request.integration_candidate_id, "candidate_model");
  assert.equal(result.status, "blocked");
  assert.equal(batch.summary.blocked_count, 1);
});

test("eligible approved candidate applies through safe adapter, snapshots, validates, persists, traces, and releases locks", async () => {
  const workspace = await fixtureWorkspace("controlled-apply-pass");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, { runId: "run_controlled_pass" });
    const approval = await persistedApproval(workspace, artifactStore, candidate);
    const manager = new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore });
    const result = await manager.applyApprovedIntegrationCandidate(candidate, approval);
    assert.equal(result.status, "post_validation_passed");
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), "main changed\n");
    assert.ok(result.pre_apply_snapshot_ref && existsSync(result.pre_apply_snapshot_ref));
    assert.equal(result.apply_adapter, "structured_patch_controlled_apply_adapter");
    assert.equal(result.metadata_json.no_provider_writer, true);
    assert.equal(result.metadata_json.no_patch_generation, true);
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_controlled_integration_applies")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_pre_apply_snapshots")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_controlled_apply_files WHERE file_status = 'applied'")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE status = 'acquired'")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE status = 'released'")?.count, 3);
    } finally {
      store.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: candidate.run_id });
    for (const eventType of [
      "controlled_apply_started",
      "controlled_apply_eligibility_passed",
      "controlled_apply_locks_acquired",
      "controlled_apply_pre_snapshot_created",
      "controlled_apply_patch_completed",
      "controlled_apply_post_validation_completed",
      "controlled_apply_locks_released",
      "controlled_apply_result_persisted"
    ]) {
      assert.ok(trace.events.some((event) => event.event_type === eventType), `missing trace ${eventType}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing approval sandbox failure dirty overlap and missing locks block before lock acquisition or apply", async () => {
  const workspace = await gitWorkspace("controlled-apply-blocks");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    await gitCommitAll(workspace);
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const manager = new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore });

    const missingApproval = await persistedCandidate(workspace, artifactStore, { runId: "run_missing_approval" });
    assert.equal((await manager.applyApprovedIntegrationCandidate(missingApproval)).status, "blocked");

    const failedSandbox = await persistedCandidate(workspace, artifactStore, { runId: "run_failed_sandbox", strictStatus: "failed" });
    const failedApproval = await persistedApproval(workspace, artifactStore, failedSandbox);
    assert.equal((await manager.applyApprovedIntegrationCandidate(failedSandbox, failedApproval)).status, "blocked");

    const missingLocks = await persistedCandidate(workspace, artifactStore, {
      runId: "run_missing_locks",
      requiredFileLocks: [],
      requiredModuleLocks: [],
      requiredSemanticLocks: []
    });
    const missingLocksApproval = await persistedApproval(workspace, artifactStore, missingLocks);
    assert.equal((await manager.applyApprovedIntegrationCandidate(missingLocks, missingLocksApproval)).status, "blocked");

    await writeWorkspaceFile(workspace, "src/runtime.ts", "dirty\n");
    const dirty = await persistedCandidate(workspace, artifactStore, { runId: "run_dirty_overlap" });
    const dirtyApproval = await persistedApproval(workspace, artifactStore, dirty);
    assert.equal((await manager.applyApprovedIntegrationCandidate(dirty, dirtyApproval)).status, "dirty_worktree_blocked");

    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE owner_component = 'ControlledIntegrationApplyManager' AND status = 'acquired'")?.count, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("pre-existing durable lock blocks controlled apply and prevents file mutation", async () => {
  const workspace = await fixtureWorkspace("controlled-apply-lock-failed");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, { runId: "run_lock_failed" });
    const approval = await persistedApproval(workspace, artifactStore, candidate);
    const lockManager = new (await import("../orchestration/index.js")).DurableLockManager({ workspacePath: workspace, ownerComponent: "TestLockOwner" });
    await lockManager.acquireFileLock(candidate.run_id, "holder", "src/runtime.ts");
    const manager = new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore });
    const result = await manager.applyApprovedIntegrationCandidate(candidate, approval);
    assert.equal(result.status, "lock_failed");
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), "main\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("safe adapter applies structured patch and rejects forbidden traversal and delete without approval", async () => {
  const workspace = await fixtureWorkspace("controlled-adapter-rules");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const adapter = new StructuredPatchControlledApplyAdapter();
    const traversalRef = await patchArtifact(workspace, "traversal", [
      change("proposal_traversal", "../escape.ts", "modify", true)
    ], ["../escape.ts"]);
    const forbiddenRef = await patchArtifact(workspace, "forbidden", [
      change("proposal_forbidden", "secrets.env", "modify", true)
    ], ["secrets.env"]);
    const deleteRef = await patchArtifact(workspace, "delete", [
      change("proposal_delete", "src/runtime.ts", "delete", true)
    ], ["src/runtime.ts"]);
    assert.equal((await adapter.apply(adapterInput(workspace, traversalRef, ["../escape.ts"]))).status, "failed");
    assert.equal((await adapter.apply(adapterInput(workspace, forbiddenRef, ["secrets.env"], ["secrets.env"], ["secrets.env"]))).status, "failed");
    assert.equal((await adapter.apply(adapterInput(workspace, deleteRef, ["src/runtime.ts"]))).status, "failed");
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), "main\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("post-validation failure rolls back file content and records rollback result", async () => {
  const workspace = await fixtureWorkspace("controlled-apply-rollback");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, {
      runId: "run_rollback",
      validationCommands: ["node -e \"process.exit(1)\""]
    });
    const approval = await persistedApproval(workspace, artifactStore, candidate);
    const result = await new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore })
      .applyApprovedIntegrationCandidate(candidate, approval);
    assert.equal(result.status, "post_validation_failed");
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), "main\n");
    assert.ok(result.rollback_result_ref && existsSync(result.rollback_result_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_controlled_rollback_results WHERE status = 'rolled_back'")?.count, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rollback failure records critical rollback_failed status", async () => {
  const workspace = await fixtureWorkspace("controlled-rollback-failed");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, { runId: "run_rollback_failed" });
    const manager = new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore });
    const result = createControlledIntegrationApplyResult({
      controlled_apply_id: "controlled_rollback_failed",
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      integration_apply_approval_id: "approval",
      proposal_id: candidate.proposal_id,
      changed_files: candidate.changed_files,
      acquired_lock_refs: [],
      apply_adapter: "test",
      apply_status: "failed",
      applied_files: [],
      failed_files: ["src/runtime.ts"],
      strict_validation_status: "passed",
      status: "rollback_required"
    });
    const rollback = await manager.rollbackIfRequired(result, {
      snapshot_id: "snapshot_missing_content",
      controlled_apply_id: result.controlled_apply_id,
      run_id: result.run_id,
      integration_candidate_id: result.integration_candidate_id,
      changed_files: ["src/runtime.ts"],
      files: [{ path: "src/runtime.ts", exists: true, content_ref: path.join(workspace, "missing.snapshot") }],
      metadata_json: {},
      created_at: new Date().toISOString()
    });
    assert.equal(rollback.status, "rollback_failed");
    assert.ok(rollback.failed_files.includes("src/runtime.ts"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("controlled apply batch disabled enabled behavior and desktop dirty fixture remains untouched", async () => {
  const workspace = await fixtureWorkspace("controlled-apply-batch");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    await writeWorkspaceFile(workspace, "apps/desktop/src/app/App.tsx", "desktop dirty\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, { runId: "run_batch" });
    await persistedApproval(workspace, artifactStore, candidate);
    const disabled = await new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config({ enable_controlled_integration_apply: false }), artifactStore })
      .applyApprovedIntegrationBatch("run_batch");
    assert.equal(disabled.summary.controlled_apply_count, 0);
    const enabled = await new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore })
      .applyApprovedIntegrationBatch("run_batch");
    assert.equal(enabled.summary.controlled_apply_count, 1);
    assert.equal(enabled.summary.post_validation_passed_count, 1);
    assert.equal(await readFile(path.join(workspace, "apps/desktop/src/app/App.tsx"), "utf8"), "desktop dirty\n");
    assert.ok(enabled.artifact_ref && existsSync(enabled.artifact_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_controlled_apply_batches")?.count, 2);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function gitWorkspace(name: string) {
  const workspace = await fixtureWorkspace(name);
  await execFileAsync("git", ["init"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workspace, windowsHide: true });
  await writeWorkspaceFile(workspace, ".gitignore", ".agent_memory/\n");
  return workspace;
}

async function gitCommitAll(workspace: string) {
  await execFileAsync("git", ["add", "-A"], { cwd: workspace, windowsHide: true });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace, windowsHide: true });
}

async function writeWorkspaceFile(workspace: string, relative: string, content: string) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function writeJsonFile(workspace: string, relative: string, value: unknown) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    enable_controlled_integration_apply: true,
    controlled_apply_mode: "apply_with_approval",
    require_human_approval_for_controlled_apply: true,
    require_automatic_rollback: true,
    require_clean_candidate_paths: true,
    controlled_apply_validation_timeout_ms: 10_000,
    safe_commands_allowlist: ["node -e", "git diff --check"],
    enable_integration_apply_approval_gate: true,
    integration_apply_approval_mode: "require_approval",
    enable_sandbox_integration_candidates: true,
    sandbox_integration_candidate_mode: "create_candidates",
    require_environment_readiness: false,
    ...overrides
  });
}

async function persistedCandidate(workspace: string, artifactStore: OrchestrationArtifactStore, options: {
  runId: string;
  changedFiles?: string[];
  strictStatus?: "passed" | "failed" | "blocked" | "partial" | "not_run" | "skipped";
  validationCommands?: string[];
  requiredFileLocks?: string[];
  requiredModuleLocks?: string[];
  requiredSemanticLocks?: string[];
}) {
  const candidate = await candidateFixture(workspace, options);
  const refs = await artifactStore.saveSandboxIntegrationCandidate({ candidate });
  candidate.artifact_ref = refs.candidateRef;
  candidate.rollback_requirements_ref = refs.rollbackRef;
  candidate.rollback_requirements.artifact_ref = refs.rollbackRef;
  candidate.post_integration_validation_plan_ref = refs.postValidationRef;
  candidate.post_integration_validation_plan.artifact_ref = refs.postValidationRef;
  candidate.summary_ref = refs.summaryRef;
  await new FactoryMetadataAdapter(workspace).recordSandboxIntegrationCandidateSaved(candidate);
  return candidate;
}

async function persistedApproval(workspace: string, artifactStore: OrchestrationArtifactStore, candidate: SandboxValidatedIntegrationCandidate) {
  const scope = createIntegrationApplyScope({
    integration_candidate_id: candidate.integration_candidate_id,
    allowed_files: candidate.changed_files,
    forbidden_files: ["secrets.env"],
    changed_files: candidate.changed_files,
    required_file_locks: candidate.required_file_locks,
    required_module_locks: candidate.required_module_locks,
    required_semantic_locks: candidate.required_semantic_locks,
    validation_requirements: candidate.post_integration_validation_plan.required_commands,
    rollback_requirements_ref: candidate.rollback_requirements_ref,
    post_integration_validation_plan_ref: candidate.post_integration_validation_plan_ref,
    integration_manager_required: true,
    durable_locks_required: true,
    strict_validation_required: true,
    provider_write_workers_allowed: false,
    dirty_overlap_override: false
  });
  const approval = createIntegrationApplyApproval({
    integration_apply_approval_id: `integration_apply_approval_${candidate.integration_candidate_id}`,
    run_id: candidate.run_id,
    integration_candidate_id: candidate.integration_candidate_id,
    proposal_id: candidate.proposal_id,
    review_id: candidate.review_id,
    validation_candidate_id: candidate.validation_candidate_id,
    sandbox_result_id: candidate.sandbox_result_id,
    sandbox_validation_id: candidate.sandbox_validation_id,
    preparation_plan_id: candidate.preparation_plan_id,
    proposed_node_id: candidate.proposed_node_id,
    approval_required: true,
    approval_status: "approved_for_apply_candidate",
    approver_type: "human",
    approver_id: "operator",
    approval_reason: "Fixture approval for controlled apply.",
    approved_scope: scope,
    allowed_files: scope.allowed_files,
    forbidden_files: scope.forbidden_files,
    changed_files: candidate.changed_files,
    required_file_locks: candidate.required_file_locks,
    required_module_locks: candidate.required_module_locks,
    required_semantic_locks: candidate.required_semantic_locks,
    rollback_requirements_ref: candidate.rollback_requirements_ref,
    post_integration_validation_plan_ref: candidate.post_integration_validation_plan_ref,
    worktree_safety_status: "clean",
    apply_mode_recommendation: "controlled_apply_requires_approval",
    risk_level: "low"
  });
  const worktreeSafetyCheck = createWorktreeSafetyCheck({
    run_id: candidate.run_id,
    integration_candidate_id: candidate.integration_candidate_id,
    status: "clean",
    dirty_files: [],
    findings: [],
    command: "git status --short"
  });
  const refs = await artifactStore.saveIntegrationApplyApproval({
    approval,
    worktreeSafetyCheck,
    approvalScopeCheck: { approved_scope: scope, blockers: [] },
    applyModeRecommendation: { recommendation: "controlled_apply_requires_approval" }
  });
  approval.artifact_ref = refs.approvalRef;
  approval.summary_ref = refs.summaryRef;
  await new FactoryMetadataAdapter(workspace).recordIntegrationApplyApprovalSaved(approval, worktreeSafetyCheck);
  return approval;
}

async function candidateFixture(workspace: string, options: {
  runId: string;
  changedFiles?: string[];
  strictStatus?: "passed" | "failed" | "blocked" | "partial" | "not_run" | "skipped";
  validationCommands?: string[];
  requiredFileLocks?: string[];
  requiredModuleLocks?: string[];
  requiredSemanticLocks?: string[];
}): Promise<SandboxValidatedIntegrationCandidate> {
  const changedFiles = options.changedFiles ?? ["src/runtime.ts"];
  const proposalRef = await patchArtifact(workspace, options.runId, [
    change(`proposal_${options.runId}`, changedFiles[0] ?? "src/runtime.ts", "modify", true, "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@\n-main\n+main changed\n")
  ], changedFiles);
  const sandboxApplyRef = await writeJsonFile(workspace, `.agent_memory/fixtures/sandbox_apply_${options.runId}.json`, {
    sandbox_result_id: `sandbox_result_${options.runId}`,
    run_id: options.runId,
    validation_candidate_id: `validation_candidate_${options.runId}`,
    proposal_id: `proposal_${options.runId}`,
    review_id: `review_${options.runId}`,
    patch_artifact_ref: proposalRef,
    sandbox_mode: "simulate_only",
    changed_files: changedFiles,
    dry_apply_status: "dry_apply_passed",
    conflicts: [],
    failed_hunks: [],
    unsafe_findings: [],
    main_repo_modified: false,
    validation_run: false,
    integration_created: false,
    metadata_json: {},
    created_at: new Date().toISOString()
  });
  const reviewRef = await writeJsonFile(workspace, `.agent_memory/fixtures/review_${options.runId}.json`, {
    review_id: `review_${options.runId}`,
    decision: "accept_for_validation_candidate",
    findings: []
  });
  const validationCommands = options.validationCommands ?? ["node -e \"process.exit(0)\""];
  return createSandboxValidatedIntegrationCandidate({
    integration_candidate_id: `integration_candidate_${options.runId}`,
    run_id: options.runId,
    proposal_id: `proposal_${options.runId}`,
    review_id: `review_${options.runId}`,
    validation_candidate_id: `validation_candidate_${options.runId}`,
    sandbox_result_id: `sandbox_result_${options.runId}`,
    sandbox_validation_id: `sandbox_validation_${options.runId}`,
    preparation_plan_id: `preparation_${options.runId}`,
    proposed_node_id: `node_${options.runId}`,
    patch_artifact_ref: proposalRef,
    patch_summary: "Patch summary.",
    changed_files: changedFiles,
    required_file_locks: options.requiredFileLocks ?? changedFiles,
    required_module_locks: options.requiredModuleLocks ?? ["module:src"],
    required_semantic_locks: options.requiredSemanticLocks ?? [`preparation:preparation_${options.runId}`],
    review_ref: reviewRef,
    sandbox_apply_ref: sandboxApplyRef,
    sandbox_validation_ref: `sandbox_validation_ref_${options.runId}`,
    strict_validation_status: options.strictStatus ?? "passed",
    rollback_requirements: createRollbackRequirements({
      status: "automatic_available",
      changed_files: changedFiles,
      rollback_refs: [proposalRef],
      instructions: ["Restore from pre-apply snapshot."],
      limitations: []
    }),
    post_integration_validation_plan: createPostIntegrationValidationPlan({
      required_commands: validationCommands,
      optional_commands: [],
      expected_outputs: ["Strict validation artifact."],
      sandbox_validation_id: `sandbox_validation_${options.runId}`,
      sandbox_strict_validation_status: options.strictStatus ?? "passed",
      additional_checks: ["Re-run after apply."]
    }),
    risk_level: "low",
    approval_required: true,
    status: "candidate_created",
    metadata_json: {
      scope_check_status: "passed",
      dry_apply_status: "dry_apply_passed",
      main_repo_integrity_ok: true
    }
  });
}

async function patchArtifact(workspace: string, id: string, changes: ReturnType<typeof change>[], changedFiles: string[]) {
  const patchProposal = createPatchProposal({
    run_id: `run_${id}`,
    preparation_plan_id: `preparation_${id}`,
    proposal_id: `proposal_${id}`,
    summary: "Patch proposal.",
    changed_files: changedFiles,
    file_changes: changes,
    risks: [],
    assumptions: [],
    validation_recommendations: [],
    review_notes: [],
    confidence: 0.9
  });
  return writeJsonFile(workspace, `.agent_memory/patches/patch_${id}.json`, patchProposal);
}

function change(proposalId: string, file: string, changeType: PatchProposalChangeType, withinScope: boolean, diff?: string) {
  return createPatchProposalFileChange({
    proposal_id: proposalId,
    path: file,
    change_type: changeType,
    proposed_diff: diff,
    rationale: "Test change.",
    risk: "low",
    within_allowed_scope: withinScope
  });
}

function adapterInput(workspace: string, patchRef: string, changedFiles: string[], allowedFiles = changedFiles, forbiddenFiles: string[] = []) {
  return {
    controlled_apply_id: "controlled_adapter_test",
    run_id: "run_adapter_test",
    integration_candidate_id: "candidate_adapter_test",
    workspacePath: workspace,
    patch_artifact_ref: patchRef,
    changed_files: changedFiles,
    allowed_files: allowedFiles,
    forbidden_files: forbiddenFiles,
    allow_delete: false,
    allow_rename: false
  };
}
