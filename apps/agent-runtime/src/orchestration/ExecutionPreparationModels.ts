import { randomUUID } from "node:crypto";
import type { AgentRoleName } from "./OrchestrationModels.js";
import type { ReadOrWriteClassification } from "./TeamTaskAdoptionModels.js";

export type ExecutionPreparationStatus =
  | "not_required"
  | "prepared"
  | "blocked"
  | "missing_approval"
  | "missing_context"
  | "missing_prompt"
  | "missing_validation"
  | "missing_locks"
  | "missing_review_policy"
  | "missing_integration_path"
  | "unsafe_scope"
  | "stale_context"
  | "cancelled";

export type ExecutionPreparationBlockerType =
  | "missing_approval"
  | "invalid_approval"
  | "missing_queue_item"
  | "invalid_queue_status"
  | "missing_promotion_request"
  | "missing_readiness_decision"
  | "blocked_readiness"
  | "missing_proposed_node"
  | "unsafe_scope"
  | "missing_context"
  | "stale_context"
  | "missing_prompt"
  | "prompt_quality_blocked"
  | "missing_validation"
  | "missing_locks"
  | "lock_conflict"
  | "missing_review_policy"
  | "missing_integration_path"
  | "cancelled";

export type ExecutionPreparationWarningType =
  | "stale_context"
  | "low_confidence_context"
  | "advisory_lock_conflict"
  | "prompt_quality_warning"
  | "limited_rollback"
  | "read_only_no_validation"
  | "integration_preview_only"
  | "existing_preparation_conflict";

export type WriterSlot = {
  writer_slot_id: string;
  run_id: string;
  queue_item_id: string;
  proposed_node_id: string;
  writer_role: AgentRoleName | string;
  max_active_writers: 1;
  write_capable: boolean;
  invocation_allowed: false;
  provider_write_worker_allowed: false;
  scheduler_allowed: false;
  metadata_json: Record<string, unknown>;
};

export type ExecutionValidationPlan = {
  validation_plan_id: string;
  status: "not_required" | "planned" | "missing" | "blocked";
  required_commands: string[];
  required_checks: string[];
  command_inventory_refs: string[];
  strict_validation_required: boolean;
  no_commands_run: true;
  metadata_json: Record<string, unknown>;
};

export type ExecutionReviewPolicy = {
  review_policy_id: string;
  status: "not_required" | "planned" | "missing";
  required_reviews: string[];
  specialist_reviews: string[];
  validation_review_required: boolean;
  integration_review_required: boolean;
  metadata_json: Record<string, unknown>;
};

export type ExecutionIntegrationPreview = {
  integration_preview_id: string;
  status: "not_required" | "available" | "missing" | "blocked";
  integration_manager_required: boolean;
  expected_candidate_requirements: string[];
  required_post_integration_validation: string[];
  changed_files_preview: string[];
  limitations: string[];
  no_candidate_created: true;
  no_apply_called: true;
  metadata_json: Record<string, unknown>;
};

export type ExecutionRollbackPreview = {
  rollback_preview_id: string;
  status: "not_required" | "manual_limited" | "missing";
  rollback_available: boolean;
  limitations: string[];
  refs: string[];
  metadata_json: Record<string, unknown>;
};

