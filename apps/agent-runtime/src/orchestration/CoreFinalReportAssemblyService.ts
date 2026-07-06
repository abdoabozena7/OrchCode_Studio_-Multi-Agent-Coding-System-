import { randomUUID } from "node:crypto";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { AgentTeamHierarchy } from "./AgentTeamModels.js";
import { CoreFinalReportArtifactSummaryService } from "./CoreFinalReportArtifactSummaryService.js";
import { CoreFinalReportMetadataSummaryService } from "./CoreFinalReportMetadataSummaryService.js";
import {
  executorProviderTruthLimitation,
  validationTruthLimitations
} from "./CoreFinalReportPolicy.js";
import type { IntentReviewResult } from "./IntentLedgerModels.js";
import type { IntegrationResult as FactoryIntegrationResult } from "./IntegrationModels.js";
import type { MultiPlanSummary } from "./MultiPlanModels.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type FinalRunReport,
  type OrchestratorEvent,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { assertValid, validateFinalRunReport } from "./Validation.js";

export type CoreFinalReportAssemblyInput = {
  run: Run;
  tasks: Task[];
  outputs: ParsedAgentOutput[];
  extraLimitations: string[];
  multiPlanSummary?: MultiPlanSummary;
  integration?: FactoryIntegrationResult;
  teamHierarchy?: AgentTeamHierarchy;
};

export type CoreFinalReportAssemblyOptions = {
  config: OrchestrationSafetyConfig;
  artifactStore: OrchestrationArtifactStore;
  artifactSummaries: CoreFinalReportArtifactSummaryService;
  metadataSummaries: CoreFinalReportMetadataSummaryService;
  reviewFinalIntent?: (
    run: Run,
    candidate: unknown,
    reviewedArtifactRefs: Array<string | undefined>
  ) => Promise<IntentReviewResult | undefined>;
  eventFactory?: (runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string) => OrchestratorEvent;
};

export class CoreFinalReportAssemblyService {
  private readonly eventFactory: NonNullable<CoreFinalReportAssemblyOptions["eventFactory"]>;

  constructor(private readonly options: CoreFinalReportAssemblyOptions) {
    this.eventFactory = options.eventFactory ?? defaultEvent;
  }

