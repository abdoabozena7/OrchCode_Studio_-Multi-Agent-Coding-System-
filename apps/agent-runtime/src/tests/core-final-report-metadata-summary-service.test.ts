import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreFinalReportMetadataSummaryService,
  type ControlledApplyBatch,
  FactoryMetadataStore,
  type ExecutionPreparationBatch,
  type ExecutionReadinessBatch,
  type IntegrationApplyApprovalBatch,
  type IntegrationCandidateBatch,
  type IntegrationFinalizationBatch,
  type OneWriterDryRunBatch,
  type PatchSandboxBatch,
  type PatchProposalReviewBatch,
  type SandboxValidationBatch,
  type TeamContextScope,
  type TeamSubPlan,
  type TeamSubPlanAggregation,
  type ValidationCandidateBatch
} from "../orchestration/index.js";

test("CoreFinalReportMetadataSummaryService returns empty summaries without metadata database", async () => {
  const workspace = await fixtureWorkspace("metadata-summary-empty");
  try {
    const service = new CoreFinalReportMetadataSummaryService(workspace);

    assert.deepEqual(await service.goalStewardReportSummary("run_missing"), {
      goal_steward_used: false,
      goal_alignment_status: undefined,
      goal_conflict_count: 0,
      project_goal_spec_ref: undefined,
      goal_steward_review_ref: undefined
    });
    assert.equal((await service.teamContextReportSummary("run_missing")).team_context_used, false);
    assert.equal((await service.executionReadinessReportSummary("run_missing")).execution_readiness_used, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreFinalReportMetadataSummaryService summarizes populated team and readiness metadata", async () => {
  const workspace = await fixtureWorkspace("metadata-summary-populated");
  const runId = "run_metadata_summary";
  try {
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace });
    try {
      metadata.recordTeamContextScope(fakeTeamContextScope(runId));
      metadata.recordTeamSubPlan({ plan: fakeSubPlan(runId, "sub_ok", "generated") });
      metadata.recordTeamSubPlan({ plan: fakeSubPlan(runId, "sub_bad", "invalid") });
      metadata.recordTeamSubPlanAggregation({ aggregation: fakeAggregation(runId) });
      metadata.recordExecutionReadinessBatch({ batch: fakeReadinessBatch(runId) });
    } finally {
      metadata.close();
    }

    const service = new CoreFinalReportMetadataSummaryService(workspace);
    const context = await service.teamContextReportSummary(runId);
    const subPlanning = await service.teamSubPlanningReportSummary(runId);
    const readiness = await service.executionReadinessReportSummary(runId);

    assert.equal(context.team_context_used, true);
    assert.equal(context.team_context_scope_count, 1);
    assert.equal(context.team_scope_warnings, 2);
    assert.equal(subPlanning.team_sub_planning_used, true);
    assert.equal(subPlanning.sub_plan_count, 2);
    assert.equal(subPlanning.invalid_sub_plan_count, 1);
    assert.equal(subPlanning.teams_planned, 2);
    assert.equal(subPlanning.cross_team_dependency_count, 1);
    assert.equal(subPlanning.scope_conflict_count, 1);
    assert.deepEqual(subPlanning.top_team_risks, ["Shared module risk"]);
    assert.equal(subPlanning.aggregation_ref, "aggregation.json");
    assert.equal(readiness.execution_readiness_used, true);
    assert.equal(readiness.nodes_evaluated, 4);
    assert.equal(readiness.ready_read_only_count, 1);
    assert.equal(readiness.future_write_candidate_count, 1);
    assert.equal(readiness.requires_human_approval_count, 1);
    assert.equal(readiness.blocked_count, 1);
    assert.equal(readiness.readiness_summary_ref, "readiness-summary.json");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreFinalReportMetadataSummaryService summarizes pre-apply review metadata", async () => {
  const workspace = await fixtureWorkspace("metadata-summary-pre-apply");
  const runId = "run_pre_apply_summary";
  try {
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace });
    try {
      metadata.recordExecutionPreparationBatch({ batch: fakePreparationBatch(runId) });
      metadata.recordDryRunWriterBatch({ batch: fakeDryRunBatch(runId) });
      metadata.recordPatchReviewBatch({ batch: fakePatchReviewBatch(runId) });
      metadata.recordValidationCandidateBatch({ batch: fakeValidationCandidateBatch(runId) });
    } finally {
      metadata.close();
    }

    const service = new CoreFinalReportMetadataSummaryService(workspace);
    const preparation = await service.executionPreparationReportSummary(runId);
    const dryRun = await service.oneWriterDryRunReportSummary(runId);
    const review = await service.patchProposalReviewReportSummary(runId);
    const validation = await service.validationCandidateReportSummary(runId);

    assert.equal(preparation.execution_preparation_used, true);
    assert.equal(preparation.preparation_plan_count, 3);
    assert.equal(preparation.missing_prompt_count, 1);
    assert.equal(preparation.preparation_summary_ref, "preparation-summary.json");
    assert.equal(dryRun.one_writer_dry_run_used, true);
    assert.equal(dryRun.generated_count, 2);
    assert.deepEqual(dryRun.changed_files_preview, ["src/a.ts", "src/b.ts"]);
    assert.equal(review.patch_review_used, true);
    assert.equal(review.patch_reviews_count, 4);
    assert.equal(review.critical_findings_count, 1);
    assert.equal(validation.validation_candidate_used, true);
    assert.equal(validation.validation_candidate_count, 5);
    assert.equal(validation.command_blocked_count, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreFinalReportMetadataSummaryService summarizes sandbox apply and finalization metadata", async () => {
  const workspace = await fixtureWorkspace("metadata-summary-apply-finalization");
  const runId = "run_apply_finalization_summary";
  try {
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace });
    try {
      metadata.recordPatchApplySandboxBatch({ batch: fakePatchSandboxBatch(runId) });
      metadata.recordSandboxValidationBatch({ batch: fakeSandboxValidationBatch(runId) });
      metadata.recordSandboxIntegrationCandidateBatch({ batch: fakeIntegrationCandidateBatch(runId) });
      metadata.recordIntegrationApplyApprovalBatch({ batch: fakeIntegrationApplyApprovalBatch(runId) });
      metadata.recordControlledApplyBatch({ batch: fakeControlledApplyBatch(runId) });
      metadata.recordIntegrationFinalizationBatch({ batch: fakeIntegrationFinalizationBatch(runId) });
    } finally {
      metadata.close();
    }

    const service = new CoreFinalReportMetadataSummaryService(workspace);
    const patchApply = await service.patchApplySandboxReportSummary(runId);
    const sandboxValidation = await service.sandboxValidationReportSummary(runId);
    const candidate = await service.sandboxIntegrationCandidateReportSummary(runId);
    const approval = await service.integrationApplyApprovalReportSummary(runId);
    const controlledApply = await service.controlledApplyReportSummary(runId);
    const finalization = await service.integrationFinalizationReportSummary(runId);

    assert.equal(patchApply.patch_apply_sandbox_used, true);
    assert.equal(patchApply.sandbox_result_count, 4);
    assert.equal(patchApply.dry_apply_failed_count, 1);
    assert.equal(patchApply.main_repo_integrity_ok, false);
    assert.equal(patchApply.sandbox_summary_ref, "patch-sandbox-summary.json");
    assert.equal(sandboxValidation.sandbox_validation_used, true);
    assert.equal(sandboxValidation.sandbox_validation_count, 3);
    assert.equal(sandboxValidation.sandbox_validation_partial_count, 1);
    assert.equal(candidate.sandbox_integration_candidate_used, true);
    assert.equal(candidate.integration_candidate_count, 3);
    assert.equal(candidate.validation_blocked_count, 1);
    assert.equal(approval.integration_apply_approval_used, true);
    assert.equal(approval.apply_approval_count, 3);
    assert.equal(approval.requires_human_approval_count, 1);
    assert.equal(controlledApply.controlled_apply_used, true);
    assert.equal(controlledApply.controlled_apply_count, 3);
    assert.equal(controlledApply.rollback_failed_count, 1);
    assert.equal(finalization.integration_finalization_used, true);
    assert.equal(finalization.integration_finalization_count, 2);
    assert.equal(finalization.memory_entries_created_count, 3);
    assert.equal(finalization.finalization_summary_ref, "finalization-summary.json");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function fakeTeamContextScope(runId: string): TeamContextScope {
  return {
    team_context_scope_id: "scope_metadata_summary",
    team_id: "team_platform",
    run_id: runId,
    domain: "platform",
    objective: "Refactor orchestration.",
    team_type: "domain",
    memory_scope: "memory_scope_platform",
    inherited_memory_scopes: [],
    allowed_files: ["src/"],
    forbidden_files: [],
    read_only_files: [],
    module_locks: [],
    semantic_locks: [],
    evidence_refs: [],
    decision_refs: [],
    failure_refs: [],
    budget_summary: {},
    constraints: [],
    warnings: [
      { warning_id: "warning_1", reason: "budget_pressure", message: "Budget pressure.", severity: "warning", metadata_json: {} },
      { warning_id: "warning_2", reason: "low_confidence", message: "Low confidence.", severity: "warning", metadata_json: {} }
    ],
    confidence: 0.8,
    freshness: "current",
    metadata_json: {}
  };
}

function fakeSubPlan(runId: string, subPlanId: string, status: TeamSubPlan["status"]): TeamSubPlan {
  return {
    sub_plan_id: subPlanId,
    run_id: runId,
    team_id: `team_${subPlanId}`,
    team_domain: "platform",
    team_type: "domain",
    objective: "Plan a small orchestration slice.",
    status,
    scope_summary: "Small scoped plan.",
    assumptions: [],
    proposed_tasks: [],
    dependencies: [],
    risks: [],
    validation_strategy: {
      strategy_id: `strategy_${subPlanId}`,
      status: "planned",
      commands: [],
      required_checks: [],
      artifact_refs: [],
      notes: [],
      metadata_json: {}
    },
    required_context_refs: [],
    evidence_refs: [],
    memory_scope_refs: [],
    lock_context_refs: [],
    budget_usage: {
      max_task_count: 4,
      proposed_task_count: 0,
      max_depth: 1,
      planned_depth: 1,
      max_active_writers: 1,
      provider_read_only_worker_budget: 1,
      budget_warnings: [],
      metadata_json: {}
    },
    unresolved_questions: [],
    confidence: 0.8,
    generation_mode: "deterministic",
    validation_findings: [],
    metadata_json: {},
    created_at: new Date().toISOString()
  };
}

function fakeAggregation(runId: string): TeamSubPlanAggregation {
  return {
    aggregation_id: "aggregation_metadata_summary",
    run_id: runId,
    status: "generated",
    teams_planned: ["team_left", "team_right"],
    teams_skipped: [],
    accepted_sub_plans: ["sub_ok"],
    invalid_sub_plans: ["sub_bad"],
    cross_team_dependencies: [{
      conflict_id: "conflict_dependency",
      conflict_type: "cross_team_dependency",
      severity: "warning",
      sub_plan_ids: ["sub_ok"],
      team_ids: ["team_left", "team_right"],
      summary: "Cross-team dependency.",
      refs: [],
      metadata_json: {}
    }],
    duplicate_task_groups: [],
    scope_conflicts: [{
      conflict_id: "conflict_scope",
      conflict_type: "scope_overlap",
      severity: "blocking",
      sub_plan_ids: ["sub_ok", "sub_bad"],
      team_ids: ["team_left", "team_right"],
      summary: "Scope overlap.",
      refs: [],
      metadata_json: {}
    }],
    validation_strategy_summary: [],
    top_risks: [{
      risk_id: "risk_shared_module",
      severity: "high",
      summary: "Shared module risk",
      affected_files: ["src/shared.ts"],
      mitigation: "Sequence work.",
      evidence_refs: [],
      metadata_json: {}
    }],
    unresolved_questions: [],
    recommended_next_step: "Continue.",
    artifact_ref: "aggregation.json",
    summary_ref: "aggregation-summary.md",
    metadata_json: {},
    created_at: new Date().toISOString()
  };
}

function fakeReadinessBatch(runId: string): ExecutionReadinessBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "batch_metadata_summary",
    run_id: runId,
    graph_id: "graph_metadata_summary",
    request: {
      request_id: "request_metadata_summary",
      run_id: runId,
      graph_id: "graph_metadata_summary",
      proposed_node_ids: [],
      policy: {
        mode: "report_only",
        allow_read_only_promotion_candidates: true,
        allow_write_future_candidates: true,
        require_human_approval_for_write: true,
        allow_auto_approval_for_low_risk_read_only: true,
        max_nodes_evaluated_per_run: 10,
        metadata_json: {}
      },
      requested_by: "test",
      metadata_json: {},
      created_at: now
    },
    decisions: [],
    approval_requirements: [],
    summary: {
      summary_id: "summary_metadata_summary",
      run_id: runId,
      graph_id: "graph_metadata_summary",
      nodes_evaluated: 4,
      ready_read_only_count: 1,
      future_write_candidate_count: 1,
      requires_human_approval_count: 1,
      blocked_count: 1,
      rejected_count: 0,
      requires_context_count: 1,
      requires_validation_count: 1,
      requires_locks_count: 1,
      readiness_summary_ref: "readiness-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "readiness-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakePreparationBatch(runId: string): ExecutionPreparationBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "preparation_batch_summary",
    run_id: runId,
    request: {
      request_id: "preparation_request_summary",
      run_id: runId,
      queue_item_ids: [],
      requested_by: "test",
      mode: "prepare_only",
      metadata_json: {},
      created_at: now
    },
    plans: [],
    summary: {
      summary_id: "preparation_summary",
      run_id: runId,
      execution_preparation_used: true,
      preparation_plan_count: 3,
      prepared_count: 1,
      blocked_count: 1,
      missing_approval_count: 1,
      missing_context_count: 0,
      missing_prompt_count: 1,
      missing_validation_count: 0,
      missing_locks_count: 0,
      stale_context_count: 0,
      cancelled_count: 0,
      preparation_summary_ref: "preparation-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "preparation-summary.json",
    metadata_json: {},
    created_at: now
  } as ExecutionPreparationBatch;
}

function fakeDryRunBatch(runId: string): OneWriterDryRunBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "dry_run_batch_summary",
    run_id: runId,
    request: {
      request_id: "dry_run_request_summary",
      run_id: runId,
      preparation_plan_ids: [],
      requested_by: "test",
      mode: "auto",
      metadata_json: {},
      created_at: now
    },
    proposals: [],
    summary: {
      summary_id: "dry_run_summary",
      run_id: runId,
      one_writer_dry_run_used: true,
      dry_run_proposal_count: 3,
      generated_count: 2,
      schema_failed_count: 1,
      scope_failed_count: 0,
      blocked_count: 0,
      review_candidate_count: 2,
      changed_files_preview: ["src/a.ts", "src/b.ts"],
      dry_run_summary_ref: "dry-run-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "dry-run-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakePatchReviewBatch(runId: string): PatchProposalReviewBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "patch_review_batch_summary",
    run_id: runId,
    request: {
      request_id: "patch_review_request_summary",
      run_id: runId,
      proposal_ids: [],
      requested_by: "test",
      mode: "auto",
      metadata_json: {},
      created_at: now
    },
    reviews: [],
    summary: {
      summary_id: "patch_review_summary",
      run_id: runId,
      patch_review_used: true,
      patch_reviews_count: 4,
      accepted_for_validation_candidate_count: 2,
      changes_requested_count: 1,
      rejected_count: 0,
      blocked_count: 1,
      review_schema_failed_count: 0,
      critical_findings_count: 1,
      high_findings_count: 2,
      review_summary_ref: "patch-review-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "patch-review-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakeValidationCandidateBatch(runId: string): ValidationCandidateBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "validation_candidate_batch_summary",
    run_id: runId,
    review_ids: ["review_1"],
    candidates: [],
    summary: {
      summary_id: "validation_candidate_summary",
      run_id: runId,
      validation_candidate_used: true,
      validation_candidate_count: 5,
      preflight_passed_count: 3,
      incomplete_count: 1,
      command_blocked_count: 1,
      environment_blocked_count: 0,
      rejected_count: 1,
      validation_candidate_summary_ref: "validation-candidate-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "validation-candidate-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakePatchSandboxBatch(runId: string): PatchSandboxBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "patch_sandbox_batch_summary",
    run_id: runId,
    validation_candidate_ids: ["candidate_1"],
    results: [],
    summary: {
      summary_id: "patch_sandbox_summary",
      run_id: runId,
      patch_apply_sandbox_used: true,
      sandbox_result_count: 4,
      dry_apply_passed_count: 3,
      dry_apply_failed_count: 1,
      conflict_count: 2,
      failed_hunk_count: 1,
      sandbox_unavailable_count: 0,
      unsafe_patch_count: 0,
      blocked_count: 0,
      main_repo_integrity_ok: false,
      sandbox_summary_ref: "patch-sandbox-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "patch-sandbox-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakeSandboxValidationBatch(runId: string): SandboxValidationBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "sandbox_validation_batch_summary",
    run_id: runId,
    sandbox_result_ids: ["sandbox_result_1"],
    results: [],
    summary: {
      summary_id: "sandbox_validation_summary",
      run_id: runId,
      sandbox_validation_used: true,
      sandbox_validation_count: 3,
      sandbox_validation_passed_count: 1,
      sandbox_validation_failed_count: 1,
      sandbox_validation_blocked_count: 0,
      sandbox_validation_partial_count: 1,
      sandbox_validation_summary_ref: "sandbox-validation-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "sandbox-validation-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakeIntegrationCandidateBatch(runId: string): IntegrationCandidateBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "integration_candidate_batch_summary",
    run_id: runId,
    sandbox_validation_ids: ["sandbox_validation_1"],
    candidates: [],
    results: [],
    summary: {
      summary_id: "integration_candidate_summary",
      run_id: runId,
      sandbox_integration_candidate_used: true,
      integration_candidate_count: 3,
      candidate_created_count: 1,
      blocked_count: 1,
      rejected_count: 1,
      validation_failed_count: 1,
      validation_blocked_count: 1,
      candidate_summary_ref: "candidate-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "candidate-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakeIntegrationApplyApprovalBatch(runId: string): IntegrationApplyApprovalBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "integration_apply_approval_batch_summary",
    run_id: runId,
    integration_candidate_ids: ["integration_candidate_1"],
    approvals: [],
    results: [],
    summary: {
      summary_id: "integration_apply_approval_summary",
      run_id: runId,
      integration_apply_approval_used: true,
      apply_approval_count: 3,
      approved_for_apply_candidate_count: 1,
      requires_human_approval_count: 1,
      blocked_count: 1,
      rejected_count: 0,
      dirty_worktree_blocked_count: 1,
      apply_mode_recommendation_count: 2,
      apply_approval_summary_ref: "apply-approval-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "apply-approval-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakeControlledApplyBatch(runId: string): ControlledApplyBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "controlled_apply_batch_summary",
    run_id: runId,
    integration_candidate_ids: ["integration_candidate_1"],
    results: [],
    summary: {
      summary_id: "controlled_apply_summary",
      run_id: runId,
      controlled_apply_used: true,
      controlled_apply_count: 3,
      applied_count: 1,
      post_validation_passed_count: 1,
      post_validation_failed_count: 1,
      rolled_back_count: 1,
      rollback_failed_count: 1,
      lock_failed_count: 0,
      blocked_count: 1,
      controlled_apply_summary_ref: "controlled-apply-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "controlled-apply-summary.json",
    metadata_json: {},
    created_at: now
  };
}

function fakeIntegrationFinalizationBatch(runId: string): IntegrationFinalizationBatch {
  const now = new Date().toISOString();
  return {
    batch_id: "integration_finalization_batch_summary",
    run_id: runId,
    controlled_apply_ids: ["controlled_apply_1"],
    results: [],
    summary: {
      summary_id: "integration_finalization_summary",
      run_id: runId,
      integration_finalization_used: true,
      integration_finalization_count: 2,
      finalized_count: 1,
      validation_failed_count: 1,
      rollback_completed_count: 1,
      rollback_failed_count: 0,
      memory_entries_created_count: 3,
      lessons_created_count: 2,
      finalization_summary_ref: "finalization-summary.json",
      metadata_json: {},
      created_at: now
    },
    summary_ref: "finalization-summary.json",
    metadata_json: {},
    created_at: now
  };
}
