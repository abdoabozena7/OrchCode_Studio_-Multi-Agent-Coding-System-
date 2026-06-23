import { randomUUID } from "node:crypto";

export const PROJECT_GOAL_SPEC_SCHEMA_VERSION = 1;
export const GOAL_STEWARD_SCHEMA_VERSION = 1;

export type ProjectGoalSpecStatus = "draft" | "active" | "superseded" | "archived";

export type ProjectGoalTradeoff = {
  name: string;
  prefer: string;
  over: string;
  rationale?: string;
};

export type ProjectGoalSpec = {
  schema_version: number;
  spec_id: string;
  project_id?: string;
  title: string;
  primary_goal: string;
  non_goals: string[];
  tradeoffs: ProjectGoalTradeoff[];
  constraints: string[];
  accepted_examples: string[];
  rejected_examples: string[];
  source_refs: string[];
  version: number;
  status: ProjectGoalSpecStatus;
  artifact_ref?: string;
  summary_ref?: string;
  created_at: string;
  updated_at: string;
  metadata_json: Record<string, unknown>;
};

export type GoalStewardMode = "strict" | "report_only";

export type GoalStewardReviewStatus =
  | "aligned"
  | "conflicts_with_spec"
  | "requires_human_approval"
  | "insufficient_spec"
  | "provider_unavailable";

export type GoalStewardFindingType =
  | "conflicts_with_spec"
  | "requires_human_approval"
  | "insufficient_spec"
  | "provider_unavailable"
  | "warning";

export type GoalStewardRecommendedAction =
  | "allow"
  | "block_integration"
  | "require_human_approval"
  | "clarify_spec";

export type GoalStewardFinding = {
  finding_id: string;
  review_id: string;
  run_id: string;
  candidate_id?: string;
  task_id?: string;
  finding_type: GoalStewardFindingType;
  severity: "info" | "warning" | "blocking";
  spec_refs: string[];
  candidate_refs: string[];
  rationale: string;
  recommended_action: GoalStewardRecommendedAction;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export type GoalStewardReview = {
  schema_version: number;
  review_id: string;
  run_id: string;
  spec_id?: string;
  spec_ref?: string;
  status: GoalStewardReviewStatus;
  mode: GoalStewardMode;
  candidate_count: number;
  findings: GoalStewardFinding[];
  rationale: string;
  artifact_ref?: string;
  summary_ref?: string;
  created_at: string;
  metadata_json: Record<string, unknown>;
};

export function createProjectGoalSpec(input: Omit<ProjectGoalSpec, "schema_version" | "spec_id" | "created_at" | "updated_at" | "metadata_json"> & {
  spec_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata_json?: Record<string, unknown>;
}): ProjectGoalSpec {
  const now = new Date().toISOString();
  return {
    ...input,
    schema_version: PROJECT_GOAL_SPEC_SCHEMA_VERSION,
    spec_id: input.spec_id ?? `project_goal_spec_${randomUUID()}`,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? input.created_at ?? now,
    metadata_json: input.metadata_json ?? {}
  };
}

export function createGoalStewardFinding(input: Omit<GoalStewardFinding, "finding_id" | "created_at" | "metadata_json"> & {
  finding_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): GoalStewardFinding {
  return {
    ...input,
    finding_id: input.finding_id ?? `goal_steward_finding_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}

export function createGoalStewardReview(input: Omit<GoalStewardReview, "schema_version" | "review_id" | "created_at" | "metadata_json"> & {
  review_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): GoalStewardReview {
  return {
    ...input,
    schema_version: GOAL_STEWARD_SCHEMA_VERSION,
    review_id: input.review_id ?? `goal_steward_review_${randomUUID()}`,
    created_at: input.created_at ?? new Date().toISOString(),
    metadata_json: input.metadata_json ?? {}
  };
}
