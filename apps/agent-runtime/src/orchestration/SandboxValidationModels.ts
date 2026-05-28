import { randomUUID } from "node:crypto";
import type { OverallValidationStatus, ValidationCommandStatus } from "./ValidationSemantics.js";

export type SandboxValidationStatus =
  | "not_required"
  | "pending"
  | "sandbox_missing"
  | "validation_started"
  | "passed"
  | "failed"
  | "blocked"
  | "partial"
  | "skipped"
  | "not_run"
  | "timed_out"
  | "cancelled";

export type SandboxValidationFinding = {
  finding_id: string;
  sandbox_validation_id: string;
  run_id: string;
  finding_type:
    | "sandbox_missing"
    | "dry_apply_not_passed"
    | "candidate_not_preflight_passed"
    | "review_not_accepted"
    | "main_repo_integrity_failed"
    | "missing_validation_commands"
    | "command_not_allowed"
    | "command_blocked"
    | "command_timed_out"
    | "execution_error";
  severity: "info" | "warning" | "blocking" | "critical";
  message: string;
  command?: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type SandboxValidationCommandResult = {
  command_result_id: string;
  sandbox_validation_id: string;
  run_id: string;
  sandbox_result_id: string;
  validation_candidate_id: string;
  command: string;
  cwd: string;
  required: boolean;
  status: ValidationCommandStatus;
  exit_code?: number | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  log_ref?: string;
  summary: string;
  metadata_json: Record<string, unknown>;
};

export type SandboxValidationRequest = {
  request_id: string;
  run_id: string;
  sandbox_result_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  review_id: string;
  sandbox_ref?: string;
  commands: Array<{ command: string; required: boolean; cwd: string }>;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type SandboxValidationResult = {
  sandbox_validation_id: string;
  run_id: string;
  sandbox_result_id: string;
  validation_candidate_id: string;
  proposal_id: string;
  review_id: string;
  patch_artifact_ref?: string;
  sandbox_ref?: string;
  commands: string[];
  command_results: SandboxValidationCommandResult[];
  strict_validation_status: OverallValidationStatus;
  status: SandboxValidationStatus;
  required_command_count: number;
  optional_command_count: number;
  passed_count: number;
  failed_count: number;
  blocked_count: number;
  skipped_count: number;
  timed_out_count: number;
  not_run_count: number;
  findings: SandboxValidationFinding[];
  logs_ref?: string;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type SandboxValidationSummary = {
  summary_id: string;
  run_id: string;
  sandbox_validation_used: boolean;
  sandbox_validation_count: number;
  sandbox_validation_passed_count: number;
  sandbox_validation_failed_count: number;
  sandbox_validation_blocked_count: number;
  sandbox_validation_partial_count: number;
  sandbox_validation_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type SandboxValidationBatch = {
  batch_id: string;
  run_id: string;
  sandbox_result_ids: string[];
  results: SandboxValidationResult[];
  summary: SandboxValidationSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createSandboxValidationFinding(input: Omit<SandboxValidationFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): SandboxValidationFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `sandbox_validation_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createSandboxValidationCommandResult(input: Omit<SandboxValidationCommandResult, "command_result_id" | "metadata_json"> & {
  command_result_id?: string;
  metadata_json?: Record<string, unknown>;
}): SandboxValidationCommandResult {
  return {
    ...input,
    command_result_id: input.command_result_id ?? `sandbox_validation_command_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createSandboxValidationRequest(input: Omit<SandboxValidationRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): SandboxValidationRequest {
  return {
    ...input,
    request_id: input.request_id ?? `sandbox_validation_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createSandboxValidationResult(input: Omit<SandboxValidationResult, "sandbox_validation_id" | "created_at" | "metadata_json"> & {
  sandbox_validation_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): SandboxValidationResult {
  return {
    ...input,
    sandbox_validation_id: input.sandbox_validation_id ?? `sandbox_validation_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createSandboxValidationSummary(input: Omit<SandboxValidationSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): SandboxValidationSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `sandbox_validation_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createSandboxValidationBatch(input: Omit<SandboxValidationBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): SandboxValidationBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `sandbox_validation_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
