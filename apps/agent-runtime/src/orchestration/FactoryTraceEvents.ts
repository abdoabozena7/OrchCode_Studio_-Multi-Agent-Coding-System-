import { createHash, randomUUID } from "node:crypto";
import type { OrchestratorEvent } from "./OrchestrationModels.js";
import type { CanonicalRunStatus } from "./RunStateMachine.js";
import type { SchedulerTraceEntry, SwarmEvent } from "./SwarmModels.js";

export const FACTORY_TRACE_EVENT_TYPES = [
  "run_created",
  "run_transition_requested",
  "run_transition_accepted",
  "run_transition_rejected",
  "run_blocked",
  "run_failed",
  "run_resumed",
  "run_resume_mismatch_detected",
  "task_created",
  "task_status_changed",
  "task_dependency_ready",
  "multi_plan_started",
  "plan_variant_created",
  "plan_variant_evaluated",
  "plan_variant_rejected",
  "plan_variant_selected",
  "plan_merge_started",
  "plan_merge_completed",
  "merged_plan_artifact_written",
  "multi_plan_skipped",
  "planning_evidence_collection_started",
  "planning_evidence_item_collected",
  "planning_evidence_item_rejected",
  "planning_evidence_bundle_created",
  "planning_evidence_used_by_plan",
  "planning_evidence_used_by_evaluation",
  "planning_evidence_used_by_merge",
  "planning_evidence_conflict_detected",
  "planning_evidence_unavailable",
  "worker_provider_selected",
  "worker_provider_unavailable",
  "worker_read_only_guard_passed",
  "worker_read_only_guard_blocked",
  "provider_invocation_started",
  "provider_invocation_completed",
  "provider_invocation_failed",
  "provider_output_saved",
  "provider_output_schema_validated",
  "provider_output_schema_repaired",
  "provider_output_schema_failed",
  "provider_worker_result_recorded",
  "provider_worker_fallback_to_mock",
  "context_pack_created",
  "context_item_included",
  "context_item_excluded",
  "context_freshness_warning",
  "context_fallback_used",
  "prompt_template_selected",
  "prompt_render_started",
  "prompt_created",
  "prompt_rendered",
  "prompt_render_failed",
  "prompt_artifact_written",
  "prompt_metadata_recorded",
  "prompt_quality_started",
  "prompt_quality_completed",
  "prompt_quality_warning",
  "prompt_quality_failed",
  "prompt_quality_blocked",
  "prompt_quality_metadata_recorded",
  "prompt_writer_started",
  "prompt_writer_input_created",
  "prompt_writer_provider_selected",
  "prompt_writer_provider_unavailable",
  "prompt_writer_output_saved",
  "prompt_writer_output_schema_validated",
  "prompt_writer_output_schema_failed",
  "prompt_writer_candidate_prompt_rendered",
  "prompt_writer_quality_gate_started",
  "prompt_writer_quality_gate_completed",
  "prompt_writer_adoption_evaluated",
  "prompt_writer_adopted",
  "prompt_writer_rejected",
  "prompt_writer_shadow_recorded",
  "prompt_writer_fallback_used",
  "agent_invocation_started",
  "agent_invocation_completed",
  "agent_invocation_failed",
  "raw_output_saved",
  "parsed_output_saved",
  "output_schema_validated",
  "output_schema_failed",
  "review_started",
  "review_completed",
  "review_requested_changes",
  "validation_started",
  "validation_command_started",
  "validation_command_completed",
  "validation_completed",
  "validation_failed",
  "validation_blocked",
  "validation_skipped",
  "validation_partial",
  "validation_not_required",
  "validation_not_run",
  "patch_proposed",
  "patch_scope_checked",
  "patch_rejected",
  "integration_started",
  "integration_candidate_discovered",
  "integration_candidate_rejected",
  "integration_plan_created",
  "integration_conflict_detected",
  "integration_locks_requested",
  "integration_locks_acquired",
  "integration_locks_rejected",
  "integration_apply_started",
  "integration_apply_completed",
  "integration_apply_failed",
  "integration_validation_started",
  "integration_validation_completed",
  "integration_validation_failed",
  "integration_blocked",
  "integration_passed",
  "integration_completed",
  "integration_failed",
  "integration_rollback_planned",
  "integration_rollback_completed",
  "integration_not_required",
  "agent_team_root_created",
  "agent_team_proposed",
  "agent_team_created",
  "agent_team_child_created",
  "agent_team_hierarchy_validated",
  "agent_team_budget_inherited",
  "agent_team_budget_exceeded",
  "agent_team_scope_validated",
  "agent_team_scope_rejected",
  "agent_team_task_assigned",
  "agent_team_agent_assigned",
  "agent_team_blocked",
  "agent_team_completed",
  "team_context_scope_resolved",
  "team_context_scope_fallback",
  "team_context_item_included",
  "team_context_item_excluded",
  "team_memory_scope_queried",
  "team_memory_scope_fallback",
  "team_scope_validation_passed",
  "team_scope_validation_failed",
  "team_context_pack_created",
  "team_sub_planning_started",
  "team_sub_plan_input_created",
  "team_sub_plan_generated",
  "team_sub_plan_skipped",
  "team_sub_plan_invalid",
  "team_sub_plan_blocked",
  "team_sub_plan_persisted",
  "team_sub_plan_aggregation_started",
  "team_sub_plan_aggregation_completed",
  "team_sub_plan_scope_conflict_detected",
  "team_sub_plan_dependency_detected",
  "team_task_adoption_started",
  "team_task_draft_evaluated",
  "team_task_draft_adopted",
  "team_task_draft_rejected",
  "team_task_draft_duplicate_detected",
  "team_task_readiness_checked",
  "team_task_readiness_passed",
  "team_task_readiness_blocked",
  "team_task_scope_validated",
  "team_task_scope_rejected",
  "team_task_adoption_summary_created",
  "proposed_task_graph_build_started",
  "proposed_task_graph_build_skipped",
  "proposed_task_graph_node_created",
  "proposed_task_graph_edge_created",
  "proposed_task_graph_node_blocked",
  "proposed_task_graph_duplicate_detected",
  "proposed_task_graph_scope_overlap_detected",
  "proposed_task_graph_cycle_detected",
  "proposed_task_graph_validated",
  "proposed_task_graph_persisted",
  "proposed_task_graph_summary_created",
  "execution_readiness_started",
  "execution_readiness_node_evaluated",
  "execution_readiness_requirement_passed",
  "execution_readiness_requirement_failed",
  "execution_readiness_blocked",
  "execution_readiness_human_approval_required",
  "execution_readiness_read_only_ready",
  "execution_readiness_future_write_candidate",
  "execution_readiness_dry_run_prompt_checked",
  "execution_readiness_context_checked",
  "execution_readiness_locks_derived",
  "execution_readiness_batch_completed",
  "execution_readiness_summary_created",
  "execution_promotion_request_created",
  "execution_promotion_request_blocked",
  "human_approval_required",
  "human_approval_recorded",
  "human_approval_denied",
  "human_approval_revoked",
  "human_approval_expired",
  "human_approval_scope_validated",
  "human_approval_scope_rejected",
  "promotion_queue_item_created",
  "promotion_queue_item_blocked",
  "promotion_queue_item_cancelled",
  "promotion_queue_summary_created",
  "execution_preparation_started",
  "execution_preparation_queue_item_loaded",
  "execution_preparation_context_prepared",
  "execution_preparation_prompt_prepared",
  "execution_preparation_prompt_quality_passed",
  "execution_preparation_prompt_quality_blocked",
  "execution_preparation_locks_derived",
  "execution_preparation_validation_plan_created",
  "execution_preparation_review_policy_created",
  "execution_preparation_integration_preview_created",
  "execution_preparation_blocked",
  "execution_preparation_completed",
  "execution_preparation_batch_completed",
  "execution_preparation_summary_created",
  "one_writer_dry_run_started",
  "one_writer_dry_run_preparation_loaded",
  "one_writer_dry_run_prompt_checked",
  "one_writer_dry_run_provider_selected",
  "one_writer_dry_run_provider_started",
  "one_writer_dry_run_provider_completed",
  "one_writer_dry_run_provider_failed",
  "patch_proposal_raw_output_saved",
  "patch_proposal_schema_validated",
  "patch_proposal_schema_failed",
  "patch_proposal_scope_check_started",
  "patch_proposal_scope_check_passed",
  "patch_proposal_scope_check_failed",
  "patch_proposal_generated",
  "patch_proposal_blocked",
  "patch_proposal_review_candidate_created",
  "one_writer_dry_run_batch_completed",
  "one_writer_dry_run_summary_created",
  "patch_proposal_review_started",
  "patch_proposal_review_prompt_checked",
  "patch_proposal_review_provider_selected",
  "patch_proposal_review_provider_started",
  "patch_proposal_review_provider_completed",
  "patch_proposal_review_provider_failed",
  "patch_proposal_review_output_saved",
  "patch_proposal_review_schema_validated",
  "patch_proposal_review_schema_failed",
  "patch_proposal_review_completed",
  "patch_proposal_review_changes_requested",
  "patch_proposal_review_rejected",
  "patch_proposal_review_blocked",
  "patch_proposal_review_validation_candidate_created",
  "patch_proposal_review_batch_completed",
  "patch_proposal_review_summary_created",
  "validation_candidate_started",
  "validation_candidate_created",
  "validation_candidate_rejected",
  "validation_candidate_preflight_started",
  "validation_command_preflight_checked",
  "validation_command_preflight_blocked",
  "validation_environment_preflight_checked",
  "validation_candidate_preflight_passed",
  "validation_candidate_preflight_blocked",
  "validation_candidate_summary_created",
  "validation_candidate_batch_completed",
  "patch_apply_sandbox_started",
  "patch_apply_sandbox_created",
  "patch_apply_sandbox_unavailable",
  "patch_dry_apply_started",
  "patch_dry_apply_passed",
  "patch_dry_apply_failed",
  "patch_apply_conflict_detected",
  "patch_apply_failed_hunk_detected",
  "patch_apply_unsafe_patch_detected",
  "patch_apply_main_repo_integrity_checked",
  "patch_apply_sandbox_cleaned",
  "patch_apply_sandbox_result_persisted",
  "patch_apply_sandbox_batch_completed",
  "patch_apply_sandbox_summary_created",
  "sandbox_validation_started",
  "sandbox_validation_eligibility_failed",
  "sandbox_validation_command_started",
  "sandbox_validation_command_completed",
  "sandbox_validation_command_failed",
  "sandbox_validation_command_blocked",
  "sandbox_validation_command_timed_out",
  "sandbox_validation_completed",
  "sandbox_validation_failed",
  "sandbox_validation_blocked",
  "sandbox_validation_partial",
  "sandbox_validation_result_persisted",
  "sandbox_validation_batch_completed",
  "sandbox_validation_summary_created",
  "sandbox_integration_candidate_started",
  "sandbox_integration_candidate_created",
  "sandbox_integration_candidate_blocked",
  "sandbox_integration_candidate_rejected",
  "sandbox_integration_candidate_locks_derived",
  "sandbox_integration_candidate_rollback_planned",
  "sandbox_integration_candidate_post_validation_planned",
  "sandbox_integration_candidate_persisted",
  "sandbox_integration_candidate_batch_completed",
  "sandbox_integration_candidate_summary_created",
  "integration_finalization_started",
  "integration_finalization_eligibility_passed",
  "integration_finalization_eligibility_blocked",
  "integration_finalization_status_updated",
  "integration_finalization_memory_update_started",
  "integration_finalization_memory_update_completed",
  "integration_finalization_memory_update_failed",
  "integration_finalization_lesson_created",
  "integration_finalization_task_status_updated",
  "integration_finalization_completed",
  "integration_finalization_blocked",
  "integration_finalization_batch_completed",
  "integration_finalization_summary_created",
  "memory_append_started",
  "memory_append_completed",
  "report_started",
  "report_completed",
  "policy_decision_recorded",
  "lock_requested",
  "lock_acquired",
  "lock_rejected",
  "lock_conflict_detected",
  "lock_released",
  "lock_expired",
  "lock_recovered",
  "lock_heartbeat",
  "semantic_lock_derived",
  "module_lock_derived",
  "advisory_lock_recorded",
  "artifact_written",
  "metadata_record_written"
] as const;

