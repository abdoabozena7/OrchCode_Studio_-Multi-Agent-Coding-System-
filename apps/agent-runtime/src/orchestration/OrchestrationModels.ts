export const ORCHESTRATION_SCHEMA_VERSION = 1;

export type RunStatus =
  | "created"
  | "indexing"
  | "planning"
  | "executing"
  | "reviewing"
  | "verifying"
  | "integrating"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped";

export type AgentInvocationStatus = "created" | "running" | "succeeded" | "failed" | "cancelled";

export type AgentRoleName =
  | "ScoutAgent"
  | "ArchitectAgent"
  | "PlannerAgent"
  | "ExecutorAgent"
  | "ReviewerAgent"
  | "TesterAgent"
  | "IntegratorAgent"
  | "ReporterAgent";

export type Run = {
  schema_version: number;
  id: string;
  user_request: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
  root_task_ids: string[];
  memory_snapshot_ref: string;
  config: {
    workspace_path: string;
    memory_dir: string;
    max_context_files: number;
    max_context_chars: number;
    max_task_attempts: number;
    provider_mode: "mock";
    execution_mode?: "fast" | "deep" | "exhaustive";
    max_tasks_per_run?: number;
    max_parallel_tasks?: number;
    max_repair_rounds?: number;
    max_files_per_task?: number;
    max_validation_log_size?: number;
    max_patch_bytes?: number;
    lock_ttl_ms?: number;
    enable_multi_perspective_review?: boolean;
    enable_parallel_execution?: boolean;
    validation_level?: "basic" | "standard" | "strict";
    require_human_approval_for_risky_files?: boolean;
    validation_timeout?: number;
    safe_commands_allowlist?: string[];
  };
  summary?: string;
  artifacts_path: string;
};

export type Task = {
  schema_version: number;
  id: string;
  run_id: string;
  parent_id?: string;
  title: string;
  objective: string;
  role_required: AgentRoleName;
  status: TaskStatus;
  dependencies: string[];
  relevant_files: string[];
  allowed_files_to_edit: string[];
  forbidden_files: string[];
  input_context?: string;
  expected_output_schema: string;
  validation_commands: string[];
  max_attempts: number;
  attempt_count: number;
  result_summary?: string;
  artifacts: string[];
  created_at: string;
  updated_at: string;
};

export type AgentRole = {
  name: AgentRoleName;
  purpose: string;
  allowed_operations: string[];
  forbidden_operations: string[];
  default_prompt: string;
  expected_output_schema: string;
  can_edit_files: boolean;
  can_run_commands: boolean;
  review_required: boolean;
  required_output_format: string;
  success_criteria: string[];
};

export type AgentInvocation = {
  schema_version: number;
  id: string;
  run_id: string;
  task_id: string;
  role: AgentRoleName;
  prompt: string;
  context_pack_ref: string;
  started_at: string;
  finished_at?: string;
  status: AgentInvocationStatus;
  raw_output_ref?: string;
  parsed_output_ref?: string;
  error?: string;
};

export type ContextSnippet = {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  truncated: boolean;
};

export type ContextPack = {
  schema_version: number;
  id: string;
  run_id: string;
  task_id: string;
  objective: string;
  relevant_files: string[];
  snippets: ContextSnippet[];
  repo_index_refs: string[];
  constraints: string[];
  allowed_files_to_edit: string[];
  forbidden_files: string[];
  previous_decisions: string[];
  expected_output_schema: string;
  validation_requirements: string[];
  approximate_size: number;
  warnings: string[];
};

export type ValidationResultRecord = {
  command: string;
  status: "not_run" | "passed" | "failed" | "blocked";
  summary: string;
};

export type FinalRunReport = {
  schema_version: number;
  run_id: string;
  status: RunStatus;
  user_request: string;
  tasks_created: number;
  tasks_completed: number;
  tasks_failed: number;
  files_changed: string[];
  validation_results: ValidationResultRecord[];
  artifacts_path: string;
  limitations: string[];
  next_recommendations: string[];
  completed_tasks?: string[];
  failed_tasks?: string[];
  changed_files?: string[];
  unresolved_risks?: string[];
  next_steps?: string[];
};

export type OrchestratorEvent = {
  id: string;
  run_id: string;
  task_id?: string;
  type:
    | "run.created"
    | "run.status_changed"
    | "run.checkpoint_written"
    | "run.resumed"
    | "index.stale"
    | "repo.indexed"
    | "task.created"
    | "task.status_changed"
    | "context_pack.created"
    | "agent.invocation_started"
    | "agent.invocation_finished"
    | "artifact.written"
    | "lock.acquired"
    | "lock.released"
    | "lock.conflict"
    | "agent.output_parsed"
    | "agent.output_validation_failed"
    | "agent.output_repaired"
    | "patch.created"
    | "patch.rejected"
    | "review.started"
    | "review.completed"
    | "validation.command_started"
    | "validation.command_completed"
    | "approval.required"
    | "repair.task_created"
    | "integration.decision_recorded"
    | "task.ready"
    | "task.started"
    | "task.succeeded"
    | "task.failed"
    | "task.blocked"
    | "run.reported"
    | "run.completed"
    | "metrics.written"
    | "campaign.created"
    | "campaign.planned"
    | "campaign.paused"
    | "campaign.resumed"
    | "campaign.run_started"
    | "campaign.run_completed"
    | "run.failed";
  message: string;
  created_at: string;
  payload?: Record<string, unknown>;
};

export type ParsedAgentOutput = {
  summary: string;
  status: "succeeded" | "failed" | "blocked";
  files_changed: string[];
  validation_results: ValidationResultRecord[];
  artifacts: string[];
  limitations: string[];
  next_recommendations: string[];
};

export type RunCheckpoint = {
  schema_version: number;
  id: string;
  run_id: string;
  label: string;
  created_at: string;
  run_status: RunStatus;
  task_graph_state: Task[];
  memory_snapshot_ref: string;
  config: Run["config"];
  index_freshness?: unknown;
  notes: string[];
};

export type RunMetrics = {
  schema_version: number;
  run_id: string;
  status: RunStatus;
  generated_at: string;
  tasks_created: number;
  tasks_completed: number;
  tasks_failed: number;
  repair_attempts: number;
  validation: {
    passed: number;
    failed: number;
    blocked: number;
  };
  files_changed: number;
  review_findings_by_severity: Record<string, number>;
  time_per_stage_ms: Record<string, number>;
  context_size_approximation: number;
  invalid_structured_outputs: number;
  repeated_failure_fingerprints: number;
  stale_index_warnings: number;
  approval_gates_triggered: number;
};

export type CampaignStatus =
  | "created"
  | "analyzing"
  | "planning"
  | "running"
  | "paused"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type CampaignMilestone = {
  id: string;
  title: string;
  objective: string;
  status: "pending" | "running" | "succeeded" | "failed" | "blocked" | "skipped";
  run_id?: string;
  created_at: string;
  updated_at: string;
};

export type Campaign = {
  schema_version: number;
  id: string;
  title: string;
  original_goal: string;
  status: CampaignStatus;
  created_at: string;
  updated_at: string;
  runs: string[];
  milestones: CampaignMilestone[];
  risks: string[];
  decisions: string[];
  memory_refs: string[];
  final_report_ref?: string;
};

export type CampaignMetrics = {
  schema_version: number;
  campaign_id: string;
  generated_at: string;
  runs: number;
  milestones_total: number;
  milestones_completed: number;
  milestones_failed: number;
  status: CampaignStatus;
};
