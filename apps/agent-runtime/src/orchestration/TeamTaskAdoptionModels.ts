import { randomUUID } from "node:crypto";
import type { AgentRoleName } from "./OrchestrationModels.js";
import type { TeamSubPlan, TeamSubPlanTaskDraft, TeamSubPlanValidationStrategy } from "./TeamSubPlanningModels.js";

export type TaskAdoptionStatus =
  | "proposed"
  | "adopted_metadata_only"
  | "adopted_read_only"
  | "adopted_blocked"
  | "rejected"
  | "duplicate"
  | "out_of_scope"
  | "missing_validation"
  | "missing_success_criteria"
  | "missing_locks"
  | "unsafe_write_scope"
  | "ready_for_future_gate";

export type TaskReadinessStatus =
  | "metadata_only"
  | "read_only_ready"
  | "blocked"
  | "future_write_candidate"
  | "executable_ready";

export type TaskPromotionMode = "off" | "metadata_only" | "read_only_only" | "gated_future_ready";

export type ReadOrWriteClassification = "read_only" | "write_candidate" | "repair_candidate" | "unknown";

export type TaskAdoptionFinding = {
  finding_id: string;
  code:
    | "objective_missing"
    | "team_missing"
    | "scope_valid"
    | "out_of_scope"
    | "forbidden_file_conflict"
    | "allowed_files_missing"
    | "validation_missing"
    | "success_criteria_missing"
    | "stop_conditions_missing"
    | "locks_missing"
    | "prompt_profile_missing"
    | "context_missing"
    | "risk_classified"
    | "validation_weakening"
    | "duplicate"
    | "metadata_only_default"
    | "executable_disabled";
  severity: "info" | "warning" | "blocking";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
};

export type TaskReadinessRequirement = {
  requirement_id: string;
  requirement_type:
    | "objective"
    | "team_scope"
    | "allowed_files"
    | "forbidden_files"
    | "validation"
    | "success_criteria"
    | "stop_conditions"
    | "locks"
    | "prompt_profile"
    | "context"
    | "risk"
    | "execution_policy";
  status: "satisfied" | "missing" | "blocked" | "not_required";
  summary: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
};