export type FactoryTraceEventType = typeof FACTORY_TRACE_EVENT_TYPES[number] | (string & {});
export type FactoryTraceSeverity = "debug" | "info" | "warning" | "error" | "critical";
export type FactoryTraceSourceComponent =
  | "CoreOrchestrator"
  | "TaskGraphManager"
  | "OrchestrationArtifactStore"
  | "ValidationRunner"
  | "IntegrationManager"
  | "AgentTeamManager"
  | "SwarmAutopilotRuntime"
  | "SwarmScheduler"
  | "SwarmArtifactStore"
  | "FactoryMetadataStore"
  | "FactoryTraceWriter"
  | "CampaignManager"
  | "unknown"
  | (string & {});
export type FactoryTraceLifecycleStage =
  | CanonicalRunStatus
  | "task"
  | "artifact"
  | "metadata"
  | "policy"
  | "validation"
  | "review"
  | "integration"
  | "memory"
  | "reporting"
  | "unknown"
  | (string & {});
export type FactoryTraceCausalityKind = "root" | "child" | "sibling" | "derived" | "retry" | "resume" | "failure" | "unknown";

export type FactoryTraceEvent = {
  trace_event_id: string;
  run_id: string;
  campaign_id?: string;
  task_id?: string;
  parent_task_id?: string;
  agent_id?: string;
  team_id?: string;
  event_type: FactoryTraceEventType;
  lifecycle_stage?: FactoryTraceLifecycleStage;
  previous_status?: string;
  next_status?: string;
  causal_parent_event_id?: string;
  causal_chain_id: string;
  source_component: FactoryTraceSourceComponent;
  severity: FactoryTraceSeverity;
  timestamp: string;
  reason?: string;
  summary?: string;
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  causality_kind?: FactoryTraceCausalityKind;
};

