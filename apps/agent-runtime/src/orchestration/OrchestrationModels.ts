export const ORCHESTRATION_SCHEMA_VERSION = 1;

export type RunStatus =
  | "created"
  | "intake"
  | "prompt_rewrite"
  | "clarification_check"
  | "repo_mapping"
  | "complexity_estimation"
  | "staffing_plan"
  | "indexing"
  | "planning"
  | "task_graph_ready"
  | "executing"
  | "reviewing"
  | "validating"
  | "verifying"
  | "integrating"
  | "memory_update"
  | "reporting"
  | "succeeded"
  | "failed"
  | "blocked"
  | "analyzing"
  | "staffing"
  | "scheduling"
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
    enable_internal_swarm_autopilot?: boolean;
    max_supported_logical_agents?: number;
    max_swarm_parallel_agents?: number;
    max_swarm_executors?: number;
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
    enable_multi_plan_factory?: boolean;
    enable_parallel_execution?: boolean;
    validation_level?: "basic" | "standard" | "strict";
    require_human_approval_for_risky_files?: boolean;
    validation_timeout?: number;
    safe_commands_allowlist?: string[];
    swarm_worker_mode?: "mock" | "provider_read_only" | "auto";
    use_planning_evidence?: boolean;
    planning_evidence_mode?: "off" | "available" | "require_for_provider_mode";
    max_evidence_items?: number;
    min_evidence_confidence?: number;
    allow_mock_evidence?: boolean;
    prompt_writer_mode?: "off" | "shadow" | "advisory" | "gated_adopt";
    prompt_writer_provider_mode?: "deterministic" | "provider_read_only" | "auto";
    enable_team_sub_planning?: boolean;
    team_sub_planning_mode?: "off" | "deterministic" | "provider_read_only" | "auto";
    max_team_sub_plans_per_run?: number;
    max_team_sub_plan_tasks?: number;
    max_team_sub_plan_depth?: number;
    allow_provider_team_sub_planning?: boolean;
    enable_team_task_adoption?: boolean;
    team_task_adoption_mode?: "off" | "metadata_only" | "read_only_only" | "gated_future_ready";
    max_adopted_tasks_per_run?: number;
    max_adopted_tasks_per_team?: number;
    allow_write_task_future_candidates?: boolean;
    allow_executable_adoption?: boolean;
    enable_proposed_task_graph?: boolean;
    proposed_task_graph_mode?: "off" | "metadata_only" | "read_only_ready";
    max_proposed_nodes_per_run?: number;
    max_proposed_edges_per_run?: number;
    block_cycles?: boolean;
    dedupe_proposed_nodes?: boolean;
    execution_readiness_gate_enabled?: boolean;
    execution_readiness_mode?: "off" | "report_only" | "strict";
    allow_read_only_promotion_candidates?: boolean;
    allow_write_future_candidates?: boolean;
    require_human_approval_for_write?: boolean;
    allow_auto_approval_for_low_risk_read_only?: boolean;
    max_nodes_evaluated_per_run?: number;
    enable_execution_promotion_queue?: boolean;
    promotion_queue_mode?: "off" | "report_only" | "approval_records" | "queue_candidates";
    allow_read_only_queue_without_human_approval?: boolean;
    approval_default_ttl_hours?: number;
    allow_test_fixture_approvals?: boolean;
    track_blocked_promotion_requests?: boolean;
    enable_execution_preparation?: boolean;
    execution_preparation_mode?: "off" | "report_only" | "prepare_only";
    max_preparation_plans_per_run?: number;
    require_human_approval_for_write_preparation?: boolean;
    allow_read_only_preparation_without_human_approval?: boolean;
    block_on_stale_context?: boolean;
    block_on_prompt_quality_warning_for_write?: boolean;
    enable_one_writer_dry_run?: boolean;
    one_writer_dry_run_mode?: "off" | "fake_provider" | "provider" | "auto";
    enable_patch_proposal_review_gate?: boolean;
    patch_proposal_review_mode?: "off" | "deterministic" | "fake_provider" | "provider" | "auto";
    enable_validation_candidate_gate?: boolean;
    validation_candidate_mode?: "off" | "report_only" | "preflight";
    enable_patch_apply_sandbox?: boolean;
    patch_apply_sandbox_mode?: "off" | "simulate_only" | "temp_copy" | "git_worktree_if_available";
    enable_sandbox_validation?: boolean;
    sandbox_validation_mode?: "off" | "report_only" | "execute_safe_commands";
    enable_sandbox_integration_candidates?: boolean;
    sandbox_integration_candidate_mode?: "off" | "report_only" | "create_candidates";
    enable_integration_apply_approval_gate?: boolean;
    integration_apply_approval_mode?: "off" | "report_only" | "require_approval";
    enable_controlled_integration_apply?: boolean;
    controlled_apply_mode?: "off" | "report_only" | "apply_with_approval";
    enable_integration_finalization?: boolean;
    integration_finalization_mode?: "off" | "report_only" | "finalize_metadata";
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
  prompt_metadata?: {
    prompt_id: string;
    prompt_type: string;
    template_id: string;
    template_version: string;
    renderer_version: string;
    template_input_schema_version: string;
    input_hash: string;
    rendered_prompt_hash: string;
    context_pack_ref: string;
    output_schema_name: string;
    prompt_artifact_ref?: string;
    source_component: string;
  };
};

