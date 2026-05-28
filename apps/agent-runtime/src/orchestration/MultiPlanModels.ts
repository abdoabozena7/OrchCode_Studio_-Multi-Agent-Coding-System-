import type { CommandInventory, RepoIndex } from "../memory/types.js";
import type { ContextPack, Run } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { StaffingPlan, TaskComplexity } from "./SwarmModels.js";

export const REQUIRED_PLAN_PERSPECTIVES = [
  "mvp_first",
  "architecture_first",
  "risk_first",
  "test_first",
  "speed_first"
] as const;

export type PlanPerspective = typeof REQUIRED_PLAN_PERSPECTIVES[number];
export type MultiPlanGenerationMode = "deterministic" | "heuristic" | "provider_backed" | "mixed";
export type PlanningSeverity = "low" | "medium" | "high" | "critical";
export type PlanningConfidence = "low" | "medium" | "high";
export type PlanningEvidenceConfidence = PlanningConfidence;
export type PlanningEvidenceFreshness = "fresh" | "possibly_stale" | "stale" | "unknown";
export type PlanningEvidenceSourceType =
  | "provider_scout_output"
  | "provider_planner_output"
  | "provider_risk_analyst_output"
  | "provider_reviewer_output"
  | "provider_specialist_output"
  | "provider_tester_planner_output"
  | "provider_reporter_output"
  | "mock_worker_output"
  | "deterministic_context"
  | "repo_index"
  | "context_pack"
  | "validation_history"
  | "prior_failure"
  | "prior_decision";
export type PlanningEvidenceUsage =
  | "informed_plan_variant"
  | "adjusted_evaluation"
  | "merged_into_plan"
  | "risk_source"
  | "validation_source"
  | "architecture_source"
  | "not_used";

export type PlanningEvidenceItem = {
  evidence_id: string;
  run_id: string;
  task_id?: string;
  work_item_id?: string;
  source_type: PlanningEvidenceSourceType;
  source_role?: string;
  artifact_ref?: string;
  parsed_output_ref?: string;
  trace_event_id?: string;
  confidence: PlanningEvidenceConfidence;
  confidence_score: number;
  freshness: PlanningEvidenceFreshness;
  summary: string;
  extracted_findings: string[];
  extracted_risks: string[];
  extracted_tasks: string[];
  extracted_validation_recommendations: string[];
  extracted_dependencies: string[];
  metadata_json: Record<string, unknown>;
};

export type PlanningEvidenceConflict = {
  conflict_id: string;
  evidence_ids: string[];
  summary: string;
  severity: PlanningSeverity;
  resolution: string;
};

export type PlanningEvidenceSummary = {
  evidence_used: boolean;
  evidence_item_count: number;
  provider_evidence_count: number;
  mock_evidence_count: number;
  low_confidence_count: number;
  rejected_evidence_count: number;
  evidence_conflict_count: number;
  evidence_bundle_ref?: string;
  top_evidence_sources: PlanningEvidenceSourceType[];
  limitations: string[];
};

export type PlanningEvidenceBundle = {
  evidence_bundle_id: string;
  run_id: string;
  task_id?: string;
  generation_mode: MultiPlanGenerationMode;
  items: PlanningEvidenceItem[];
  rejected_items: Array<{
    source_ref?: string;
    source_role?: string;
    reason: string;
    artifact_ref?: string;
  }>;
  conflicts: PlanningEvidenceConflict[];
  summary: PlanningEvidenceSummary;
  limitations: string[];
  artifact_ref?: string;
  summary_ref?: string;
  created_at: string;
};

export type PlanningRisk = {
  id: string;
  summary: string;
  severity: PlanningSeverity;
  affected_domains: string[];
  mitigation: string;
  approval_required: boolean;
};

export type PlanningAssumption = {
  id: string;
  statement: string;
  confidence: PlanningConfidence;
  evidence_refs: string[];
};

export type PlanningDependency = {
  id: string;
  summary: string;
  dependency_type: "repo_context" | "command" | "artifact" | "approval" | "external" | "unknown";
  required: boolean;
  evidence_refs: string[];
};

export type PlanningValidationStrategy = {
  required_commands: string[];
  optional_commands: string[];
  smoke_checks: string[];
  manual_checks: string[];
  success_criteria: string[];
  validation_risk: PlanningSeverity;
};

export type PlanningTaskDraft = {
  id: string;
  title: string;
  objective: string;
  role_hint: string;
  read_only: boolean;
  proposed_files: string[];
  allowed_write_paths: string[];
  dependencies: string[];
  validation_refs: string[];
  rationale: string;
};