export type FactoryTraceEventInput = Omit<
  FactoryTraceEvent,
  "trace_event_id" | "timestamp" | "causal_chain_id" | "artifact_refs" | "metadata_json" | "severity" | "source_component"
> & {
  trace_event_id?: string;
  timestamp?: string;
  causal_chain_id?: string;
  artifact_refs?: string[];
  metadata_json?: Record<string, unknown>;
  severity?: FactoryTraceSeverity;
  source_component?: FactoryTraceSourceComponent;
};

export type FactoryTraceSummary = {
  total_events: number;
  failed_events: number;
  blocked_events: number;
  rejected_transitions: number;
  validation_failures: number;
  artifact_refs_count: number;
  missing_causal_links_count: number;
};

export function createFactoryTraceEvent(input: FactoryTraceEventInput): FactoryTraceEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const traceEventId = input.trace_event_id ?? `trace_${traceHash(input.run_id, input.event_type, timestamp)}_${randomUUID().slice(0, 8)}`;
  return {
    trace_event_id: traceEventId,
    run_id: input.run_id,
    campaign_id: input.campaign_id,
    task_id: input.task_id,
    parent_task_id: input.parent_task_id,
    agent_id: input.agent_id,
    team_id: input.team_id,
    event_type: input.event_type,
    lifecycle_stage: input.lifecycle_stage,
    previous_status: input.previous_status,
    next_status: input.next_status,
    causal_parent_event_id: input.causal_parent_event_id,
    causal_chain_id: input.causal_chain_id ?? input.causal_parent_event_id ?? traceEventId,
    source_component: input.source_component ?? "unknown",
    severity: input.severity ?? "info",
    timestamp,
    reason: input.reason,
    summary: input.summary,
    artifact_refs: uniqueStrings(input.artifact_refs ?? []),
    metadata_json: input.metadata_json ?? {},
    causality_kind: input.causality_kind ?? (input.causal_parent_event_id ? "child" : "root")
  };
}

