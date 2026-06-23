export const SWARM_SCHEMA_VERSION = 1;
export const MAX_SUPPORTED_LOGICAL_AGENTS = 300;

export type SwarmRunStatus =
  | "created"
  | "intake"
  | "prompt_rewrite"
  | "clarification_check"
  | "repo_mapping"
  | "complexity_estimation"
  | "analyzing"
  | "staffing_plan"
  | "staffing"
  | "planning"
  | "task_graph_ready"
  | "scheduling"
  | "executing"
  | "reviewing"
  | "validating"
  | "integrating"
  | "memory_update"
  | "reporting"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type SwarmRunMode = "auto" | "fast" | "deep" | "exhaustive";
export type TaskComplexity = "tiny" | "small" | "medium" | "large" | "huge";
export type RepoScope = "single_file" | "few_files" | "single_module" | "multiple_modules" | "whole_repo";
export type SwarmRiskLevel = "low" | "medium" | "high" | "critical";
export type SwarmValidationLevel = "none" | "basic" | "normal" | "strict" | "exhaustive";
export type SwarmAgentOperation =
  | "read_repo_index"
  | "read_workspace_files"
  | "read_context_pack"
  | "read_run_artifacts"
  | "read_outputs"
  | "propose_plan"
  | "propose_patch"
  | "review_outputs"
  | "request_safe_validation"
  | "summarize_results"
  | "update_memory";

export type SwarmRoleName =
  | "ScoutAgent"
  | "PlannerAgent"
  | "ArchitectAgent"
  | "ExecutorAgent"
  | "ReviewerAgent"
  | "TesterAgent"
  | "IntegratorAgent"
  | "ReporterAgent"
  | "RiskAnalyzerAgent"
  | "MemoryUpdaterAgent"
  | "ContextBuilderAgent"
  | string;

export type WorkItemType =
  | "scout"
  | "plan"
  | "execute"
  | "review"
  | "test"
  | "integrate"
  | "summarize"
  | "memory_update"
  | "risk_analysis";

export type WorkItemStatus = "queued" | "ready" | "leased" | "running" | "succeeded" | "failed" | "blocked" | "skipped";
export type AgentInstanceStatus = "idle" | "leased" | "running" | "succeeded" | "failed" | "retired";

export type RoleCounts = {
  ScoutAgent: number;
  PlannerAgent: number;
  ArchitectAgent: number;
  ExecutorAgent: number;
  ReviewerAgent: number;
  TesterAgent: number;
  IntegratorAgent: number;
  ReporterAgent: number;
  RiskAnalyzerAgent: number;
  MemoryUpdaterAgent: number;
  ContextBuilderAgent: number;
  [role: string]: number;
};

export type SpecialistAgentDescriptor = {
  id: string;
  role: string;
  purpose: string;
  trigger: string;
  read_only: boolean;
  output_schema: string;
};

export type SwarmRun = {
  schema_version: number;
  id: string;
  campaign_id?: string;
  parent_run_id?: string;
  user_goal: string;
  original_request_ref?: string;
  intent_ledger_ref?: string;
  intent_contract_ref?: string;
  intent_contract_status?: import("@hivo/protocol").IntentContractStatus;
  status: SwarmRunStatus;
  mode: SwarmRunMode;
  staffing_plan_ref: string;
  effective_total_logical_agents: number;
  active_agent_count: number;
  max_supported_logical_agents: number;
  scheduler_config: SwarmSchedulerConfig;
  created_at: string;
  updated_at: string;
  artifacts_path: string;
  metrics_ref?: string;
  final_report_ref?: string;
};

export type SwarmSchedulerConfig = {
  max_parallel_agents: number;
  max_parallel_read_only_agents: number;
  executor_limit: number;
  write_agent_limit: number;
  reviewer_limit: number;
  tester_limit: number;
  risk_level: SwarmRiskLevel;
  validation_level: SwarmValidationLevel;
  backpressure_failure_threshold: number;
};

export type StaffingPlan = {
  schema_version: number;
  id: string;
  swarm_run_id: string;
  task_complexity: TaskComplexity;
  repo_scope: RepoScope;
  risk_level: SwarmRiskLevel;
  recommended_total_logical_agents: number;
  max_parallel_agents: number;
  scout_count: number;
  planner_count: number;
  architect_count: number;
  executor_count: number;
  reviewer_count: number;
  tester_count: number;
  integrator_count: number;
  specialist_agents: SpecialistAgentDescriptor[];
  role_counts: RoleCounts;
  executor_limit: number;
  reviewer_limit: number;
  tester_limit: number;
  read_only_ratio: number;
  write_agent_limit: number;
  validation_level: SwarmValidationLevel;
  requires_human_approval: boolean;
  reasoning: string[];
  confidence: number;
  downgrade_conditions: string[];
  escalation_conditions: string[];
  created_at: string;
};

export type AgentTemplate = {
  schema_version: number;
  id: string;
  role: SwarmRoleName;
  purpose: string;
  allowed_operations: SwarmAgentOperation[];
  forbidden_operations: string[];
  can_read_files: boolean;
  can_edit_files: boolean;
  can_run_commands: boolean;
  max_context_size: number;
  default_output_schema: string;
  risk_level: SwarmRiskLevel;
  suitable_task_types: WorkItemType[];
};

