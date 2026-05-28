import type { ExecutionPreparationMode, OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ExecutionPreparationStatus } from "./ExecutionPreparationModels.js";
import {
  createExecutionPreparationBlocker,
  type ExecutionPreparationBlocker
} from "./ExecutionPreparationModels.js";
import type { ExecutionPromotionRequest, HumanApprovalRecord, PromotionQueueItem } from "./ExecutionApprovalModels.js";

export type ExecutionPreparationPolicy = {
  enabled: boolean;
  mode: ExecutionPreparationMode;
  max_preparation_plans_per_run: number;
  require_human_approval_for_write_preparation: boolean;
  allow_read_only_preparation_without_human_approval: boolean;
  block_on_stale_context: boolean;
  block_on_prompt_quality_warning_for_write: boolean;
  metadata_json: Record<string, unknown>;
};

export type PreparationInputPolicyResult = {
  allowed: boolean;
  status: ExecutionPreparationStatus;
  blockers: ExecutionPreparationBlocker[];
};

export function executionPreparationPolicyFromConfig(config: OrchestrationSafetyConfig): ExecutionPreparationPolicy {
  return {
    enabled: config.enable_execution_preparation ?? Boolean(config.enable_execution_promotion_queue),
    mode: config.execution_preparation_mode ?? "prepare_only",
    max_preparation_plans_per_run: config.max_preparation_plans_per_run ?? 24,
    require_human_approval_for_write_preparation: config.require_human_approval_for_write_preparation ?? true,
    allow_read_only_preparation_without_human_approval: config.allow_read_only_preparation_without_human_approval ?? true,
    block_on_stale_context: config.block_on_stale_context ?? false,
    block_on_prompt_quality_warning_for_write: config.block_on_prompt_quality_warning_for_write ?? false,
    metadata_json: {
      no_execution: true,
      max_active_writers: 1
    }
  };
}

export function evaluatePreparationInputPolicy(input: {
  planId: string;
  queueItem?: PromotionQueueItem;
  request?: ExecutionPromotionRequest;
  approval?: HumanApprovalRecord;
  readinessDecisionExists: boolean;
  proposedNodeExists: boolean;
  policy: ExecutionPreparationPolicy;
}): PreparationInputPolicyResult {
  const blockers: ExecutionPreparationBlocker[] = [];
  const add = (type: ExecutionPreparationBlocker["blocker_type"], reason: string, refs: string[] = []) => {
    blockers.push(createExecutionPreparationBlocker({
      preparation_plan_id: input.planId,
      blocker_type: type,
      severity: "blocking",
      reason,
      refs
    }));
  };

  if (!input.policy.enabled || input.policy.mode === "off") {
    add("cancelled", "Execution preparation is disabled by configuration.");
    return { allowed: false, status: "cancelled", blockers };
  }
  if (!input.queueItem) add("missing_queue_item", "Promotion queue item is missing.");
  if (!input.request) add("missing_promotion_request", "Promotion request is missing.");
  if (!input.readinessDecisionExists) add("missing_readiness_decision", "Readiness decision ref is missing or not persisted.");
  if (!input.proposedNodeExists) add("missing_proposed_node", "Proposed graph node ref is missing or not persisted.");
  if (input.queueItem) {
    if (input.queueItem.queue_status === "cancelled") add("cancelled", "Promotion queue item was cancelled.", [input.queueItem.queue_item_id]);
    if (input.queueItem.queue_status === "blocked") add("invalid_queue_status", "Blocked queue item cannot be prepared.", [input.queueItem.queue_item_id]);
    const readyStatuses = ["queued", "ready_for_future_execution_gate"];
    if (!readyStatuses.includes(input.queueItem.queue_status)) add("invalid_queue_status", `Queue item status ${input.queueItem.queue_status} is not preparable.`, [input.queueItem.queue_item_id]);
  }
  if (input.request) {
    if (["denied", "expired", "revoked", "cancelled", "blocked"].includes(input.request.status)) {
      add("invalid_approval", `Promotion request status ${input.request.status} is not preparable.`, [input.request.promotion_request_id]);
    }
    if (["blocked", "rejected", "not_ready", "requires_context", "requires_prompt", "requires_validation_strategy", "requires_locks", "requires_review_policy"].includes(input.request.readiness_status)) {
      add("blocked_readiness", `Readiness status ${input.request.readiness_status} blocks preparation.`, [input.request.readiness_decision_id]);
    }
    if (input.request.read_or_write_classification !== "read_only" && input.policy.require_human_approval_for_write_preparation) {
      if (!input.approval) add("missing_approval", "Write-classified preparation requires a human approval record.", [input.request.promotion_request_id]);
      else if (input.approval.decision !== "approved" || input.approval.approval_status !== "approved") {
        add("invalid_approval", `Approval status ${input.approval.approval_status}/${input.approval.decision} blocks write preparation.`, [input.approval.approval_id]);
      }
      if (input.approval?.expires_at && new Date(input.approval.expires_at).getTime() <= Date.now()) {
        add("invalid_approval", "Approval is expired.", [input.approval.approval_id]);
      }
    }
    if (input.request.read_or_write_classification === "read_only" && !input.approval && !input.policy.allow_read_only_preparation_without_human_approval) {
      add("missing_approval", "Read-only preparation without human approval is disabled by policy.", [input.request.promotion_request_id]);
    }
    const scope = input.approval?.approved_scope ?? input.request.requested_scope;
    const forbiddenOverlap = scope.allowed_files.filter((file) => scope.forbidden_files.includes(file));
    if (forbiddenOverlap.length) add("unsafe_scope", `Allowed files overlap forbidden files: ${forbiddenOverlap.join(", ")}.`, forbiddenOverlap);
  }

  return {
    allowed: blockers.length === 0,
    status: statusForBlockers(blockers),
    blockers
  };
}

export function statusForBlockers(blockers: ExecutionPreparationBlocker[]): ExecutionPreparationStatus {
  if (!blockers.length) return "prepared";
  if (blockers.some((blocker) => blocker.blocker_type === "cancelled")) return "cancelled";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_approval" || blocker.blocker_type === "invalid_approval")) return "missing_approval";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_context")) return "missing_context";
  if (blockers.some((blocker) => blocker.blocker_type === "stale_context")) return "stale_context";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_prompt" || blocker.blocker_type === "prompt_quality_blocked")) return "missing_prompt";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_validation")) return "missing_validation";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_locks" || blocker.blocker_type === "lock_conflict")) return "missing_locks";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_review_policy")) return "missing_review_policy";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_integration_path")) return "missing_integration_path";
  if (blockers.some((blocker) => blocker.blocker_type === "unsafe_scope")) return "unsafe_scope";
  return "blocked";
}

export function isWriteClassified(value: string) {
  return value === "write_candidate" || value === "repair_candidate" || value === "unknown";
}