export function factoryTraceEventFromArtifactEvent(input: {
  event: OrchestratorEvent | SwarmEvent;
  artifactRef: string;
  causalParentEventId?: string;
  causalChainId?: string;
}): FactoryTraceEvent {
  const event = input.event;
  const isSwarm = "swarm_run_id" in event;
  const payload = event.payload ?? {};
  const runId = isSwarm ? event.swarm_run_id : event.run_id;
  const taskId = isSwarm ? event.work_item_id : event.task_id;
  const eventType = mapArtifactEventType(event.type, payload);
  const previousStatus = stringField(payload, "previous_status");
  const nextStatus = stringField(payload, "next_status") ?? stringField(payload, "status");
  return createFactoryTraceEvent({
    trace_event_id: event.id,
    run_id: runId,
    task_id: taskId,
    event_type: eventType,
    lifecycle_stage: lifecycleStageForEvent(eventType, payload, nextStatus ?? previousStatus),
    previous_status: previousStatus,
    next_status: nextStatus,
    causal_parent_event_id: input.causalParentEventId,
    causal_chain_id: input.causalChainId,
    source_component: sourceComponentForArtifactEvent(event.type, isSwarm),
    severity: severityForEvent(event.type, eventType, payload, event.message),
    timestamp: event.created_at,
    reason: stringField(payload, "reason"),
    summary: event.message,
    artifact_refs: uniqueStrings([input.artifactRef, ...extractArtifactRefs(payload)]),
    metadata_json: {
      original_event_type: event.type,
      payload_keys: Object.keys(payload).sort(),
      payload_summary: summarizeTracePayload(payload)
    }
  });
}

