import { randomUUID } from "node:crypto";
import type { OverallValidationStatus } from "./ValidationSemantics.js";
import type { IntegrationRiskLevel } from "./IntegrationModels.js";

export type IntegrationCandidateStatus =
  | "not_required"
  | "pending"
  | "candidate_created"
  | "blocked"
  | "rejected"
  | "missing_review"
  | "missing_sandbox_apply"
  | "missing_sandbox_validation"
  | "validation_failed"
  | "validation_blocked"
  | "dry_apply_failed"
  | "scope_failed"
  | "cancelled";

export type IntegrationCandidateBlocker = {
  blocker_id: string;
  integration_candidate_id: string;
  run_id: string;
  blocker_type:
    | "missing_review"
    | "review_not_accepted"
    | "critical_review_blocker"
    | "missing_proposal"
    | "scope_failed"
    | "missing_validation_candidate"
    | "validation_candidate_not_preflight_passed"
    | "missing_sandbox_apply"
    | "dry_apply_failed"
    | "main_repo_integrity_failed"
    | "missing_sandbox_validation"
    | "validation_failed"
    | "validation_blocked"
    | "missing_patch_artifact"
    | "missing_changed_files"
    | "missing_locks"
    | "missing_post_integration_validation_plan"
    | "missing_rollback_plan"
    | "cancelled";
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationCandidateWarning = {
  warning_id: string;
  integration_candidate_id: string;
  run_id: string;
  warning_type:
    | "manual_rollback_only"
    | "future_apply_required"
    | "locks_not_acquired"
    | "post_integration_validation_not_run"
    | "sandbox_only_validation";
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationRollbackRequirements = {
  rollback_requirement_id: string;
  status: "manual_limited" | "automatic_available" | "not_required";
  changed_files: string[];
  rollback_refs: string[];
  instructions: string[];
  limitations: string[];
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type PostIntegrationValidationPlan = {
  validation_plan_id: string;
  required_commands: string[];
  optional_commands: string[];
  expected_outputs: string[];
  strict_validation_semantics_ref?: string;
  sandbox_validation_id: string;
  sandbox_strict_validation_status: OverallValidationStatus;
  additional_checks: string[];
  commands_run: false;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type SandboxValidatedIntegrationCandidate = {
  integration_candidate_id: string;
  run_id: string;
  proposal_id: string;
  review_id: string;
  validation_candidate_id: string;
  sandbox_result_id: string;
  sandbox_validation_id: string;
  preparation_plan_id: string;
  proposed_node_id: string;
  patch_artifact_ref?: string;
  patch_summary: string;
  changed_files: string[];
  required_file_locks: string[];
  required_module_locks: string[];
  required_semantic_locks: string[];
  review_ref?: string;
  sandbox_apply_ref?: string;
  sandbox_validation_ref?: string;
  strict_validation_status: OverallValidationStatus;
  rollback_requirements: IntegrationRollbackRequirements;
  post_integration_validation_plan: PostIntegrationValidationPlan;
  risk_level: IntegrationRiskLevel;
  approval_required: boolean;
  status: IntegrationCandidateStatus;
  blockers: IntegrationCandidateBlocker[];
  warnings: IntegrationCandidateWarning[];
  artifact_ref?: string;
  rollback_requirements_ref?: string;
  post_integration_validation_plan_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationCandidateCreationRequest = {
  request_id: string;
  run_id: string;
  sandbox_validation_ids: string[];
  requested_by: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationCandidateCreationResult = {
  result_id: string;
  run_id: string;
  sandbox_validation_id: string;
  status: IntegrationCandidateStatus;
  candidate?: SandboxValidatedIntegrationCandidate;
  blockers: IntegrationCandidateBlocker[];
  warnings: IntegrationCandidateWarning[];
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationCandidateSummary = {
  summary_id: string;
  run_id: string;
  sandbox_integration_candidate_used: boolean;
  integration_candidate_count: number;
  candidate_created_count: number;
  blocked_count: number;
  rejected_count: number;
  validation_failed_count: number;
  validation_blocked_count: number;
  candidate_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationCandidateBatch = {
  batch_id: string;
  run_id: string;
  sandbox_validation_ids: string[];
  candidates: SandboxValidatedIntegrationCandidate[];
  results: IntegrationCandidateCreationResult[];
  summary: IntegrationCandidateSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createIntegrationCandidateBlocker(input: Omit<IntegrationCandidateBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidateBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `sandbox_integration_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationCandidateWarning(input: Omit<IntegrationCandidateWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidateWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `sandbox_integration_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createRollbackRequirements(input: Omit<IntegrationRollbackRequirements, "rollback_requirement_id" | "metadata_json"> & {
  rollback_requirement_id?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationRollbackRequirements {
  return {
    ...input,
    rollback_requirement_id: input.rollback_requirement_id ?? `rollback_requirements_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createPostIntegrationValidationPlan(input: Omit<PostIntegrationValidationPlan, "validation_plan_id" | "commands_run" | "metadata_json"> & {
  validation_plan_id?: string;
  metadata_json?: Record<string, unknown>;
}): PostIntegrationValidationPlan {
  return {
    ...input,
    validation_plan_id: input.validation_plan_id ?? `post_integration_validation_${randomUUID()}`,
    commands_run: false,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createSandboxValidatedIntegrationCandidate(input: Omit<SandboxValidatedIntegrationCandidate, "integration_candidate_id" | "created_at" | "metadata_json" | "blockers" | "warnings"> & {
  integration_candidate_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: IntegrationCandidateBlocker[];
  warnings?: IntegrationCandidateWarning[];
}): SandboxValidatedIntegrationCandidate {
  return {
    ...input,
    integration_candidate_id: input.integration_candidate_id ?? `sandbox_integration_candidate_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationCandidateCreationRequest(input: Omit<IntegrationCandidateCreationRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidateCreationRequest {
  return {
    ...input,
    request_id: input.request_id ?? `sandbox_integration_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationCandidateCreationResult(input: Omit<IntegrationCandidateCreationResult, "result_id" | "created_at" | "metadata_json"> & {
  result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidateCreationResult {
  return {
    ...input,
    result_id: input.result_id ?? `sandbox_integration_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationCandidateSummary(input: Omit<IntegrationCandidateSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidateSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `sandbox_integration_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationCandidateBatch(input: Omit<IntegrationCandidateBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidateBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `sandbox_integration_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