export type PlanVariant = {
  plan_id: string;
  run_id: string;
  task_id?: string;
  perspective: PlanPerspective;
  title: string;
  summary: string;
  generation_mode: MultiPlanGenerationMode;
  prompt_ref?: string;
  model_used?: string;
  assumptions: PlanningAssumption[];
  proposed_domains: string[];
  proposed_tasks: PlanningTaskDraft[];
  dependencies: PlanningDependency[];
  risks: PlanningRisk[];
  unknowns: string[];
  validation_strategy: PlanningValidationStrategy;
  suggested_agents: string[];
  suggested_limits: Record<string, number | string | boolean>;
  confidence: number;
  artifact_ref: string;
  evidence_bundle_ref?: string;
  evidence_item_refs?: string[];
  evidence_used_summary?: string[];
  created_at: string;
};

export type PlanEvaluationScore = {
  safety: number;
  completeness: number;
  minimality: number;
  testability: number;
  architecture_quality: number;
  implementation_speed: number;
  integration_risk: number;
  user_value: number;
  confidence: number;
};

export type PlanEvaluation = {
  evaluation_id: string;
  run_id: string;
  plan_id: string;
  perspective: PlanPerspective;
  scores: PlanEvaluationScore;
  strengths: string[];
  weaknesses: string[];
  contradictions: string[];
  risky_assumptions: string[];
  selected: boolean;
  rejected_reason?: string;
  confidence: number;
  artifact_ref: string;
  evidence_item_refs?: string[];
  evidence_influence_notes?: string[];
  created_at: string;
};

export type PlanningMergeDecision = {
  decision_id: string;
  source_plan_ids: string[];
  decision: string;
  rationale: string;
  confidence: number;
};

export type MergedPlan = {
  merged_plan_id: string;
  run_id: string;
  task_id?: string;
  generation_mode: MultiPlanGenerationMode;
  selected_plan_ids: string[];
  rejected_plan_ids: string[];
  summary: string;
  chosen_strategy: string;
  merged_tasks: PlanningTaskDraft[];
  dependencies: PlanningDependency[];
  risks: PlanningRisk[];
  assumptions: PlanningAssumption[];
  validation_strategy: PlanningValidationStrategy;
  recommended_limits: Record<string, number | string | boolean>;
  merge_rationale: string[];
  merge_decisions: PlanningMergeDecision[];
  unresolved_questions: string[];
  confidence: number;
  artifact_ref: string;
  evidence_bundle_ref?: string;
  evidence_item_refs?: string[];
  evidence_used_summary?: PlanningEvidenceSummary;
  evidence_conflicts?: PlanningEvidenceConflict[];
  evidence_limitations?: string[];
  evidence_influence_notes?: string[];
  created_at: string;
};

export type MultiPlanTriggerDecision = {
  use_multi_plan: boolean;
  reason: string;
  inferred_complexity: TaskComplexity;
  inferred_risk: PlanningSeverity;
  confidence: number;
};

export type MultiPlanInput = {
  run: Run;
  taskId?: string;
  rawUserRequest?: string;
  taskObjective?: string;
  structuredRequest?: Record<string, unknown>;
  repoIndex?: RepoIndex;
  commandInventory?: CommandInventory;
  contextPack?: ContextPack;
  staffingPlan?: StaffingPlan;
  projectIntake?: unknown;
  projectIntelligence?: unknown;
  config?: OrchestrationSafetyConfig;
  planOnly?: boolean;
  planningEvidence?: PlanningEvidenceBundle;
};

export type MultiPlanEvaluationContext = {
  trigger: MultiPlanTriggerDecision;
  generation_mode: MultiPlanGenerationMode;
  validation_commands: string[];
  high_signal_files: string[];
  risk_signals: string[];
  evidence_bundle?: PlanningEvidenceBundle;
};

export type MultiPlanFactoryResult = {
  used: boolean;
  trigger: MultiPlanTriggerDecision;
  generation_mode?: MultiPlanGenerationMode;
  variants: PlanVariant[];
  evaluations: PlanEvaluation[];
  merged_plan?: MergedPlan;
  summary?: MultiPlanSummary;
};

export type MultiPlanSummary = {
  multi_plan_used: boolean;
  generation_mode?: MultiPlanGenerationMode;
  plan_variant_count: number;
  selected_perspectives: PlanPerspective[];
  rejected_perspectives: PlanPerspective[];
  top_risks: string[];
  merged_plan_ref?: string;
  confidence: number;
  unresolved_questions: string[];
  recommended_next_step: string;
  evidence_used?: boolean;
  evidence_item_count?: number;
  provider_evidence_count?: number;
  mock_evidence_count?: number;
  low_confidence_count?: number;
  rejected_evidence_count?: number;
  evidence_conflict_count?: number;
  evidence_bundle_ref?: string;
  top_evidence_sources?: PlanningEvidenceSourceType[];
  evidence_limitations?: string[];
};