export type ContextSnippet = {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  truncated: boolean;
};

export type ContextSourceType =
  | "direct_allowed_file"
  | "read_only_dependency"
  | "forbidden_file_reference"
  | "repo_index_summary"
  | "file_summary"
  | "symbol_reference"
  | "prior_decision"
  | "prior_failure"
  | "successful_pattern"
  | "lesson"
  | "validation_command"
  | "task_dependency"
  | "artifact_reference"
  | "user_constraint"
  | "policy_requirement"
  | "risk_warning"
  | "project_intelligence"
  | "fallback_heuristic"
  | "team_scope_allowed_file"
  | "team_scope_read_only_dependency"
  | "team_scope_forbidden_guardrail"
  | "team_parent_scope_constraint"
  | "team_memory_scope_decision"
  | "team_memory_scope_failure"
  | "team_planning_evidence"
  | "team_semantic_lock_context"
  | "team_module_lock_context"
  | "team_budget_warning"
  | "team_scope_fallback";

export type ContextFreshness = "current" | "fresh" | "possibly_stale" | "stale" | "unknown";
export type ContextAccessMode =
  | "editable"
  | "read_only"
  | "forbidden"
  | "caution"
  | "reference_only"
  | "validation_only"
  | "memory_only";
export type ContextConfidence = "high" | "medium" | "low";

export type ContextItemEvidence = {
  evidence_ref: string;
  evidence_type?: ContextSourceType | string;
  source_path?: string;
  summary?: string;
};

export type ContextPackInclusionRecord = {
  item_id: string;
  item_type: string;
  source_type: ContextSourceType;
  source_ref: string;
  source_path?: string;
  task_id: string;
  run_id: string;
  agent_role: AgentRoleName | string;
  access_mode: ContextAccessMode;
  inclusion_reason: string;
  relevance_score: number | null;
  confidence: ContextConfidence;
  freshness: ContextFreshness;
  evidence_refs: string[];
  evidence?: ContextItemEvidence[];
  trace_event_ref?: string;
  warnings: string[];
  metadata_json: Record<string, unknown>;
};

export type ContextRetrievalSummary = {
  total_included_items: number;
  editable_file_count: number;
  read_only_file_count: number;
  forbidden_reference_count: number;
  memory_item_count: number;
  decision_count: number;
  prior_failure_count: number;
  validation_command_count: number;
  stale_or_unknown_count: number;
  low_confidence_count: number;
  fallback_item_count: number;
  warning_count: number;
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
  target_mechanism_chain: string[];
  confirmed_relevant_files: string[];
  missing_evidence_links: string[];
  safe_edit_surface: string[];
  previous_decisions: string[];
  expected_output_schema: string;
  validation_requirements: string[];
  approximate_size: number;
  warnings: string[];
  included_items?: ContextPackInclusionRecord[];
  excluded_items?: ContextPackInclusionRecord[];
  freshness_warnings?: string[];
  fallback_items?: ContextPackInclusionRecord[];
  retrieval_summary?: ContextRetrievalSummary;
  context_retrieval_summary?: ContextRetrievalSummary;
  team_context?: import("./AgentTeamModels.js").TeamContextPackExtension;
};

