import { randomUUID } from "node:crypto";
import type { AgentRoleName } from "./OrchestrationModels.js";
import type { ReadOrWriteClassification } from "./TeamTaskAdoptionModels.js";
import type { ExecutionReadinessStatus } from "./ExecutionReadinessModels.js";

export type PromotionRequestStatus =
  | "requested"
  | "awaiting_human_approval"
  | "approved"
  | "denied"
  | "expired"
  | "revoked"
  | "blocked"
  | "queued_for_future_promotion"
  | "cancelled";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "revoked"
  | "invalid"
  | "superseded";

export type ApprovalDecision = "approved" | "denied" | "revoked" | "expired";

export type PromotionQueueStatus =
  | "queued"
  | "blocked"
  | "waiting_for_approval"
  | "waiting_for_context"
  | "waiting_for_validation_strategy"
  | "waiting_for_locks"
  | "waiting_for_prompt"
  | "ready_for_future_execution_gate"
  | "cancelled";

export type ExecutionPromotionType = "read_only_candidate" | "future_write_candidate" | "future_execution_promotion";
export type ApprovalApproverType = "human" | "system_policy" | "test_fixture";

export type ApprovalConstraint = {
  constraint_id: string;
  constraint_type:
    | "allowed_files_subset"
    | "forbidden_files_preserved"
    | "validation_preserved"
    | "locks_preserved"
    | "prompt_quality_gate_required"
    | "integration_manager_required"
    | "provider_write_workers_disallowed";
  description: string;
  refs: string[];
  status: "required" | "satisfied" | "violated";
  metadata_json: Record<string, unknown>;
};

export type ApprovalScope = {
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  required_locks: string[];
  required_context_refs: string[];
  required_prompt_template_ref?: string;
  required_validation_strategy: string[];
  required_success_criteria: string[];
  required_review_policy: string[];
  metadata_json: Record<string, unknown>;
};

