import { randomUUID } from "node:crypto";
import type { IntegrationRiskLevel } from "./IntegrationModels.js";

export type IntegrationApplyApprovalStatus =
  | "not_required"
  | "pending"
  | "approved_for_apply_candidate"
  | "requires_human_approval"
  | "blocked"
  | "rejected"
  | "expired"
  | "revoked"
  | "dirty_worktree_blocked"
  | "missing_locks"
  | "missing_rollback_plan"
  | "missing_post_validation_plan"
  | "candidate_invalid"
  | "cancelled";

export type ApplyModeRecommendation =
  | "no_apply"
  | "prepare_only"
  | "controlled_apply_requires_approval"
  | "blocked";

export type WorktreeSafetyStatus =
  | "clean"
  | "dirty_unrelated"
  | "dirty_overlap"
  | "dirty_known_desktop_overlap"
  | "unavailable";

export type IntegrationApplyScope = {
  scope_id: string;
  integration_candidate_id: string;
  allowed_files: string[];
  forbidden_files: string[];
  changed_files: string[];
  required_file_locks: string[];
  required_module_locks: string[];
  required_semantic_locks: string[];
  validation_requirements: string[];
  rollback_requirements_ref?: string;
  post_integration_validation_plan_ref?: string;
  integration_manager_required: boolean;
  durable_locks_required: boolean;
  strict_validation_required: boolean;
  provider_write_workers_allowed: false;
  dirty_overlap_override: boolean;
  metadata_json: Record<string, unknown>;
};

