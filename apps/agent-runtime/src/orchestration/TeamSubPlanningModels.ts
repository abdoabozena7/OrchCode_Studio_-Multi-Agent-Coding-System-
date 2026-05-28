import { randomUUID } from "node:crypto";
import type { AgentTeam, AgentTeamType, TeamContextScope, TeamMemoryScopeRef } from "./AgentTeamModels.js";

export type TeamSubPlanStatus =
  | "proposed"
  | "generated"
  | "skipped"
  | "blocked"
  | "invalid"
  | "aggregated";

export type TeamSubPlanGenerationMode =
  | "deterministic"
  | "heuristic"
  | "provider_read_only"
  | "mixed";

export type TeamSubPlanTaskDraft = {
  task_draft_id: string;
  title: string;
  objective: string;
  role_hint: string;
  read_only: boolean;
  proposed_files: string[];
  allowed_write_paths: string[];
  forbidden_files: string[];
  required_context_refs: string[];
  evidence_refs: string[];
  validation_refs: string[];
  rationale: string;
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlanDependency = {
  dependency_id: string;
  dependency_type: "context" | "team" | "artifact" | "validation" | "lock" | "memory";
  source_ref: string;
  target_ref: string;
  depends_on_team_id?: string;
  depends_on_sub_plan_id?: string;
  summary: string;
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlanRisk = {
  risk_id: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  affected_files: string[];
  mitigation: string;
  evidence_refs: string[];
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlanValidationStrategy = {
  strategy_id: string;
  status: "planned" | "not_run" | "blocked";
  commands: string[];
  required_checks: string[];
  artifact_refs: string[];
  notes: string[];
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlanBudgetUsage = {
  max_task_count: number;
  proposed_task_count: number;
  max_depth: number;
  planned_depth: number;
  max_active_writers: number;
  provider_read_only_worker_budget: number;
  budget_warnings: string[];
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlanInput = {
  input_id: string;
  run_id: string;
  team_id: string;
  parent_team_id?: string;
  team: AgentTeam;
  team_context_scope: TeamContextScope;
  objective: string;
  scope_summary: string;
  context_pack_ref?: string;
  context_summary?: string;
  merged_plan_refs: string[];
  planning_evidence_refs: string[];
  memory_scope_refs: TeamMemoryScopeRef[];
  lock_context_refs: string[];
  generation_mode: TeamSubPlanGenerationMode;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlan = {
  sub_plan_id: string;
  run_id: string;
  team_id: string;
  parent_team_id?: string;
  team_domain: string;
  team_type: AgentTeamType;
  objective: string;
  status: TeamSubPlanStatus;
  scope_summary: string;
  assumptions: string[];
  proposed_tasks: TeamSubPlanTaskDraft[];
  dependencies: TeamSubPlanDependency[];
  risks: TeamSubPlanRisk[];
  validation_strategy: TeamSubPlanValidationStrategy;
  required_context_refs: string[];
  evidence_refs: string[];
  memory_scope_refs: TeamMemoryScopeRef[];
  lock_context_refs: string[];
  budget_usage: TeamSubPlanBudgetUsage;
  unresolved_questions: string[];
  confidence: number;
  generation_mode: TeamSubPlanGenerationMode;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  validation_findings: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TeamSubPlanConflict = {
  conflict_id: string;
  conflict_type: "duplicate_task" | "scope_overlap" | "validation_strategy" | "cross_team_dependency";
  severity: "info" | "warning" | "blocking";
  sub_plan_ids: string[];
  team_ids: string[];
  summary: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
};

export type TeamSubPlanAggregation = {
  aggregation_id: string;
  run_id: string;
  status: "generated" | "partial" | "empty";
  teams_planned: string[];
  teams_skipped: string[];
  accepted_sub_plans: string[];
  invalid_sub_plans: string[];
  cross_team_dependencies: TeamSubPlanConflict[];
  duplicate_task_groups: TeamSubPlanConflict[];
  scope_conflicts: TeamSubPlanConflict[];
  validation_strategy_summary: string[];
  top_risks: TeamSubPlanRisk[];
  unresolved_questions: string[];
  recommended_next_step: string;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TeamSubPlanSummary = {
  sub_plan_id: string;
  run_id: string;
  team_id: string;
  parent_team_id?: string;
  status: TeamSubPlanStatus;
  generation_mode: TeamSubPlanGenerationMode;
  proposed_task_count: number;
  risk_count: number;
  dependency_count: number;
  confidence: number;
  artifact_ref?: string;
  summary_ref?: string;
};

export type TeamSubPlanValidationResult = {
  valid: boolean;
  status: TeamSubPlanStatus;
  findings: string[];
  blocking_findings: string[];
};

export function createTeamSubPlanTaskDraft(input: Omit<TeamSubPlanTaskDraft, "task_draft_id" | "metadata_json"> & { task_draft_id?: string; metadata_json?: Record<string, unknown> }): TeamSubPlanTaskDraft {
  return {
    ...input,
    task_draft_id: input.task_draft_id ?? `team_task_draft_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createTeamSubPlan(input: Omit<TeamSubPlan, "sub_plan_id" | "created_at" | "metadata_json" | "validation_findings"> & {
  sub_plan_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  validation_findings?: string[];
}): TeamSubPlan {
  return {
    ...input,
    sub_plan_id: input.sub_plan_id ?? `team_sub_plan_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {},
    validation_findings: input.validation_findings ?? []
  };
}

export function createTeamSubPlanAggregation(input: Omit<TeamSubPlanAggregation, "aggregation_id" | "created_at" | "metadata_json"> & {
  aggregation_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): TeamSubPlanAggregation {
  return {
    ...input,
    aggregation_id: input.aggregation_id ?? `team_sub_plan_aggregation_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}
