import { randomUUID } from "node:crypto";

export type PatchApplySandboxStatus =
  | "not_required"
  | "pending"
  | "sandbox_created"
  | "dry_apply_passed"
  | "dry_apply_failed"
  | "conflict_detected"
  | "unsafe_patch"
  | "sandbox_unavailable"
  | "blocked"
  | "cancelled";

export type PatchSandboxMode = "off" | "simulate_only" | "temp_copy" | "git_worktree_if_available";

export type PatchDryApplyConflict = {
  conflict_id: string;
  sandbox_result_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  path: string;
  conflict_type:
    | "missing_target"
    | "target_exists"
    | "forbidden_path"
    | "out_of_scope"
    | "path_traversal"
    | "delete_without_approval"
    | "rename_without_approval"
    | "rename_source_missing"
    | "rename_target_exists"
    | "unsupported_change";
  severity: "warning" | "blocking";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchFailedHunk = {
  failed_hunk_id: string;
  sandbox_result_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  path: string;
  hunk_header?: string;
  reason: string;
  expected_lines: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchUnsafeFinding = {
  finding_id: string;
  sandbox_result_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  finding_type:
    | "missing_reviewed_validation_candidate"
    | "missing_patch_artifact"
    | "main_repo_source_edit_forbidden"
    | "main_repo_modified"
    | "path_traversal"
    | "forbidden_path"
    | "out_of_scope"
    | "sandbox_escape"
    | "unsupported_patch_format"
    | "critical_review_blocker"
    | "command_preflight_blocked"
    | "scope_check_failed"
    | "cancelled_or_rejected"
    | "sandbox_root_unsafe";
  severity: "info" | "warning" | "blocking" | "critical";
  message: string;
  path?: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchApplySandboxRequest = {
  request_id: string;
  run_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  review_id: string;
  patch_artifact_ref?: string;
  sandbox_mode: PatchSandboxMode;
  changed_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchApplySandboxResult = {
  sandbox_result_id: string;
  run_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  review_id: string;
  patch_artifact_ref?: string;
  sandbox_mode: PatchSandboxMode;
  sandbox_path_ref?: string;
  sandbox_artifact_ref?: string;
  base_revision_ref?: string;
  changed_files: string[];
  dry_apply_status: PatchApplySandboxStatus;
  conflicts: PatchDryApplyConflict[];
  failed_hunks: PatchFailedHunk[];
  unsafe_findings: PatchUnsafeFinding[];
  main_repo_modified: false;
  validation_run: false;
  integration_created: false;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchSandboxSummary = {
  summary_id: string;
  run_id: string;
  patch_apply_sandbox_used: boolean;
  sandbox_result_count: number;
  dry_apply_passed_count: number;
  dry_apply_failed_count: number;
  conflict_count: number;
  failed_hunk_count: number;
  sandbox_unavailable_count: number;
  unsafe_patch_count: number;
  blocked_count: number;
  main_repo_integrity_ok: boolean;
  sandbox_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchSandboxBatch = {
  batch_id: string;
  run_id: string;
  validation_candidate_ids: string[];
  results: PatchApplySandboxResult[];
  summary: PatchSandboxSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createPatchDryApplyConflict(input: Omit<PatchDryApplyConflict, "conflict_id" | "created_at" | "metadata_json"> & {
  conflict_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchDryApplyConflict {
  return {
    ...input,
    conflict_id: input.conflict_id ?? `patch_apply_conflict_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchFailedHunk(input: Omit<PatchFailedHunk, "failed_hunk_id" | "created_at" | "metadata_json"> & {
  failed_hunk_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchFailedHunk {
  return {
    ...input,
    failed_hunk_id: input.failed_hunk_id ?? `patch_failed_hunk_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchUnsafeFinding(input: Omit<PatchUnsafeFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchUnsafeFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `patch_apply_unsafe_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchApplySandboxRequest(input: Omit<PatchApplySandboxRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchApplySandboxRequest {
  return {
    ...input,
    request_id: input.request_id ?? `patch_apply_sandbox_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchApplySandboxResult(input: Omit<PatchApplySandboxResult, "sandbox_result_id" | "created_at" | "metadata_json" | "main_repo_modified" | "validation_run" | "integration_created"> & {
  sandbox_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchApplySandboxResult {
  return {
    ...input,
    sandbox_result_id: input.sandbox_result_id ?? `patch_apply_sandbox_${randomUUID()}`,
    main_repo_modified: false,
    validation_run: false,
    integration_created: false,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchSandboxSummary(input: Omit<PatchSandboxSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchSandboxSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `patch_apply_sandbox_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchSandboxBatch(input: Omit<PatchSandboxBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchSandboxBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `patch_apply_sandbox_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
