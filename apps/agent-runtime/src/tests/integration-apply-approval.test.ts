import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  CoreOrchestrator,
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  IntegrationApplyApprovalGate,
  OrchestrationArtifactStore,
  createDirtyWorktreeFinding,
  createIntegrationApplyApprovalDecision,
  createIntegrationApplyApprovalSummary,
  createIntegrationApplyScope,
  createPatchApplySandboxResult,
  createPatchProposalReview,
  createPostIntegrationValidationPlan,
  createRollbackRequirements,
  createSandboxValidatedIntegrationCandidate,
  defaultApplyScopeForCandidate,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type IntegrationApplyScope,
  type SandboxValidatedIntegrationCandidate
} from "../orchestration/index.js";

const execFileAsync = promisify(execFile);

test("integration apply approval models create scope dirty finding decision and summary", () => {
  const scope = createIntegrationApplyScope({
    integration_candidate_id: "candidate_model",
    allowed_files: ["src/runtime.ts"],
    forbidden_files: ["secrets.env"],
    changed_files: ["src/runtime.ts"],
    required_file_locks: ["src/runtime.ts"],
    required_module_locks: ["module:src"],
    required_semantic_locks: ["preparation:prep_model"],
    validation_requirements: ["npm test"],
    integration_manager_required: true,
    durable_locks_required: true,
    strict_validation_required: true,
    provider_write_workers_allowed: false,
    dirty_overlap_override: false
  });
  const decision = createIntegrationApplyApprovalDecision({
    decision: "approve",
    approver_type: "human",
    approver_id: "operator",
    reason: "Approved for controlled future apply.",
    approved_scope: scope
  });
  const finding = createDirtyWorktreeFinding({
    path: "src/runtime.ts",
    git_status: "M",
    overlap: true,
    known_dirty_sensitive_path: false,
    severity: "blocking",
    reason: "Overlap."
  });
  const summary = createIntegrationApplyApprovalSummary({
    run_id: "run_model",
    integration_apply_approval_used: true,
    apply_approval_count: 1,
    approved_for_apply_candidate_count: 1,
    requires_human_approval_count: 0,
    blocked_count: 0,
    rejected_count: 0,
    dirty_worktree_blocked_count: 0,
    apply_mode_recommendation_count: 1
  });
  assert.equal(scope.integration_manager_required, true);
  assert.equal(decision.approver_type, "human");
  assert.equal(finding.overlap, true);
  assert.equal(summary.approved_for_apply_candidate_count, 1);
});

