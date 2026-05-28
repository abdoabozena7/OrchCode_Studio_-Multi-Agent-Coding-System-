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
  SandboxIntegrationCandidateGate,
  createExecutionIntegrationPreview,
  createExecutionPreparationPlan,
  createExecutionReviewPolicy,
  createExecutionRollbackPreview,
  createExecutionValidationPlan,
  createIntegrationCandidateBlocker,
  createIntegrationCandidateSummary,
  createOneWriterDryRunProposal,
  createPatchApplySandboxResult,
  createPatchProposal,
  createPatchProposalFileChange,
  createPatchProposalReview,
  createPatchProposalScopeCheck,
  createPostIntegrationValidationPlan,
  createRollbackRequirements,
  createSandboxValidatedIntegrationCandidate,
  createSandboxValidationCommandResult,
  createSandboxValidationResult,
  createValidationCandidate,
  createValidationCommandPreflight,
  createValidationEnvironmentReadiness,
  createWriterSlot,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type ExecutionPreparationPlan,
  type OneWriterDryRunProposal,
  type OverallValidationStatus,
  type PatchApplySandboxResult,
  type PatchProposalReview,
  type ValidationCandidate
} from "../orchestration/index.js";

test("sandbox integration candidate models create candidate blocker rollback plan and summary", () => {
  const blocker = createIntegrationCandidateBlocker({
    integration_candidate_id: "integration_candidate_model",
    run_id: "run_model",
    blocker_type: "missing_review",
    severity: "blocking",
    reason: "Review missing.",
    refs: ["review_model"]
  });
  const rollback = createRollbackRequirements({
    status: "manual_limited",
    changed_files: ["src/runtime.ts"],
    rollback_refs: ["patch.json"],
    instructions: ["Capture snapshot before future apply."],
    limitations: ["Automatic rollback not claimed."]
  });
  const postValidation = createPostIntegrationValidationPlan({
    required_commands: ["npm test"],
    optional_commands: [],
    expected_outputs: ["test log"],
    sandbox_validation_id: "sandbox_validation_model",
    sandbox_strict_validation_status: "passed",
    additional_checks: ["Re-run after future apply."]
  });
  const candidate = createSandboxValidatedIntegrationCandidate({
    integration_candidate_id: "integration_candidate_model",
    run_id: "run_model",
    proposal_id: "proposal_model",
    review_id: "review_model",
    validation_candidate_id: "candidate_model",
    sandbox_result_id: "sandbox_model",
    sandbox_validation_id: "sandbox_validation_model",
    preparation_plan_id: "prep_model",
    proposed_node_id: "node_model",
    patch_summary: "Patch summary.",
    changed_files: ["src/runtime.ts"],
    required_file_locks: ["src/runtime.ts"],
    required_module_locks: ["module:src/runtime.ts"],
    required_semantic_locks: ["preparation:prep_model"],
    strict_validation_status: "passed",
    rollback_requirements: rollback,
    post_integration_validation_plan: postValidation,
    risk_level: "low",
    approval_required: true,
    status: "candidate_created",
    blockers: [blocker]
  });
  const summary = createIntegrationCandidateSummary({
    run_id: "run_model",
    sandbox_integration_candidate_used: true,
    integration_candidate_count: 1,
    candidate_created_count: 1,
    blocked_count: 0,
    rejected_count: 0,
    validation_failed_count: 0,
    validation_blocked_count: 0
  });
  assert.equal(candidate.status, "candidate_created");
  assert.equal(candidate.post_integration_validation_plan.commands_run, false);
  assert.equal(summary.candidate_created_count, 1);
});

