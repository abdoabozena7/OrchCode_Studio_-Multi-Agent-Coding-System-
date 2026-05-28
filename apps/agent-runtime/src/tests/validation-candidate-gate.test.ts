import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson, resolveMemoryPaths } from "../memory/ProjectMemory.js";
import {
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  OrchestrationArtifactStore,
  ValidationCandidateGate,
  createExecutionIntegrationPreview,
  createExecutionPreparationPlan,
  createExecutionReviewPolicy,
  createExecutionRollbackPreview,
  createExecutionValidationPlan,
  createOneWriterDryRunProposal,
  createPatchProposal,
  createPatchProposalFileChange,
  createPatchProposalReview,
  createPatchProposalScopeCheck,
  createValidationCandidate,
  createValidationCandidateBatch,
  createValidationCandidateSummary,
  createValidationCommandPreflight,
  createValidationEnvironmentReadiness,
  createWriterSlot,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type ExecutionPreparationPlan,
  type OneWriterDryRunProposal,
  type PatchProposalReview
} from "../orchestration/index.js";

test("validation candidate models create candidate preflights environment and summary", () => {
  const command = createValidationCommandPreflight({
    validation_candidate_id: "candidate_model",
    command: "npm test",
    required: true,
    purpose: "Run tests later.",
    expected_output: "Strict validation result artifact.",
    fallback_behavior: "Record blocked/not_run.",
    safety_status: "safe",
    risk: "safe",
    allowlisted: true,
    inventory_present: true,
    inventory_match: true,
    future_semantics_status: "not_run"
  });
  const environment = createValidationEnvironmentReadiness({
    validation_candidate_id: "candidate_model",
    status: "ready",
    workspace_path_known: true,
    command_inventory_available: true,
    validation_runner_available: true,
    required_artifacts_exist: true,
    patch_apply_strategy: "prepare_only",
    findings: []
  });
  const candidate = createValidationCandidate({
    validation_candidate_id: "candidate_model",
    run_id: "run_model",
    proposal_id: "proposal_model",
    review_id: "review_model",
    preparation_plan_id: "prep_model",
    proposed_node_id: "node_model",
    required_commands: ["npm test"],
    optional_commands: [],
    command_safety_results: [command],
    environment_readiness: environment,
    expected_validation_outputs: ["Strict validation result artifact."],
    strict_validation_semantics_ref: "ValidationSemantics.aggregateValidationStatus:v1",
    status: "preflight_passed"
  });
  const summary = createValidationCandidateSummary({
    run_id: "run_model",
    validation_candidate_used: true,
    validation_candidate_count: 1,
    preflight_passed_count: 1,
    incomplete_count: 0,
    command_blocked_count: 0,
    environment_blocked_count: 0,
    rejected_count: 0
  });
  const batch = createValidationCandidateBatch({ run_id: "run_model", review_ids: ["review_model"], candidates: [candidate], summary });
  assert.equal(command.future_semantics_status, "not_run");
  assert.equal(environment.patch_applied, false);
  assert.equal(batch.summary.preflight_passed_count, 1);
});

