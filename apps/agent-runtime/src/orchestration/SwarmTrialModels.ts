import type {
  RepoScope,
  SpecialistAgentDescriptor,
  StaffingPlan,
  SwarmMetrics,
  SwarmRiskLevel,
  SwarmRunMode,
  TaskComplexity
} from "./SwarmModels.js";

export const SWARM_TRIAL_SCHEMA_VERSION = 1;

export type SwarmExperimentScenarioType =
  | "automatic_staffing"
  | "synthetic_repo"
  | "scheduler_stress"
  | "mock_swarm"
  | "dry_run"
  | "live_safe_task"
  | "comparison"
  | "specialist_selection";

export type SwarmExperimentStatus = "created" | "running" | "succeeded" | "failed";

export type TrialComparisonMode =
  | "baseline-simple"
  | "orchestrated"
  | "autopilot-fast"
  | "autopilot-deep"
  | "autopilot-exhaustive"
  | "autopilot-huge-readonly";

export type ExpectedStaffingBehavior = {
  expected_complexity: TaskComplexity;
  expected_repo_scope?: RepoScope;
  expected_risk_level?: SwarmRiskLevel;
  expected_agent_range: [number, number];
  expected_executor_limit: number;
  expected_specialists?: string[];
  forbidden_specialists?: string[];
  min_read_only_ratio?: number;
  max_executor_count?: number;
  validation_level?: Array<"none" | "basic" | "normal" | "strict" | "exhaustive">;
  requires_human_approval?: boolean;
};

export type TrialTaskScenario = {
  id: string;
  title: string;
  input_goal: string;
  expected: ExpectedStaffingBehavior;
};

export type SwarmExperiment = {
  schema_version: number;
  id: string;
  title: string;
  description: string;
  scenario_type: SwarmExperimentScenarioType;
  tasks_to_test: TrialTaskScenario[];
  modes_to_compare: TrialComparisonMode[];
  expected_staffing_behavior: ExpectedStaffingBehavior[];
  created_at: string;
  status: SwarmExperimentStatus;
  config: Record<string, unknown>;
  results_ref?: string;
  report_ref?: string;
};

export type ExperimentRun = {
  schema_version: number;
  id: string;
  experiment_id: string;
  input_goal: string;
  mode: TrialComparisonMode | SwarmRunMode;
  uses_mock_agents: boolean;
  uses_real_model: boolean;
  uses_real_repo: boolean;
  status: "created" | "running" | "succeeded" | "failed";
  staffing_plan_ref?: string;
  effective_total_logical_agents: number;
  role_distribution: Record<string, number>;
  started_at: string;
  finished_at?: string;
  metrics_ref?: string;
  artifacts_ref?: string;
  final_report_ref?: string;
};

export type StaffingEvaluationResult = {
  schema_version: number;
  input_goal: string;
  expected_complexity: TaskComplexity;
  expected_repo_scope?: RepoScope;
  expected_risk_level?: SwarmRiskLevel;
  expected_agent_range: [number, number];
  expected_executor_limit: number;
  expected_specialists: string[];
  actual_staffing_plan: StaffingPlan;
  pass_fail: "pass" | "fail";
  reasoning: string[];
  deviations: string[];
};

export type ComparisonModeMetrics = {
  success_rate: number;
  validation_pass_rate: number;
  average_duration_ms: number;
  average_work_items: number;
  conflict_rate: number;
  repair_rate: number;
  review_findings: number;
  coverage_of_relevant_files: number;
  duplicate_work_rate: number;
  useful_finding_rate: number;
  selected_agents: number;
  executor_limit: number;
};

export type ComparisonResult = {
  schema_version: number;
  experiment_id: string;
  baseline_mode: TrialComparisonMode;
  compared_modes: TrialComparisonMode[];
  success_rates: Record<string, number>;
  validation_pass_rates: Record<string, number>;
  average_duration: Record<string, number>;
  average_work_items: Record<string, number>;
  conflict_rates: Record<string, number>;
  repair_rates: Record<string, number>;
  review_findings: Record<string, number>;
  coverage_of_relevant_files: Record<string, number>;
  duplicate_work_rate: Record<string, number>;
  useful_finding_rate: Record<string, number>;
  staffing_accuracy: Record<string, number>;
  recommendation: string;
  mode_metrics: Record<string, ComparisonModeMetrics>;
};

export type SwarmTuningPolicy = {
  schema_version: number;
  task_size_estimate: TaskComplexity;
  repo_size_estimate: "small_repo" | "medium_repo" | "large_repo" | "huge_repo";
  risk_level: SwarmRiskLevel;
  edit_scope_size: "read_only" | "single_file" | "few_files" | "many_files";
  validation_strength: "none" | "basic" | "normal" | "strict" | "exhaustive";
  recommended_mode: SwarmRunMode;
  recommended_total_logical_agents: number;
  executor_limit: number;
  reviewer_limit: number;
  scout_limit: number;
  specialist_agents: SpecialistAgentDescriptor[];
  reasoning: string[];
};

export type SwarmTrialReport = {
  schema_version: number;
  experiment_id: string;
  summary: string;
  scenarios_run: number;
  staffing_accuracy: number;
  modes_compared: TrialComparisonMode[];
  key_metrics: Record<string, number | string>;
  wins: string[];
  losses: string[];
  bottlenecks: string[];
  safety_findings: string[];
  specialist_selection_findings: string[];
  recommended_defaults: string[];
  next_improvements: string[];
};

export type SwarmTrialResult = {
  experiment: SwarmExperiment;
  runs: ExperimentRun[];
  staffingEvaluations: StaffingEvaluationResult[];
  comparison?: ComparisonResult;
  tuningPolicy: SwarmTuningPolicy;
  trialReport: SwarmTrialReport;
  markdownReport: string;
};

export type SwarmTrialMemoryRecord = {
  schema_version: number;
  id: string;
  created_at: string;
  experiment_id: string;
  task_type: string;
  predicted_complexity: TaskComplexity;
  selected_staffing: {
    total_agents: number;
    executor_limit: number;
    reviewer_limit: number;
    scout_count: number;
    specialists: string[];
  };
  actual_results: {
    pass_fail: "pass" | "fail";
    validation_pass_rate?: number;
    conflict_rate?: number;
    duplicate_work_rate?: number;
    useful_finding_rate?: number;
  };
  staffing_fit: "too_small" | "good" | "too_large" | "unknown";
  recommended_future_adjustment: string;
  confidence: number;
  evidence_count: number;
};

export type SchedulerScaleTrialResult = {
  run_id: string;
  metrics: SwarmMetrics;
  agent_instances: number;
  work_items: number;
  executor_peak_count: number;
  trace_ref: string;
  report_ref: string;
};