export type IntegrationApplyApprovalDecision = {
  decision_id: string;
  decision: "approve" | "reject" | "request_human_approval" | "block";
  approver_type: "human" | "system_policy" | "test_fixture" | "none";
  approver_id?: string;
  reason: string;
  approved_scope?: IntegrationApplyScope;
  expires_at?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type DirtyWorktreeFinding = {
  finding_id: string;
  path: string;
  git_status: string;
  overlap: boolean;
  known_dirty_sensitive_path: boolean;
  severity: "info" | "warning" | "blocking";
  reason: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type WorktreeSafetyCheck = {
  worktree_check_id: string;
  run_id: string;
  integration_candidate_id: string;
  status: WorktreeSafetyStatus;
  dirty_files: string[];
  findings: DirtyWorktreeFinding[];
  command: "git status --short";
  command_exit_code?: number;
  command_error?: string;
  checked_at: string;
  metadata_json: Record<string, unknown>;
};

export type IntegrationApplyApprovalBlocker = {
  blocker_id: string;
  integration_apply_approval_id: string;
  run_id: string;
  integration_candidate_id: string;
  blocker_type:
    | "candidate_not_created"
    | "sandbox_validation_not_passed"
    | "dry_apply_not_passed"
    | "review_not_accepted"
    | "scope_check_not_passed"
    | "main_repo_integrity_not_ok"
    | "missing_patch_artifact"
    | "missing_changed_files"
    | "missing_locks"
    | "missing_rollback_plan"
    | "missing_post_validation_plan"
    | "approval_scope_too_broad"
    | "approval_weakened_validation"
    | "approval_weakened_locks"
    | "approval_weakened_rollback"
    | "approval_bypasses_integration_manager"
    | "approval_bypasses_durable_locks"
    | "approval_bypasses_strict_validation"
    | "approval_allows_provider_write_workers"
    | "dirty_worktree_overlap"
    | "dirty_known_desktop_file"
    | "clean_worktree_required"
    | "cancelled";
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationApplyApprovalWarning = {
  warning_id: string;
  integration_apply_approval_id: string;
  run_id: string;
  integration_candidate_id: string;
  warning_type:
    | "human_approval_required"
    | "unrelated_dirty_worktree"
    | "worktree_status_unavailable"
    | "manual_rollback_only"
    | "post_validation_not_run"
    | "locks_not_acquired"
    | "main_repo_apply_not_performed"
    | "approval_expires";
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationApplyApproval = {
  integration_apply_approval_id: string;
  run_id: string;
  integration_candidate_id: string;
  proposal_id: string;
  review_id: string;
  validation_candidate_id: string;
  sandbox_result_id: string;
  sandbox_validation_id: string;
  preparation_plan_id: string;
  proposed_node_id: string;
  approval_required: boolean;
  approval_status: IntegrationApplyApprovalStatus;
  approver_type: IntegrationApplyApprovalDecision["approver_type"];
  approver_id?: string;
  approval_reason: string;
  approved_scope: IntegrationApplyScope;
  allowed_files: string[];
  forbidden_files: string[];
  changed_files: string[];
  required_file_locks: string[];
  required_module_locks: string[];
  required_semantic_locks: string[];
  rollback_requirements_ref?: string;
  post_integration_validation_plan_ref?: string;
  worktree_safety_status: WorktreeSafetyStatus;
  dirty_worktree_findings: DirtyWorktreeFinding[];
  apply_mode_recommendation: ApplyModeRecommendation;
  risk_level: IntegrationRiskLevel;
  blockers: IntegrationApplyApprovalBlocker[];
  warnings: IntegrationApplyApprovalWarning[];
  expires_at?: string;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationApplyApprovalRequest = {
  request_id: string;
  run_id: string;
  integration_candidate_id: string;
  requested_by: string;
  approval_decision?: IntegrationApplyApprovalDecision;
  approved_scope?: IntegrationApplyScope;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationApplyApprovalResult = {
  result_id: string;
  run_id: string;
  integration_candidate_id: string;
  approval_status: IntegrationApplyApprovalStatus;
  approval?: IntegrationApplyApproval;
  blockers: IntegrationApplyApprovalBlocker[];
  warnings: IntegrationApplyApprovalWarning[];
  worktree_safety_check?: WorktreeSafetyCheck;
  apply_mode_recommendation: ApplyModeRecommendation;
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationApplyApprovalSummary = {
  summary_id: string;
  run_id: string;
  integration_apply_approval_used: boolean;
  apply_approval_count: number;
  approved_for_apply_candidate_count: number;
  requires_human_approval_count: number;
  blocked_count: number;
  rejected_count: number;
  dirty_worktree_blocked_count: number;
  apply_mode_recommendation_count: number;
  apply_approval_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationApplyApprovalBatch = {
  batch_id: string;
  run_id: string;
  integration_candidate_ids: string[];
  approvals: IntegrationApplyApproval[];
  results: IntegrationApplyApprovalResult[];
  summary: IntegrationApplyApprovalSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createIntegrationApplyScope(input: Omit<IntegrationApplyScope, "scope_id" | "metadata_json"> & {
  scope_id?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyScope {
  return {
    ...input,
    scope_id: input.scope_id ?? `integration_apply_scope_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createIntegrationApplyApprovalDecision(input: Omit<IntegrationApplyApprovalDecision, "decision_id" | "created_at" | "metadata_json"> & {
  decision_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalDecision {
  return {
    ...input,
    decision_id: input.decision_id ?? `integration_apply_decision_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createDirtyWorktreeFinding(input: Omit<DirtyWorktreeFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): DirtyWorktreeFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `dirty_worktree_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createWorktreeSafetyCheck(input: Omit<WorktreeSafetyCheck, "worktree_check_id" | "checked_at" | "metadata_json"> & {
  worktree_check_id?: string;
  checked_at?: string;
  metadata_json?: Record<string, unknown>;
}): WorktreeSafetyCheck {
  return {
    ...input,
    worktree_check_id: input.worktree_check_id ?? `integration_apply_worktree_check_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    checked_at: input.checked_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApprovalBlocker(input: Omit<IntegrationApplyApprovalBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `integration_apply_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApprovalWarning(input: Omit<IntegrationApplyApprovalWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `integration_apply_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApproval(input: Omit<IntegrationApplyApproval, "integration_apply_approval_id" | "created_at" | "metadata_json" | "blockers" | "warnings" | "dirty_worktree_findings"> & {
  integration_apply_approval_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: IntegrationApplyApprovalBlocker[];
  warnings?: IntegrationApplyApprovalWarning[];
  dirty_worktree_findings?: DirtyWorktreeFinding[];
}): IntegrationApplyApproval {
  return {
    ...input,
    integration_apply_approval_id: input.integration_apply_approval_id ?? `integration_apply_approval_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    dirty_worktree_findings: input.dirty_worktree_findings ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApprovalRequest(input: Omit<IntegrationApplyApprovalRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalRequest {
  return {
    ...input,
    request_id: input.request_id ?? `integration_apply_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApprovalResult(input: Omit<IntegrationApplyApprovalResult, "result_id" | "created_at" | "metadata_json"> & {
  result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalResult {
  return {
    ...input,
    result_id: input.result_id ?? `integration_apply_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApprovalSummary(input: Omit<IntegrationApplyApprovalSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `integration_apply_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationApplyApprovalBatch(input: Omit<IntegrationApplyApprovalBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationApplyApprovalBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `integration_apply_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