export type ExecutionPreparationBlocker = {
  blocker_id: string;
  preparation_plan_id: string;
  blocker_type: ExecutionPreparationBlockerType;
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionPreparationWarning = {
  warning_id: string;
  preparation_plan_id: string;
  warning_type: ExecutionPreparationWarningType;
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionPreparationPlan = {
  preparation_plan_id: string;
  run_id: string;
  queue_item_id: string;
  promotion_request_id: string;
  approval_id?: string;
  proposed_node_id: string;
  team_id?: string;
  adopted_task_id?: string;
  status: ExecutionPreparationStatus;
  intended_writer_slot: WriterSlot;
  writer_role: AgentRoleName | string;
  task_type: string;
  read_or_write_classification: ReadOrWriteClassification;
  objective: string;
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  required_file_locks: string[];
  required_module_locks: string[];
  required_semantic_locks: string[];
  context_pack_ref?: string;
  context_freshness_summary: Record<string, unknown>;
  prompt_id?: string;
  prompt_template_ref?: string;
  prompt_quality_result_ref?: string;
  prompt_writer_output_ref?: string;
  validation_plan: ExecutionValidationPlan;
  review_policy: ExecutionReviewPolicy;
  integration_preview: ExecutionIntegrationPreview;
  rollback_preview: ExecutionRollbackPreview;
  risk_level: "low" | "medium" | "high" | "critical";
  human_approval_ref?: string;
  readiness_decision_ref?: string;
  blockers: ExecutionPreparationBlocker[];
  warnings: ExecutionPreparationWarning[];
  artifact_ref?: string;
  lock_plan_ref?: string;
  validation_plan_ref?: string;
  review_policy_ref?: string;
  integration_preview_ref?: string;
  rollback_preview_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionPreparationRequest = {
  request_id: string;
  run_id: string;
  queue_item_ids: string[];
  requested_by: string;
  mode: "off" | "report_only" | "prepare_only";
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionPreparationResult = {
  result_id: string;
  run_id: string;
  queue_item_id?: string;
  status: ExecutionPreparationStatus;
  plan?: ExecutionPreparationPlan;
  blockers: ExecutionPreparationBlocker[];
  warnings: ExecutionPreparationWarning[];
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionPreparationSummary = {
  summary_id: string;
  run_id: string;
  execution_preparation_used: boolean;
  preparation_plan_count: number;
  prepared_count: number;
  blocked_count: number;
  missing_approval_count: number;
  missing_context_count: number;
  missing_prompt_count: number;
  missing_validation_count: number;
  missing_locks_count: number;
  stale_context_count: number;
  cancelled_count: number;
  preparation_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionPreparationBatch = {
  batch_id: string;
  run_id: string;
  request: ExecutionPreparationRequest;
  plans: ExecutionPreparationPlan[];
  summary: ExecutionPreparationSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createWriterSlot(input: Omit<WriterSlot, "writer_slot_id" | "max_active_writers" | "invocation_allowed" | "provider_write_worker_allowed" | "scheduler_allowed" | "metadata_json"> & {
  writer_slot_id?: string;
  metadata_json?: Record<string, unknown>;
}): WriterSlot {
  return {
    ...input,
    writer_slot_id: input.writer_slot_id ?? `writer_slot_${randomUUID()}`,
    max_active_writers: 1,
    invocation_allowed: false,
    provider_write_worker_allowed: false,
    scheduler_allowed: false,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionValidationPlan(input: Omit<ExecutionValidationPlan, "validation_plan_id" | "no_commands_run" | "metadata_json"> & {
  validation_plan_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionValidationPlan {
  return {
    ...input,
    validation_plan_id: input.validation_plan_id ?? `execution_validation_plan_${randomUUID()}`,
    no_commands_run: true,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionReviewPolicy(input: Omit<ExecutionReviewPolicy, "review_policy_id" | "metadata_json"> & {
  review_policy_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReviewPolicy {
  return {
    ...input,
    review_policy_id: input.review_policy_id ?? `execution_review_policy_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionIntegrationPreview(input: Omit<ExecutionIntegrationPreview, "integration_preview_id" | "no_candidate_created" | "no_apply_called" | "metadata_json"> & {
  integration_preview_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionIntegrationPreview {
  return {
    ...input,
    integration_preview_id: input.integration_preview_id ?? `execution_integration_preview_${randomUUID()}`,
    no_candidate_created: true,
    no_apply_called: true,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionRollbackPreview(input: Omit<ExecutionRollbackPreview, "rollback_preview_id" | "metadata_json"> & {
  rollback_preview_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionRollbackPreview {
  return {
    ...input,
    rollback_preview_id: input.rollback_preview_id ?? `execution_rollback_preview_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionPreparationBlocker(input: Omit<ExecutionPreparationBlocker, "blocker_id" | "metadata_json" | "created_at"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPreparationBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `execution_preparation_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createExecutionPreparationWarning(input: Omit<ExecutionPreparationWarning, "warning_id" | "metadata_json" | "created_at"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPreparationWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `execution_preparation_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createExecutionPreparationPlan(input: Omit<ExecutionPreparationPlan, "preparation_plan_id" | "created_at" | "metadata_json" | "blockers" | "warnings"> & {
  preparation_plan_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: ExecutionPreparationBlocker[];
  warnings?: ExecutionPreparationWarning[];
}): ExecutionPreparationPlan {
  return {
    ...input,
    preparation_plan_id: input.preparation_plan_id ?? `execution_preparation_plan_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createExecutionPreparationRequest(input: Omit<ExecutionPreparationRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPreparationRequest {
  return {
    ...input,
    request_id: input.request_id ?? `execution_preparation_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createExecutionPreparationResult(input: Omit<ExecutionPreparationResult, "result_id" | "created_at" | "metadata_json"> & {
  result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPreparationResult {
  return {
    ...input,
    result_id: input.result_id ?? `execution_preparation_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createExecutionPreparationSummary(input: Omit<ExecutionPreparationSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPreparationSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `execution_preparation_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createExecutionPreparationBatch(input: Omit<ExecutionPreparationBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPreparationBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `execution_preparation_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
