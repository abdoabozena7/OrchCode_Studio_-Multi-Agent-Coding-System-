import { randomUUID } from "node:crypto";
import type { OverallValidationStatus } from "./ValidationSemantics.js";

export type IntegrationStatus =
  | "not_required"
  | "pending"
  | "planned"
  | "applying"
  | "applied"
  | "validating"
  | "passed"
  | "failed"
  | "blocked"
  | "partial"
  | "rolled_back"
  | "cancelled";

export type IntegrationApplyMode = "prepare_only" | "dry_run" | "safe_adapter";
export type IntegrationRiskLevel = "low" | "medium" | "high" | "critical";
export type IntegrationValidationImpact = "allow_success" | "failed" | "blocked" | "partial" | "not_required";

export type IntegrationArtifactRef = {
  kind: string;
  artifact_ref: string;
  task_id?: string;
  candidate_id?: string;
  status?: string;
  metadata_json?: Record<string, unknown>;
};

export type IntegrationCandidate = {
  candidate_id: string;
  run_id: string;
  task_id: string;
  patch_ref?: string;
  change_artifact_ref?: string;
  review_ref?: string;
  validation_ref?: string;
  changed_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  dependencies: string[];
  status: IntegrationStatus;
  risk_level: IntegrationRiskLevel;
  metadata_json: Record<string, unknown>;
  review_decision?: string;
  validation_status?: OverallValidationStatus;
  rejection_reasons?: string[];
};

export type IntegrationConflict = {
  conflict_id: string;
  run_id: string;
  candidate_ids: string[];
  conflict_type:
    | "same_file"
    | "path_overlap"
    | "module_lock"
    | "semantic_lock"
    | "public_api_risk"
    | "config_risk"
    | "database_schema_risk"
    | "dependency_manifest_risk"
    | "missing_review"
    | "missing_validation"
    | "validation_not_passed"
    | "stale_candidate"
    | "lock_rejected"
    | "apply_failed"
    | "goal_spec_conflict"
    | "goal_change_requires_approval"
    | "goal_spec_missing"
    | "goal_steward_unavailable";
  changed_files: string[];
  lock_refs: string[];
  severity: "warning" | "blocking";
  reason: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationRollbackPlan = {
  rollback_plan_id: string;
  run_id: string;
  status: "manual_limited" | "automatic_available" | "not_required";
  candidate_ids: string[];
  changed_files: string[];
  rollback_refs: string[];
  instructions: string[];
  artifact_ref?: string;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type IntegrationBatch = {
  integration_batch_id: string;
  run_id: string;
  candidate_ids: string[];
  changed_files: string[];
  required_locks: string[];
  module_locks: string[];
  semantic_locks: string[];
  status: IntegrationStatus;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationPlan = {
  integration_plan_id: string;
  run_id: string;
  candidates: IntegrationCandidate[];
  dependency_order: string[];
  conflict_checks: IntegrationConflict[];
  required_locks: string[];
  validation_plan: {
    status: IntegrationStatus;
    commands: string[];
    impacted_files: string[];
    validation_refs: string[];
    metadata_json: Record<string, unknown>;
  };
  rollback_plan: IntegrationRollbackPlan;
  batches: IntegrationBatch[];
  artifact_ref?: string;
  warnings: string[];
  created_at: string;
};

export type IntegrationResult = {
  integration_result_id: string;
  run_id: string;
  status: IntegrationStatus;
  applied_candidates: string[];
  rejected_candidates: string[];
  blocked_candidates: string[];
  conflicts: IntegrationConflict[];
  validation_status: OverallValidationStatus;
  validation_refs: string[];
  rollback_refs: string[];
  changed_files: string[];
  artifact_ref?: string;
  trace_event_id?: string;
  created_at: string;
  blocked_reason?: string;
  apply_mode: IntegrationApplyMode;
  rollback_available: boolean;
  metadata_json: Record<string, unknown>;
};

export function createIntegrationCandidate(input: Omit<IntegrationCandidate, "candidate_id" | "risk_level" | "metadata_json"> & {
  candidate_id?: string;
  risk_level?: IntegrationRiskLevel;
  metadata_json?: Record<string, unknown>;
}): IntegrationCandidate {
  return {
    ...input,
    candidate_id: input.candidate_id ?? `integration_candidate_${randomUUID()}`,
    risk_level: input.risk_level ?? riskLevelForFiles(input.changed_files),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createIntegrationPlan(input: Omit<IntegrationPlan, "integration_plan_id" | "created_at" | "warnings"> & {
  integration_plan_id?: string;
  created_at?: string;
  warnings?: string[];
}): IntegrationPlan {
  return {
    ...input,
    integration_plan_id: input.integration_plan_id ?? `integration_plan_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    warnings: input.warnings ?? []
  };
}

export function createIntegrationResult(input: Omit<IntegrationResult, "integration_result_id" | "created_at" | "metadata_json"> & {
  integration_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationResult {
  return {
    ...input,
    integration_result_id: input.integration_result_id ?? `integration_result_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function integrationStatusFromValidation(status: OverallValidationStatus): IntegrationStatus {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "partial") return "partial";
  if (status === "blocked" || status === "skipped" || status === "not_run") return "blocked";
  return "not_required";
}

export function integrationValidationImpact(status: OverallValidationStatus): IntegrationValidationImpact {
  if (status === "passed") return "allow_success";
  if (status === "failed") return "failed";
  if (status === "partial") return "partial";
  if (status === "blocked" || status === "skipped" || status === "not_run") return "blocked";
  return "not_required";
}

export function isIntegrationSuccessful(status: IntegrationStatus): boolean {
  return status === "passed" || status === "not_required";
}

export function isIntegrationBlocking(status: IntegrationStatus): boolean {
  return status === "blocked" || status === "partial" || status === "pending" || status === "planned" || status === "validating" || status === "applying";
}

export function riskLevelForFiles(files: string[]): IntegrationRiskLevel {
  const normalized = files.map((file) => file.replace(/\\/g, "/").toLowerCase());
  if (normalized.some((file) => file.includes("package-lock.json") || file.includes("package.json") || file.includes("pnpm-lock") || file.includes("yarn.lock"))) return "high";
  if (normalized.some((file) => file.includes("schema") || file.includes("migration") || file.endsWith(".sql"))) return "high";
  if (normalized.some((file) => file.includes("/api/") || file.endsWith(".d.ts") || file.includes("config"))) return "medium";
  return files.length > 5 ? "medium" : "low";
}
