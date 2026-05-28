import { randomUUID } from "node:crypto";

export type PatchProposalChangeType = "create" | "modify" | "delete" | "rename";
export type PatchProposalFindingSeverity = "info" | "warning" | "blocking";
export type PatchProposalFindingType =
  | "allowed_file"
  | "forbidden_file"
  | "out_of_scope_file"
  | "delete_requires_explicit_approval"
  | "rename_requires_explicit_approval"
  | "sensitive_file_requires_explicit_approval"
  | "missing_diff"
  | "broad_change"
  | "claims_validation_passed"
  | "claims_patch_applied"
  | "schema";

export type PatchProposalFileChange = {
  file_change_id: string;
  proposal_id: string;
  path: string;
  change_type: PatchProposalChangeType;
  proposed_diff?: string;
  replacement_snippet_ref?: string;
  rationale: string;
  risk: "low" | "medium" | "high" | "critical";
  within_allowed_scope: boolean;
  metadata_json: Record<string, unknown>;
};

export type PatchProposal = {
  patch_proposal_id: string;
  proposal_id: string;
  run_id: string;
  preparation_plan_id: string;
  summary: string;
  changed_files: string[];
  file_changes: PatchProposalFileChange[];
  risks: string[];
  assumptions: string[];
  validation_recommendations: string[];
  review_notes: string[];
  confidence: number;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalFinding = {
  finding_id: string;
  proposal_id: string;
  finding_type: PatchProposalFindingType;
  severity: PatchProposalFindingSeverity;
  message: string;
  path?: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalScopeCheck = {
  scope_check_id: string;
  proposal_id: string;
  status: "passed" | "failed" | "blocked";
  changed_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  forbidden_file_violations: string[];
  out_of_scope_changes: string[];
  findings: PatchProposalFinding[];
  review_candidate_allowed: boolean;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalSummary = {
  summary_id: string;
  run_id: string;
  one_writer_dry_run_used: boolean;
  dry_run_proposal_count: number;
  generated_count: number;
  schema_failed_count: number;
  scope_failed_count: number;
  blocked_count: number;
  review_candidate_count: number;
  changed_files_preview: string[];
  dry_run_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalBatch = {
  batch_id: string;
  run_id: string;
  preparation_plan_ids: string[];
  proposals: Array<{ proposal_id: string; status: string }>;
  summary: PatchProposalSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createPatchProposalFileChange(input: Omit<PatchProposalFileChange, "file_change_id" | "metadata_json"> & {
  file_change_id?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalFileChange {
  return {
    ...input,
    file_change_id: input.file_change_id ?? `patch_file_change_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createPatchProposal(input: Omit<PatchProposal, "patch_proposal_id" | "created_at" | "metadata_json"> & {
  patch_proposal_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposal {
  return {
    ...input,
    patch_proposal_id: input.patch_proposal_id ?? `patch_proposal_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalFinding(input: Omit<PatchProposalFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `patch_proposal_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalScopeCheck(input: Omit<PatchProposalScopeCheck, "scope_check_id" | "created_at" | "metadata_json"> & {
  scope_check_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalScopeCheck {
  return {
    ...input,
    scope_check_id: input.scope_check_id ?? `patch_scope_check_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalSummary(input: Omit<PatchProposalSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `dry_run_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalBatch(input: Omit<PatchProposalBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `dry_run_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
