import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  OneWriterDryRunExecutor,
  OrchestrationArtifactStore,
  checkPatchProposalScope,
  createExecutionIntegrationPreview,
  createExecutionPreparationPlan,
  createExecutionReviewPolicy,
  createExecutionRollbackPreview,
  createExecutionValidationPlan,
  createOneWriterDryRunProposal,
  createPatchProposal,
  createPatchProposalBatch,
  createPatchProposalFileChange,
  createPatchProposalSummary,
  createProposedTaskGraphNode,
  createWriterSlot,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type ExecutionPreparationPlan,
  type OneWriterDryRunProvider,
  type OneWriterDryRunProviderInput,
  type OneWriterDryRunProviderResult
} from "../orchestration/index.js";

test("dry-run writer models create proposals patch changes batches and scope checks", () => {
  const fileChange = createPatchProposalFileChange({
    proposal_id: "dry_model",
    path: "src/runtime.ts",
    change_type: "modify",
    proposed_diff: "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@\n+export const value = 1;\n",
    rationale: "Scoped model test.",
    risk: "low",
    within_allowed_scope: true
  });
  const patch = createPatchProposal({
    proposal_id: "dry_model",
    run_id: "run_model",
    preparation_plan_id: "prep_model",
    summary: "Scoped dry-run proposal.",
    changed_files: ["src/runtime.ts"],
    file_changes: [fileChange],
    risks: [],
    assumptions: [],
    validation_recommendations: ["npm test later"],
    review_notes: ["Review later"],
    confidence: 0.8
  });
  const dryRun = createOneWriterDryRunProposal({
    proposal_id: "dry_model",
    run_id: "run_model",
    preparation_plan_id: "prep_model",
    queue_item_id: "queue_model",
    promotion_request_id: "request_model",
    approval_id: "approval_model",
    proposed_node_id: "node_model",
    writer_role: "ExecutorAgent",
    provider_mode: "fake_provider",
    prompt_id: "prompt_model",
    context_pack_ref: "context.json",
    patch_summary: patch.summary,
    changed_files: patch.changed_files,
    allowed_files: ["src/runtime.ts"],
    forbidden_files: [".env"],
    forbidden_file_violations: [],
    out_of_scope_changes: [],
    required_locks_preview: ["file:src/runtime.ts"],
    risk_level: "low",
    status: "accepted_for_review_candidate",
    patch_proposal: patch
  });
  const scope = checkPatchProposalScope({ proposalId: dryRun.proposal_id, patchProposal: patch, preparationPlan: plan("run_model", { preparation_plan_id: "prep_model" }) });
  const summary = createPatchProposalSummary({
    run_id: "run_model",
    one_writer_dry_run_used: true,
    dry_run_proposal_count: 1,
    generated_count: 1,
    schema_failed_count: 0,
    scope_failed_count: 0,
    blocked_count: 0,
    review_candidate_count: 1,
    changed_files_preview: ["src/runtime.ts"]
  });
  const batch = createPatchProposalBatch({
    run_id: "run_model",
    preparation_plan_ids: ["prep_model"],
    proposals: [{ proposal_id: dryRun.proposal_id, status: dryRun.status }],
    summary
  });
  assert.equal(scope.status, "passed");
  assert.equal(dryRun.status, "accepted_for_review_candidate");
  assert.equal(JSON.parse(JSON.stringify(scope)).review_candidate_allowed, true);
  assert.equal(batch.summary.review_candidate_count, 1);
});