export type AgentInstance = {
  schema_version: number;
  id: string;
  template_id: string;
  role: SwarmRoleName;
  status: AgentInstanceStatus;
  current_work_item_id?: string;
  lease_id?: string;
  created_at: string;
  last_heartbeat_at: string;
  failure_count: number;
  completed_work_item_count: number;
  scratchpad_ref?: string;
};

export type WorkItem = {
  schema_version: number;
  id: string;
  swarm_run_id: string;
  task_id?: string;
  type: WorkItemType;
  priority: number;
  dependencies: string[];
  required_role: SwarmRoleName;
  read_files: string[];
  write_files: string[];
  team_id?: string;
  risk_level: SwarmRiskLevel;
  context_pack_ref?: string;
  expected_output_schema: string;
  status: WorkItemStatus;
  attempt_count: number;
  max_attempts: number;
  lease_id?: string;
  result_ref?: string;
  created_at: string;
  updated_at: string;
};

export type WorkItemResult = {
  schema_version: number;
  work_item_id: string;
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  relevant_files: string[];
  findings: string[];
  risks: string[];
  unknowns: string[];
  validation_passed?: boolean;
  structured_output_valid: boolean;
  confidence: number;
  intent_alignment?: import("@hivo/protocol").AgentIntentAlignment;
  intent_handoff_gate_ref?: string;
  intent_handoff_gate_status?: import("@hivo/protocol").IntentHandoffGateResult["status"];
};

export type SwarmScoutResult = {
  work_item_id: string;
  relevant_files: string[];
  relevant_symbols: string[];
  risks: string[];
  test_recommendations: string[];
  unknowns: string[];
  confidence: number;
};

export type ScoutAggregate = {
  relevant_files: string[];
  relevant_symbols: string[];
  risks: string[];
  test_recommendations: string[];
  unknowns: string[];
  confidence: number;
};

export type ConsensusGroup = {
  schema_version: number;
  id: string;
  swarm_run_id: string;
  topic: string;
  participant_work_items: string[];
  quorum_policy: "simple_majority" | "unanimous" | "reviewer_quorum" | "manual_approval";
  decision: string;
  consolidated_findings: string[];
  dissenting_findings: string[];
  confidence: number;
  created_at: string;
};

export type SwarmMetrics = {
  schema_version: number;
  swarm_run_id: string;
  staffing_plan_ref: string;
  effective_total_logical_agents: number;
  peak_active_agents: number;
  role_distribution: Record<string, number>;
  executor_peak_count: number;
  reviewer_peak_count: number;
  scout_peak_count: number;
  work_items_created: number;
  work_items_completed: number;
  work_items_failed: number;
  read_only_items: number;
  edit_items: number;
  review_items: number;
  validation_items: number;
  lock_wait_count: number;
  retries: number;
  repair_tasks: number;
  invalid_structured_outputs: number;
  consensus_groups: number;
  validation_pass_rate: number;
  conflicts_detected: number;
  approval_gates_triggered: number;
  generated_at: string;
};

export type SwarmEventType =
  | "swarm.run.created"
  | "swarm.intent_contract.compiled"
  | "swarm.task.analyzed"
  | "swarm.staffing_plan.created"
  | "swarm.effective_agents.selected"
  | "swarm.specialist_agents.created"
  | "swarm.work_item.queued"
  | "swarm.work_item.leased"
  | "swarm.lock.requested"
  | "swarm.lock.acquired"
  | "swarm.lock.denied"
  | "swarm.work_item.started"
  | "swarm.work_item.succeeded"
  | "swarm.work_item.failed"
  | "swarm.output_validation.failed"
  | "swarm.consensus.created"
  | "swarm.consensus.decision_made"
  | "swarm.executor.patch_proposed"
  | "swarm.patch.accepted"
  | "swarm.patch.rejected"
  | "swarm.validation.started"
  | "swarm.validation.completed"
  | "swarm.repair_item.created"
  | "swarm.concurrency.reduced"
  | "swarm.concurrency.increased"
  | "swarm.scheduler.backpressure_applied"
  | "swarm.run.completed";

export type SwarmEvent = {
  id: string;
  swarm_run_id: string;
  work_item_id?: string;
  type: SwarmEventType;
  message: string;
  created_at: string;
  payload?: Record<string, unknown>;
};

export type SchedulerTraceEntry = {
  id: string;
  swarm_run_id: string;
  tick: number;
  decision: string;
  reasoning: string;
  selected_work_items: string[];
  deferred_work_items: Array<{ id: string; reason: string }>;
  active_agent_count: number;
  executor_concurrency: number;
  parallel_limit?: number;
  queue_depth?: number;
  resource_snapshot?: Record<string, unknown>;
  aging_deferrals?: Record<string, number>;
  selected_role_distribution?: Record<string, number>;
  deferred_count_by_reason?: Record<string, number>;
  parallel_backpressure?: number;
  executor_backpressure?: number;
  created_at: string;
};

export type SwarmRunResult = {
  run: SwarmRun;
  staffingPlan: StaffingPlan;
  agentTemplates: AgentTemplate[];
  agentInstances: AgentInstance[];
  workItems: WorkItem[];
  metrics: SwarmMetrics;
  finalReport: string;
};