export type TaskReadinessProfile = {
  readiness_id: string;
  run_id: string;
  team_id: string;
  sub_plan_id: string;
  task_draft_id: string;
  adopted_task_id?: string;
  readiness_status: TaskReadinessStatus;
  requirements: TaskReadinessRequirement[];
  findings: TaskAdoptionFinding[];
  executable_allowed: boolean;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TaskPromotionPolicy = {
  mode: TaskPromotionMode;
  allow_write_task_future_candidates: boolean;
  allow_executable_adoption: boolean;
  max_adopted_tasks_per_run: number;
  max_adopted_tasks_per_team: number;
  metadata_json: Record<string, unknown>;
};

export type TaskPromotionResult = {
  promotion_result_id: string;
  run_id: string;
  adopted_task_id: string;
  readiness_status: TaskReadinessStatus;
  executable: boolean;
  reason: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TeamTaskAdoptionRequest = {
  adoption_request_id: string;
  run_id: string;
  team_id?: string;
  sub_plan_ids: string[];
  mode: TaskPromotionMode;
  policy: TaskPromotionPolicy;
  requested_by: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type AdoptedTaskProposal = {
  adopted_task_id: string;
  run_id: string;
  team_id: string;
  sub_plan_id: string;
  source_task_draft_id: string;
  parent_task_id?: string;
  title: string;
  objective: string;
  task_type: string;
  read_or_write_classification: ReadOrWriteClassification;
  proposed_role: AgentRoleName | string;
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  dependencies: string[];
  validation_strategy: TeamSubPlanValidationStrategy;
  success_criteria: string[];
  stop_conditions: string[];
  prompt_template_ref?: string;
  context_pack_ref?: string;
  evidence_refs: string[];
  risk_level: "low" | "medium" | "high" | "critical";
  readiness_status: TaskReadinessStatus;
  adoption_status: TaskAdoptionStatus;
  artifact_ref?: string;
  readiness_ref?: string;
  decision_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TaskAdoptionDecision = {
  adoption_decision_id: string;
  run_id: string;
  team_id: string;
  sub_plan_id: string;
  task_draft_id: string;
  adopted_task_id?: string;
  adoption_status: TaskAdoptionStatus;
  readiness_status: TaskReadinessStatus;
  reason: string;
  findings: TaskAdoptionFinding[];
  artifact_ref?: string;
  readiness_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TeamTaskAdoptionResult = {
  adoption_result_id: string;
  run_id: string;
  request: TeamTaskAdoptionRequest;
  evaluated_drafts: number;
  proposals: AdoptedTaskProposal[];
  decisions: TaskAdoptionDecision[];
  readiness_results: TaskReadinessProfile[];
  summary: {
    adopted_metadata_only_count: number;
    adopted_read_only_count: number;
    rejected_count: number;
    duplicate_count: number;
    blocked_count: number;
    future_write_candidate_count: number;
    executable_ready_count: number;
  };
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TeamTaskAdoptionContext = {
  sub_plan: TeamSubPlan;
  draft: TeamSubPlanTaskDraft;
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  context_pack_ref?: string;
  existing_task_signatures: string[];
  already_adopted_signatures: string[];
  sibling_draft_signatures: string[];
};

export function createTeamTaskAdoptionRequest(input: Omit<TeamTaskAdoptionRequest, "adoption_request_id" | "created_at" | "metadata_json"> & {
  adoption_request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): TeamTaskAdoptionRequest {
  return {
    ...input,
    adoption_request_id: input.adoption_request_id ?? `team_task_adoption_request_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createAdoptedTaskProposal(input: Omit<AdoptedTaskProposal, "adopted_task_id" | "created_at" | "metadata_json"> & {
  adopted_task_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): AdoptedTaskProposal {
  return {
    ...input,
    adopted_task_id: input.adopted_task_id ?? `adopted_task_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createTaskAdoptionDecision(input: Omit<TaskAdoptionDecision, "adoption_decision_id" | "created_at" | "metadata_json"> & {
  adoption_decision_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): TaskAdoptionDecision {
  return {
    ...input,
    adoption_decision_id: input.adoption_decision_id ?? `team_task_adoption_decision_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createTaskReadinessProfile(input: Omit<TaskReadinessProfile, "readiness_id" | "created_at" | "metadata_json"> & {
  readiness_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): TaskReadinessProfile {
  return {
    ...input,
    readiness_id: input.readiness_id ?? `team_task_readiness_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createTaskAdoptionFinding(input: Omit<TaskAdoptionFinding, "finding_id" | "metadata_json"> & {
  finding_id?: string;
  metadata_json?: Record<string, unknown>;
}): TaskAdoptionFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `team_task_adoption_finding_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createTeamTaskAdoptionResult(input: Omit<TeamTaskAdoptionResult, "adoption_result_id" | "created_at" | "metadata_json" | "summary"> & {
  adoption_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): TeamTaskAdoptionResult {
  const proposals = input.proposals;
  const decisions = input.decisions;
  return {
    ...input,
    adoption_result_id: input.adoption_result_id ?? `team_task_adoption_result_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {},
    summary: {
      adopted_metadata_only_count: proposals.filter((proposal) => proposal.adoption_status === "adopted_metadata_only").length,
      adopted_read_only_count: proposals.filter((proposal) => proposal.adoption_status === "adopted_read_only").length,
      rejected_count: decisions.filter((decision) => decision.adoption_status === "rejected" || decision.adoption_status === "out_of_scope" || decision.adoption_status === "unsafe_write_scope").length,
      duplicate_count: decisions.filter((decision) => decision.adoption_status === "duplicate").length,
      blocked_count: decisions.filter((decision) => decision.adoption_status === "adopted_blocked" || decision.adoption_status.startsWith("missing_")).length,
      future_write_candidate_count: proposals.filter((proposal) => proposal.readiness_status === "future_write_candidate").length,
      executable_ready_count: proposals.filter((proposal) => proposal.readiness_status === "executable_ready").length
    }
  };
}

export function taskDraftSignature(title: string, objective: string) {
  return `${title}:${objective}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