test("fake provider valid output creates one review-candidate proposal without applying or integrating", async () => {
  const workspace = await fixtureWorkspace("one-writer-dry-run-valid");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const preparation = await persistPreparedPlan(workspace, artifactStore, "run_dry_valid");
    const provider = providerReturning(validPatchOutput(["src/runtime.ts"]));
    const executor = new OneWriterDryRunExecutor({ workspacePath: workspace, config: config({ enable_one_writer_dry_run: true }), artifactStore, provider });
    const result = await executor.generatePatchProposalFromPreparation(preparation);
    assert.equal(result.status, "accepted_for_review_candidate");
    assert.equal(provider.calls, 1);
    assert.ok(result.proposal);
    assert.equal(result.proposal.changed_files[0], "src/runtime.ts");
    assert.ok(result.proposal.artifact_ref && existsSync(result.proposal.artifact_ref));
    assert.ok(result.proposal.raw_output_ref && existsSync(result.proposal.raw_output_ref));
    assert.ok(result.proposal.parsed_output_ref && existsSync(result.proposal.parsed_output_ref));
    assert.ok(result.proposal.patch_artifact_ref && existsSync(result.proposal.patch_artifact_ref));
    assert.ok(result.proposal.scope_check_result?.review_candidate_allowed);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_one_writer_dry_run_proposals WHERE run_id = ?", "run_dry_valid")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_patch_proposal_files WHERE run_id = ?", "run_dry_valid")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_patch_proposal_scope_checks WHERE run_id = ?", "run_dry_valid")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_locks WHERE run_id = ?", "run_dry_valid")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations WHERE run_id = ?", "run_dry_valid")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_candidates WHERE run_id = ?", "run_dry_valid")?.count ?? 0, 0);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_worker_invocations WHERE run_id = ?", "run_dry_valid")?.count ?? 0, 0);
      const fileRow = metadata.get<{ metadata_json: string }>("SELECT metadata_json FROM factory_patch_proposal_files WHERE run_id = ?", "run_dry_valid");
      assert.equal(JSON.parse(fileRow?.metadata_json ?? "{}").proposed_diff_stored_in_sqlite, false);
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_dry_valid" });
    const events = new Set(trace.events.map((event) => event.event_type));
    for (const event of [
      "one_writer_dry_run_started",
      "one_writer_dry_run_preparation_loaded",
      "one_writer_dry_run_prompt_checked",
      "one_writer_dry_run_provider_selected",
      "one_writer_dry_run_provider_started",
      "one_writer_dry_run_provider_completed",
      "patch_proposal_raw_output_saved",
      "patch_proposal_schema_validated",
      "patch_proposal_scope_check_started",
      "patch_proposal_scope_check_passed",
      "patch_proposal_generated",
      "patch_proposal_review_candidate_created"
    ]) {
      assert.ok(events.has(event), `missing trace event ${event}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("preparation validation blocks missing gates without provider calls", async () => {
  const workspace = await fixtureWorkspace("one-writer-dry-run-blocks");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const noApproval = await persistPreparedPlan(workspace, artifactStore, "run_missing_approval", { approval_id: undefined });
    const notPrepared = await persistPreparedPlan(workspace, artifactStore, "run_not_prepared", { status: "missing_validation" });
    const missingValidation = await persistPreparedPlan(workspace, artifactStore, "run_missing_validation", { validationStatus: "missing" });
    const missingReview = await persistPreparedPlan(workspace, artifactStore, "run_missing_review", { reviewStatus: "missing" });
    const missingIntegration = await persistPreparedPlan(workspace, artifactStore, "run_missing_integration", { integrationStatus: "missing" });
    const missingScope = await persistPreparedPlan(workspace, artifactStore, "run_missing_scope", { allowed_files: [] });
    const blockedNode = await persistPreparedPlan(workspace, artifactStore, "run_blocked_node", { nodeStatus: "blocked" });
    const realProviderDisallowed = await persistPreparedPlan(workspace, artifactStore, "run_real_provider_block", {});
    const provider = providerReturning(validPatchOutput(["src/runtime.ts"]));
    for (const [expectedRun, planInput, mode] of [
      ["run_missing_approval", noApproval, "fake_provider"],
      ["run_not_prepared", notPrepared, "fake_provider"],
      ["run_missing_validation", missingValidation, "fake_provider"],
      ["run_missing_review", missingReview, "fake_provider"],
      ["run_missing_integration", missingIntegration, "fake_provider"],
      ["run_missing_scope", missingScope, "fake_provider"],
      ["run_blocked_node", blockedNode, "fake_provider"],
      ["run_real_provider_block", realProviderDisallowed, "provider"]
    ] as const) {
      const result = await new OneWriterDryRunExecutor({
        workspacePath: workspace,
        config: config({ enable_one_writer_dry_run: true, one_writer_dry_run_mode: mode, allow_real_provider_dry_run: false }),
        artifactStore,
        provider
      }).generatePatchProposalFromPreparation(planInput);
      assert.equal(result.status, "blocked", expectedRun);
    }
    assert.equal(provider.calls, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("schema failures and provider errors are persisted without review candidate promotion", async () => {
  const workspace = await fixtureWorkspace("one-writer-dry-run-provider-fail");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const invalidPlan = await persistPreparedPlan(workspace, artifactStore, "run_schema_fail");
    const invalidResult = await new OneWriterDryRunExecutor({
      workspacePath: workspace,
      config: config({ enable_one_writer_dry_run: true }),
      artifactStore,
      provider: providerReturning("not json")
    }).generatePatchProposalFromPreparation(invalidPlan);
    assert.equal(invalidResult.status, "schema_failed");
    assert.ok(invalidResult.proposal?.raw_output_ref && existsSync(invalidResult.proposal.raw_output_ref));
    assert.equal(invalidResult.proposal?.parsed_output_ref, undefined);

    const errorPlan = await persistPreparedPlan(workspace, artifactStore, "run_provider_error");
    const providerError = providerReturning(validPatchOutput(["src/runtime.ts"]), new Error("fake provider failed"));
    const errorResult = await new OneWriterDryRunExecutor({
      workspacePath: workspace,
      config: config({ enable_one_writer_dry_run: true }),
      artifactStore,
      provider: providerError
    }).generatePatchProposalFromPreparation(errorPlan);
    assert.equal(errorResult.status, "blocked");
    assert.equal(providerError.calls, 1);

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_provider_error" });
    assert.ok(trace.events.some((event) => event.event_type === "one_writer_dry_run_provider_failed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate dry-run proposals for a preparation are blocked unless explicitly allowed", async () => {
  const workspace = await fixtureWorkspace("one-writer-dry-run-duplicate");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const preparation = await persistPreparedPlan(workspace, artifactStore, "run_duplicate");
    const provider = providerReturning(validPatchOutput(["src/runtime.ts"]));
    const executor = new OneWriterDryRunExecutor({ workspacePath: workspace, config: config({ enable_one_writer_dry_run: true }), artifactStore, provider });
    assert.equal((await executor.generatePatchProposalFromPreparation(preparation)).status, "accepted_for_review_candidate");
    assert.equal((await executor.generatePatchProposalFromPreparation(preparation)).status, "blocked");
    assert.equal(provider.calls, 1);
    const batch = await executor.generatePatchProposalBatch("run_duplicate", { allowDuplicatePreparation: true });
    assert.equal(batch.proposals.length, 1);
    assert.equal(provider.calls, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scope checker rejects forbidden out-of-scope delete sensitive and false validation/application claims", async () => {
  const base = plan("run_scope", { preparation_plan_id: "prep_scope" });
  const cases: Array<[string, string, ExecutionPreparationPlan]> = [
    ["forbidden", validPatchOutput([".env"]), base],
    ["out-of-scope", validPatchOutput(["src/outside.ts"]), base],
    ["delete", validPatchOutput(["src/runtime.ts"], { change_type: "delete", proposed_diff: undefined }), base],
    ["sensitive", validPatchOutput(["package.json"]), plan("run_scope", { preparation_plan_id: "prep_sensitive", allowed_files: ["package.json"] })],
    ["validation claim", validPatchOutput(["src/runtime.ts"], { summary: "Validation passed for this patch." }), base],
    ["applied claim", validPatchOutput(["src/runtime.ts"], { review_notes: ["Patch applied to workspace."] }), base]
  ];
  for (const [label, raw, preparation] of cases) {
    const proposal = createOneWriterDryRunProposal({
      proposal_id: `dry_scope_${label.replace(/\W+/g, "_")}`,
      run_id: "run_scope",
      preparation_plan_id: preparation.preparation_plan_id,
      queue_item_id: preparation.queue_item_id,
      promotion_request_id: preparation.promotion_request_id,
      approval_id: preparation.approval_id,
      proposed_node_id: preparation.proposed_node_id,
      writer_role: "ExecutorAgent",
      provider_mode: "fake_provider",
      patch_summary: "",
      changed_files: [],
      allowed_files: preparation.allowed_files,
      forbidden_files: preparation.forbidden_files,
      forbidden_file_violations: [],
      out_of_scope_changes: [],
      required_locks_preview: ["file:src/runtime.ts"],
      risk_level: "medium",
      status: "pending"
    });
    const parsed = new OneWriterDryRunExecutor({ workspacePath: process.cwd(), config: config({ enable_one_writer_dry_run: true }) }).parsePatchProposalOutput(raw, proposal);
    const scope = checkPatchProposalScope({ proposalId: proposal.proposal_id, patchProposal: parsed, preparationPlan: preparation });
    assert.equal(scope.status, "failed", label);
    assert.ok(scope.findings.some((finding) => finding.severity === "blocking"), label);
  }
});

test("CoreOrchestrator dry-run hook is disabled by default and enabled only by config", async () => {
  const workspace = await fixtureWorkspace("one-writer-dry-run-core");
  try {
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const preparation = await persistPreparedPlan(workspace, artifactStore, "run_core_dry");
    const before = await readFile(path.join(workspace, "src", "runtime.ts"), "utf8");
    const disabled = new CoreOrchestrator({ workspacePath: workspace, config: config({ enable_one_writer_dry_run: false }) });
    await (disabled as unknown as { generateOneWriterDryRunIfAllowed(runId: string, planOnly: boolean): Promise<void> }).generateOneWriterDryRunIfAllowed("run_core_dry", true);
    let metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_dry_run_writer_batches WHERE run_id = ?", "run_core_dry")?.count ?? 0, 0);
    } finally {
      metadata.close();
    }

    const enabled = new CoreOrchestrator({ workspacePath: workspace, config: config({ enable_one_writer_dry_run: true, max_dry_run_proposals_per_run: 1 }) });
    await (enabled as unknown as { generateOneWriterDryRunIfAllowed(runId: string, planOnly: boolean): Promise<void> }).generateOneWriterDryRunIfAllowed(preparation.run_id, true);
    metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_dry_run_writer_batches WHERE run_id = ?", "run_core_dry")?.count, 1);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_one_writer_dry_run_proposals WHERE run_id = ?", "run_core_dry")?.count, 1);
    } finally {
      metadata.close();
    }
    assert.equal(await readFile(path.join(workspace, "src", "runtime.ts"), "utf8"), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function persistPreparedPlan(
  workspace: string,
  artifactStore: OrchestrationArtifactStore,
  runId: string,
  overrides: Partial<ExecutionPreparationPlan> & {
    validationStatus?: "planned" | "missing" | "blocked" | "not_required";
    reviewStatus?: "planned" | "missing" | "not_required";
    integrationStatus?: "available" | "missing" | "blocked" | "not_required";
    nodeStatus?: "future_write_candidate" | "blocked" | "rejected" | "duplicate" | "superseded";
  } = {}
) {
  const contextRef = path.join(workspace, ".agent_memory", "runs", runId, "context_packs", `context_${runId}.json`);
  await mkdir(path.dirname(contextRef), { recursive: true });
  await writeJson(contextRef, { run_id: runId, allowed_files: overrides.allowed_files ?? ["src/runtime.ts"], no_full_repo_dump: true });
  const preparation = plan(runId, {
    ...overrides,
    context_pack_ref: contextRef,
    validation_plan: createExecutionValidationPlan({
      status: overrides.validationStatus ?? "planned",
      required_commands: overrides.validationStatus === "missing" ? [] : ["npm test"],
      required_checks: overrides.validationStatus === "missing" ? [] : ["strict_validation_required"],
      command_inventory_refs: ["command_inventory"],
      strict_validation_required: true
    }),
    review_policy: createExecutionReviewPolicy({
      status: overrides.reviewStatus ?? "planned",
      required_reviews: overrides.reviewStatus === "missing" ? [] : ["basic_review"],
      specialist_reviews: preparationSpecialists(overrides.risk_level ?? "medium"),
      validation_review_required: true,
      integration_review_required: true
    }),
    integration_preview: createExecutionIntegrationPreview({
      status: overrides.integrationStatus ?? "available",
      integration_manager_required: true,
      expected_candidate_requirements: ["accepted_review_ref", "validation_ref"],
      required_post_integration_validation: ["npm test"],
      changed_files_preview: overrides.allowed_files ?? ["src/runtime.ts"],
      limitations: ["preview only"]
    })
  });
  const refs = await artifactStore.saveExecutionPreparationPlan(preparation);
  preparation.artifact_ref = refs.planRef;
  preparation.lock_plan_ref = refs.lockPlanRef;
  preparation.validation_plan_ref = refs.validationPlanRef;
  preparation.review_policy_ref = refs.reviewPolicyRef;
  preparation.integration_preview_ref = refs.integrationPreviewRef;
  preparation.rollback_preview_ref = refs.rollbackPreviewRef;
  await new FactoryMetadataAdapter(workspace).recordExecutionPreparationPlanSaved(preparation);
  await new FactoryMetadataAdapter(workspace).recordProposedTaskNodeSaved("graph_dry_run_test", createProposedTaskGraphNode({
    proposed_node_id: preparation.proposed_node_id,
    run_id: runId,
    team_id: preparation.team_id,
    adopted_task_id: preparation.adopted_task_id,
    title: "Dry-run node",
    objective: preparation.objective,
    task_type: preparation.task_type,
    read_or_write_classification: preparation.read_or_write_classification,
    proposed_role: preparation.writer_role,
    status: overrides.nodeStatus ?? "future_write_candidate",
    readiness_status: "future_write_candidate",
    adoption_status: "adopted_read_only",
    allowed_files: preparation.allowed_files,
    forbidden_files: preparation.forbidden_files,
    read_only_files: preparation.read_only_files,
    module_locks: ["module:src"],
    semantic_locks: ["semantic:runtime"],
    dependencies: [],
    validation_strategy: { strategy_id: `validation_${runId}`, status: "planned", commands: ["npm test"], required_checks: [], artifact_refs: [], notes: [], metadata_json: {} },
    success_criteria: ["Dry-run proposal only."],
    stop_conditions: ["Stop if any gate is missing."],
    prompt_template_ref: "factory.role.executor@1.0.0",
    context_pack_ref: contextRef,
    evidence_refs: [],
    risk_level: preparation.risk_level,
    non_executable_reason: "Dry-run test node."
  }));
  return preparation;
}

function plan(runId: string, overrides: Partial<ExecutionPreparationPlan> = {}): ExecutionPreparationPlan {
  const preparationPlanId = overrides.preparation_plan_id ?? `prep_${runId}`;
  const allowedFiles = overrides.allowed_files ?? ["src/runtime.ts"];
  return createExecutionPreparationPlan({
    preparation_plan_id: preparationPlanId,
    run_id: runId,
    queue_item_id: overrides.queue_item_id ?? `queue_${runId}`,
    promotion_request_id: overrides.promotion_request_id ?? `request_${runId}`,
    approval_id: Object.prototype.hasOwnProperty.call(overrides, "approval_id") ? overrides.approval_id : `approval_${runId}`,
    proposed_node_id: overrides.proposed_node_id ?? `node_${runId}`,
    team_id: overrides.team_id ?? "team_runtime",
    adopted_task_id: overrides.adopted_task_id ?? `adopted_${runId}`,
    status: overrides.status ?? "prepared",
    intended_writer_slot: overrides.intended_writer_slot ?? createWriterSlot({
      run_id: runId,
      queue_item_id: overrides.queue_item_id ?? `queue_${runId}`,
      proposed_node_id: overrides.proposed_node_id ?? `node_${runId}`,
      writer_role: "ExecutorAgent",
      write_capable: true
    }),
    writer_role: overrides.writer_role ?? "ExecutorAgent",
    task_type: overrides.task_type ?? "domain",
    read_or_write_classification: overrides.read_or_write_classification ?? "write_candidate",
    objective: overrides.objective ?? "Generate a dry-run patch proposal for runtime.",
    allowed_files: allowedFiles,
    forbidden_files: overrides.forbidden_files ?? [".env"],
    read_only_files: overrides.read_only_files ?? ["src/review.ts"],
    required_file_locks: overrides.required_file_locks ?? allowedFiles.map((file) => `file:${file}`),
    required_module_locks: overrides.required_module_locks ?? ["module:src"],
    required_semantic_locks: overrides.required_semantic_locks ?? ["semantic:runtime"],
    context_pack_ref: overrides.context_pack_ref ?? "context.json",
    context_freshness_summary: overrides.context_freshness_summary ?? { status: "current", confidence: 0.9 },
    prompt_id: overrides.prompt_id ?? `prompt_${runId}`,
    prompt_template_ref: overrides.prompt_template_ref ?? "factory.role.executor@1.0.0",
    prompt_quality_result_ref: overrides.prompt_quality_result_ref ?? `prompt_quality_${runId}.json`,
    validation_plan: overrides.validation_plan ?? createExecutionValidationPlan({ status: "planned", required_commands: ["npm test"], required_checks: ["strict_validation_required"], command_inventory_refs: ["command_inventory"], strict_validation_required: true }),
    review_policy: overrides.review_policy ?? createExecutionReviewPolicy({ status: "planned", required_reviews: ["basic_review"], specialist_reviews: [], validation_review_required: true, integration_review_required: true }),
    integration_preview: overrides.integration_preview ?? createExecutionIntegrationPreview({ status: "available", integration_manager_required: true, expected_candidate_requirements: ["accepted_review_ref"], required_post_integration_validation: ["npm test"], changed_files_preview: allowedFiles, limitations: ["preview only"] }),
    rollback_preview: overrides.rollback_preview ?? createExecutionRollbackPreview({ status: "manual_limited", rollback_available: false, limitations: ["manual only"], refs: [] }),
    risk_level: overrides.risk_level ?? "medium",
    human_approval_ref: overrides.human_approval_ref ?? `approval_${runId}.json`,
    readiness_decision_ref: overrides.readiness_decision_ref ?? `decision_${runId}`,
    blockers: overrides.blockers ?? [],
    warnings: overrides.warnings ?? [],
    metadata_json: overrides.metadata_json ?? { dry_run_test_fixture: true }
  });
}

function validPatchOutput(files: string[], overrides: Record<string, unknown> = {}) {
  const changeType = String(overrides.change_type ?? "modify");
  return JSON.stringify({
    summary: overrides.summary ?? "Scoped patch proposal only.",
    changed_files: files,
    file_changes: files.map((file) => ({
      path: file,
      change_type: changeType,
      proposed_diff: Object.prototype.hasOwnProperty.call(overrides, "proposed_diff") ? overrides.proposed_diff : `--- a/${file}\n+++ b/${file}\n@@\n+// dry-run scoped change\n`,
      rationale: "Scoped dry-run proposal.",
      risk: "low",
      within_allowed_scope: file === "src/runtime.ts" || file === "package.json"
    })),
    risks: [],
    assumptions: [],
    validation_recommendations: ["Validation remains pending until a later gate."],
    review_notes: overrides.review_notes ?? ["Review later before integration."],
    confidence: 0.8
  }, null, 2);
}

function providerReturning(raw: string, error?: Error): OneWriterDryRunProvider & { calls: number } {
  return {
    provider_name: "test_fake_provider",
    provider_mode: "fake_provider",
    calls: 0,
    async generatePatchProposal(_input: OneWriterDryRunProviderInput): Promise<OneWriterDryRunProviderResult> {
      this.calls += 1;
      if (error) throw error;
      return { raw_output: raw, provider_name: "test_fake_provider", model_name: "test-fake-model" };
    }
  };
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    memory_path: ".agent_memory",
    enable_one_writer_dry_run: false,
    one_writer_dry_run_mode: "fake_provider",
    allow_real_provider_dry_run: false,
    ...overrides
  });
}

function preparationSpecialists(risk: string) {
  return risk === "high" || risk === "critical" ? ["security_review"] : [];
}

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "src", "runtime.ts"), "export const runtime = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "review.ts"), "export const review = 1;\n", "utf8");
  await writeFile(path.join(root, "README.md"), "fixture workspace\n", "utf8");
  return root;
}