test("passed sandbox validation creates metadata-only integration candidate", async () => {
  const workspace = await fixtureWorkspace("sandbox-integration-candidate-pass");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const { sandboxValidation } = await persistedPassedFixture(workspace, artifactStore, { runId: "run_sandbox_integration_pass" });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    const gate = new SandboxIntegrationCandidateGate({
      workspacePath: workspace,
      config: config({ sandbox_integration_candidate_mode: "create_candidates" }),
      artifactStore
    });
    const result = await gate.createCandidateFromSandboxValidation(sandboxValidation);
    const after = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    assert.equal(result.status, "candidate_created");
    assert.equal(result.candidate?.status, "candidate_created");
    assert.equal(result.candidate?.strict_validation_status, "passed");
    assert.deepEqual(result.candidate?.required_file_locks, ["src/runtime.ts"]);
    assert.equal(result.candidate?.post_integration_validation_plan.commands_run, false);
    assert.equal(result.candidate?.rollback_requirements.status, "manual_limited");
    assert.equal(after, before);
    assert.ok(result.candidate?.artifact_ref && existsSync(result.candidate.artifact_ref));
    assert.ok(result.candidate?.rollback_requirements_ref && existsSync(result.candidate.rollback_requirements_ref));
    assert.ok(result.candidate?.post_integration_validation_plan_ref && existsSync(result.candidate.post_integration_validation_plan_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_integration_candidates")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("failed blocked partial not_run validation and dry apply failure block candidacy", async () => {
  const workspace = await fixtureWorkspace("sandbox-integration-candidate-blocks");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const gate = new SandboxIntegrationCandidateGate({
      workspacePath: workspace,
      config: config({ sandbox_integration_candidate_mode: "create_candidates" }),
      artifactStore
    });
    for (const strictStatus of ["failed", "blocked", "partial", "not_run"] as OverallValidationStatus[]) {
      const { sandboxValidation } = await persistedPassedFixture(workspace, artifactStore, {
        runId: `run_sandbox_integration_${strictStatus}`,
        sandboxValidationStatus: strictStatus === "failed" ? "failed" : "blocked",
        strictStatus
      });
      const result = await gate.createCandidateFromSandboxValidation(sandboxValidation);
      assert.notEqual(result.status, "candidate_created");
      assert.ok(result.blockers.length > 0);
    }
    const { sandboxValidation: dryFailed } = await persistedPassedFixture(workspace, artifactStore, {
      runId: "run_sandbox_integration_dry_failed",
      dryApplyStatus: "dry_apply_failed"
    });
    const dryFailedResult = await gate.createCandidateFromSandboxValidation(dryFailed);
    assert.equal(dryFailedResult.status, "dry_apply_failed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("missing review missing patch artifact scope failure and missing locks are explicit blockers", async () => {
  const workspace = await fixtureWorkspace("sandbox-integration-candidate-input-blocks");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const gate = new SandboxIntegrationCandidateGate({
      workspacePath: workspace,
      config: config({ sandbox_integration_candidate_mode: "create_candidates" }),
      artifactStore
    });
    const missingReview = await persistedPassedFixture(workspace, artifactStore, {
      runId: "run_sandbox_integration_missing_review",
      review: "missing"
    });
    assert.equal((await gate.createCandidateFromSandboxValidation(missingReview.sandboxValidation)).status, "missing_review");
    const missingPatch = await persistedPassedFixture(workspace, artifactStore, {
      runId: "run_sandbox_integration_missing_patch",
      patchArtifact: "missing"
    });
    assert.equal((await gate.createCandidateFromSandboxValidation(missingPatch.sandboxValidation)).status, "blocked");
    const scopeFailed = await persistedPassedFixture(workspace, artifactStore, {
      runId: "run_sandbox_integration_scope_failed",
      scopeStatus: "failed"
    });
    assert.equal((await gate.createCandidateFromSandboxValidation(scopeFailed.sandboxValidation)).status, "scope_failed");
    const missingLocks = await persistedPassedFixture(workspace, artifactStore, {
      runId: "run_sandbox_integration_missing_locks",
      changedFiles: []
    });
    assert.equal((await gate.createCandidateFromSandboxValidation(missingLocks.sandboxValidation)).status, "blocked");
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal((store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_integration_candidate_blockers")?.count ?? 0) > 0, true);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("batch writes artifacts metadata trace and does not use IntegrationManager apply table", async () => {
  const workspace = await fixtureWorkspace("sandbox-integration-candidate-batch");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedPassedFixture(workspace, artifactStore, { runId: "run_sandbox_integration_batch" });
    const gate = new SandboxIntegrationCandidateGate({
      workspacePath: workspace,
      config: config({ sandbox_integration_candidate_mode: "create_candidates" }),
      artifactStore
    });
    const batch = await gate.createCandidateBatch("run_sandbox_integration_batch");
    assert.equal(batch.summary.integration_candidate_count, 1);
    assert.equal(batch.summary.candidate_created_count, 1);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_integration_candidate_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_integration_candidates WHERE status = 'candidate_created'")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_results")?.count, 0);
    } finally {
      store.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_sandbox_integration_batch" });
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_integration_candidate_created"));
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_integration_candidate_locks_derived"));
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_integration_candidate_persisted"));
    assert.ok(trace.events.some((event) => event.event_type === "sandbox_integration_candidate_summary_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator candidate hook respects disabled and enabled behavior without apply or validation commands", async () => {
  const workspace = await fixtureWorkspace("sandbox-integration-candidate-orchestrator");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await persistedPassedFixture(workspace, artifactStore, { runId: "run_sandbox_integration_orchestrator" });
    const disabled = new CoreOrchestrator({
      workspacePath: workspace,
      config: config({ enable_sandbox_integration_candidates: false })
    });
    await (disabled as unknown as { createSandboxIntegrationCandidatesIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .createSandboxIntegrationCandidatesIfAllowed("run_sandbox_integration_orchestrator", true);
    let store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_integration_candidate_batches")?.count, 0);
    } finally {
      store.close();
    }
    const enabled = new CoreOrchestrator({
      workspacePath: workspace,
      config: config({ sandbox_integration_candidate_mode: "create_candidates" })
    });
    const before = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    await (enabled as unknown as { createSandboxIntegrationCandidatesIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .createSandboxIntegrationCandidatesIfAllowed("run_sandbox_integration_orchestrator", true);
    const after = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    assert.equal(after, before);
    store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_sandbox_integration_candidate_batches")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks")?.count, 0);
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

async function writeWorkspaceFile(workspace: string, relative: string, content: string) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    enable_sandbox_integration_candidates: true,
    sandbox_integration_candidate_mode: "report_only",
    require_passed_sandbox_validation: true,
    require_post_integration_validation_plan: true,
    require_rollback_plan: true,
    enable_sandbox_validation: false,
    enable_patch_apply_sandbox: false,
    enable_validation_candidate_gate: false,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    require_environment_readiness: false,
    ...overrides
  });
}

async function persistedPassedFixture(workspace: string, artifactStore: OrchestrationArtifactStore, options: {
  runId: string;
  strictStatus?: OverallValidationStatus;
  sandboxValidationStatus?: "passed" | "failed" | "blocked" | "partial" | "not_run";
  dryApplyStatus?: PatchApplySandboxResult["dry_apply_status"];
  scopeStatus?: "passed" | "failed";
  review?: "present" | "missing";
  patchArtifact?: "present" | "missing";
  changedFiles?: string[];
}) {
  const changedFiles = options.changedFiles ?? ["src/runtime.ts"];
  if (changedFiles.length) await writeWorkspaceFile(workspace, changedFiles[0] ?? "src/runtime.ts", "main\n");
  const prep = await persistedPreparation(workspace, options.runId, changedFiles);
  const proposal = await persistedProposal(workspace, artifactStore, prep, options.scopeStatus ?? "passed", changedFiles);
  const review = await persistedReview(workspace, artifactStore, proposal, prep, options.review ?? "present");
  const candidate = await persistedCandidate(workspace, artifactStore, prep, proposal, review, options.patchArtifact ?? "present");
  const sandboxApply = await persistedSandboxApply(workspace, artifactStore, candidate, changedFiles, options.dryApplyStatus ?? "dry_apply_passed");
  const command = createSandboxValidationCommandResult({
    sandbox_validation_id: `sandbox_validation_${options.runId}`,
    run_id: options.runId,
    sandbox_result_id: sandboxApply.sandbox_result_id,
    validation_candidate_id: candidate.validation_candidate_id,
    command: "node -e \"process.exit(0)\"",
    cwd: path.join(workspace, "sandbox"),
    required: true,
    status: options.strictStatus === "passed" || !options.strictStatus ? "passed" : "failed",
    started_at: "2026-05-28T00:00:00.000Z",
    finished_at: "2026-05-28T00:00:00.001Z",
    duration_ms: 1,
    summary: "fixture command result"
  });
  const strictStatus = options.strictStatus ?? "passed";
  const sandboxValidation = createSandboxValidationResult({
    sandbox_validation_id: `sandbox_validation_${options.runId}`,
    run_id: options.runId,
    sandbox_result_id: sandboxApply.sandbox_result_id,
    validation_candidate_id: candidate.validation_candidate_id,
    proposal_id: proposal.proposal_id,
    review_id: review.review_id,
    patch_artifact_ref: candidate.patch_artifact_ref,
    sandbox_ref: sandboxApply.sandbox_path_ref,
    commands: candidate.required_commands,
    command_results: [command],
    strict_validation_status: strictStatus,
    status: options.sandboxValidationStatus ?? (strictStatus === "passed" ? "passed" : "failed"),
    required_command_count: 1,
    optional_command_count: 0,
    passed_count: strictStatus === "passed" ? 1 : 0,
    failed_count: strictStatus === "passed" ? 0 : 1,
    blocked_count: strictStatus === "blocked" ? 1 : 0,
    skipped_count: strictStatus === "skipped" ? 1 : 0,
    timed_out_count: 0,
    not_run_count: strictStatus === "not_run" ? 1 : 0,
    findings: []
  });
  const validationRefs = await artifactStore.saveSandboxValidationResult({ result: sandboxValidation });
  sandboxValidation.artifact_ref = validationRefs.resultRef;
  sandboxValidation.summary_ref = validationRefs.summaryRef;
  sandboxValidation.logs_ref = validationRefs.logsDir;
  await new FactoryMetadataAdapter(workspace).recordSandboxValidationResultSaved(sandboxValidation);
  return { prep, proposal, review, candidate, sandboxApply, sandboxValidation };
}

async function persistedPreparation(workspace: string, runId: string, changedFiles: string[]): Promise<ExecutionPreparationPlan> {
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
    objective: "Prepare sandbox integration candidate",
    allowed_files: changedFiles,
    forbidden_files: ["secrets.env"],
    read_only_files: [],
    required_file_locks: changedFiles,
    required_module_locks: [],
    required_semantic_locks: [],
    context_freshness_summary: { status: "fresh" },
    prompt_id: `prompt_${runId}`,
    prompt_template_ref: `prompt_template_${runId}`,
    prompt_quality_result_ref: `prompt_quality_${runId}`,
    validation_plan: createExecutionValidationPlan({
      status: "planned",
      required_commands: ["node -e \"process.exit(0)\""],
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
      required_post_integration_validation: ["node -e \"process.exit(0)\""],
      changed_files_preview: changedFiles,
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

async function persistedProposal(
  workspace: string,
  artifactStore: OrchestrationArtifactStore,
  prep: ExecutionPreparationPlan,
  scopeStatus: "passed" | "failed",
  changedFiles: string[]
) {
  const proposal = proposalFixture(`proposal_${prep.run_id}`, prep.run_id, changedFiles);
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
    changed_files: changedFiles,
    allowed_files: changedFiles,
    forbidden_files: ["secrets.env"],
    forbidden_file_violations: [],
    out_of_scope_changes: scopeStatus === "passed" ? [] : changedFiles,
    findings: []
  });
  proposal.scope_check_result = scope;
  const refs = await artifactStore.saveOneWriterDryRunProposalArtifacts({ proposal, patchProposal: proposal.patch_proposal, scopeCheck: scope });
  proposal.patch_artifact_ref = refs.patchProposalRef;
  proposal.artifact_ref = refs.artifactRef;
  await new FactoryMetadataAdapter(workspace).recordOneWriterDryRunProposalSaved(proposal);
  return proposal;
}

function proposalFixture(proposalId: string, runId: string, changedFiles: string[]): OneWriterDryRunProposal {
  const fileChanges = changedFiles.map((file) => createPatchProposalFileChange({
    proposal_id: proposalId,
    path: file,
    change_type: "modify",
    proposed_diff: "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@\n-main\n+main changed\n",
    rationale: "Test change.",
    risk: "low",
    within_allowed_scope: true
  }));
  const patchProposal = createPatchProposal({
    run_id: runId,
    preparation_plan_id: `prep_${runId}`,
    proposal_id: proposalId,
    summary: "Patch proposal.",
    changed_files: changedFiles,
    file_changes: fileChanges,
    risks: [],
    assumptions: [],
    validation_recommendations: ["node -e \"process.exit(0)\""],
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
    allowed_files: changedFiles,
    forbidden_files: ["secrets.env"],
    forbidden_file_violations: [],
    out_of_scope_changes: [],
    required_locks_preview: changedFiles,
    risk_level: "low",
    status: "accepted_for_review_candidate",
    patch_proposal: patchProposal
  });
}

async function persistedReview(
  workspace: string,
  artifactStore: OrchestrationArtifactStore,
  proposal: OneWriterDryRunProposal,
  prep: ExecutionPreparationPlan,
  presence: "present" | "missing"
): Promise<PatchProposalReview> {
  const review = createPatchProposalReview({
    review_id: `review_${prep.run_id}`,
    run_id: prep.run_id,
    proposal_id: proposal.proposal_id,
    preparation_plan_id: prep.preparation_plan_id,
    proposed_node_id: prep.proposed_node_id,
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
  const refs = await artifactStore.savePatchProposalReviewArtifacts({ review });
  review.review_artifact_ref = presence === "present" ? refs.reviewResultRef : path.join(workspace, "missing-review.json");
  if (presence === "present") await new FactoryMetadataAdapter(workspace).recordPatchProposalReviewSaved(review);
  return review;
}

async function persistedCandidate(
  workspace: string,
  artifactStore: OrchestrationArtifactStore,
  prep: ExecutionPreparationPlan,
  proposal: OneWriterDryRunProposal,
  review: PatchProposalReview,
  patchArtifact: "present" | "missing"
): Promise<ValidationCandidate> {
  const candidateId = `candidate_${prep.run_id}`;
  const command = createValidationCommandPreflight({
    validation_candidate_id: candidateId,
    command: "node -e \"process.exit(0)\"",
    required: true,
    purpose: "Post-integration validation plan.",
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
    validation_candidate_id: candidateId,
    run_id: prep.run_id,
    proposal_id: proposal.proposal_id,
    review_id: review.review_id,
    preparation_plan_id: prep.preparation_plan_id,
    proposed_node_id: prep.proposed_node_id,
    patch_artifact_ref: patchArtifact === "present" ? proposal.patch_artifact_ref : path.join(workspace, "missing-patch.json"),
    review_artifact_ref: review.review_artifact_ref,
    validation_plan_ref: proposal.validation_plan_ref,
    required_commands: ["node -e \"process.exit(0)\""],
    optional_commands: [],
    command_safety_results: [command],
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
    expected_validation_outputs: ["Strict validation artifact."],
    strict_validation_semantics_ref: "ValidationSemantics.aggregateValidationStatus:v1",
    status: "preflight_passed"
  });
  const refs = await artifactStore.saveValidationCandidateArtifacts({ candidate });
  candidate.artifact_ref = refs.candidateRef;
  candidate.command_preflight_ref = refs.commandPreflightRef;
  candidate.environment_preflight_ref = refs.environmentPreflightRef;
  await new FactoryMetadataAdapter(workspace).recordValidationCandidateSaved(candidate);
  return candidate;
}

async function persistedSandboxApply(
  workspace: string,
  artifactStore: OrchestrationArtifactStore,
  candidate: ValidationCandidate,
  changedFiles: string[],
  dryApplyStatus: PatchApplySandboxResult["dry_apply_status"]
) {
  const sandboxResult = createPatchApplySandboxResult({
    sandbox_result_id: `sandbox_result_${candidate.run_id}`,
    run_id: candidate.run_id,
    validation_candidate_id: candidate.validation_candidate_id,
    proposal_id: candidate.proposal_id,
    review_id: candidate.review_id,
    patch_artifact_ref: candidate.patch_artifact_ref,
    sandbox_mode: "simulate_only",
    sandbox_artifact_ref: `sandbox_ref_${candidate.run_id}`,
    changed_files: changedFiles,
    dry_apply_status: dryApplyStatus,
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
