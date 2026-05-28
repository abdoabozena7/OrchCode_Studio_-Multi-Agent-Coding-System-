import { randomUUID } from "node:crypto";
import type { PatchProposalReviewMode } from "./OrchestrationConfig.js";

export type PatchProposalReviewStatus =
  | "not_required"
  | "pending"
  | "reviewed"
  | "accepted_for_validation_candidate"
  | "changes_requested"
  | "rejected"
  | "blocked"
  | "provider_failed"
  | "schema_failed"
  | "cancelled";

export type PatchProposalReviewDecision =
  | "accept_for_validation_candidate"
  | "request_changes"
  | "reject"
  | "block"
  | "split_further"
  | "require_human_approval";

export type ReviewSeverity = "info" | "low" | "medium" | "high" | "critical";
export type ReviewCategory =
  | "correctness"
  | "scope"
  | "architecture"
  | "security"
  | "performance"
  | "validation"
  | "test_coverage"
  | "integration"
  | "maintainability"
  | "style"
  | "risk"
  | "unknown";

export type PatchProposalReviewFinding = {
  finding_id: string;
  review_id: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  message: string;
  file?: string;
  suggested_change?: string;
  blocking: boolean;
  evidence_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewBlocker = {
  blocker_id: string;
  review_id: string;
  blocker_type:
    | "review_disabled"
    | "ineligible_proposal"
    | "missing_scope_check"
    | "missing_patch_artifact"
    | "missing_changed_files"
    | "missing_review_policy"
    | "missing_preparation_plan"
    | "prompt_quality_blocked"
    | "provider_unavailable"
    | "provider_failed"
    | "schema_failed"
    | "decision_blocked";
  severity: "warning" | "blocking";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewWarning = {
  warning_id: string;
  review_id: string;
  warning_type:
    | "deterministic_review"
    | "fake_provider"
    | "prompt_quality_warning"
    | "specialist_review_required"
    | "validation_candidate_only"
    | "limited_context";
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewRequest = {
  request_id: string;
  run_id: string;
  proposal_ids: string[];
  requested_by: string;
  mode: PatchProposalReviewMode;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewProviderInput = {
  request: PatchProposalReviewRequest;
  review_id: string;
  run_id: string;
  proposal_id: string;
  preparation_plan_id: string;
  prompt: string;
  prompt_id: string;
  reviewer_role: string;
  patch_summary: string;
  changed_files: string[];
  allowed_files: string[];
  forbidden_files: string[];
  scope_check_status?: string;
  validation_plan_ref?: string;
  review_policy_ref?: string;
  integration_preview_ref?: string;
  risk_level: string;
  metadata_json: Record<string, unknown>;
};

export type PatchProposalReviewProviderResult = {
  raw_output: string;
  provider_name?: string;
  model_name?: string;
  metadata_json?: Record<string, unknown>;
};

export type PatchProposalReviewProvider = {
  provider_name: string;
  reviewer_mode: PatchProposalReviewMode;
  reviewPatchProposal(input: PatchProposalReviewProviderInput): Promise<PatchProposalReviewProviderResult>;
};

export type PatchProposalReview = {
  review_id: string;
  run_id: string;
  proposal_id: string;
  preparation_plan_id: string;
  proposed_node_id: string;
  reviewer_role: string;
  reviewer_mode: PatchProposalReviewMode;
  provider_name?: string;
  model_name?: string;
  prompt_id?: string;
  prompt_quality_result_ref?: string;
  raw_review_output_ref?: string;
  parsed_review_output_ref?: string;
  review_artifact_ref?: string;
  decision: PatchProposalReviewDecision;
  status: PatchProposalReviewStatus;
  findings: PatchProposalReviewFinding[];
  severity_counts: Record<ReviewSeverity, number>;
  required_changes: string[];
  validation_recommendations: string[];
  integration_risks: string[];
  security_risks: string[];
  performance_risks: string[];
  test_coverage_risks: string[];
  confidence: number;
  blockers: PatchProposalReviewBlocker[];
  warnings: PatchProposalReviewWarning[];
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewResult = {
  result_id: string;
  run_id: string;
  proposal_id?: string;
  review?: PatchProposalReview;
  status: PatchProposalReviewStatus;
  blockers: PatchProposalReviewBlocker[];
  warnings: PatchProposalReviewWarning[];
  artifact_refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewSummary = {
  summary_id: string;
  run_id: string;
  patch_review_used: boolean;
  patch_reviews_count: number;
  accepted_for_validation_candidate_count: number;
  changes_requested_count: number;
  rejected_count: number;
  blocked_count: number;
  review_schema_failed_count: number;
  critical_findings_count: number;
  high_findings_count: number;
  review_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PatchProposalReviewBatch = {
  batch_id: string;
  run_id: string;
  request: PatchProposalReviewRequest;
  reviews: PatchProposalReview[];
  summary: PatchProposalReviewSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createPatchProposalReviewFinding(input: Omit<PatchProposalReviewFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `patch_review_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReviewBlocker(input: Omit<PatchProposalReviewBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `patch_review_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReviewWarning(input: Omit<PatchProposalReviewWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `patch_review_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReview(input: Omit<PatchProposalReview, "review_id" | "created_at" | "metadata_json" | "blockers" | "warnings" | "severity_counts"> & {
  review_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: PatchProposalReviewBlocker[];
  warnings?: PatchProposalReviewWarning[];
  severity_counts?: Record<ReviewSeverity, number>;
}): PatchProposalReview {
  const findings = input.findings ?? [];
  return {
    ...input,
    review_id: input.review_id ?? `patch_review_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    severity_counts: input.severity_counts ?? countSeverities(findings),
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReviewRequest(input: Omit<PatchProposalReviewRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewRequest {
  return {
    ...input,
    request_id: input.request_id ?? `patch_review_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReviewResult(input: Omit<PatchProposalReviewResult, "result_id" | "created_at" | "metadata_json"> & {
  result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewResult {
  return {
    ...input,
    result_id: input.result_id ?? `patch_review_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReviewSummary(input: Omit<PatchProposalReviewSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `patch_review_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createPatchProposalReviewBatch(input: Omit<PatchProposalReviewBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): PatchProposalReviewBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `patch_review_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function countSeverities(findings: PatchProposalReviewFinding[]): Record<ReviewSeverity, number> {
  return {
    info: findings.filter((finding) => finding.severity === "info").length,
    low: findings.filter((finding) => finding.severity === "low").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    high: findings.filter((finding) => finding.severity === "high").length,
    critical: findings.filter((finding) => finding.severity === "critical").length
  };
}
