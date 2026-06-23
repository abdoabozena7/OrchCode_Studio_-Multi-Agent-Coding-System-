import { randomUUID } from "node:crypto";
import type {
  SemanticConflictDecision,
  SemanticConflictDecisionStatus,
  SemanticConflictPhase,
  SemanticConflictResolutionBatch,
  SemanticConflictResolutionBatchStatus,
  SemanticConflictSeverity
} from "@hivo/protocol";

export const SEMANTIC_CONFLICT_SCHEMA_VERSION = 1;

export function createSemanticConflictDecision(input: Omit<SemanticConflictDecision, "schema_version" | "decision_id" | "created_at" | "metadata_json" | "options" | "source_refs" | "evidence_refs" | "severity" | "status"> & {
  decision_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  options?: string[];
  source_refs?: string[];
  evidence_refs?: string[];
  severity?: SemanticConflictSeverity;
  status?: SemanticConflictDecisionStatus;
}): SemanticConflictDecision {
  const requiresUserApproval = input.requires_user_approval === true;
  const status = input.status ?? (requiresUserApproval ? "requires_user_approval" : "resolved");
  return {
    ...input,
    schema_version: SEMANTIC_CONFLICT_SCHEMA_VERSION,
    decision_id: input.decision_id ?? `semantic_conflict_decision_${randomUUID()}`,
    severity: input.severity ?? (requiresUserApproval || status === "blocked" ? "blocking" : "warning"),
    status,
    options: uniqueStrings(input.options ?? []),
    source_refs: uniqueStrings(input.source_refs ?? []),
    evidence_refs: uniqueStrings(input.evidence_refs ?? []),
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createSemanticConflictResolutionBatch(input: Omit<SemanticConflictResolutionBatch, "schema_version" | "batch_id" | "created_at" | "metadata_json" | "decision_ids" | "unresolved_decision_ids" | "status"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  status?: SemanticConflictResolutionBatchStatus;
}): SemanticConflictResolutionBatch {
  const batchId = input.batch_id ?? `semantic_conflict_batch_${randomUUID()}`;
  const decisions = input.decisions.map((decision) => ({ ...decision, batch_id: decision.batch_id ?? batchId }));
  const unresolved = decisions
    .filter((decision) => decision.requires_user_approval || decision.status === "requires_user_approval" || decision.status === "blocked")
    .map((decision) => decision.decision_id);
  return {
    ...input,
    schema_version: SEMANTIC_CONFLICT_SCHEMA_VERSION,
    batch_id: batchId,
    status: input.status ?? batchStatus(decisions),
    decisions,
    decision_ids: decisions.map((decision) => decision.decision_id),
    unresolved_decision_ids: uniqueStrings(unresolved),
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function semanticBatchBlocks(batch: SemanticConflictResolutionBatch | undefined) {
  return Boolean(batch?.decisions.some((decision) =>
    decision.severity === "blocking"
    || decision.requires_user_approval
    || decision.status === "requires_user_approval"
    || decision.status === "blocked"
  ));
}

export function semanticDecisionRequiresUser(decision: SemanticConflictDecision) {
  return decision.requires_user_approval || decision.status === "requires_user_approval";
}

function batchStatus(decisions: SemanticConflictDecision[]): SemanticConflictResolutionBatchStatus {
  if (!decisions.length) return "empty";
  if (decisions.some((decision) => decision.status === "provider_unavailable")) return "provider_unavailable";
  if (decisions.some((decision) => semanticDecisionRequiresUser(decision))) return "requires_user_approval";
  if (decisions.some((decision) => decision.status === "blocked" || decision.severity === "blocking")) return "blocked";
  return "resolved";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

export type {
  SemanticConflictDecision,
  SemanticConflictDecisionStatus,
  SemanticConflictPhase,
  SemanticConflictResolutionBatch,
  SemanticConflictResolutionBatchStatus,
  SemanticConflictSeverity
};