test("eligible candidate records requires-human approval and human decision approves future apply candidate", async () => {
  const workspace = await fixtureWorkspace("integration-apply-approval-pass");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, { runId: "run_apply_approval_pass" });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    const gate = new IntegrationApplyApprovalGate({ workspacePath: workspace, config: config(), artifactStore });
    const needsApproval = await gate.evaluateIntegrationCandidateForApplyApproval(candidate);
    assert.equal(needsApproval.approval_status, "requires_human_approval");
    assert.equal(needsApproval.apply_mode_recommendation, "prepare_only");
    assert.equal(needsApproval.approval?.metadata_json.no_apply, true);
    const decision = createIntegrationApplyApprovalDecision({
      decision: "approve",
      approver_type: "human",
      approver_id: "operator",
      reason: "Approve exact scope for future controlled apply.",
      approved_scope: defaultApplyScopeForCandidate(candidate)
    });
    const approved = await gate.evaluateIntegrationCandidateForApplyApproval(candidate, { approvalDecision: decision });
    assert.equal(approved.approval_status, "approved_for_apply_candidate");
    assert.equal(approved.apply_mode_recommendation, "controlled_apply_requires_approval");
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing candidate failed sandbox missing rollback post validation and locks block exactly", async () => {
  const workspace = await fixtureWorkspace("integration-apply-approval-blocks");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const gate = new IntegrationApplyApprovalGate({ workspacePath: workspace, config: config(), artifactStore });
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(undefined)).approval_status, "candidate_invalid");

    const failedSandbox = await candidateFixture(workspace, { runId: "run_apply_failed_sandbox", strictStatus: "failed" });
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(failedSandbox)).approval_status, "candidate_invalid");

    const missingRollback = await candidateFixture(workspace, { runId: "run_apply_missing_rollback", omitRollbackRef: true });
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(missingRollback)).approval_status, "missing_rollback_plan");

    const missingPostValidation = await candidateFixture(workspace, { runId: "run_apply_missing_post_validation", omitPostValidationRef: true, requiredCommands: [] });
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(missingPostValidation)).approval_status, "missing_post_validation_plan");

    const missingLocks = await candidateFixture(workspace, { runId: "run_apply_missing_locks", changedFiles: ["src/runtime.ts"], requiredFileLocks: [], requiredModuleLocks: [], requiredSemanticLocks: [] });
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(missingLocks)).approval_status, "missing_locks");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("approval scope broader or weaker than candidate is rejected", async () => {
  const workspace = await fixtureWorkspace("integration-apply-approval-scope");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await candidateFixture(workspace, { runId: "run_apply_scope" });
    const gate = new IntegrationApplyApprovalGate({ workspacePath: workspace, config: config(), artifactStore });
    const broader = { ...defaultApplyScopeForCandidate(candidate), allowed_files: ["src/runtime.ts", "src/other.ts"] };
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(candidate, { approvedScope: broader })).approval_status, "rejected");
    const weakenedValidation = { ...defaultApplyScopeForCandidate(candidate), validation_requirements: [] };
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(candidate, { approvedScope: weakenedValidation })).approval_status, "rejected");
    const weakenedLocks = { ...defaultApplyScopeForCandidate(candidate), required_file_locks: [] };
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(candidate, { approvedScope: weakenedLocks })).approval_status, "rejected");
    const bypassManager = { ...defaultApplyScopeForCandidate(candidate), integration_manager_required: false };
    assert.equal((await gate.evaluateIntegrationCandidateForApplyApproval(candidate, { approvedScope: bypassManager })).approval_status, "rejected");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dirty worktree unrelated warns while overlap and known desktop path block", async () => {
  const unrelatedWorkspace = await gitWorkspace("integration-apply-approval-dirty-unrelated");
  try {
    await writeWorkspaceFile(unrelatedWorkspace, "src/runtime.ts", "main\n");
    await gitCommitAll(unrelatedWorkspace);
    await writeWorkspaceFile(unrelatedWorkspace, "src/unrelated.ts", "dirty\n");
    const unrelatedCandidate = await candidateFixture(unrelatedWorkspace, { runId: "run_apply_dirty_unrelated" });
    const unrelated = await new IntegrationApplyApprovalGate({ workspacePath: unrelatedWorkspace, config: config(), artifactStore: new OrchestrationArtifactStore(unrelatedWorkspace) })
      .evaluateIntegrationCandidateForApplyApproval(unrelatedCandidate);
    assert.equal(unrelated.approval_status, "requires_human_approval");
    assert.equal(unrelated.worktree_safety_check?.status, "dirty_unrelated");
    assert.ok(unrelated.warnings.some((warning) => warning.warning_type === "unrelated_dirty_worktree"));
  } finally {
    await rm(unrelatedWorkspace, { recursive: true, force: true });
  }

  const overlapWorkspace = await gitWorkspace("integration-apply-approval-dirty-overlap");
  try {
    await writeWorkspaceFile(overlapWorkspace, "src/runtime.ts", "main\n");
    await gitCommitAll(overlapWorkspace);
    await writeWorkspaceFile(overlapWorkspace, "src/runtime.ts", "dirty\n");
    const overlapCandidate = await candidateFixture(overlapWorkspace, { runId: "run_apply_dirty_overlap" });
    const overlap = await new IntegrationApplyApprovalGate({ workspacePath: overlapWorkspace, config: config(), artifactStore: new OrchestrationArtifactStore(overlapWorkspace) })
      .evaluateIntegrationCandidateForApplyApproval(overlapCandidate);
    assert.equal(overlap.approval_status, "dirty_worktree_blocked");
    assert.ok(overlap.blockers.some((blocker) => blocker.blocker_type === "dirty_worktree_overlap"));
  } finally {
    await rm(overlapWorkspace, { recursive: true, force: true });
  }

  const desktopWorkspace = await gitWorkspace("integration-apply-approval-dirty-desktop");
  try {
    await writeWorkspaceFile(desktopWorkspace, "apps/desktop/src/app/App.tsx", "clean\n");
    await gitCommitAll(desktopWorkspace);
    await writeWorkspaceFile(desktopWorkspace, "apps/desktop/src/app/App.tsx", "dirty\n");
    const desktopCandidate = await candidateFixture(desktopWorkspace, { runId: "run_apply_dirty_desktop", changedFiles: ["apps/desktop/src/app/App.tsx"] });
    const desktop = await new IntegrationApplyApprovalGate({ workspacePath: desktopWorkspace, config: config(), artifactStore: new OrchestrationArtifactStore(desktopWorkspace) })
      .evaluateIntegrationCandidateForApplyApproval(desktopCandidate);
    assert.equal(desktop.approval_status, "dirty_worktree_blocked");
    assert.ok(desktop.blockers.some((blocker) => blocker.blocker_type === "dirty_known_desktop_file"));
  } finally {
    await rm(desktopWorkspace, { recursive: true, force: true });
  }
});