  async create(input: CoreFinalReportAssemblyInput): Promise<FinalRunReport> {
    const { run, tasks, outputs, extraLimitations, multiPlanSummary, integration, teamHierarchy } = input;
    const promptWriterSummary = await this.options.artifactSummaries.promptWriterReportSummary(tasks);
    const lockSummary = await this.options.artifactSummaries.lockReportSummary(run, tasks);
    const finalIntentReview = await this.options.reviewFinalIntent?.(run, {
      user_request: run.user_request,
      intent_contract_ref: run.intent_contract_ref,
      intent_contract_status: run.intent_contract_status,
      status: run.status,
      task_results: tasks.map((task) => ({
        task_id: task.id,
        title: task.title,
        objective: task.objective,
        status: task.status,
        role_required: task.role_required,
        artifacts: task.artifacts
      })),
      outputs: outputs.map((output) => ({
        summary: output.summary,
        files_changed: output.files_changed,
        validation_results: output.validation_results,
        limitations: output.limitations,
        next_recommendations: output.next_recommendations
      })),
      extra_limitations: extraLimitations,
      multi_plan_summary: multiPlanSummary,
      integration: integration ? {
        status: integration.status,
        applied_count: integration.applied_candidates.length,
        rejected_count: integration.rejected_candidates.length,
        blocked_count: integration.blocked_candidates.length,
        conflicts_count: integration.conflicts.length,
        validation_status: integration.validation_status,
        artifact_ref: integration.artifact_ref
      } : undefined,
      team_hierarchy: teamHierarchy ? {
        root_team_id: teamHierarchy.root_team_id,
        team_count: teamHierarchy.teams.length,
        max_depth: teamHierarchy.max_depth,
        blocked_teams: teamHierarchy.teams.filter((team) => team.status === "blocked").map((team) => team.team_id)
      } : undefined
    }, [
      run.original_request_ref,
      run.intent_contract_ref,
      run.intent_ledger_ref,
      multiPlanSummary?.merged_plan_ref,
      integration?.artifact_ref,
      teamHierarchy?.artifact_ref,
      ...tasks.flatMap((task) => task.artifacts)
    ]);

    const report: FinalRunReport = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      run_id: run.id,
      status: run.status,
      user_request: run.user_request,
      tasks_created: tasks.length,
      tasks_completed: tasks.filter((task) => task.status === "succeeded").length,
      tasks_failed: tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
      files_changed: uniqueStrings(outputs.flatMap((output) => output.files_changed)),
      validation_results: outputs.flatMap((output) => output.validation_results),
      artifacts_path: run.artifacts_path,
      limitations: uniqueStrings([
        "Phase 4 keeps parallel execution conservative by default; it is not a full background swarm yet.",
        executorProviderTruthLimitation(outputs),
        ...validationTruthLimitations(run, outputs),
        ...outputs.flatMap((output) => output.limitations),
        ...extraLimitations
      ]),
      next_recommendations: uniqueStrings([
        ...outputs.flatMap((output) => output.next_recommendations),
        "Next hardening should connect real provider-backed worker roles and shared Rust command execution authority."
      ]).slice(0, 8),
      completed_tasks: tasks.filter((task) => task.status === "succeeded").map((task) => task.id),
      failed_tasks: tasks.filter((task) => task.status === "failed" || task.status === "blocked").map((task) => task.id),
      changed_files: uniqueStrings(outputs.flatMap((output) => output.files_changed)),
      unresolved_risks: uniqueStrings([
        ...validationTruthLimitations(run, outputs),
        ...outputs.flatMap((output) => output.limitations),
        ...extraLimitations,
        ...(multiPlanSummary?.top_risks ?? [])
      ]),
      next_steps: uniqueStrings([
        ...outputs.flatMap((output) => output.next_recommendations),
        "Inspect review and validation artifacts before applying any proposed patch.",
        multiPlanSummary?.recommended_next_step ?? ""
      ]).slice(0, 8),
      multi_plan_used: multiPlanSummary?.multi_plan_used ?? false,
      generation_mode: multiPlanSummary?.generation_mode,
      plan_variant_count: multiPlanSummary?.plan_variant_count ?? 0,
      selected_perspectives: multiPlanSummary?.selected_perspectives ?? [],
      rejected_perspectives: multiPlanSummary?.rejected_perspectives ?? [],
      top_risks: multiPlanSummary?.top_risks ?? [],
      merged_plan_ref: multiPlanSummary?.merged_plan_ref,
      confidence: multiPlanSummary?.confidence,
      unresolved_questions: multiPlanSummary?.unresolved_questions ?? [],
      evidence_used: multiPlanSummary?.evidence_used ?? false,
      evidence_item_count: multiPlanSummary?.evidence_item_count ?? 0,
      provider_evidence_count: multiPlanSummary?.provider_evidence_count ?? 0,
      low_confidence_count: multiPlanSummary?.low_confidence_count ?? 0,
      rejected_evidence_count: multiPlanSummary?.rejected_evidence_count ?? 0,
      evidence_conflict_count: multiPlanSummary?.evidence_conflict_count ?? 0,
      evidence_bundle_ref: multiPlanSummary?.evidence_bundle_ref,
      top_evidence_sources: multiPlanSummary?.top_evidence_sources ?? [],
      evidence_limitations: multiPlanSummary?.evidence_limitations ?? [],
      prompt_writer_mode: this.options.config.prompt_writer_mode,
      prompt_writer_runs: promptWriterSummary.prompt_writer_runs,
      adopted_count: promptWriterSummary.adopted_count,
      rejected_count: promptWriterSummary.rejected_count,
      shadow_count: promptWriterSummary.shadow_count,
      fallback_count: promptWriterSummary.fallback_count,
      failed_schema_count: promptWriterSummary.failed_schema_count,
      failed_quality_count: promptWriterSummary.failed_quality_count,
      top_missing_context_warnings: promptWriterSummary.top_missing_context_warnings,
      locks_requested: lockSummary.locks_requested,
      locks_acquired: lockSummary.locks_acquired,
      locks_rejected: lockSummary.locks_rejected,
      advisory_locks: lockSummary.advisory_locks,
      semantic_locks: lockSummary.semantic_locks,
      module_locks: lockSummary.module_locks,
      expired_locks_recovered: lockSummary.expired_locks_recovered,
      active_locks_at_end: lockSummary.active_locks_at_end,
      blocking_conflicts: lockSummary.blocking_conflicts,
      integration_status: integration?.status,
      candidates_found: integration
        ? integration.applied_candidates.length + integration.rejected_candidates.length + integration.blocked_candidates.length
        : undefined,
      candidates_applied: integration?.applied_candidates.length,
      conflicts_count: integration?.conflicts.length,
      integration_validation_status: integration?.validation_status,
      rollback_available: integration?.rollback_available,
      blocked_reason: integration?.blocked_reason,
      integration_result_ref: integration?.artifact_ref,
      root_team_id: teamHierarchy?.root_team_id,
      team_count: teamHierarchy?.teams.length,
      max_team_depth: teamHierarchy?.max_depth,
      domain_teams: teamHierarchy?.teams.filter((team) => team.team_type === "domain").map((team) => team.domain),
      blocked_teams: teamHierarchy?.teams.filter((team) => team.status === "blocked").map((team) => team.team_id),
      budget_warnings: teamHierarchy?.warnings,
      hierarchy_ref: teamHierarchy?.artifact_ref
    };
    report.intent_review_used = Boolean(finalIntentReview);
    report.intent_alignment_status = finalIntentReview?.status;
    report.intent_drift_count = countIntentDriftFindings(finalIntentReview);
    report.original_request_ref = run.original_request_ref;
    report.intent_ledger_ref = run.intent_ledger_ref;
    report.intent_contract_ref = run.intent_contract_ref;
    report.intent_contract_status = run.intent_contract_status;
    report.intent_review_ref = finalIntentReview?.artifact_ref;
    report.intent_rewrite_suggestion_ref = finalIntentReview?.rewrite_suggestion_ref;