export type ExecutionPromotionRequest = {
  promotion_request_id: string;
  run_id: string;
  proposed_node_id: string;
  readiness_decision_id: string;
  team_id?: string;
  adopted_task_id?: string;
  task_type: string;
  read_or_write_classification: ReadOrWriteClassification;
  proposed_role: AgentRoleName | string;
  requested_promotion_type: ExecutionPromotionType;
  readiness_status: ExecutionReadinessStatus;
  risk_level: "low" | "medium" | "high" | "critical";
  approval_required: boolean;
  approval_reason?: string;
  requested_scope: ApprovalScope;
  required_locks: string[];
  required_context_refs: string[];
  required_prompt_template_ref?: string;
  required_validation_strategy: string[];
  required_success_criteria: string[];
  required_review_policy: string[];
  status: PromotionRequestStatus;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type HumanApprovalRecord = {
  approval_id: string;
  promotion_request_id: string;
  run_id: string;
  proposed_node_id: string;
  approver_type: ApprovalApproverType;
  approver_id?: string;
  decision: ApprovalDecision;
  approval_status: ApprovalStatus;
  decision_reason: string;
  approved_scope: ApprovalScope;
  constraints: ApprovalConstraint[];
  expires_at?: string;
  created_at: string;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
};

export type PromotionQueueItem = {
  queue_item_id: string;
  promotion_request_id: string;
  approval_id?: string;
  run_id: string;
  proposed_node_id: string;
  queue_status: PromotionQueueStatus;
  promotion_type: ExecutionPromotionType;
  priority: number;
  blockers: string[];
  constraints: ApprovalConstraint[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type PromotionPolicyResult = {
  policy_result_id: string;
  run_id: string;
  promotion_request_id?: string;
  allowed: boolean;
  status: PromotionRequestStatus | PromotionQueueStatus;
  approval_required: boolean;
  blockers: string[];
  warnings: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PromotionQueueSummary = {
  summary_id: string;
  run_id: string;
  promotion_requests_created: number;
  approvals_required: number;
  approvals_granted: number;
  approvals_denied: number;
  approvals_expired: number;
  queue_items_created: number;
  queue_items_blocked: number;
  read_only_candidates: number;
  write_candidates_waiting_approval: number;
  approval_summary_ref?: string;
  promotion_queue_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ApprovalExpirationPolicy = {
  ttl_hours: number;
  expires_at?: string;
  metadata_json: Record<string, unknown>;
};

export type ApprovalRevocationRecord = {
  revocation_id: string;
  approval_id: string;
  promotion_request_id: string;
  run_id: string;
  reason: string;
  created_at: string;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
};

export function createApprovalConstraint(input: Omit<ApprovalConstraint, "constraint_id" | "metadata_json"> & {
  constraint_id?: string;
  metadata_json?: Record<string, unknown>;
}): ApprovalConstraint {
  return {
    ...input,
    constraint_id: input.constraint_id ?? `approval_constraint_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createApprovalScope(input: Partial<Omit<ApprovalScope, "metadata_json">> & {
  metadata_json?: Record<string, unknown>;
} = {}): ApprovalScope {
  return {
    allowed_files: uniqueStrings(input.allowed_files ?? []),
    forbidden_files: uniqueStrings(input.forbidden_files ?? []),
    read_only_files: uniqueStrings(input.read_only_files ?? []),
    required_locks: uniqueStrings(input.required_locks ?? []),
    required_context_refs: uniqueStrings(input.required_context_refs ?? []),
    required_prompt_template_ref: input.required_prompt_template_ref,
    required_validation_strategy: uniqueStrings(input.required_validation_strategy ?? []),
    required_success_criteria: uniqueStrings(input.required_success_criteria ?? []),
    required_review_policy: uniqueStrings(input.required_review_policy ?? []),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionPromotionRequest(input: Omit<ExecutionPromotionRequest, "promotion_request_id" | "created_at" | "updated_at" | "metadata_json"> & {
  promotion_request_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPromotionRequest {
  const now = input.created_at ?? new Date().toISOString();
  return {
    ...input,
    promotion_request_id: input.promotion_request_id ?? `execution_promotion_request_${randomUUID()}`,
    created_at: now,
    updated_at: input.updated_at ?? now,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createHumanApprovalRecord(input: Omit<HumanApprovalRecord, "approval_id" | "created_at" | "metadata_json" | "approval_status"> & {
  approval_id?: string;
  approval_status?: ApprovalStatus;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): HumanApprovalRecord {
  return {
    ...input,
    approval_id: input.approval_id ?? `human_approval_${randomUUID()}`,
    approval_status: input.approval_status ?? approvalStatusFromDecision(input.decision),
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createPromotionQueueItem(input: Omit<PromotionQueueItem, "queue_item_id" | "created_at" | "updated_at" | "metadata_json"> & {
  queue_item_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata_json?: Record<string, unknown>;
}): PromotionQueueItem {
  const now = input.created_at ?? new Date().toISOString();
  return {
    ...input,
    queue_item_id: input.queue_item_id ?? `promotion_queue_item_${randomUUID()}`,
    created_at: now,
    updated_at: input.updated_at ?? now,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createPromotionPolicyResult(input: Omit<PromotionPolicyResult, "policy_result_id" | "created_at" | "metadata_json"> & {
  policy_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PromotionPolicyResult {
  return {
    ...input,
    policy_result_id: input.policy_result_id ?? `promotion_policy_result_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createPromotionQueueSummary(input: Omit<PromotionQueueSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PromotionQueueSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `promotion_queue_summary_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createApprovalExpirationPolicy(input: Omit<ApprovalExpirationPolicy, "metadata_json"> & {
  metadata_json?: Record<string, unknown>;
}): ApprovalExpirationPolicy {
  return { ...input, metadata_json: input.metadata_json ?? {} };
}

export function createApprovalRevocationRecord(input: Omit<ApprovalRevocationRecord, "revocation_id" | "created_at" | "metadata_json"> & {
  revocation_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ApprovalRevocationRecord {
  return {
    ...input,
    revocation_id: input.revocation_id ?? `approval_revocation_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

function approvalStatusFromDecision(decision: ApprovalDecision): ApprovalStatus {
  if (decision === "approved") return "approved";
  if (decision === "denied") return "denied";
  if (decision === "expired") return "expired";
  return "revoked";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}