test("batch persists metadata artifacts traces and never applies locks validations or integration results", async () => {
  const workspace = await fixtureWorkspace("integration-apply-approval-batch");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidate(workspace, artifactStore, { runId: "run_apply_batch" });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    const gate = new IntegrationApplyApprovalGate({ workspacePath: workspace, config: config(), artifactStore });
    const batch = await gate.createApplyApprovalBatch("run_apply_batch");
    assert.equal(batch.summary.apply_approval_count, 1);
    assert.equal(batch.summary.requires_human_approval_count, 1);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    assert.ok(batch.approvals[0]?.artifact_ref && existsSync(batch.approvals[0].artifact_ref));
    assert.ok(batch.approvals[0]?.summary_ref && existsSync(batch.approvals[0].summary_ref));
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), before);
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_apply_approvals")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_apply_approval_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_apply_worktree_checks")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_results")?.count, 0);
    } finally {
      store.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: candidate.run_id });
    for (const eventType of [
      "integration_apply_approval_started",
      "integration_apply_candidate_loaded",
      "integration_apply_approval_scope_checked",
      "integration_apply_worktree_checked",
      "integration_apply_locks_verified",
      "integration_apply_rollback_verified",
      "integration_apply_post_validation_verified",
      "integration_apply_approval_required",
      "integration_apply_mode_recommended",
      "integration_apply_approval_persisted",
      "integration_apply_approval_batch_completed",
      "integration_apply_approval_summary_created"
    ]) {
      assert.ok(trace.events.some((event) => event.event_type === eventType), `missing trace ${eventType}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator apply approval hook respects disabled and enabled behavior without apply", async () => {
  const workspace = await fixtureWorkspace("integration-apply-approval-orchestrator");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedCandidate(workspace, artifactStore, { runId: "run_apply_orchestrator" });
    const disabled = new CoreOrchestrator({ workspacePath: workspace, config: config({ enable_integration_apply_approval_gate: false }) });
    await (disabled as unknown as { createIntegrationApplyApprovalsIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .createIntegrationApplyApprovalsIfAllowed("run_apply_orchestrator", true);
    let store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_apply_approval_batches")?.count, 0);
    } finally {
      store.close();
    }
    const enabled = new CoreOrchestrator({ workspacePath: workspace, config: config({ enable_integration_apply_approval_gate: true }) });
    await (enabled as unknown as { createIntegrationApplyApprovalsIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .createIntegrationApplyApprovalsIfAllowed("run_apply_orchestrator", true);
    store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_apply_approval_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_results")?.count, 0);
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
    enable_integration_apply_approval_gate: true,
    integration_apply_approval_mode: "require_approval",
    enable_sandbox_integration_candidates: true,
    sandbox_integration_candidate_mode: "create_candidates",
    require_human_approval_for_main_repo_apply: true,
    block_dirty_overlap: true,
    allow_unrelated_dirty_worktree: true,
    require_clean_worktree_for_apply_approval: false,
    enable_sandbox_validation: false,
    enable_patch_apply_sandbox: false,
    enable_validation_candidate_gate: false,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    require_environment_readiness: false,
    ...overrides
  });
}

async function persistedCandidate(workspace: string, artifactStore: OrchestrationArtifactStore, options: CandidateOptions) {
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

type CandidateOptions = {
  runId: string;
  changedFiles?: string[];
  strictStatus?: "passed" | "failed" | "blocked" | "partial" | "not_run" | "skipped";
  requiredCommands?: string[];
  requiredFileLocks?: string[];
  requiredModuleLocks?: string[];
  requiredSemanticLocks?: string[];
  omitRollbackRef?: boolean;
  omitPostValidationRef?: boolean;
};

async function candidateFixture(workspace: string, options: CandidateOptions): Promise<SandboxValidatedIntegrationCandidate> {
  const changedFiles = options.changedFiles ?? ["src/runtime.ts"];
  const primaryChangedFile = path.join(workspace, changedFiles[0] ?? "src/runtime.ts");
  if (!existsSync(primaryChangedFile)) await writeWorkspaceFile(workspace, changedFiles[0] ?? "src/runtime.ts", "main\n");
  const patchRef = await writeWorkspaceFileReturn(workspace, `.agent_memory/patches/patch_${options.runId}.diff`, "diff\n");
  const sandboxApply = createPatchApplySandboxResult({
    sandbox_result_id: `sandbox_result_${options.runId}`,
    run_id: options.runId,
    validation_candidate_id: `validation_candidate_${options.runId}`,
    proposal_id: `proposal_${options.runId}`,
    review_id: `review_${options.runId}`,
    patch_artifact_ref: patchRef,
    sandbox_mode: "simulate_only",
    sandbox_artifact_ref: `sandbox_${options.runId}`,
    changed_files: changedFiles,
    dry_apply_status: "dry_apply_passed",
    conflicts: [],
    failed_hunks: [],
    unsafe_findings: []
  });
  const sandboxApplyRef = await writeJsonFile(workspace, `.agent_memory/fixtures/sandbox_apply_${options.runId}.json`, sandboxApply);
  const review = createPatchProposalReview({
    review_id: `review_${options.runId}`,
    run_id: options.runId,
    proposal_id: `proposal_${options.runId}`,
    preparation_plan_id: `preparation_${options.runId}`,
    proposed_node_id: `node_${options.runId}`,
    reviewer_role: "ReviewerAgent",
    reviewer_mode: "deterministic",
    decision: "accept_for_validation_candidate",
    status: "accepted_for_validation_candidate",
    findings: [],
    required_changes: [],
    validation_recommendations: ["Run validation after future apply."],
    integration_risks: [],
    security_risks: [],
    performance_risks: [],
    test_coverage_risks: [],
    confidence: 0.9
  });
  const reviewRef = await writeJsonFile(workspace, `.agent_memory/fixtures/review_${options.runId}.json`, review);
  const requiredCommands = options.requiredCommands ?? ["node -e \"process.exit(0)\""];
  const rollback = createRollbackRequirements({
    status: "manual_limited",
    changed_files: changedFiles,
    rollback_refs: [patchRef],
    instructions: ["Capture file snapshot before future apply."],
    limitations: ["Manual rollback only."]
  });
  const postValidation = createPostIntegrationValidationPlan({
    required_commands: requiredCommands,
    optional_commands: [],
    expected_outputs: ["Strict validation artifact."],
    sandbox_validation_id: `sandbox_validation_${options.runId}`,
    sandbox_strict_validation_status: options.strictStatus ?? "passed",
    additional_checks: ["Re-run after future apply."]
  });
  const candidate = createSandboxValidatedIntegrationCandidate({
    integration_candidate_id: `integration_candidate_${options.runId}`,
    run_id: options.runId,
    proposal_id: `proposal_${options.runId}`,
    review_id: `review_${options.runId}`,
    validation_candidate_id: `validation_candidate_${options.runId}`,
    sandbox_result_id: sandboxApply.sandbox_result_id,
    sandbox_validation_id: `sandbox_validation_${options.runId}`,
    preparation_plan_id: `preparation_${options.runId}`,
    proposed_node_id: `node_${options.runId}`,
    patch_artifact_ref: patchRef,
    patch_summary: "Patch summary.",
    changed_files: changedFiles,
    required_file_locks: options.requiredFileLocks ?? changedFiles,
    required_module_locks: options.requiredModuleLocks ?? ["module:src"],
    required_semantic_locks: options.requiredSemanticLocks ?? [`preparation:preparation_${options.runId}`],
    review_ref: reviewRef,
    sandbox_apply_ref: sandboxApplyRef,
    sandbox_validation_ref: `sandbox_validation_ref_${options.runId}`,
    strict_validation_status: options.strictStatus ?? "passed",
    rollback_requirements: rollback,
    post_integration_validation_plan: postValidation,
    risk_level: "low",
    approval_required: true,
    status: "candidate_created",
    metadata_json: {
      scope_check_status: "passed",
      dry_apply_status: "dry_apply_passed",
      main_repo_integrity_ok: true,
      forbidden_files: ["secrets.env"],
      no_apply: true
    }
  });
  if (!options.omitRollbackRef) candidate.rollback_requirements_ref = `rollback_ref_${options.runId}`;
  if (!options.omitPostValidationRef) candidate.post_integration_validation_plan_ref = `post_validation_ref_${options.runId}`;
  return candidate;
}

async function writeWorkspaceFileReturn(workspace: string, relative: string, content: string) {
  await writeWorkspaceFile(workspace, relative, content);
  return path.join(workspace, relative);
}
