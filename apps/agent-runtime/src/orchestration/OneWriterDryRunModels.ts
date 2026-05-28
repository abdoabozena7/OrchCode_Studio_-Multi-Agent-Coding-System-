import { randomUUID } from "node:crypto";
import type { AgentRoleName } from "./OrchestrationModels.js";
import type { OneWriterDryRunMode } from "./OrchestrationConfig.js";
import type {
  PatchProposal,
  PatchProposalScopeCheck,
  PatchProposalSummary
} from "./PatchProposalModels.js";

export type OneWriterDryRunStatus =
  | "not_required"
  | "pending"
  | "generated"
  | "schema_failed"
  | "scope_failed"
  | "blocked"
  | "rejected"
  | "accepted_for_review_candidate"
  | "cancelled";

export type OneWriterDryRunBlockerType =
  | "dry_run_disabled"
  | "not_prepared"
  | "missing_approval"
  | "invalid_approval"
  | "missing_prompt"
  | "prompt_quality_blocked"
  | "stale_context"
  | "missing_context"
  | "missing_validation_plan"
  | "missing_review_policy"
  | "missing_integration_preview"
  | "missing_lock_preview"
  | "missing_scope"
  | "invalid_writer_slot"
  | "blocked_proposed_node"
  | "duplicate_proposal"
  | "provider_unavailable"
  | "provider_failed"
  | "schema_failed"
  | "scope_failed";

export type OneWriterDryRunWarningType =
  | "prompt_quality_warning"
  | "stale_context_warning"
  | "fake_provider"
  | "review_candidate_only"
  | "rollback_limited"
  | "advisory_conflict";

export type OneWriterDryRunBlocker = {
  blocker_id: string;
  proposal_id: string;
  blocker_type: OneWriterDryRunBlockerType;
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type OneWriterDryRunWarning = {
  warning_id: string;
  proposal_id: string;
  warning_type: OneWriterDryRunWarningType;
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type OneWriterDryRunRequest = {
  request_id: string;
  run_id: string;
  preparation_plan_ids: string[];
  requested_by: string;
  mode: OneWriterDryRunMode;
  allow_duplicate_preparation?: boolean;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type OneWriterDryRunProviderResult = {
  raw_output: string;
  provider_name?: string;
  model_name?: string;
  metadata_json?: Record<string, unknown>;
};

export type OneWriterDryRunProviderInput = {
  request: OneWriterDryRunRequest;
  proposal_id: string;
  run_id: string;
  preparation_plan_id: string;
  prompt: string;
  prompt_id: string;
  objective: string;
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  validation_requirements: string[];
  review_policy: Record<string, unknown>;
  integration_preview: Record<string, unknown>;
  required_locks_preview: string[];
  metadata_json: Record<string, unknown>;
};

export type OneWriterDryRunProvider = {
  provider_name: string;
  provider_mode: OneWriterDryRunMode;
  generatePatchProposal(input: OneWriterDryRunProviderInput): Promise<OneWriterDryRunProviderResult>;
};

export type OneWriterDryRunProposal = {
  proposal_id: string;
  run_id: string;
  preparation_plan_id: string;
  queue_item_id: string;
  promotion_request_id: string;
  approval_id?: string;
  proposed_node_id: string;
  team_id?: string;
  writer_role: AgentRoleName | string;
  provider_mode: OneWriterDryRunMode;
  provider_name?: string;
  model_name?: string;
  prompt_id?: string;
  prompt_quality_result_ref?: string;
  context_pack_ref?: string;
  raw_output_ref?: string;
  parsed_output_ref?: string;
  patch_artifact_ref?: string;
  patch_summary: string;
  changed_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  scope_check_result?: PatchProposalScopeCheck;
  forbidden_file_violations: string[];
  out_of_scope_changes: string[];
  required_locks_preview: string[];
  validation_plan_ref?: string;
  review_policy_ref?: string;
  integration_preview_ref?: string;
  risk_level: "low" | "medium" | "high" | "critical";
  status: OneWriterDryRunStatus;
  blockers: OneWriterDryRunBlocker[];
  warnings: OneWriterDryRunWarning[];
  patch_proposal?: PatchProposal;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type OneWriterDryRunResult = {
  result_id: string;
  run_id: string;
  preparation_plan_id?: string;
  proposal?: OneWriterDryRunProposal;
  status: OneWriterDryRunStatus;
  blockers: OneWriterDryRunBlocker[];
  warnings: OneWriterDryRunWarning[];
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type OneWriterDryRunBatch = {
  batch_id: string;
  run_id: string;
  request: OneWriterDryRunRequest;
  proposals: OneWriterDryRunProposal[];
  summary: PatchProposalSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createOneWriterDryRunRequest(input: Omit<OneWriterDryRunRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): OneWriterDryRunRequest {
  return {
    ...input,
    request_id: input.request_id ?? `dry_run_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createOneWriterDryRunBlocker(input: Omit<OneWriterDryRunBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): OneWriterDryRunBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `dry_run_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createOneWriterDryRunWarning(input: Omit<OneWriterDryRunWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): OneWriterDryRunWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `dry_run_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createOneWriterDryRunProposal(input: Omit<OneWriterDryRunProposal, "proposal_id" | "created_at" | "metadata_json" | "blockers" | "warnings"> & {
  proposal_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: OneWriterDryRunBlocker[];
  warnings?: OneWriterDryRunWarning[];
}): OneWriterDryRunProposal {
  return {
    ...input,
    proposal_id: input.proposal_id ?? `one_writer_dry_run_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createOneWriterDryRunResult(input: Omit<OneWriterDryRunResult, "result_id" | "created_at" | "metadata_json"> & {
  result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): OneWriterDryRunResult {
  return {
    ...input,
    result_id: input.result_id ?? `dry_run_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createOneWriterDryRunBatch(input: Omit<OneWriterDryRunBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): OneWriterDryRunBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `one_writer_dry_run_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