export function factoryTraceEventFromSchedulerTrace(input: {
  entry: SchedulerTraceEntry;
  artifactRef: string;
  causalParentEventId?: string;
  causalChainId?: string;
}): FactoryTraceEvent {
  return createFactoryTraceEvent({
    trace_event_id: input.entry.id,
    run_id: input.entry.swarm_run_id,
    event_type: "policy_decision_recorded",
    lifecycle_stage: "executing",
    causal_parent_event_id: input.causalParentEventId,
    causal_chain_id: input.causalChainId,
    source_component: "SwarmScheduler",
    severity: input.entry.selected_work_items.length ? "info" : "warning",
    timestamp: input.entry.created_at,
    summary: input.entry.decision,
    reason: input.entry.reasoning,
    artifact_refs: [input.artifactRef],
    metadata_json: {
      original_event_type: "swarm.scheduler_trace",
      tick: input.entry.tick,
      selected_work_item_count: input.entry.selected_work_items.length,
      deferred_work_item_count: input.entry.deferred_work_items.length,
      active_agent_count: input.entry.active_agent_count,
      executor_concurrency: input.entry.executor_concurrency
    }
  });
}

export function summarizeFactoryTraceEvents(events: FactoryTraceEvent[], missingCausalLinksCount = 0): FactoryTraceSummary {
  const artifactRefs = new Set(events.flatMap((event) => event.artifact_refs));
  return {
    total_events: events.length,
    failed_events: events.filter((event) => event.severity === "error" || event.severity === "critical" || event.event_type === "run_failed").length,
    blocked_events: events.filter((event) => event.event_type === "run_blocked" || event.event_type === "validation_blocked" || event.next_status === "blocked").length,
    rejected_transitions: events.filter((event) => event.event_type === "run_transition_rejected").length,
    validation_failures: events.filter((event) => event.event_type === "validation_failed" || event.event_type === "output_schema_failed" || event.event_type === "validation_partial").length,
    artifact_refs_count: artifactRefs.size,
    missing_causal_links_count: missingCausalLinksCount
  };
}

