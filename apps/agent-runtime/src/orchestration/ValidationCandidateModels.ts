import { randomUUID } from "node:crypto";

export type ValidationCandidateStatus =
  | "not_required"
  | "pending"
  | "candidate_created"
  | "preflight_passed"
  | "missing_validation_plan"
  | "command_blocked"
  | "environment_blocked"
  | "incomplete"
  | "blocked"
  | "rejected"
  | "cancelled";

export type ValidationCommandSafetyStatus =
  | "safe"
  | "blocked"
  | "unknown"
  | "missing"
  | "not_allowed"
  | "requires_environment"
  | "requires_human_approval";

export type ValidationPreflightFinding = {
  finding_id: string;
  validation_candidate_id: string;
  finding_type:
    | "missing_validation_plan"
    | "missing_required_command"
    | "missing_command_purpose"
    | "missing_expected_output"
    | "missing_fallback"
    | "command_blocked"
    | "command_unknown"
    | "environment_missing"
    | "strict_semantics_missing"
    | "validation_claimed"
    | "patch_applied"
    | "artifact_missing";
  severity: "info" | "warning" | "blocking";
  message: string;
  command?: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCommandPreflight = {
  command_preflight_id: string;
  validation_candidate_id: string;
  command: string;
  required: boolean;
  purpose: string;
  expected_output: string;
  fallback_behavior: string;
  safety_status: ValidationCommandSafetyStatus;
  risk: string;
  allowlisted: boolean;
  inventory_present: boolean;
  inventory_match: boolean;
  future_semantics_status: "not_run" | "blocked";
  blocked_reason?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationEnvironmentReadiness = {
  environment_readiness_id: string;
  validation_candidate_id: string;
  status: "ready" | "warning" | "blocked";
  workspace_path_known: boolean;
  command_inventory_available: boolean;
  validation_runner_available: boolean;
  required_artifacts_exist: boolean;
  patch_applied: false;
  patch_apply_strategy: "not_available" | "prepare_only";
  findings: ValidationPreflightFinding[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationPreflightResult = {
  preflight_result_id: string;
  validation_candidate_id: string;
  status: "passed" | "blocked" | "incomplete";
  command_preflights: ValidationCommandPreflight[];
  environment_readiness: ValidationEnvironmentReadiness;
  findings: ValidationPreflightFinding[];
  no_commands_run: true;
  no_patch_applied: true;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCandidateBlocker = {
  blocker_id: string;
  validation_candidate_id: string;
  blocker_type:
    | "validation_candidate_disabled"
    | "ineligible_review"
    | "missing_review"
    | "missing_proposal"
    | "missing_patch_artifact"
    | "missing_validation_plan"
    | "command_blocked"
    | "environment_blocked"
    | "incomplete_plan"
    | "cancelled";
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCandidateWarning = {
  warning_id: string;
  validation_candidate_id: string;
  warning_type:
    | "optional_command_blocked"
    | "missing_command_inventory"
    | "unknown_optional_command"
    | "patch_not_applied_expected"
    | "preflight_only"
    | "environment_warning";
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCandidate = {
  validation_candidate_id: string;
  run_id: string;
  proposal_id: string;
  review_id: string;
  preparation_plan_id: string;
  proposed_node_id: string;
  patch_artifact_ref?: string;
  review_artifact_ref?: string;
  validation_plan_ref?: string;
  required_commands: string[];
  optional_commands: string[];
  command_safety_results: ValidationCommandPreflight[];
  environment_readiness?: ValidationEnvironmentReadiness;
  expected_validation_outputs: string[];
  strict_validation_semantics_ref?: string;
  status: ValidationCandidateStatus;
  blockers: ValidationCandidateBlocker[];
  warnings: ValidationCandidateWarning[];
  artifact_ref?: string;
  validation_plan_artifact_ref?: string;
  command_preflight_ref?: string;
  environment_preflight_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCandidateResult = {
  result_id: string;
  run_id: string;
  review_id?: string;
  candidate?: ValidationCandidate;
  status: ValidationCandidateStatus;
  blockers: ValidationCandidateBlocker[];
  warnings: ValidationCandidateWarning[];
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCandidateBatch = {
  batch_id: string;
  run_id: string;
  review_ids: string[];
  candidates: ValidationCandidate[];
  summary: ValidationCandidateSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ValidationCandidateSummary = {
  summary_id: string;
  run_id: string;
  validation_candidate_used: boolean;
  validation_candidate_count: number;
  preflight_passed_count: number;
  incomplete_count: number;
  command_blocked_count: number;
  environment_blocked_count: number;
  rejected_count: number;
  validation_candidate_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createValidationPreflightFinding(input: Omit<ValidationPreflightFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationPreflightFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `validation_preflight_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCommandPreflight(input: Omit<ValidationCommandPreflight, "command_preflight_id" | "created_at" | "metadata_json"> & {
  command_preflight_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationCommandPreflight {
  return {
    ...input,
    command_preflight_id: input.command_preflight_id ?? `validation_command_preflight_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationEnvironmentReadiness(input: Omit<ValidationEnvironmentReadiness, "environment_readiness_id" | "created_at" | "metadata_json" | "patch_applied"> & {
  environment_readiness_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationEnvironmentReadiness {
  return {
    ...input,
    environment_readiness_id: input.environment_readiness_id ?? `validation_environment_${randomUUID()}`,
    patch_applied: false,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationPreflightResult(input: Omit<ValidationPreflightResult, "preflight_result_id" | "created_at" | "metadata_json" | "no_commands_run" | "no_patch_applied"> & {
  preflight_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationPreflightResult {
  return {
    ...input,
    preflight_result_id: input.preflight_result_id ?? `validation_preflight_${randomUUID()}`,
    no_commands_run: true,
    no_patch_applied: true,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCandidateBlocker(input: Omit<ValidationCandidateBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationCandidateBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `validation_candidate_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCandidateWarning(input: Omit<ValidationCandidateWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationCandidateWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `validation_candidate_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCandidate(input: Omit<ValidationCandidate, "validation_candidate_id" | "created_at" | "metadata_json" | "blockers" | "warnings"> & {
  validation_candidate_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: ValidationCandidateBlocker[];
  warnings?: ValidationCandidateWarning[];
}): ValidationCandidate {
  return {
    ...input,
    validation_candidate_id: input.validation_candidate_id ?? `validation_candidate_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCandidateResult(input: Omit<ValidationCandidateResult, "result_id" | "created_at" | "metadata_json"> & {
  result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationCandidateResult {
  return {
    ...input,
    result_id: input.result_id ?? `validation_candidate_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCandidateSummary(input: Omit<ValidationCandidateSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationCandidateSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `validation_candidate_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createValidationCandidateBatch(input: Omit<ValidationCandidateBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ValidationCandidateBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `validation_candidate_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
