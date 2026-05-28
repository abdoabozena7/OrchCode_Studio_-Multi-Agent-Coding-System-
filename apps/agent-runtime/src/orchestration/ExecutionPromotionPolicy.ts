import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ExecutionReadinessDecision } from "./ExecutionReadinessModels.js";
import {
  createApprovalConstraint,
  createPromotionPolicyResult,
  type ApprovalConstraint,
  type ApprovalScope,
  type ExecutionPromotionRequest,
  type HumanApprovalRecord,
  type PromotionPolicyResult
} from "./ExecutionApprovalModels.js";

export type ExecutionPromotionQueueMode = "off" | "report_only" | "approval_records" | "queue_candidates";

export type ExecutionPromotionPolicyConfig = {
  enabled: boolean;
  mode: ExecutionPromotionQueueMode;
  require_human_approval_for_write: boolean;
  allow_read_only_queue_without_human_approval: boolean;
  approval_default_ttl_hours: number;
  allow_test_fixture_approvals: boolean;
  track_blocked_promotion_requests: boolean;
  metadata_json: Record<string, unknown>;
};

export function executionPromotionPolicyFromConfig(config: OrchestrationSafetyConfig): ExecutionPromotionPolicyConfig {
  return {
    enabled: config.enable_execution_promotion_queue ?? false,
    mode: config.promotion_queue_mode ?? "off",
    require_human_approval_for_write: config.require_human_approval_for_write,
    allow_read_only_queue_without_human_approval: config.allow_read_only_queue_without_human_approval ?? false,
    approval_default_ttl_hours: config.approval_default_ttl_hours ?? 168,
    allow_test_fixture_approvals: config.allow_test_fixture_approvals ?? false,
    track_blocked_promotion_requests: config.track_blocked_promotion_requests ?? false,
    metadata_json: { source: "orchestration_config" }
  };
}

export function shouldCreatePromotionRequest(decision: ExecutionReadinessDecision, policy: ExecutionPromotionPolicyConfig) {
  if (!policy.enabled || policy.mode === "off") return false;
  if (["ready_read_only", "future_write_candidate", "requires_human_approval", "approved_for_future_promotion"].includes(decision.readiness_status)) return true;
  return policy.track_blocked_promotion_requests && (decision.readiness_status === "blocked" || decision.readiness_status === "rejected" || decision.readiness_status.startsWith("requires_"));
}

export function approvalRequiredForDecision(decision: ExecutionReadinessDecision, policy: ExecutionPromotionPolicyConfig) {
  if (decision.required_human_approval?.required) return true;
  if (policy.require_human_approval_for_write && decision.read_or_write_classification !== "read_only") return true;
  return false;
}

export function evaluatePromotionRequestPolicy(request: ExecutionPromotionRequest, policy: ExecutionPromotionPolicyConfig): PromotionPolicyResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!policy.enabled || policy.mode === "off") blockers.push("promotion_queue_disabled");
  if (request.status === "blocked") blockers.push(request.approval_reason ?? "readiness_not_promotable");
  if (request.read_or_write_classification !== "read_only") {
    if (!request.requested_scope.allowed_files.length) blockers.push("missing_allowed_files");
    if (!request.required_validation_strategy.length) blockers.push("missing_validation_strategy");
    if (!request.required_success_criteria.length) blockers.push("missing_success_criteria");
    if (!request.required_locks.length) blockers.push("missing_locks");
    if (request.approval_required) warnings.push("human_approval_required");
  }
  if (!request.required_context_refs.length) warnings.push("context_ref_missing_or_preview_only");
  if (!request.required_prompt_template_ref) blockers.push("missing_prompt_template");
  return createPromotionPolicyResult({
    run_id: request.run_id,
    promotion_request_id: request.promotion_request_id,
    allowed: blockers.length === 0,
    status: blockers.length ? "blocked" : request.approval_required ? "awaiting_human_approval" : "requested",
    approval_required: request.approval_required,
    blockers,
    warnings,
    metadata_json: { non_executing_policy: true }
  });
}

export function validateApprovalScope(request: ExecutionPromotionRequest, approval: HumanApprovalRecord) {
  const constraints: ApprovalConstraint[] = [];
  const requested = request.requested_scope;
  const approved = approval.approved_scope;
  const filesOk = isSubset(approved.allowed_files, requested.allowed_files);
  constraints.push(createApprovalConstraint({
    constraint_type: "allowed_files_subset",
    description: "Approved files must be a subset of requested allowed files.",
    refs: approved.allowed_files,
    status: filesOk ? "satisfied" : "violated"
  }));
  const forbiddenOk = isSubset(requested.forbidden_files, approved.forbidden_files);
  constraints.push(createApprovalConstraint({
    constraint_type: "forbidden_files_preserved",
    description: "Approval must preserve inherited forbidden files.",
    refs: requested.forbidden_files,
    status: forbiddenOk ? "satisfied" : "violated"
  }));
  const validationOk = isSubset(request.required_validation_strategy, approved.required_validation_strategy);
  constraints.push(createApprovalConstraint({
    constraint_type: "validation_preserved",
    description: "Approval must preserve validation requirements.",
    refs: request.required_validation_strategy,
    status: validationOk ? "satisfied" : "violated"
  }));
  const locksOk = isSubset(request.required_locks, approved.required_locks);
  constraints.push(createApprovalConstraint({
    constraint_type: "locks_preserved",
    description: "Approval must preserve lock requirements.",
    refs: request.required_locks,
    status: locksOk ? "satisfied" : "violated"
  }));
  const metadata = approved.metadata_json;
  const providerWriteOk = metadata.provider_write_workers_allowed !== true;
  const integrationOk = metadata.bypass_integration_manager !== true;
  const promptQualityOk = metadata.bypass_prompt_quality_gate !== true;
  constraints.push(createApprovalConstraint({
    constraint_type: "provider_write_workers_disallowed",
    description: "Approval cannot enable provider-backed write workers.",
    refs: [request.proposed_node_id],
    status: providerWriteOk ? "satisfied" : "violated"
  }));
  constraints.push(createApprovalConstraint({
    constraint_type: "integration_manager_required",
    description: "Approval cannot bypass IntegrationManager.",
    refs: request.required_review_policy,
    status: integrationOk ? "satisfied" : "violated"
  }));
  constraints.push(createApprovalConstraint({
    constraint_type: "prompt_quality_gate_required",
    description: "Approval cannot bypass PromptQualityGate.",
    refs: request.required_prompt_template_ref ? [request.required_prompt_template_ref] : [],
    status: promptQualityOk ? "satisfied" : "violated"
  }));
  return {
    valid: constraints.every((constraint) => constraint.status !== "violated"),
    constraints,
    reasons: constraints.filter((constraint) => constraint.status === "violated").map((constraint) => constraint.description)
  };
}

export function scopeFromDecisionMetadata(decision: ExecutionReadinessDecision): ApprovalScope {
  const metadata = decision.metadata_json;
  return {
    allowed_files: stringArray(metadata.allowed_files),
    forbidden_files: stringArray(metadata.forbidden_files),
    read_only_files: stringArray(metadata.read_only_files),
    required_locks: decision.required_locks,
    required_context_refs: decision.required_context_refs,
    required_prompt_template_ref: decision.required_prompt_template_ref,
    required_validation_strategy: decision.required_validation_strategy,
    required_success_criteria: decision.required_success_criteria,
    required_review_policy: decision.required_review_policy,
    metadata_json: { source: "execution_readiness_decision" }
  };
}

function isSubset(values: string[], allowed: string[]) {
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