export function parseFactoryTraceMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function parseFactoryTraceArtifactRefs(value: unknown, fallback?: unknown): string[] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : undefined;
  const refs = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  if (typeof fallback === "string" && fallback.length) refs.push(fallback);
  return uniqueStrings(refs);
}

export function extractArtifactRefs(value: unknown): string[] {
  const refs: string[] = [];
  const visit = (entry: unknown, key = "", depth = 0) => {
    if (depth > 3 || entry === undefined || entry === null) return;
    if (typeof entry === "string") {
      if (looksLikeArtifactRef(key, entry)) refs.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry.slice(0, 32)) visit(item, key, depth + 1);
      return;
    }
    if (typeof entry === "object") {
      for (const [childKey, childValue] of Object.entries(entry as Record<string, unknown>)) {
        visit(childValue, childKey, depth + 1);
      }
    }
  };
  visit(value);
  return uniqueStrings(refs);
}

function mapArtifactEventType(type: string, payload: Record<string, unknown>): FactoryTraceEventType {
  if (type === "run.created" || type === "swarm.run.created") return "run_created";
  if (type === "run.status_changed") return "run_transition_accepted";
  if (type === "run.resumed") return "run_resumed";
  if (type === "run.failed") return "run_failed";
  if (type === "task.created" || type === "repair.task_created" || type === "swarm.work_item.queued" || type === "swarm.repair_item.created") return "task_created";
  if (type === "task.ready") return "task_dependency_ready";
  if (type === "task.status_changed" || type.startsWith("task.") || type === "swarm.work_item.leased") return "task_status_changed";
  if (type === "context_pack.created") return "context_pack_created";
  if (type === "agent.invocation_started" || type === "swarm.work_item.started") return "agent_invocation_started";
  if (type === "agent.invocation_finished") return /failed/i.test(String(payload.status ?? payload.summary ?? "")) ? "agent_invocation_failed" : "agent_invocation_completed";
  if (type === "swarm.work_item.succeeded") return "agent_invocation_completed";
  if (type === "swarm.work_item.failed") return "agent_invocation_failed";
  if (type === "agent.output_parsed") return "output_schema_validated";
  if (type === "agent.output_validation_failed" || type === "swarm.output_validation.failed") return "output_schema_failed";
  if (type === "agent.output_repaired") return "parsed_output_saved";
  if (type === "patch.created" || type === "swarm.executor.patch_proposed") return "patch_proposed";
  if (type === "swarm.patch.accepted") return "patch_scope_checked";
  if (type === "patch.rejected" || type === "swarm.patch.rejected") return "patch_rejected";
  if (type === "review.started") return "review_started";
  if (type === "review.completed") return payload.decision && payload.decision !== "accept" ? "review_requested_changes" : "review_completed";
  if (type === "validation.started") return "validation_started";
  if (type === "validation.command_started") return "validation_command_started";
  if (type === "validation.command_completed") return mapValidationCompletedType(payload);
  if (type === "validation.completed") return mapValidationCompletedType(payload);
  if (type === "swarm.validation.started") return "validation_started";
  if (type === "swarm.validation.completed") return payload.passed === false ? "validation_failed" : "validation_completed";
  if (type === "approval.required") return "run_blocked";
  if (type === "integration.decision_recorded" || type === "swarm.consensus.decision_made") return payload.final_status === "failed" ? "integration_failed" : "integration_completed";
  if (type === "swarm.consensus.created") return "integration_started";
  if (type === "run.reported" || type === "swarm.run.completed") return "report_completed";
  if (type === "metrics.written") return "metadata_record_written";
  if (type === "lock.acquired" || type === "swarm.lock.acquired") return "lock_acquired";
  if (type === "lock.released") return "lock_released";
  if (type === "lock.conflict" || type === "swarm.lock.denied") return "lock_rejected";
  if (type === "swarm.lock.requested") return "lock_requested";
  if (type === "artifact.written") return "artifact_written";
  if (type === "index.stale" || type === "repo.indexed" || type.startsWith("campaign.") || type.startsWith("swarm.")) return "policy_decision_recorded";
  return "metadata_record_written";
}