    await this.addMetadataSummaries(report, run.id);

    assertValid("FinalRunReport", report, validateFinalRunReport);
    const reportPath = await this.options.artifactStore.saveFinalReport(report);
    await this.options.artifactStore.appendEvent(this.event(run.id, "run.reported", `Final report written: ${reportPath}`, {
      report: reportPath
    }));
    return report;
  }

  private async addMetadataSummaries(report: FinalRunReport, runId: string) {
    const teamContextSummary = await this.options.metadataSummaries.teamContextReportSummary(runId);
    report.team_context_used = teamContextSummary.team_context_used;
    report.team_context_scope_count = teamContextSummary.team_context_scope_count;
    report.team_memory_queries = teamContextSummary.team_memory_queries;
    report.team_scope_fallbacks = teamContextSummary.team_scope_fallbacks;
    report.team_scope_warnings = teamContextSummary.team_scope_warnings;
    report.stale_or_low_confidence_team_context_items = teamContextSummary.stale_or_low_confidence_team_context_items;
    const teamSubPlanningSummary = await this.options.metadataSummaries.teamSubPlanningReportSummary(runId);
    report.team_sub_planning_used = teamSubPlanningSummary.team_sub_planning_used;
    report.sub_plan_count = teamSubPlanningSummary.sub_plan_count;
    report.invalid_sub_plan_count = teamSubPlanningSummary.invalid_sub_plan_count;
    report.teams_planned = teamSubPlanningSummary.teams_planned;
    report.cross_team_dependency_count = teamSubPlanningSummary.cross_team_dependency_count;
    report.scope_conflict_count = teamSubPlanningSummary.scope_conflict_count;
    report.top_team_risks = teamSubPlanningSummary.top_team_risks;
    report.aggregation_ref = teamSubPlanningSummary.aggregation_ref;
    const adoptionSummary = await this.options.metadataSummaries.teamTaskAdoptionReportSummary(runId);
    report.team_task_adoption_used = adoptionSummary.team_task_adoption_used;
    report.drafts_evaluated = adoptionSummary.drafts_evaluated;
    report.adopted_metadata_only_count = adoptionSummary.adopted_metadata_only_count;
    report.adopted_read_only_count = adoptionSummary.adopted_read_only_count;
    report.task_adoption_rejected_count = adoptionSummary.rejected_count;
    report.task_adoption_duplicate_count = adoptionSummary.duplicate_count;
    report.task_adoption_blocked_count = adoptionSummary.blocked_count;
    report.future_write_candidate_count = adoptionSummary.future_write_candidate_count;
    report.executable_ready_count = adoptionSummary.executable_ready_count;
    report.adoption_summary_ref = adoptionSummary.adoption_summary_ref;
    const proposedGraphSummary = await this.options.metadataSummaries.proposedTaskGraphReportSummary(runId);
    report.proposed_task_graph_used = proposedGraphSummary.proposed_task_graph_used;
    report.proposed_node_count = proposedGraphSummary.proposed_node_count;
    report.proposed_edge_count = proposedGraphSummary.proposed_edge_count;
    report.read_only_ready_count = proposedGraphSummary.read_only_ready_count;
    report.proposed_graph_future_write_candidate_count = proposedGraphSummary.future_write_candidate_count;
    report.proposed_graph_blocked_count = proposedGraphSummary.blocked_count;
    report.proposed_graph_duplicate_count = proposedGraphSummary.duplicate_count;
    report.cycle_count = proposedGraphSummary.cycle_count;
    report.proposed_graph_scope_overlap_count = proposedGraphSummary.scope_overlap_count;
    report.graph_summary_ref = proposedGraphSummary.graph_summary_ref;
    const executionReadinessSummary = await this.options.metadataSummaries.executionReadinessReportSummary(runId);
    report.execution_readiness_used = executionReadinessSummary.execution_readiness_used;
    report.nodes_evaluated = executionReadinessSummary.nodes_evaluated;
    report.ready_read_only_count = executionReadinessSummary.ready_read_only_count;
    report.execution_future_write_candidate_count = executionReadinessSummary.future_write_candidate_count;
    report.requires_human_approval_count = executionReadinessSummary.requires_human_approval_count;
    report.execution_readiness_blocked_count = executionReadinessSummary.blocked_count;
    report.execution_readiness_rejected_count = executionReadinessSummary.rejected_count;
    report.requires_context_count = executionReadinessSummary.requires_context_count;
    report.requires_validation_count = executionReadinessSummary.requires_validation_count;
    report.requires_locks_count = executionReadinessSummary.requires_locks_count;
    report.readiness_summary_ref = executionReadinessSummary.readiness_summary_ref;
    const promotionSummary = await this.options.metadataSummaries.approvalPromotionReportSummary(runId);
    report.promotion_requests_created = promotionSummary.promotion_requests_created;
    report.approvals_required = promotionSummary.approvals_required;
    report.approvals_granted = promotionSummary.approvals_granted;
    report.approvals_denied = promotionSummary.approvals_denied;
    report.approvals_expired = promotionSummary.approvals_expired;
    report.queue_items_created = promotionSummary.queue_items_created;
    report.queue_items_blocked = promotionSummary.queue_items_blocked;
    report.read_only_candidates = promotionSummary.read_only_candidates;
    report.write_candidates_waiting_approval = promotionSummary.write_candidates_waiting_approval;
    report.approval_summary_ref = promotionSummary.approval_summary_ref;
    report.promotion_queue_summary_ref = promotionSummary.promotion_queue_summary_ref;
    const preparationSummary = await this.options.metadataSummaries.executionPreparationReportSummary(runId);
    report.execution_preparation_used = preparationSummary.execution_preparation_used;
    report.preparation_plan_count = preparationSummary.preparation_plan_count;
    report.prepared_count = preparationSummary.prepared_count;
    report.blocked_count = preparationSummary.blocked_count;
    report.missing_approval_count = preparationSummary.missing_approval_count;
    report.missing_context_count = preparationSummary.missing_context_count;
    report.missing_prompt_count = preparationSummary.missing_prompt_count;
    report.missing_validation_count = preparationSummary.missing_validation_count;
    report.missing_locks_count = preparationSummary.missing_locks_count;
    report.stale_context_count = preparationSummary.stale_context_count;
    report.preparation_summary_ref = preparationSummary.preparation_summary_ref;
    const dryRunSummary = await this.options.metadataSummaries.oneWriterDryRunReportSummary(runId);
    report.one_writer_dry_run_used = dryRunSummary.one_writer_dry_run_used;
    report.dry_run_proposal_count = dryRunSummary.dry_run_proposal_count;
    report.generated_count = dryRunSummary.generated_count;
    report.schema_failed_count = dryRunSummary.schema_failed_count;
    report.scope_failed_count = dryRunSummary.scope_failed_count;
    report.dry_run_blocked_count = dryRunSummary.blocked_count;
    report.review_candidate_count = dryRunSummary.review_candidate_count;
    report.changed_files_preview = dryRunSummary.changed_files_preview;
    report.dry_run_summary_ref = dryRunSummary.dry_run_summary_ref;
    const patchReviewSummary = await this.options.metadataSummaries.patchProposalReviewReportSummary(runId);
    report.patch_review_used = patchReviewSummary.patch_review_used;
    report.patch_reviews_count = patchReviewSummary.patch_reviews_count;
    report.accepted_for_validation_candidate_count = patchReviewSummary.accepted_for_validation_candidate_count;
    report.changes_requested_count = patchReviewSummary.changes_requested_count;
    report.patch_review_rejected_count = patchReviewSummary.rejected_count;
    report.patch_review_blocked_count = patchReviewSummary.blocked_count;
    report.review_schema_failed_count = patchReviewSummary.review_schema_failed_count;
    report.critical_findings_count = patchReviewSummary.critical_findings_count;
    report.high_findings_count = patchReviewSummary.high_findings_count;
    report.review_summary_ref = patchReviewSummary.review_summary_ref;
    const validationCandidateSummary = await this.options.metadataSummaries.validationCandidateReportSummary(runId);
    report.validation_candidate_used = validationCandidateSummary.validation_candidate_used;
    report.validation_candidate_count = validationCandidateSummary.validation_candidate_count;
    report.preflight_passed_count = validationCandidateSummary.preflight_passed_count;
    report.incomplete_count = validationCandidateSummary.incomplete_count;
    report.command_blocked_count = validationCandidateSummary.command_blocked_count;
    report.environment_blocked_count = validationCandidateSummary.environment_blocked_count;
    report.validation_candidate_rejected_count = validationCandidateSummary.rejected_count;
    report.validation_candidate_summary_ref = validationCandidateSummary.validation_candidate_summary_ref;
    const patchApplySummary = await this.options.metadataSummaries.patchApplySandboxReportSummary(runId);
    report.patch_apply_sandbox_used = patchApplySummary.patch_apply_sandbox_used;
    report.sandbox_result_count = patchApplySummary.sandbox_result_count;
    report.dry_apply_passed_count = patchApplySummary.dry_apply_passed_count;
    report.dry_apply_failed_count = patchApplySummary.dry_apply_failed_count;
    report.conflict_count = patchApplySummary.conflict_count;
    report.failed_hunk_count = patchApplySummary.failed_hunk_count;
    report.sandbox_unavailable_count = patchApplySummary.sandbox_unavailable_count;
    report.main_repo_integrity_ok = patchApplySummary.main_repo_integrity_ok;
    report.sandbox_summary_ref = patchApplySummary.sandbox_summary_ref;
    const sandboxValidationSummary = await this.options.metadataSummaries.sandboxValidationReportSummary(runId);
    report.sandbox_validation_used = sandboxValidationSummary.sandbox_validation_used;
    report.sandbox_validation_count = sandboxValidationSummary.sandbox_validation_count;
    report.sandbox_validation_passed_count = sandboxValidationSummary.sandbox_validation_passed_count;
    report.sandbox_validation_failed_count = sandboxValidationSummary.sandbox_validation_failed_count;
    report.sandbox_validation_blocked_count = sandboxValidationSummary.sandbox_validation_blocked_count;
    report.sandbox_validation_partial_count = sandboxValidationSummary.sandbox_validation_partial_count;
    report.sandbox_validation_summary_ref = sandboxValidationSummary.sandbox_validation_summary_ref;
    const sandboxIntegrationCandidateSummary = await this.options.metadataSummaries.sandboxIntegrationCandidateReportSummary(runId);
    report.sandbox_integration_candidate_used = sandboxIntegrationCandidateSummary.sandbox_integration_candidate_used;
    report.integration_candidate_count = sandboxIntegrationCandidateSummary.integration_candidate_count;
    report.candidate_created_count = sandboxIntegrationCandidateSummary.candidate_created_count;
    report.candidate_blocked_count = sandboxIntegrationCandidateSummary.blocked_count;
    report.candidate_rejected_count = sandboxIntegrationCandidateSummary.rejected_count;
    report.candidate_validation_failed_count = sandboxIntegrationCandidateSummary.validation_failed_count;
    report.candidate_validation_blocked_count = sandboxIntegrationCandidateSummary.validation_blocked_count;
    report.candidate_summary_ref = sandboxIntegrationCandidateSummary.candidate_summary_ref;
    const applyApprovalSummary = await this.options.metadataSummaries.integrationApplyApprovalReportSummary(runId);
    report.integration_apply_approval_used = applyApprovalSummary.integration_apply_approval_used;
    report.apply_approval_count = applyApprovalSummary.apply_approval_count;
    report.approved_for_apply_candidate_count = applyApprovalSummary.approved_for_apply_candidate_count;
    report.apply_approval_requires_human_approval_count = applyApprovalSummary.requires_human_approval_count;
    report.apply_approval_blocked_count = applyApprovalSummary.blocked_count;
    report.apply_approval_rejected_count = applyApprovalSummary.rejected_count;
    report.dirty_worktree_blocked_count = applyApprovalSummary.dirty_worktree_blocked_count;
    report.apply_mode_recommendation_count = applyApprovalSummary.apply_mode_recommendation_count;
    report.apply_approval_summary_ref = applyApprovalSummary.apply_approval_summary_ref;
    const controlledApplySummary = await this.options.metadataSummaries.controlledApplyReportSummary(runId);
    report.controlled_apply_used = controlledApplySummary.controlled_apply_used;
    report.controlled_apply_count = controlledApplySummary.controlled_apply_count;
    report.applied_count = controlledApplySummary.applied_count;
    report.post_validation_passed_count = controlledApplySummary.post_validation_passed_count;
    report.post_validation_failed_count = controlledApplySummary.post_validation_failed_count;
    report.rolled_back_count = controlledApplySummary.rolled_back_count;
    report.rollback_failed_count = controlledApplySummary.rollback_failed_count;
    report.lock_failed_count = controlledApplySummary.lock_failed_count;
    report.controlled_apply_blocked_count = controlledApplySummary.blocked_count;
    report.controlled_apply_summary_ref = controlledApplySummary.controlled_apply_summary_ref;
    const integrationFinalizationSummary = await this.options.metadataSummaries.integrationFinalizationReportSummary(runId);
    report.integration_finalization_used = integrationFinalizationSummary.integration_finalization_used;
    report.integration_finalization_count = integrationFinalizationSummary.integration_finalization_count;
    report.finalized_count = integrationFinalizationSummary.finalized_count;
    report.finalization_validation_failed_count = integrationFinalizationSummary.validation_failed_count;
    report.finalization_rollback_completed_count = integrationFinalizationSummary.rollback_completed_count;
    report.finalization_rollback_failed_count = integrationFinalizationSummary.rollback_failed_count;
    report.memory_entries_created_count = integrationFinalizationSummary.memory_entries_created_count;
    report.lessons_created_count = integrationFinalizationSummary.lessons_created_count;
    report.finalization_summary_ref = integrationFinalizationSummary.finalization_summary_ref;
    const goalStewardSummary = await this.options.metadataSummaries.goalStewardReportSummary(runId);
    report.goal_steward_used = goalStewardSummary.goal_steward_used;
    report.goal_alignment_status = goalStewardSummary.goal_alignment_status;
    report.goal_conflict_count = goalStewardSummary.goal_conflict_count;
    report.project_goal_spec_ref = goalStewardSummary.project_goal_spec_ref;
    report.goal_steward_review_ref = goalStewardSummary.goal_steward_review_ref;
  }

  private event(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
    return this.eventFactory(runId, type, message, payload, taskId);
  }
}

function defaultEvent(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
  return {
    id: `event_${randomUUID()}`,
    run_id: runId,
    task_id: taskId,
    type,
    message,
    created_at: new Date().toISOString(),
    payload
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function countIntentDriftFindings(review: IntentReviewResult | undefined) {
  return review?.findings.filter((finding) =>
    finding.finding_type === "possible_drift" || finding.finding_type === "drift_detected"
  ).length ?? 0;
}
