import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  CoreOrchestrator,
  OrchestrationArtifactStore,
  PatchApplySandboxManager,
  PatchDryApplyChecker,
  createExecutionIntegrationPreview,
  createExecutionPreparationPlan,
  createExecutionReviewPolicy,
  createExecutionRollbackPreview,
  createExecutionValidationPlan,
  createOneWriterDryRunProposal,
  createPatchApplySandboxResult,
  createPatchDryApplyConflict,
  createPatchFailedHunk,
  createPatchProposal,
  createPatchProposalFileChange,
  createPatchProposalReview,
  createPatchProposalScopeCheck,
  createPatchSandboxBatch,
  createPatchSandboxSummary,
  createPatchUnsafeFinding,
  createValidationCandidate,
  createValidationCommandPreflight,
  createValidationEnvironmentReadiness,
  createWriterSlot,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type ExecutionPreparationPlan,
  type OneWriterDryRunProposal,
  type PatchProposalChangeType
} from "../orchestration/index.js";

test("patch apply sandbox models create result conflict failed hunk summary and batch", () => {
  const conflict = createPatchDryApplyConflict({
    sandbox_result_id: "sandbox_model",
    validation_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    path: "src/runtime.ts",
    conflict_type: "missing_target",
    severity: "blocking",
    message: "Missing target.",
    refs: ["src/runtime.ts"]
  });
  const failed = createPatchFailedHunk({
    sandbox_result_id: "sandbox_model",
    validation_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    path: "src/runtime.ts",
    reason: "Context missing.",
    expected_lines: ["old"]
  });
  const unsafe = createPatchUnsafeFinding({
    sandbox_result_id: "sandbox_model",
    validation_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    finding_type: "forbidden_path",
    severity: "blocking",
    message: "Forbidden.",
    refs: []
  });
  const result = createPatchApplySandboxResult({
    sandbox_result_id: "sandbox_model",
    run_id: "run_model",
    validation_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    review_id: "review_model",
    sandbox_mode: "simulate_only",
    changed_files: ["src/runtime.ts"],
    dry_apply_status: "dry_apply_failed",
    conflicts: [conflict],
    failed_hunks: [failed],
    unsafe_findings: [unsafe]
  });
  const summary = createPatchSandboxSummary({
    run_id: "run_model",
    patch_apply_sandbox_used: true,
    sandbox_result_count: 1,
    dry_apply_passed_count: 0,
    dry_apply_failed_count: 1,
    conflict_count: 1,
    failed_hunk_count: 1,
    sandbox_unavailable_count: 0,
    unsafe_patch_count: 1,
    blocked_count: 0,
    main_repo_integrity_ok: true
  });
  const batch = createPatchSandboxBatch({ run_id: "run_model", validation_candidate_ids: ["candidate_model"], results: [result], summary });
  assert.equal(result.main_repo_modified, false);
  assert.equal(result.validation_run, false);
  assert.equal(result.integration_created, false);
  assert.equal(batch.summary.conflict_count, 1);
});

