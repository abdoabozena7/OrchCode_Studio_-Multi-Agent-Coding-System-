import { randomUUID } from "node:crypto";
import type { OverallValidationStatus } from "./ValidationSemantics.js";

export type ControlledIntegrationApplyStatus =
  | "not_required"
  | "pending"
  | "applying"
  | "applied"
  | "post_validation_running"
  | "post_validation_passed"
  | "post_validation_failed"
  | "rollback_required"
  | "rolled_back"
  | "rollback_failed"
  | "blocked"
  | "rejected"
  | "dirty_worktree_blocked"
  | "lock_failed"
  | "apply_failed"
  | "validation_blocked"
  | "cancelled";

export type ControlledApplyAdapterStatus = "applied" | "blocked" | "failed";

export type ControlledApplyBlocker = {
  blocker_id: string;
  controlled_apply_id: string;
  run_id: string;
  integration_candidate_id: string;
  blocker_type:
    | "controlled_apply_disabled"
    | "approval_missing"
    | "approval_not_approved"
    | "approval_scope_invalid"
    | "candidate_not_created"
    | "sandbox_validation_not_passed"
    | "dry_apply_not_passed"
    | "review_not_accepted"
    | "scope_check_not_passed"
    | "missing_human_approval"
    | "missing_patch_artifact"
    | "missing_changed_files"
    | "missing_locks"
    | "missing_rollback_plan"
    | "manual_rollback_not_allowed"
    | "missing_post_validation_plan"
    | "dirty_worktree_overlap"
    | "worktree_check_unavailable"
    | "path_forbidden"
    | "path_traversal"
    | "lock_failed"
    | "apply_failed"
    | "post_validation_failed"
    | "rollback_failed"
    | "cancelled";
  severity: "warning" | "blocking" | "critical";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ControlledApplyWarning = {
  warning_id: string;
  controlled_apply_id: string;
  run_id: string;
  integration_candidate_id: string;
  warning_type:
    | "unrelated_dirty_worktree"
    | "manual_rollback_available"
    | "post_validation_optional_only"
    | "adapter_limited"
    | "rollback_performed"
    | "locks_released";
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PreApplySnapshotFile = {
  path: string;
  exists: boolean;
  sha256?: string;
  size?: number;
  content_ref?: string;
};

export type PreApplySnapshot = {
  snapshot_id: string;
  controlled_apply_id: string;
  run_id: string;
  integration_candidate_id: string;
  changed_files: string[];
  files: PreApplySnapshotFile[];
  artifact_ref?: string;
  content_dir_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ControlledApplyFileResult = {
  path: string;
  status: "applied" | "failed" | "blocked" | "skipped";
  change_type?: string;
  message?: string;
  artifact_ref?: string;
};

export type ControlledApplyAdapterInput = {
  controlled_apply_id: string;
  run_id: string;
  integration_candidate_id: string;
  workspacePath: string;
  patch_artifact_ref: string;
  changed_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  allow_delete: boolean;
  allow_rename: boolean;
};

export type ControlledApplyAdapterResult = {
  adapter_id: string;
  adapter_name: string;
  status: ControlledApplyAdapterStatus;
  applied_files: string[];
  failed_files: string[];
  file_results: ControlledApplyFileResult[];
  blockers: ControlledApplyBlocker[];
  warnings: ControlledApplyWarning[];
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ControlledApplyAdapter = {
  adapter_name: string;
  apply(input: ControlledApplyAdapterInput): Promise<ControlledApplyAdapterResult>;
};

export type RollbackResult = {
  rollback_result_id: string;
  controlled_apply_id: string;
  run_id: string;
  integration_candidate_id: string;
  status: "not_required" | "rolled_back" | "rollback_failed" | "blocked";
  restored_files: string[];
  failed_files: string[];
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ControlledIntegrationApplyRequest = {
  request_id: string;
  run_id: string;
  integration_candidate_id: string;
  integration_apply_approval_id?: string;
  requested_by: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ControlledIntegrationApplyResult = {
  controlled_apply_id: string;
  run_id: string;
  integration_candidate_id: string;
  integration_apply_approval_id: string;
  proposal_id: string;
  patch_artifact_ref?: string;
  approval_ref?: string;
  changed_files: string[];
  acquired_lock_refs: string[];
  pre_apply_snapshot_ref?: string;
  apply_adapter: string;
  apply_status: ControlledApplyAdapterStatus | "not_run";
  applied_files: string[];
  failed_files: string[];
  post_validation_result_ref?: string;
  strict_validation_status: OverallValidationStatus;
  rollback_plan_ref?: string;
  rollback_result_ref?: string;
  worktree_safety_ref?: string;
  status: ControlledIntegrationApplyStatus;
  blockers: ControlledApplyBlocker[];
  warnings: ControlledApplyWarning[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  completed_at?: string;
};

export type ControlledApplySummary = {
  summary_id: string;
  run_id: string;
  controlled_apply_used: boolean;
  controlled_apply_count: number;
  applied_count: number;
  post_validation_passed_count: number;
  post_validation_failed_count: number;
  rolled_back_count: number;
  rollback_failed_count: number;
  lock_failed_count: number;
  blocked_count: number;
  controlled_apply_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ControlledApplyBatch = {
  batch_id: string;
  run_id: string;
  integration_candidate_ids: string[];
  results: ControlledIntegrationApplyResult[];
  summary: ControlledApplySummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createControlledApplyBlocker(input: Omit<ControlledApplyBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ControlledApplyBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `controlled_apply_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createControlledApplyWarning(input: Omit<ControlledApplyWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ControlledApplyWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `controlled_apply_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPreApplySnapshot(input: Omit<PreApplySnapshot, "snapshot_id" | "created_at" | "metadata_json"> & {
  snapshot_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PreApplySnapshot {
  return {
    ...input,
    snapshot_id: input.snapshot_id ?? `pre_apply_snapshot_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createControlledApplyAdapterResult(input: Omit<ControlledApplyAdapterResult, "adapter_id" | "created_at" | "metadata_json"> & {
  adapter_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ControlledApplyAdapterResult {
  return {
    ...input,
    adapter_id: input.adapter_id ?? `controlled_apply_adapter_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createRollbackResult(input: Omit<RollbackResult, "rollback_result_id" | "created_at" | "metadata_json"> & {
  rollback_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): RollbackResult {
  return {
    ...input,
    rollback_result_id: input.rollback_result_id ?? `controlled_rollback_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createControlledIntegrationApplyRequest(input: Omit<ControlledIntegrationApplyRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ControlledIntegrationApplyRequest {
  return {
    ...input,
    request_id: input.request_id ?? `controlled_apply_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createControlledIntegrationApplyResult(input: Omit<ControlledIntegrationApplyResult, "controlled_apply_id" | "created_at" | "metadata_json" | "blockers" | "warnings"> & {
  controlled_apply_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: ControlledApplyBlocker[];
  warnings?: ControlledApplyWarning[];
}): ControlledIntegrationApplyResult {
  return {
    ...input,
    controlled_apply_id: input.controlled_apply_id ?? `controlled_apply_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createControlledApplySummary(input: Omit<ControlledApplySummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ControlledApplySummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `controlled_apply_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createControlledApplyBatch(input: Omit<ControlledApplyBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ControlledApplyBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `controlled_apply_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