function mapValidationCompletedType(payload: Record<string, unknown>): FactoryTraceEventType {
  const validationStatus = stringField(payload, "validation_status") ?? stringField(payload, "status");
  if (validationStatus === "failed" || validationStatus === "timed_out") return "validation_failed";
  if (validationStatus === "blocked") return "validation_blocked";
  if (validationStatus === "skipped") return "validation_skipped";
  if (validationStatus === "partial") return "validation_partial";
  if (validationStatus === "not_required") return "validation_not_required";
  if (validationStatus === "not_run") return "validation_not_run";
  return "validation_command_completed";
}

function sourceComponentForArtifactEvent(type: string, isSwarm: boolean): FactoryTraceSourceComponent {
  if (isSwarm) {
    if (/work_item|lock|validation|patch|output_validation|concurrency/.test(type)) return "SwarmScheduler";
    return "SwarmAutopilotRuntime";
  }
  if (type.startsWith("task.")) return "TaskGraphManager";
  if (type.startsWith("validation.")) return "ValidationRunner";
  if (type.startsWith("campaign.")) return "CampaignManager";
  return "CoreOrchestrator";
}

function lifecycleStageForEvent(eventType: FactoryTraceEventType, payload: Record<string, unknown>, status?: string): FactoryTraceLifecycleStage {
  const stage = status ?? stringField(payload, "canonical_next_status") ?? stringField(payload, "next_status");
  if (stage) return stage;
  if (eventType.startsWith("validation_")) return "validating";
  if (eventType.startsWith("review_")) return "reviewing";
  if (eventType.startsWith("integration_")) return "integrating";
  if (eventType.startsWith("report_")) return "reporting";
  if (eventType.startsWith("memory_")) return "memory_update";
  if (eventType.startsWith("task_")) return "executing";
  if (eventType.startsWith("prompt_") || eventType.startsWith("agent_") || eventType.includes("output")) return "executing";
  if (eventType.startsWith("lock_")) return "executing";
  if (eventType === "run_created") return "created";
  if (eventType === "policy_decision_recorded") return "policy";
  if (eventType === "artifact_written") return "artifact";
  return "unknown";
}

function severityForEvent(type: string, eventType: FactoryTraceEventType, payload: Record<string, unknown>, message: string): FactoryTraceSeverity {
  const status = String(payload.status ?? payload.next_status ?? payload.result ?? "");
  if (/critical/i.test(message)) return "critical";
  if (eventType === "run_failed" || eventType === "run_transition_rejected" || eventType === "validation_failed" || eventType === "output_schema_failed" || eventType === "patch_rejected") return "error";
  if (eventType === "run_blocked" || eventType === "validation_blocked" || eventType === "validation_partial" || eventType === "validation_not_run" || eventType === "lock_rejected" || /blocked|denied|approval|required|partial|skipped/i.test(`${type} ${message} ${status}`)) return "warning";
  if (/failed|failure|rejected/i.test(`${type} ${message} ${status}`)) return "error";
  return "info";
}

function summarizeTracePayload(payload: Record<string, unknown>) {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof value === "string") {
      summary[key] = value.length > 200 ? `${value.slice(0, 197)}...` : value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      summary[key] = value;
    } else if (Array.isArray(value)) {
      summary[`${key}_count`] = value.length;
    } else if (typeof value === "object" && value) {
      summary[`${key}_keys`] = Object.keys(value).sort();
    }
  }
  return summary;
}

function stringField(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeArtifactRef(key: string, value: string) {
  if (!value.length || value.length > 4096) return false;
  if (/(^|_)(ref|refs|path|artifact|file|log|report)$/i.test(key)) return true;
  return /[\\/]\.agent_memory[\\/]|[\\/]runs[\\/]|[\\/]swarm_runs[\\/]/.test(value);
}

function traceHash(runId: string, type: string, timestamp: string) {
  return createHash("sha256").update([runId, type, timestamp].join("\0")).digest("hex").slice(0, 16);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
