import { randomUUID } from "node:crypto";
import type { AgentRoleName } from "./OrchestrationModels.js";
import type { ReadOrWriteClassification } from "./TeamTaskAdoptionModels.js";

export type ExecutionReadinessStatus =
  | "not_ready"
  | "ready_read_only"
  | "future_write_candidate"
  | "requires_context"
  | "requires_prompt"
  | "requires_validation_strategy"
  | "requires_success_criteria"
  | "requires_locks"
  | "requires_review_policy"
  | "requires_human_approval"
  | "blocked"
  | "rejected"
  | "approved_for_future_promotion";

export type ExecutionApprovalMode = "off" | "report_only" | "strict";

export type ExecutionApprovalStatus =
  | "not_approved"
  | "read_only_candidate"
  | "future_promotion_candidate"
  | "human_approval_required"
  | "blocked"
  | "rejected";

export type ExecutionReadinessFinding = {
  finding_id: string;
  code:
    | "run_id_present"
    | "objective_present"
    | "role_present"
    | "task_type_present"
    | "team_scope_present"
    | "node_status_allowed"
    | "cycle_blocker"
    | "forbidden_file_conflict"
    | "context_available"
    | "context_buildable"
    | "context_missing"
    | "context_stale_or_unknown"
    | "prompt_template_available"
    | "prompt_quality_passed"
    | "prompt_quality_blocked"
    | "prompt_missing"
    | "validation_strategy_present"
    | "validation_strategy_missing"
    | "validation_strategy_insufficient"
    | "success_criteria_present"
    | "success_criteria_missing"
    | "stop_conditions_present"
    | "stop_conditions_missing"
    | "locks_derived"
    | "locks_missing"
    | "review_policy_present"
    | "review_policy_missing"
    | "integration_path_available"
    | "human_approval_required"
    | "risk_classified"
    | "read_only_write_intent";
  severity: "passed" | "info" | "warning" | "blocking";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
};

export type ExecutionReadinessRequirement = {
  requirement_id: string;
  requirement_type:
    | "identity"
    | "scope"
    | "graph_status"
    | "context"
    | "prompt"
    | "validation"
    | "success_criteria"
    | "stop_conditions"
    | "locks"
    | "review_policy"
    | "human_approval"
    | "integration";
  status: "passed" | "failed" | "warning" | "not_required";
  summary: string;
  refs: string[];
  findings: ExecutionReadinessFinding[];
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type ExecutionPromotionBlocker = {
  blocker_id: string;
  blocker_type:
    | "missing_context"
    | "missing_prompt"
    | "missing_validation"
    | "missing_success_criteria"
    | "missing_stop_conditions"
    | "missing_locks"
    | "requires_human_approval"
    | "forbidden_file_conflict"
    | "cycle"
    | "duplicate_or_rejected"
    | "unsafe_read_only_write_intent"
    | "review_policy_missing";
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
};

export type HumanApprovalRequirement = {
  approval_requirement_id: string;
  run_id: string;
  proposed_node_id: string;
  team_id?: string;
  required: boolean;
  reason: string;
  triggers: string[];
  risk_level: "low" | "medium" | "high" | "critical";
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionApprovalPolicy = {
  mode: ExecutionApprovalMode;
  allow_read_only_promotion_candidates: boolean;
  allow_write_future_candidates: boolean;
  require_human_approval_for_write: boolean;
  allow_auto_approval_for_low_risk_read_only: boolean;
  max_nodes_evaluated_per_run: number;
  metadata_json: Record<string, unknown>;
};

export type ExecutionReadinessRequest = {
  request_id: string;
  run_id: string;
  graph_id?: string;
  proposed_node_ids: string[];
  policy: ExecutionApprovalPolicy;
  requested_by: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionReadinessDecision = {
  decision_id: string;
  run_id: string;
  proposed_node_id: string;
  team_id?: string;
  adopted_task_id?: string;
  task_type: string;
  read_or_write_classification: ReadOrWriteClassification;
  proposed_role: AgentRoleName | string;
  readiness_status: ExecutionReadinessStatus;
  approval_status: ExecutionApprovalStatus;
  requirements_checked: ExecutionReadinessRequirement[];
  passed_requirements: string[];
  failed_requirements: string[];
  blockers: ExecutionPromotionBlocker[];
  warnings: ExecutionReadinessFinding[];
  required_human_approval?: HumanApprovalRequirement;
  human_approval_reason?: string;
  required_locks: string[];
  required_context_refs: string[];
  required_prompt_template_ref?: string;
  required_validation_strategy: string[];
  required_success_criteria: string[];
  required_review_policy: string[];
  risk_level: "low" | "medium" | "high" | "critical";
  confidence: number;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionReadinessSummary = {
  summary_id: string;
  run_id: string;
  graph_id?: string;
  nodes_evaluated: number;
  ready_read_only_count: number;
  future_write_candidate_count: number;
  requires_human_approval_count: number;
  blocked_count: number;
  rejected_count: number;
  requires_context_count: number;
  requires_validation_count: number;
  requires_locks_count: number;
  readiness_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ExecutionReadinessBatch = {
  batch_id: string;
  run_id: string;
  graph_id?: string;
  request: ExecutionReadinessRequest;
  decisions: ExecutionReadinessDecision[];
  approval_requirements: HumanApprovalRequirement[];
  summary: ExecutionReadinessSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createExecutionReadinessFinding(input: Omit<ExecutionReadinessFinding, "finding_id" | "metadata_json"> & {
  finding_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReadinessFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `execution_readiness_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionReadinessRequirement(input: Omit<ExecutionReadinessRequirement, "requirement_id" | "metadata_json"> & {
  requirement_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReadinessRequirement {
  return {
    ...input,
    requirement_id: input.requirement_id ?? `execution_readiness_requirement_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionPromotionBlocker(input: Omit<ExecutionPromotionBlocker, "blocker_id" | "metadata_json"> & {
  blocker_id?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionPromotionBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `execution_promotion_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createHumanApprovalRequirement(input: Omit<HumanApprovalRequirement, "approval_requirement_id" | "created_at" | "metadata_json"> & {
  approval_requirement_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): HumanApprovalRequirement {
  return {
    ...input,
    approval_requirement_id: input.approval_requirement_id ?? `human_approval_requirement_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionReadinessRequest(input: Omit<ExecutionReadinessRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReadinessRequest {
  return {
    ...input,
    request_id: input.request_id ?? `execution_readiness_request_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionReadinessDecision(input: Omit<ExecutionReadinessDecision, "decision_id" | "created_at" | "metadata_json"> & {
  decision_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReadinessDecision {
  return {
    ...input,
    decision_id: input.decision_id ?? `execution_readiness_decision_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionReadinessSummary(input: Omit<ExecutionReadinessSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReadinessSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `execution_readiness_summary_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createExecutionReadinessBatch(input: Omit<ExecutionReadinessBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ExecutionReadinessBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `execution_readiness_batch_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}
