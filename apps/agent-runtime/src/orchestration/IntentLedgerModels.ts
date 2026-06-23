import type { IntentContract } from "@hivo/protocol";

export const INTENT_LEDGER_SCHEMA_VERSION = 1;

export type IntentRunKind = "core" | "swarm" | "runtime_session";

export type OriginalRequestArtifact = {
  schema_version: number;
  run_id: string;
  run_kind: IntentRunKind;
  original_request: string;
  request_hash: string;
  source: "user";
  created_at: string;
  artifact_ref: string;
  summary_ref: string;
  metadata_json: Record<string, unknown>;
};

export type ContextLedgerEntryKind =
  | "original_request_recorded"
  | "intent_contract_compiled"
  | "locked_definition_recorded"
  | "context_pack_bound"
  | "prompt_writer_bound"
  | "swarm_context_bound"
  | "initial_intent_review"
  | "final_intent_review"
  | "intent_rewrite_suggested";

export type ContextLedgerEntry = {
  schema_version: number;
  ledger_entry_id: string;
  run_id: string;
  run_kind: IntentRunKind;
  revision: number;
  entry_kind: ContextLedgerEntryKind;
  summary: string;
  artifact_refs: string[];
  source_component: string;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type LockedIntentDefinition = {
  schema_version: number;
  definition_id: string;
  run_id: string;
  run_kind: IntentRunKind;
  revision: number;
  term: string;
  definition: string;
  source: "user_clarification" | "product_spec" | "plan_clarification" | "system";
  approval_ref?: string;
  supersedes_definition_id?: string;
  created_at: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type IntentReviewStatus =
  | "aligned"
  | "possible_drift"
  | "drift_detected"
  | "insufficient_context";

export type IntentReviewStage = "initial" | "final";

export type IntentReviewFinding = {
  finding_id: string;
  severity: "info" | "warning" | "blocking";
  finding_type:
    | "aligned"
    | "possible_drift"
    | "drift_detected"
    | "insufficient_context"
    | "provider_unavailable";
  rationale: string;
  evidence_refs: string[];
  recommended_action: "allow" | "review_manually" | "clarify_intent";
};

export type IntentReviewResult = {
  schema_version: number;
  review_id: string;
  run_id: string;
  run_kind: IntentRunKind;
  stage: IntentReviewStage;
  status: IntentReviewStatus;
  mode: "report_only";
  original_request_ref?: string;
  intent_ledger_ref?: string;
  reviewed_artifact_refs: string[];
  rationale: string;
  findings: IntentReviewFinding[];
  provider_used: boolean;
  rewrite_suggestion_ref?: string;
  created_at: string;
  artifact_ref?: string;
  summary_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type IntentRewriteTarget = "prompt" | "output" | "plan" | "final_report" | "swarm_context" | "unknown";

export type IntentRewriteSuggestion = {
  schema_version: number;
  suggestion_id: string;
  run_id: string;
  run_kind: IntentRunKind;
  review_id: string;
  stage: IntentReviewStage;
  target: IntentRewriteTarget;
  status: "suggested" | "not_available";
  source: "provider";
  original_request_ref?: string;
  intent_ledger_ref?: string;
  parent_context_refs: string[];
  rationale: string;
  rewritten_prompt?: string;
  rewritten_output_summary?: string;
  smarter_solution?: string;
  additional_context_needed: string[];
  created_at: string;
  artifact_ref?: string;
  summary_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type IntentContextSnapshot = {
  original_request?: OriginalRequestArtifact;
  original_request_ref?: string;
  original_request_hash?: string;
  intent_contract?: IntentContract;
  intent_contract_ref?: string;
  intent_contract_status?: IntentContract["status"];
  intent_ledger_ref?: string;
  intent_ledger_refs: string[];
  locked_definitions: LockedIntentDefinition[];
  latest_review?: IntentReviewResult;
};