export type ValidationResultRecord = {
  command: string;
  status: "not_run" | "passed" | "failed" | "blocked" | "skipped" | "timed_out" | "not_required" | "partial";
  summary: string;
  required?: boolean;
  log_ref?: string;
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
  multi_plan_used?: boolean;
  generation_mode?: "deterministic" | "heuristic" | "provider_backed" | "mixed";
  plan_variant_count?: number;
  selected_perspectives?: string[];
  rejected_perspectives?: string[];
  top_risks?: string[];
  merged_plan_ref?: string;
  confidence?: number;
  unresolved_questions?: string[];
  evidence_used?: boolean;
  evidence_item_count?: number;
  provider_evidence_count?: number;
  mock_evidence_count?: number;
  low_confidence_count?: number;
  rejected_evidence_count?: number;
  evidence_conflict_count?: number;
  evidence_bundle_ref?: string;
  top_evidence_sources?: string[];
  evidence_limitations?: string[];
  prompt_writer_mode?: "off" | "shadow" | "advisory" | "gated_adopt";
  prompt_writer_runs?: number;
  adopted_count?: number;
  rejected_count?: number;
  shadow_count?: number;
  fallback_count?: number;
  failed_schema_count?: number;
  failed_quality_count?: number;
  top_missing_context_warnings?: string[];
  locks_requested?: number;
  locks_acquired?: number;
  locks_rejected?: number;
  advisory_locks?: number;
  semantic_locks?: number;
  module_locks?: number;
  expired_locks_recovered?: number;
  active_locks_at_end?: number;
  blocking_conflicts?: number;
  integration_status?: string;
  candidates_found?: number;
  candidates_applied?: number;
  conflicts_count?: number;
  integration_validation_status?: string;
  rollback_available?: boolean;
  blocked_reason?: string;
  integration_result_ref?: string;
  root_team_id?: string;
  team_count?: number;
  max_team_depth?: number;
  domain_teams?: string[];
  blocked_teams?: string[];
  budget_warnings?: string[];
  hierarchy_ref?: string;
  team_context_used?: boolean;
  team_context_scope_count?: number;
  team_memory_queries?: number;
  team_scope_fallbacks?: number;
  team_scope_warnings?: number;
  stale_or_low_confidence_team_context_items?: number;
  team_sub_planning_used?: boolean;
  sub_plan_count?: number;
  invalid_sub_plan_count?: number;
  teams_planned?: number;
  cross_team_dependency_count?: number;
  scope_conflict_count?: number;
  top_team_risks?: string[];
  aggregation_ref?: string;
  team_task_adoption_used?: boolean;
  drafts_evaluated?: number;
  adopted_metadata_only_count?: number;
  adopted_read_only_count?: number;
  task_adoption_rejected_count?: number;
  task_adoption_duplicate_count?: number;
  task_adoption_blocked_count?: number;
  future_write_candidate_count?: number;
  executable_ready_count?: number;
  adoption_summary_ref?: string;
  proposed_task_graph_used?: boolean;
  proposed_node_count?: number;
  proposed_edge_count?: number;
  read_only_ready_count?: number;
  proposed_graph_future_write_candidate_count?: number;
  proposed_graph_blocked_count?: number;
  proposed_graph_duplicate_count?: number;
  cycle_count?: number;
  proposed_graph_scope_overlap_count?: number;
  graph_summary_ref?: string;
  execution_readiness_used?: boolean;
  nodes_evaluated?: number;
  ready_read_only_count?: number;
  execution_future_write_candidate_count?: number;
  requires_human_approval_count?: number;
  execution_readiness_blocked_count?: number;
  execution_readiness_rejected_count?: number;
  requires_context_count?: number;
  requires_validation_count?: number;
  requires_locks_count?: number;
  readiness_summary_ref?: string;
  promotion_requests_created?: number;
  approvals_required?: number;
  approvals_granted?: number;
  approvals_denied?: number;
  approvals_expired?: number;
  queue_items_created?: number;
  queue_items_blocked?: number;
  read_only_candidates?: number;
  write_candidates_waiting_approval?: number;
  approval_summary_ref?: string;
  promotion_queue_summary_ref?: string;
  execution_preparation_used?: boolean;
  preparation_plan_count?: number;
  prepared_count?: number;
  blocked_count?: number;
  missing_approval_count?: number;
  missing_context_count?: number;
  missing_prompt_count?: number;
  missing_validation_count?: number;
  missing_locks_count?: number;
  stale_context_count?: number;
  preparation_summary_ref?: string;
  one_writer_dry_run_used?: boolean;
  dry_run_proposal_count?: number;
  generated_count?: number;
  schema_failed_count?: number;
  scope_failed_count?: number;
  dry_run_blocked_count?: number;
  review_candidate_count?: number;
  changed_files_preview?: string[];
  dry_run_summary_ref?: string;
  patch_review_used?: boolean;
  patch_reviews_count?: number;
  accepted_for_validation_candidate_count?: number;
  changes_requested_count?: number;
  patch_review_rejected_count?: number;
  patch_review_blocked_count?: number;
  review_schema_failed_count?: number;
  critical_findings_count?: number;
  high_findings_count?: number;
  review_summary_ref?: string;
  validation_candidate_used?: boolean;
  validation_candidate_count?: number;
  preflight_passed_count?: number;
  incomplete_count?: number;
  command_blocked_count?: number;
  environment_blocked_count?: number;
  validation_candidate_rejected_count?: number;
  validation_candidate_summary_ref?: string;
  patch_apply_sandbox_used?: boolean;
  sandbox_result_count?: number;
  dry_apply_passed_count?: number;
  dry_apply_failed_count?: number;
  conflict_count?: number;
  failed_hunk_count?: number;
  sandbox_unavailable_count?: number;
  main_repo_integrity_ok?: boolean;
  sandbox_summary_ref?: string;
  sandbox_validation_used?: boolean;
  sandbox_validation_count?: number;
  sandbox_validation_passed_count?: number;
  sandbox_validation_failed_count?: number;
  sandbox_validation_blocked_count?: number;
  sandbox_validation_partial_count?: number;
  sandbox_validation_summary_ref?: string;
  sandbox_integration_candidate_used?: boolean;
  integration_candidate_count?: number;
  candidate_created_count?: number;
  candidate_blocked_count?: number;
  candidate_rejected_count?: number;
  candidate_validation_failed_count?: number;
  candidate_validation_blocked_count?: number;
  candidate_summary_ref?: string;
  integration_apply_approval_used?: boolean;
  apply_approval_count?: number;
  approved_for_apply_candidate_count?: number;
  apply_approval_requires_human_approval_count?: number;
  apply_approval_blocked_count?: number;
  apply_approval_rejected_count?: number;
  dirty_worktree_blocked_count?: number;
  apply_mode_recommendation_count?: number;
  apply_approval_summary_ref?: string;
  controlled_apply_used?: boolean;
  controlled_apply_count?: number;
  applied_count?: number;
  post_validation_passed_count?: number;
  post_validation_failed_count?: number;
  rolled_back_count?: number;
  rollback_failed_count?: number;
  lock_failed_count?: number;
  controlled_apply_blocked_count?: number;
  controlled_apply_summary_ref?: string;
  integration_finalization_used?: boolean;
  integration_finalization_count?: number;
  finalized_count?: number;
  finalization_validation_failed_count?: number;
  finalization_rollback_completed_count?: number;
  finalization_rollback_failed_count?: number;
  memory_entries_created_count?: number;
  lessons_created_count?: number;
  finalization_summary_ref?: string;
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
    | "validation.started"
    | "validation.command_started"
    | "validation.command_completed"
    | "validation.completed"
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