test("accepted review creates validation candidate preflight without running commands", async () => {
  const workspace = await fixtureWorkspace("validation-candidate-accepted");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await writeCommandInventory(workspace, ["npm test"]);
    const review = await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_candidate_ok" });
    const gate = new ValidationCandidateGate({
      workspacePath: workspace,
      config: config({ enable_validation_candidate_gate: true, safe_commands_allowlist: ["npm test"] }),
      artifactStore
    });
    const result = await gate.createValidationCandidateFromReview(review);
    assert.equal(result.status, "preflight_passed");
    assert.equal(result.candidate?.command_safety_results[0]?.safety_status, "safe");
    assert.equal(result.candidate?.command_safety_results[0]?.future_semantics_status, "not_run");
    assert.equal(result.candidate?.environment_readiness?.patch_applied, false);
    assert.ok(result.candidate?.artifact_ref && existsSync(result.candidate.artifact_ref));
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validation_candidates")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ineligible reviews and missing validation plans do not pass candidacy", async () => {
  const workspace = await fixtureWorkspace("validation-candidate-eligibility");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await writeCommandInventory(workspace, ["npm test"]);
    const accepted = await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_candidate_eligibility" });
    const gate = new ValidationCandidateGate({
      workspacePath: workspace,
      config: config({ enable_validation_candidate_gate: true, safe_commands_allowlist: ["npm test"] }),
      artifactStore
    });
    const changesRequested = { ...accepted, review_id: "review_changes", decision: "request_changes" as const, status: "changes_requested" as const };
    assert.equal((await gate.createValidationCandidateFromReview(changesRequested)).status, "rejected");
    const blocked = { ...accepted, review_id: "review_blocked", status: "blocked" as const };
    assert.equal((await gate.createValidationCandidateFromReview(blocked)).status, "rejected");
    const noPlan = await persistedReviewFixture(workspace, artifactStore, {
      runId: "run_validation_candidate_missing_plan",
      preparationCommands: [],
      validationRecommendations: []
    });
    assert.equal((await gate.createValidationCandidateFromReview(noPlan)).status, "missing_validation_plan");
    const notRequired = await persistedReviewFixture(workspace, artifactStore, {
      runId: "run_validation_candidate_not_required",
      preparationCommands: [],
      validationPlanStatus: "not_required",
      validationRecommendations: []
    });
    assert.equal((await gate.createValidationCandidateFromReview(notRequired)).status, "preflight_passed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validation plan completeness and command safety distinguish safe blocked unknown optional and claimed-passed cases", async () => {
  const workspace = await fixtureWorkspace("validation-candidate-command-safety");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await writeCommandInventory(workspace, ["npm test"]);
    const safe = await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_safe", preparationCommands: ["npm test"] });
    const dangerous = await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_blocked", preparationCommands: ["rm -rf ."] });
    const unknown = await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_unknown", preparationCommands: ["custom validate"] });
    const optional = await persistedReviewFixture(workspace, artifactStore, {
      runId: "run_validation_optional",
      preparationCommands: ["npm test"],
      preparationMetadata: { optional_commands: ["custom optional"] }
    });
    const claimed = await persistedReviewFixture(workspace, artifactStore, {
      runId: "run_validation_claimed",
      validationRecommendations: ["validation passed already"]
    });
    const gate = new ValidationCandidateGate({
      workspacePath: workspace,
      config: config({
        enable_validation_candidate_gate: true,
        safe_commands_allowlist: ["npm test"],
        block_unknown_required_commands: true,
        require_command_inventory: false,
        require_environment_readiness: false
      }),
      artifactStore
    });
    assert.equal((await gate.createValidationCandidateFromReview(safe)).status, "preflight_passed");
    assert.equal((await gate.createValidationCandidateFromReview(dangerous)).status, "command_blocked");
    assert.equal((await gate.createValidationCandidateFromReview(unknown)).status, "command_blocked");
    const optionalResult = await gate.createValidationCandidateFromReview(optional);
    assert.equal(optionalResult.status, "preflight_passed");
    assert.equal(optionalResult.candidate?.warnings.some((warning) => warning.warning_type === "unknown_optional_command"), true);
    assert.equal((await gate.createValidationCandidateFromReview(claimed)).status, "rejected");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("environment readiness can block when command inventory is required", async () => {
  const workspace = await fixtureWorkspace("validation-candidate-environment");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const review = await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_environment" });
    const gate = new ValidationCandidateGate({
      workspacePath: workspace,
      config: config({
        enable_validation_candidate_gate: true,
        safe_commands_allowlist: ["npm test"],
        require_command_inventory: true,
        require_environment_readiness: true
      }),
      artifactStore
    });
    const result = await gate.createValidationCandidateFromReview(review);
    assert.equal(result.status, "environment_blocked");
    assert.equal(result.candidate?.environment_readiness?.command_inventory_available, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validation candidate artifacts metadata trace and batch summary are persisted as refs only", async () => {
  const workspace = await fixtureWorkspace("validation-candidate-artifacts");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await writeCommandInventory(workspace, ["npm test"]);
    await persistedReviewFixture(workspace, artifactStore, { runId: "run_validation_batch" });
    const gate = new ValidationCandidateGate({
      workspacePath: workspace,
      config: config({ enable_validation_candidate_gate: true, safe_commands_allowlist: ["npm test"] }),
      artifactStore
    });
    const batch = await gate.createValidationCandidateBatch("run_validation_batch");
    assert.equal(batch.summary.validation_candidate_count, 1);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
    assert.ok(batch.summary_ref && existsSync(batch.summary_ref));
    const candidate = batch.candidates[0];
    assert.ok(candidate.artifact_ref && existsSync(candidate.artifact_ref));
    assert.ok(candidate.validation_plan_artifact_ref && existsSync(candidate.validation_plan_artifact_ref));
    assert.ok(candidate.command_preflight_ref && existsSync(candidate.command_preflight_ref));
    assert.ok(candidate.environment_preflight_ref && existsSync(candidate.environment_preflight_ref));
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const row = metadata.get<{ required_commands_json: string; artifact_ref: string }>("SELECT required_commands_json, artifact_ref FROM factory_validation_candidates LIMIT 1");
      assert.equal(row?.required_commands_json, JSON.stringify(["npm test"]));
      assert.equal(row?.artifact_ref.endsWith("validation_candidate.json"), true);
    } finally {
      metadata.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_validation_batch" });
    assert.ok(trace.events.some((event) => event.event_type === "validation_candidate_started"));
    assert.ok(trace.events.some((event) => event.event_type === "validation_command_preflight_checked"));
    assert.ok(trace.events.some((event) => event.event_type === "validation_candidate_batch_completed"));
    const summary = await readFile(batch.summary_ref, "utf8");
    assert.match(summary, /No validation commands were run/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    enable_validation_candidate_gate: true,
    validation_candidate_mode: "preflight",
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    safe_commands_allowlist: ["npm test"],
    require_environment_readiness: false,
    ...overrides
  });
}

async function writeCommandInventory(workspace: string, commands: string[]) {
  const paths = await resolveMemoryPaths(workspace);
  await writeJson(paths.commandInventory, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packageManagers: ["npm"],
    commands: commands.map((command, index) => ({
      id: `cmd_${index}`,
      kind: "test",
      command,
      cwd: ".",
      sourceFile: "package.json",
      source: "package_json",
      packageManager: "npm",
      scriptName: command.replace(/^npm\s+/, ""),
      confidence: "high"
    })),
    byKind: { test: commands, lint: [], typecheck: [], build: [], format: [], smoke: [], dev: [], run: [], unknown: [] }
  });
}

async function persistedReviewFixture(workspace: string, artifactStore: OrchestrationArtifactStore, options: {
  runId: string;
  preparationCommands?: string[];
  validationPlanStatus?: "not_required" | "planned" | "missing" | "blocked";
  preparationMetadata?: Record<string, unknown>;
  validationRecommendations?: string[];
}) {
  const prep = await persistedPreparation(workspace, options.runId, options.preparationCommands ?? ["npm test"], options.preparationMetadata ?? {}, options.validationPlanStatus);
  const proposal = await persistedProposal(workspace, artifactStore, prep);
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
    validation_recommendations: options.validationRecommendations ?? ["Run prepared validation plan later."],
    integration_risks: [],
    security_risks: [],
    performance_risks: [],
    test_coverage_risks: [],
    confidence: 0.9
  });
  const reviewRefs = await artifactStore.savePatchProposalReviewArtifacts({ review });
  review.review_artifact_ref = reviewRefs.reviewResultRef;
  await new FactoryMetadataAdapter(workspace).recordPatchProposalReviewSaved(review);
  return review;
}

async function persistedPreparation(workspace: string, runId: string, commands: string[], metadata: Record<string, unknown>, validationPlanStatus?: "not_required" | "planned" | "missing" | "blocked"): Promise<ExecutionPreparationPlan> {
  const proposedNodeId = `node_${runId}`;
  const prep = createExecutionPreparationPlan({
    run_id: runId,
    queue_item_id: `queue_${runId}`,
    promotion_request_id: `promotion_${runId}`,
    approval_id: `approval_${runId}`,
    proposed_node_id: proposedNodeId,
    status: "prepared",
    intended_writer_slot: createWriterSlot({
      run_id: runId,
      queue_item_id: `queue_${runId}`,
      proposed_node_id: proposedNodeId,
      writer_role: "ExecutorAgent",
      write_capable: true
    }),
    writer_role: "ExecutorAgent",
    task_type: "implementation",
    read_or_write_classification: "write_candidate",
    objective: "Prepare validation candidate",
    allowed_files: ["src/runtime.ts"],
    forbidden_files: ["secrets.env"],
    read_only_files: ["README.md"],
    required_file_locks: ["src/runtime.ts"],
    required_module_locks: [],
    required_semantic_locks: [],
    context_freshness_summary: { status: "fresh" },
    prompt_id: `prompt_${runId}`,
    prompt_template_ref: `prompt_template_${runId}`,
    prompt_quality_result_ref: `prompt_quality_${runId}`,
    validation_plan: createExecutionValidationPlan({
      status: validationPlanStatus ?? (commands.length ? "planned" : "missing"),
      required_commands: commands,
      required_checks: commands.length ? ["strict_validation_semantics"] : [],
      command_inventory_refs: [],
      strict_validation_required: true,
      metadata_json: metadata
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
      expected_candidate_requirements: ["future integration candidate only"],
      required_post_integration_validation: commands,
      changed_files_preview: ["src/runtime.ts"],
      limitations: ["Preview only."]
    }),
    rollback_preview: createExecutionRollbackPreview({
      status: "manual_limited",
      rollback_available: false,
      limitations: ["No patch applied."],
      refs: []
    }),
    risk_level: "low",
    human_approval_ref: `approval_${runId}`,
    readiness_decision_ref: `readiness_${runId}`
  });
  const refs = await new OrchestrationArtifactStore(workspace).saveExecutionPreparationPlan(prep);
  prep.artifact_ref = refs.planRef;
  prep.validation_plan_ref = refs.validationPlanRef;
  prep.review_policy_ref = refs.reviewPolicyRef;
  prep.integration_preview_ref = refs.integrationPreviewRef;
  await new FactoryMetadataAdapter(workspace).recordExecutionPreparationPlanSaved(prep);
  return prep;
}

async function persistedProposal(workspace: string, artifactStore: OrchestrationArtifactStore, prep: ExecutionPreparationPlan): Promise<OneWriterDryRunProposal> {
  const proposalId = `proposal_${prep.run_id}`;
  const fileChange = createPatchProposalFileChange({
    proposal_id: proposalId,
    path: "src/runtime.ts",
    change_type: "modify",
    proposed_diff: "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@\n-old\n+new\n",
    rationale: "Test change.",
    risk: "low",
    within_allowed_scope: true
  });
  const patchProposal = createPatchProposal({
    run_id: prep.run_id,
    preparation_plan_id: prep.preparation_plan_id,
    proposal_id: proposalId,
    summary: "Dry-run proposal.",
    changed_files: ["src/runtime.ts"],
    file_changes: [fileChange],
    risks: [],
    assumptions: [],
    validation_recommendations: ["Run prepared validation plan later."],
    review_notes: [],
    confidence: 0.9
  });
  const scope = createPatchProposalScopeCheck({
    proposal_id: proposalId,
    status: "passed",
    review_candidate_allowed: true,
    changed_files: ["src/runtime.ts"],
    allowed_files: ["src/runtime.ts"],
    forbidden_files: ["secrets.env"],
    forbidden_file_violations: [],
    out_of_scope_changes: [],
    findings: [],
    metadata_json: { no_patch_applied: true }
  });
  const proposal = createOneWriterDryRunProposal({
    proposal_id: proposalId,
    run_id: prep.run_id,
    preparation_plan_id: prep.preparation_plan_id,
    queue_item_id: prep.queue_item_id,
    promotion_request_id: prep.promotion_request_id,
    approval_id: prep.approval_id,
    proposed_node_id: prep.proposed_node_id,
    writer_role: "ExecutorAgent",
    provider_mode: "fake_provider",
    prompt_id: prep.prompt_id,
    prompt_quality_result_ref: prep.prompt_quality_result_ref,
    context_pack_ref: prep.context_pack_ref,
    patch_summary: "Dry-run proposal.",
    changed_files: ["src/runtime.ts"],
    allowed_files: ["src/runtime.ts"],
    forbidden_files: ["secrets.env"],
    scope_check_result: scope,
    forbidden_file_violations: [],
    out_of_scope_changes: [],
    required_locks_preview: ["src/runtime.ts"],
    validation_plan_ref: prep.validation_plan_ref,
    review_policy_ref: prep.review_policy_ref,
    integration_preview_ref: prep.integration_preview_ref,
    risk_level: "low",
    status: "accepted_for_review_candidate",
    patch_proposal: patchProposal
  });
  const refs = await artifactStore.saveOneWriterDryRunProposalArtifacts({ proposal, patchProposal, scopeCheck: scope });
  proposal.patch_artifact_ref = refs.patchProposalRef;
  proposal.artifact_ref = refs.artifactRef;
  await new FactoryMetadataAdapter(workspace).recordOneWriterDryRunProposalSaved(proposal);
  return proposal;
}