test("simulate-only dry apply passes for eligible allowed structured patch and leaves main repo unchanged", async () => {
  const workspace = await fixtureWorkspace("patch-sandbox-pass");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "old\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_pass" });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    const manager = new PatchApplySandboxManager({
      workspacePath: workspace,
      config: config({ enable_patch_apply_sandbox: true }),
      artifactStore
    });
    const result = await manager.runDryApplyForValidationCandidate(candidate);
    const after = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    assert.equal(result.dry_apply_status, "dry_apply_passed");
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.failed_hunks.length, 0);
    assert.equal(after, before);
    assert.ok(result.artifact_ref && existsSync(result.artifact_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("eligibility blocks rejected missing artifact and scope-failed candidates without sandbox creation", async () => {
  const workspace = await fixtureWorkspace("patch-sandbox-eligibility");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "old\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const manager = new PatchApplySandboxManager({
      workspacePath: workspace,
      config: config({ enable_patch_apply_sandbox: true }),
      artifactStore
    });
    const rejected = await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_rejected", candidateStatus: "rejected" });
    assert.equal((await manager.runDryApplyForValidationCandidate(rejected)).dry_apply_status, "blocked");
    const missingArtifact = await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_missing_artifact" });
    missingArtifact.patch_artifact_ref = path.join(workspace, "missing_patch.json");
    assert.equal((await manager.runDryApplyForValidationCandidate(missingArtifact)).dry_apply_status, "blocked");
    const scopeFailed = await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_scope_failed", scopeStatus: "failed" });
    assert.equal((await manager.runDryApplyForValidationCandidate(scopeFailed)).dry_apply_status, "blocked");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dry apply records missing target forbidden out-of-scope traversal delete and create-existing conflicts", async () => {
  const workspace = await fixtureWorkspace("patch-sandbox-conflicts");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "old\n");
    await writeWorkspaceFile(workspace, "src/existing.ts", "already\n");
    const checker = new PatchDryApplyChecker();
    const proposal = proposalFixture("proposal_conflicts", "run_conflicts", [
      change("proposal_conflicts", "src/missing.ts", "modify", true),
      change("proposal_conflicts", "secrets.env", "modify", true),
      change("proposal_conflicts", "src/out.ts", "modify", false),
      change("proposal_conflicts", "../escape.ts", "modify", true),
      change("proposal_conflicts", "src/runtime.ts", "delete", true),
      change("proposal_conflicts", "src/existing.ts", "create", true)
    ], ["src/runtime.ts", "src/existing.ts", "src/missing.ts", "secrets.env", "src/out.ts", "../escape.ts"]);
    const result = checker.check({
      workspacePath: workspace,
      sandboxRoot: workspace,
      resultId: "sandbox_conflicts",
      validationCandidateId: "candidate_conflicts",
      proposal,
      allowedFiles: ["src/runtime.ts", "src/existing.ts", "src/missing.ts", "../escape.ts"],
      forbiddenFiles: ["secrets.env"]
    });
    assert.ok(result.conflicts.some((entry) => entry.conflict_type === "missing_target"));
    assert.ok(result.conflicts.some((entry) => entry.conflict_type === "forbidden_path"));
    assert.ok(result.conflicts.some((entry) => entry.conflict_type === "out_of_scope"));
    assert.ok(result.conflicts.some((entry) => entry.conflict_type === "path_traversal"));
    assert.ok(result.conflicts.some((entry) => entry.conflict_type === "delete_without_approval"));
    assert.ok(result.conflicts.some((entry) => entry.conflict_type === "target_exists"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sandbox unavailable is recorded for unsafe temp sandbox root", async () => {
  const workspace = await fixtureWorkspace("patch-sandbox-unavailable");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "old\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const candidate = await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_unavailable" });
    const manager = new PatchApplySandboxManager({
      workspacePath: workspace,
      config: config({
        enable_patch_apply_sandbox: true,
        patch_apply_sandbox_mode: "temp_copy",
        sandbox_root: path.join(workspace, ".agent_memory", "unsafe_sandbox")
      }),
      artifactStore
    });
    const result = await manager.runDryApplyForValidationCandidate(candidate);
    assert.equal(result.dry_apply_status, "sandbox_unavailable");
    assert.equal(result.main_repo_modified, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sandbox batch persists metadata artifacts and trace events without validation rows or integration", async () => {
  const workspace = await fixtureWorkspace("patch-sandbox-persist");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "old\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_batch" });
    const manager = new PatchApplySandboxManager({
      workspacePath: workspace,
      config: config({ enable_patch_apply_sandbox: true }),
      artifactStore
    });
    const batch = await manager.runDryApplyBatch("run_patch_sandbox_batch");
    assert.equal(batch.summary.sandbox_result_count, 1);
    assert.equal(batch.summary.dry_apply_passed_count, 1);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_patch_apply_sandbox_results")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_patch_apply_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
    } finally {
      store.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_patch_sandbox_batch" });
    assert.ok(trace.events.some((event) => event.event_type === "patch_apply_sandbox_started"));
    assert.ok(trace.events.some((event) => event.event_type === "patch_dry_apply_passed"));
    assert.ok(trace.events.some((event) => event.event_type === "patch_apply_main_repo_integrity_checked"));
    assert.ok(trace.events.some((event) => event.event_type === "patch_apply_sandbox_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator sandbox hook respects disabled and enabled config without validation commands or main repo patching", async () => {
  const workspace = await fixtureWorkspace("patch-sandbox-orchestrator-hook");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "old\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedCandidateFixture(workspace, artifactStore, { runId: "run_patch_sandbox_orchestrator" });
    const disabled = new CoreOrchestrator({
      workspacePath: workspace,
      config: config({ enable_patch_apply_sandbox: false })
    });
    await (disabled as unknown as { createPatchApplySandboxIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .createPatchApplySandboxIfAllowed("run_patch_sandbox_orchestrator", true);
    let store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_patch_apply_batches")?.count, 0);
    } finally {
      store.close();
    }
    const enabled = new CoreOrchestrator({
      workspacePath: workspace,
      config: config({ enable_patch_apply_sandbox: true })
    });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    await (enabled as unknown as { createPatchApplySandboxIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .createPatchApplySandboxIfAllowed("run_patch_sandbox_orchestrator", true);
    const after = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_patch_apply_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
    } finally {
      store.close();
    }
    assert.equal(after, before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
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
    patch_apply_sandbox_mode: "simulate_only",
    verify_main_repo_unmodified: true,
    enable_validation_candidate_gate: false,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    require_environment_readiness: false,
    safe_commands_allowlist: ["npm test"],
    ...overrides
  });
}

async function persistedCandidateFixture(workspace: string, artifactStore: OrchestrationArtifactStore, options: {
  runId: string;
  candidateStatus?: "preflight_passed" | "rejected";
  scopeStatus?: "passed" | "failed";
}) {
  const prep = await persistedPreparation(workspace, options.runId);
  const proposal = await persistedProposal(workspace, artifactStore, prep, options.scopeStatus ?? "passed");
  const review = createPatchProposalReview({
    review_id: `review_${options.runId}`,
    run_id: options.runId,
    proposal_id: proposal.proposal_id,
    preparation_plan_id: prep.preparation_plan_id,
    proposed_node_id: prep.proposed_node_id,
    reviewer_role: "ReviewerAgent",
    reviewer_mode: "deterministic",
    decision: "accept_for_validation_candidate",
    status: "accepted_for_validation_candidate",
    findings: [],
    required_changes: [],
    validation_recommendations: ["Run prepared validation later."],
    integration_risks: [],
    security_risks: [],
    performance_risks: [],
    test_coverage_risks: [],
    confidence: 0.9
  });
  const reviewRefs = await artifactStore.savePatchProposalReviewArtifacts({ review });
  review.review_artifact_ref = reviewRefs.reviewResultRef;
  await new FactoryMetadataAdapter(workspace).recordPatchProposalReviewSaved(review);
  const command = createValidationCommandPreflight({
    validation_candidate_id: `candidate_${options.runId}`,
    command: "npm test",
    required: true,
    purpose: "Run later.",
    expected_output: "Strict validation artifact.",
    fallback_behavior: "Record not_run.",
    safety_status: "safe",
    risk: "safe",
    allowlisted: true,
    inventory_present: true,
    inventory_match: true,
    future_semantics_status: "not_run"
  });
  const candidate = createValidationCandidate({
    validation_candidate_id: `candidate_${options.runId}`,
    run_id: options.runId,
    proposal_id: proposal.proposal_id,
    review_id: review.review_id,
    preparation_plan_id: prep.preparation_plan_id,
    proposed_node_id: prep.proposed_node_id,
    patch_artifact_ref: proposal.patch_artifact_ref,
    review_artifact_ref: review.review_artifact_ref,
    validation_plan_ref: proposal.validation_plan_ref,
    required_commands: ["npm test"],
    optional_commands: [],
    command_safety_results: [command],
    environment_readiness: createValidationEnvironmentReadiness({
      validation_candidate_id: `candidate_${options.runId}`,
      status: "ready",
      workspace_path_known: true,
      command_inventory_available: true,
      validation_runner_available: true,
      required_artifacts_exist: true,
      patch_apply_strategy: "prepare_only",
      findings: []
    }),
    expected_validation_outputs: ["Strict validation artifact."],
    strict_validation_semantics_ref: "ValidationSemantics.aggregateValidationStatus:v1",
    status: options.candidateStatus ?? "preflight_passed"
  });
  const candidateRefs = await artifactStore.saveValidationCandidateArtifacts({ candidate });
  candidate.artifact_ref = candidateRefs.candidateRef;
  candidate.command_preflight_ref = candidateRefs.commandPreflightRef;
  candidate.environment_preflight_ref = candidateRefs.environmentPreflightRef;
  await new FactoryMetadataAdapter(workspace).recordValidationCandidateSaved(candidate);
  return candidate;
}

async function persistedPreparation(workspace: string, runId: string): Promise<ExecutionPreparationPlan> {
  const prep = createExecutionPreparationPlan({
    run_id: runId,
    queue_item_id: `queue_${runId}`,
    promotion_request_id: `promotion_${runId}`,
    approval_id: `approval_${runId}`,
    proposed_node_id: `node_${runId}`,
    status: "prepared",
    intended_writer_slot: createWriterSlot({
      run_id: runId,
      queue_item_id: `queue_${runId}`,
      proposed_node_id: `node_${runId}`,
      writer_role: "ExecutorAgent",
      write_capable: true
    }),
    writer_role: "ExecutorAgent",
    task_type: "implementation",
    read_or_write_classification: "write_candidate",
    objective: "Prepare sandbox dry apply",
    allowed_files: ["src/runtime.ts"],
    forbidden_files: ["secrets.env"],
    read_only_files: [],
    required_file_locks: ["src/runtime.ts"],
    required_module_locks: [],
    required_semantic_locks: [],
    context_freshness_summary: { status: "fresh" },
    prompt_id: `prompt_${runId}`,
    prompt_template_ref: `prompt_template_${runId}`,
    prompt_quality_result_ref: `prompt_quality_${runId}`,
    validation_plan: createExecutionValidationPlan({
      status: "planned",
      required_commands: ["npm test"],
      required_checks: ["strict_validation_semantics"],
      command_inventory_refs: [],
      strict_validation_required: true
    }),
    review_policy: createExecutionReviewPolicy({
      status: "planned",
      required_reviews: ["basic"],
      specialist_reviews: [],
      validation_review_required: true,
      integration_review_required: true
    }),
    integration_preview: createExecutionIntegrationPreview({
      status: "available",
      integration_manager_required: true,
      expected_candidate_requirements: [],
      required_post_integration_validation: ["npm test"],
      changed_files_preview: ["src/runtime.ts"],
      limitations: []
    }),
    rollback_preview: createExecutionRollbackPreview({
      status: "manual_limited",
      rollback_available: false,
      limitations: ["No patch applied."],
      refs: []
    }),
    risk_level: "low"
  });
  const refs = await new OrchestrationArtifactStore(workspace).saveExecutionPreparationPlan(prep);
  prep.artifact_ref = refs.planRef;
  prep.validation_plan_ref = refs.validationPlanRef;
  prep.review_policy_ref = refs.reviewPolicyRef;
  prep.integration_preview_ref = refs.integrationPreviewRef;
  await new FactoryMetadataAdapter(workspace).recordExecutionPreparationPlanSaved(prep);
  return prep;
}

async function persistedProposal(workspace: string, artifactStore: OrchestrationArtifactStore, prep: ExecutionPreparationPlan, scopeStatus: "passed" | "failed") {
  const proposal = proposalFixture(`proposal_${prep.run_id}`, prep.run_id, [
    change(`proposal_${prep.run_id}`, "src/runtime.ts", "modify", true, "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@\n-old\n+new\n")
  ], ["src/runtime.ts"]);
  proposal.preparation_plan_id = prep.preparation_plan_id;
  proposal.queue_item_id = prep.queue_item_id;
  proposal.promotion_request_id = prep.promotion_request_id;
  proposal.approval_id = prep.approval_id;
  proposal.proposed_node_id = prep.proposed_node_id;
  proposal.validation_plan_ref = prep.validation_plan_ref;
  proposal.review_policy_ref = prep.review_policy_ref;
  proposal.integration_preview_ref = prep.integration_preview_ref;
  const scope = createPatchProposalScopeCheck({
    proposal_id: proposal.proposal_id,
    status: scopeStatus,
    review_candidate_allowed: scopeStatus === "passed",
    changed_files: ["src/runtime.ts"],
    allowed_files: ["src/runtime.ts"],
    forbidden_files: ["secrets.env"],
    forbidden_file_violations: [],
    out_of_scope_changes: scopeStatus === "passed" ? [] : ["src/runtime.ts"],
    findings: []
  });
  proposal.scope_check_result = scope;
  const refs = await artifactStore.saveOneWriterDryRunProposalArtifacts({ proposal, patchProposal: proposal.patch_proposal, scopeCheck: scope });
  proposal.patch_artifact_ref = refs.patchProposalRef;
  proposal.artifact_ref = refs.artifactRef;
  await new FactoryMetadataAdapter(workspace).recordOneWriterDryRunProposalSaved(proposal);
  return proposal;
}

function proposalFixture(proposalId: string, runId: string, changes: ReturnType<typeof change>[], changedFiles: string[]): OneWriterDryRunProposal {
  const patchProposal = createPatchProposal({
    run_id: runId,
    preparation_plan_id: `prep_${runId}`,
    proposal_id: proposalId,
    summary: "Patch proposal.",
    changed_files: changedFiles,
    file_changes: changes,
    risks: [],
    assumptions: [],
    validation_recommendations: [],
    review_notes: [],
    confidence: 0.9
  });
  return createOneWriterDryRunProposal({
    proposal_id: proposalId,
    run_id: runId,
    preparation_plan_id: `prep_${runId}`,
    queue_item_id: `queue_${runId}`,
    promotion_request_id: `promotion_${runId}`,
    approval_id: `approval_${runId}`,
    proposed_node_id: `node_${runId}`,
    writer_role: "ExecutorAgent",
    provider_mode: "fake_provider",
    patch_summary: "Patch proposal.",
    changed_files: changedFiles,
    allowed_files: ["src/runtime.ts", "src/existing.ts", "src/missing.ts"],
    forbidden_files: ["secrets.env"],
    forbidden_file_violations: [],
    out_of_scope_changes: [],
    required_locks_preview: ["src/runtime.ts"],
    risk_level: "low",
    status: "accepted_for_review_candidate",
    patch_proposal: patchProposal
  });
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
