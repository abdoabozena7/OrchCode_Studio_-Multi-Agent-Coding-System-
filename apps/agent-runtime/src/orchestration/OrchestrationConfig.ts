import type { PromptWriterMode, PromptWriterProviderMode } from "./PromptWriterModels.js";

export type ExecutionMode = "fast" | "deep" | "exhaustive";
export type ValidationLevel = "basic" | "standard" | "strict";
export type SwarmWorkerMode = "provider_read_only";
export type PlanningEvidenceMode = "off" | "available" | "require_for_provider_mode";
export type TeamSubPlanningMode = "off" | "deterministic" | "provider_read_only" | "auto";
export type TeamTaskAdoptionMode = "off" | "metadata_only" | "read_only_only" | "gated_future_ready";
export type ProposedTaskGraphMode = "off" | "metadata_only" | "read_only_ready";
export type ExecutionReadinessMode = "off" | "report_only" | "strict";
export type PromotionQueueMode = "off" | "report_only" | "approval_records" | "queue_candidates";
export type ExecutionPreparationMode = "off" | "report_only" | "prepare_only";
export type OneWriterDryRunMode = "off" | "fake_provider" | "provider" | "auto";
export type PatchProposalReviewMode = "off" | "deterministic" | "fake_provider" | "provider" | "auto";
export type ValidationCandidateMode = "off" | "report_only" | "preflight";
export type PatchApplySandboxMode = "off" | "simulate_only" | "temp_copy" | "git_worktree_if_available";
export type SandboxValidationMode = "off" | "report_only" | "execute_safe_commands";
export type SandboxIntegrationCandidateMode = "off" | "report_only" | "create_candidates";
export type GoalStewardMode = "strict" | "report_only";
export type IntegrationApplyApprovalMode = "off" | "report_only" | "require_approval";
export type ControlledIntegrationApplyMode = "off" | "report_only" | "apply_with_approval";
export type IntegrationFinalizationMode = "off" | "report_only" | "finalize_metadata";

export type OrchestrationSafetyConfig = {
  execution_mode: ExecutionMode;
  memory_path: string;
  enable_internal_swarm_autopilot: boolean;
  max_supported_logical_agents: number;
  max_swarm_parallel_agents: number;
  max_swarm_executors: number;
  max_tasks_per_run: number;
  max_parallel_tasks: number;
  max_attempts_per_task: number;
  max_repair_rounds: number;
  max_files_per_task: number;
  max_context_size: number;
  max_review_findings: number;
  max_validation_log_size: number;
  max_patch_bytes: number;
  lock_ttl_ms: number;
  enable_multi_perspective_review: boolean;
  enable_multi_plan_factory: boolean;
  enable_parallel_execution: boolean;
  validation_level: ValidationLevel;
  require_human_approval_for_risky_files: boolean;
  validation_timeout: number;
  safe_commands_allowlist: string[];
  swarm_worker_mode: SwarmWorkerMode;
  use_planning_evidence: boolean;
  planning_evidence_mode: PlanningEvidenceMode;
  max_evidence_items: number;
  min_evidence_confidence: number;
  allow_mock_evidence: boolean;
  prompt_writer_mode: PromptWriterMode;
  prompt_writer_provider_mode: PromptWriterProviderMode;
  enable_team_sub_planning: boolean;
  team_sub_planning_mode: TeamSubPlanningMode;
  max_team_sub_plans_per_run: number;
  max_team_sub_plan_tasks: number;
  max_team_sub_plan_depth: number;
  allow_provider_team_sub_planning: boolean;
  enable_team_task_adoption: boolean;
  team_task_adoption_mode: TeamTaskAdoptionMode;
  max_adopted_tasks_per_run: number;
  max_adopted_tasks_per_team: number;
  allow_write_task_future_candidates: boolean;
  allow_executable_adoption: boolean;
  enable_proposed_task_graph: boolean;
  proposed_task_graph_mode: ProposedTaskGraphMode;
  max_proposed_nodes_per_run: number;
  max_proposed_edges_per_run: number;
  block_cycles: boolean;
  dedupe_proposed_nodes: boolean;
  execution_readiness_gate_enabled: boolean;
  execution_readiness_mode: ExecutionReadinessMode;
  allow_read_only_promotion_candidates: boolean;
  allow_write_future_candidates: boolean;
  require_human_approval_for_write: boolean;
  allow_auto_approval_for_low_risk_read_only: boolean;
  max_nodes_evaluated_per_run: number;
  enable_execution_promotion_queue?: boolean;
  promotion_queue_mode?: PromotionQueueMode;
  allow_read_only_queue_without_human_approval?: boolean;
  approval_default_ttl_hours?: number;
  allow_test_fixture_approvals?: boolean;
  track_blocked_promotion_requests?: boolean;
  enable_execution_preparation?: boolean;
  execution_preparation_mode?: ExecutionPreparationMode;
  max_preparation_plans_per_run?: number;
  require_human_approval_for_write_preparation?: boolean;
  allow_read_only_preparation_without_human_approval?: boolean;
  block_on_stale_context?: boolean;
  block_on_prompt_quality_warning_for_write?: boolean;
  enable_one_writer_dry_run?: boolean;
  one_writer_dry_run_mode?: OneWriterDryRunMode;
  allow_real_provider_dry_run?: boolean;
  max_dry_run_proposals_per_run?: number;
  block_on_prompt_quality_warning_for_writer?: boolean;
  block_on_stale_context_for_writer?: boolean;
  enable_patch_proposal_review_gate?: boolean;
  patch_proposal_review_mode?: PatchProposalReviewMode;
  allow_real_provider_review?: boolean;
  max_patch_proposal_reviews_per_run?: number;
  require_specialist_review_for_high_risk?: boolean;
  require_security_review_for_security_sensitive?: boolean;
  require_test_review_for_validation_risk?: boolean;
  enable_validation_candidate_gate?: boolean;
  validation_candidate_mode?: ValidationCandidateMode;
  block_unknown_required_commands?: boolean;
  require_command_inventory?: boolean;
  require_environment_readiness?: boolean;
  max_validation_candidates_per_run?: number;
  enable_patch_apply_sandbox?: boolean;
  patch_apply_sandbox_mode?: PatchApplySandboxMode;
  sandbox_root?: string;
  cleanup_sandbox_after_run?: boolean;
  max_sandbox_apply_per_run?: number;
  require_clean_main_worktree_for_sandbox?: boolean;
  verify_main_repo_unmodified?: boolean;
  enable_sandbox_validation?: boolean;
  sandbox_validation_mode?: SandboxValidationMode;
  max_sandbox_validation_per_run?: number;
  sandbox_validation_command_timeout_ms?: number;
  block_on_optional_command_failure?: boolean;
  allow_network_in_sandbox_validation?: boolean;
  allow_dependency_install_in_sandbox_validation?: boolean;
  enable_sandbox_integration_candidates?: boolean;
  sandbox_integration_candidate_mode?: SandboxIntegrationCandidateMode;
  require_passed_sandbox_validation?: boolean;
  require_post_integration_validation_plan?: boolean;
  require_rollback_plan?: boolean;
  max_integration_candidates_per_run?: number;
  enable_goal_steward?: boolean;
  goal_steward_mode?: GoalStewardMode;
  require_active_project_goal_spec?: boolean;
  enable_integration_apply_approval_gate?: boolean;
  integration_apply_approval_mode?: IntegrationApplyApprovalMode;
  require_clean_worktree_for_apply_approval?: boolean;
  allow_unrelated_dirty_worktree?: boolean;
  block_dirty_overlap?: boolean;
  require_human_approval_for_main_repo_apply?: boolean;
  apply_approval_default_ttl_hours?: number;
  max_apply_approvals_per_run?: number;
  enable_controlled_integration_apply?: boolean;
  controlled_apply_mode?: ControlledIntegrationApplyMode;
  require_human_approval_for_controlled_apply?: boolean;
  require_automatic_rollback?: boolean;
  require_clean_candidate_paths?: boolean;
  max_controlled_applies_per_run?: number;
  controlled_apply_validation_timeout_ms?: number;
  enable_integration_finalization?: boolean;
  integration_finalization_mode?: IntegrationFinalizationMode;
  create_integration_memory_entries?: boolean;
  create_integration_lessons?: boolean;
  require_passed_post_apply_validation?: boolean;
  allow_partial_finalization_for_rollback?: boolean;
  max_finalizations_per_run?: number;
};

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationSafetyConfig = {
  execution_mode: "deep",
  memory_path: ".agent_memory",
  enable_internal_swarm_autopilot: true,
  max_supported_logical_agents: 300,
  max_swarm_parallel_agents: 120,
  max_swarm_executors: 6,
  max_tasks_per_run: 20,
  max_parallel_tasks: 1,
  max_attempts_per_task: 2,
  max_repair_rounds: 1,
  max_files_per_task: 8,
  max_context_size: 12_000,
  max_review_findings: 20,
  max_validation_log_size: 20_000,
  max_patch_bytes: 120_000,
  lock_ttl_ms: 5 * 60 * 1000,
  enable_multi_perspective_review: false,
  enable_multi_plan_factory: true,
  enable_parallel_execution: false,
  validation_level: "standard",
  require_human_approval_for_risky_files: true,
  validation_timeout: 30_000,
  safe_commands_allowlist: ["git diff --check"],
  swarm_worker_mode: "provider_read_only",
  use_planning_evidence: true,
  planning_evidence_mode: "available",
  max_evidence_items: 20,
  min_evidence_confidence: 0.2,
  allow_mock_evidence: false,
  prompt_writer_mode: "shadow",
  prompt_writer_provider_mode: "auto",
  enable_team_sub_planning: true,
  team_sub_planning_mode: "deterministic",
  max_team_sub_plans_per_run: 12,
  max_team_sub_plan_tasks: 6,
  max_team_sub_plan_depth: 2,
  allow_provider_team_sub_planning: false,
  enable_team_task_adoption: true,
  team_task_adoption_mode: "metadata_only",
  max_adopted_tasks_per_run: 24,
  max_adopted_tasks_per_team: 6,
  allow_write_task_future_candidates: true,
  allow_executable_adoption: false,
  enable_proposed_task_graph: true,
  proposed_task_graph_mode: "metadata_only",
  max_proposed_nodes_per_run: 48,
  max_proposed_edges_per_run: 96,
  block_cycles: true,
  dedupe_proposed_nodes: true,
  execution_readiness_gate_enabled: true,
  execution_readiness_mode: "report_only",
  allow_read_only_promotion_candidates: true,
  allow_write_future_candidates: true,
  require_human_approval_for_write: true,
  allow_auto_approval_for_low_risk_read_only: true,
  max_nodes_evaluated_per_run: 48,
  enable_execution_promotion_queue: true,
  promotion_queue_mode: "approval_records",
  allow_read_only_queue_without_human_approval: true,
  approval_default_ttl_hours: 168,
  allow_test_fixture_approvals: false,
  track_blocked_promotion_requests: false,
  enable_execution_preparation: true,
  execution_preparation_mode: "prepare_only",
  max_preparation_plans_per_run: 24,
  require_human_approval_for_write_preparation: true,
  allow_read_only_preparation_without_human_approval: true,
  block_on_stale_context: false,
  block_on_prompt_quality_warning_for_write: false,
  enable_one_writer_dry_run: false,
  one_writer_dry_run_mode: "fake_provider",
  allow_real_provider_dry_run: false,
  max_dry_run_proposals_per_run: 12,
  block_on_prompt_quality_warning_for_writer: true,
  block_on_stale_context_for_writer: false,
  enable_patch_proposal_review_gate: false,
  patch_proposal_review_mode: "deterministic",
  allow_real_provider_review: false,
  max_patch_proposal_reviews_per_run: 12,
  require_specialist_review_for_high_risk: true,
  require_security_review_for_security_sensitive: true,
  require_test_review_for_validation_risk: true,
  enable_validation_candidate_gate: false,
  validation_candidate_mode: "preflight",
  block_unknown_required_commands: true,
  require_command_inventory: false,
  require_environment_readiness: true,
  max_validation_candidates_per_run: 12,
  enable_patch_apply_sandbox: false,
  patch_apply_sandbox_mode: "simulate_only",
  sandbox_root: "",
  cleanup_sandbox_after_run: true,
  max_sandbox_apply_per_run: 12,
  require_clean_main_worktree_for_sandbox: false,
  verify_main_repo_unmodified: true,
  enable_sandbox_validation: false,
  sandbox_validation_mode: "report_only",
  max_sandbox_validation_per_run: 12,
  sandbox_validation_command_timeout_ms: 30_000,
  block_on_optional_command_failure: false,
  allow_network_in_sandbox_validation: false,
  allow_dependency_install_in_sandbox_validation: false,
  enable_sandbox_integration_candidates: false,
  sandbox_integration_candidate_mode: "report_only",
  require_passed_sandbox_validation: true,
  require_post_integration_validation_plan: true,
  require_rollback_plan: true,
  max_integration_candidates_per_run: 12,
  enable_goal_steward: true,
  goal_steward_mode: "strict",
  require_active_project_goal_spec: false,
  enable_integration_apply_approval_gate: false,
  integration_apply_approval_mode: "report_only",
  require_clean_worktree_for_apply_approval: false,
  allow_unrelated_dirty_worktree: true,
  block_dirty_overlap: true,
  require_human_approval_for_main_repo_apply: true,
  apply_approval_default_ttl_hours: 168,
  max_apply_approvals_per_run: 12,
  enable_controlled_integration_apply: false,
  controlled_apply_mode: "off",
  require_human_approval_for_controlled_apply: true,
  require_automatic_rollback: true,
  require_clean_candidate_paths: true,
  max_controlled_applies_per_run: 4,
  controlled_apply_validation_timeout_ms: 30_000,
  enable_integration_finalization: true,
  integration_finalization_mode: "finalize_metadata",
  create_integration_memory_entries: true,
  create_integration_lessons: true,
  require_passed_post_apply_validation: true,
  allow_partial_finalization_for_rollback: true,
  max_finalizations_per_run: 4
};

export const EXECUTION_MODE_PRESETS: Record<ExecutionMode, Partial<OrchestrationSafetyConfig>> = {
  fast: {
    execution_mode: "fast",
    max_tasks_per_run: 8,
    max_parallel_tasks: 1,
    max_attempts_per_task: 1,
    max_repair_rounds: 0,
    max_context_size: 8_000,
    enable_multi_perspective_review: false,
    enable_multi_plan_factory: false,
    enable_team_sub_planning: false,
    enable_team_task_adoption: false,
    enable_proposed_task_graph: false,
    execution_readiness_gate_enabled: false,
    enable_execution_promotion_queue: false,
    enable_execution_preparation: false,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    enable_validation_candidate_gate: false,
    enable_patch_apply_sandbox: false,
    enable_sandbox_validation: false,
    enable_sandbox_integration_candidates: false,
    enable_integration_apply_approval_gate: false,
    enable_controlled_integration_apply: false,
    enable_integration_finalization: true,
    validation_level: "basic",
    require_human_approval_for_risky_files: true
  },
  deep: {
    execution_mode: "deep",
    max_tasks_per_run: 20,
    max_parallel_tasks: 1,
    max_attempts_per_task: 2,
    max_repair_rounds: 1,
    max_context_size: 12_000,
    enable_multi_perspective_review: false,
    enable_multi_plan_factory: true,
    enable_team_sub_planning: true,
    enable_team_task_adoption: true,
    enable_proposed_task_graph: true,
    execution_readiness_gate_enabled: true,
    enable_execution_promotion_queue: true,
    enable_execution_preparation: true,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    enable_validation_candidate_gate: false,
    enable_patch_apply_sandbox: false,
    enable_sandbox_validation: false,
    enable_sandbox_integration_candidates: false,
    enable_integration_apply_approval_gate: false,
    enable_controlled_integration_apply: false,
    enable_integration_finalization: true,
    validation_level: "standard",
    require_human_approval_for_risky_files: true
  },
  exhaustive: {
    execution_mode: "exhaustive",
    max_tasks_per_run: 60,
    max_parallel_tasks: 2,
    max_attempts_per_task: 3,
    max_repair_rounds: 2,
    max_context_size: 24_000,
    enable_multi_perspective_review: true,
    enable_multi_plan_factory: true,
    enable_team_sub_planning: true,
    enable_team_task_adoption: true,
    enable_proposed_task_graph: true,
    execution_readiness_gate_enabled: true,
    enable_execution_promotion_queue: true,
    enable_execution_preparation: true,
    enable_one_writer_dry_run: false,
    enable_patch_proposal_review_gate: false,
    enable_validation_candidate_gate: false,
    enable_patch_apply_sandbox: false,
    enable_sandbox_validation: false,
    enable_sandbox_integration_candidates: false,
    enable_integration_apply_approval_gate: false,
    enable_controlled_integration_apply: false,
    enable_integration_finalization: true,
    max_team_sub_plans_per_run: 24,
    max_team_sub_plan_tasks: 8,
    max_team_sub_plan_depth: 3,
    max_adopted_tasks_per_run: 48,
    max_adopted_tasks_per_team: 8,
    max_proposed_nodes_per_run: 96,
    max_proposed_edges_per_run: 192,
    max_nodes_evaluated_per_run: 96,
    validation_level: "strict",
    require_human_approval_for_risky_files: true
  }
};

export type PartialOrchestrationSafetyConfig = Partial<OrchestrationSafetyConfig>;

export function loadOrchestrationConfig(input: PartialOrchestrationSafetyConfig = {}): OrchestrationSafetyConfig {
  const mode = envMode("HIVO_EXECUTION_MODE", input.execution_mode ?? DEFAULT_ORCHESTRATION_CONFIG.execution_mode);
  const preset = EXECUTION_MODE_PRESETS[mode];
  const config: OrchestrationSafetyConfig = {
    ...DEFAULT_ORCHESTRATION_CONFIG,
    ...preset,
    execution_mode: mode,
    memory_path: envString("HIVO_MEMORY_DIR", input.memory_path, DEFAULT_ORCHESTRATION_CONFIG.memory_path),
    enable_internal_swarm_autopilot: envBool("HIVO_ENABLE_INTERNAL_SWARM_AUTOPILOT", input.enable_internal_swarm_autopilot, DEFAULT_ORCHESTRATION_CONFIG.enable_internal_swarm_autopilot),
    max_supported_logical_agents: envNumber("HIVO_MAX_SUPPORTED_LOGICAL_AGENTS", input.max_supported_logical_agents, DEFAULT_ORCHESTRATION_CONFIG.max_supported_logical_agents),
    max_swarm_parallel_agents: envNumber("HIVO_MAX_SWARM_PARALLEL_AGENTS", input.max_swarm_parallel_agents, DEFAULT_ORCHESTRATION_CONFIG.max_swarm_parallel_agents),
    max_swarm_executors: envNumber("HIVO_MAX_SWARM_EXECUTORS", input.max_swarm_executors, DEFAULT_ORCHESTRATION_CONFIG.max_swarm_executors),
    max_tasks_per_run: envNumber("HIVO_MAX_TASKS_PER_RUN", input.max_tasks_per_run, preset.max_tasks_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_tasks_per_run),
    max_parallel_tasks: envNumber("HIVO_MAX_PARALLEL_TASKS", input.max_parallel_tasks, preset.max_parallel_tasks ?? DEFAULT_ORCHESTRATION_CONFIG.max_parallel_tasks),
    max_attempts_per_task: envNumber("HIVO_MAX_ATTEMPTS_PER_TASK", input.max_attempts_per_task, preset.max_attempts_per_task ?? DEFAULT_ORCHESTRATION_CONFIG.max_attempts_per_task),
    max_repair_rounds: envNumber("HIVO_MAX_REPAIR_ROUNDS", input.max_repair_rounds, preset.max_repair_rounds ?? DEFAULT_ORCHESTRATION_CONFIG.max_repair_rounds),
    max_files_per_task: envNumber("HIVO_MAX_FILES_PER_TASK", input.max_files_per_task, preset.max_files_per_task ?? DEFAULT_ORCHESTRATION_CONFIG.max_files_per_task),
    max_context_size: envNumber("HIVO_MAX_CONTEXT_SIZE", input.max_context_size, preset.max_context_size ?? DEFAULT_ORCHESTRATION_CONFIG.max_context_size),
    max_review_findings: envNumber("HIVO_MAX_REVIEW_FINDINGS", input.max_review_findings, DEFAULT_ORCHESTRATION_CONFIG.max_review_findings),
    max_validation_log_size: envNumber("HIVO_MAX_VALIDATION_LOG_SIZE", input.max_validation_log_size, DEFAULT_ORCHESTRATION_CONFIG.max_validation_log_size),
    max_patch_bytes: envNumber("HIVO_MAX_PATCH_BYTES", input.max_patch_bytes, DEFAULT_ORCHESTRATION_CONFIG.max_patch_bytes),
    lock_ttl_ms: envNumber("HIVO_LOCK_TTL_MS", input.lock_ttl_ms, DEFAULT_ORCHESTRATION_CONFIG.lock_ttl_ms),
    enable_multi_perspective_review: envBool("HIVO_ENABLE_MULTI_PERSPECTIVE_REVIEW", input.enable_multi_perspective_review, preset.enable_multi_perspective_review ?? DEFAULT_ORCHESTRATION_CONFIG.enable_multi_perspective_review),
    enable_multi_plan_factory: envBool("HIVO_ENABLE_MULTI_PLAN_FACTORY", input.enable_multi_plan_factory, preset.enable_multi_plan_factory ?? DEFAULT_ORCHESTRATION_CONFIG.enable_multi_plan_factory),
    enable_parallel_execution: envBool("HIVO_ENABLE_PARALLEL_EXECUTION", input.enable_parallel_execution, DEFAULT_ORCHESTRATION_CONFIG.enable_parallel_execution),
    validation_level: envValidationLevel("HIVO_VALIDATION_LEVEL", input.validation_level ?? preset.validation_level ?? DEFAULT_ORCHESTRATION_CONFIG.validation_level),
    require_human_approval_for_risky_files: envBool("HIVO_REQUIRE_HUMAN_APPROVAL_FOR_RISKY_FILES", input.require_human_approval_for_risky_files, preset.require_human_approval_for_risky_files ?? DEFAULT_ORCHESTRATION_CONFIG.require_human_approval_for_risky_files),
    validation_timeout: envNumber("HIVO_VALIDATION_TIMEOUT", input.validation_timeout, DEFAULT_ORCHESTRATION_CONFIG.validation_timeout),
    safe_commands_allowlist: envList("HIVO_SAFE_COMMANDS_ALLOWLIST", input.safe_commands_allowlist, DEFAULT_ORCHESTRATION_CONFIG.safe_commands_allowlist),
    swarm_worker_mode: envSwarmWorkerMode("HIVO_SWARM_WORKER_MODE", input.swarm_worker_mode ?? DEFAULT_ORCHESTRATION_CONFIG.swarm_worker_mode),
    use_planning_evidence: envBool("HIVO_USE_PLANNING_EVIDENCE", input.use_planning_evidence, DEFAULT_ORCHESTRATION_CONFIG.use_planning_evidence),
    planning_evidence_mode: envPlanningEvidenceMode("HIVO_PLANNING_EVIDENCE_MODE", input.planning_evidence_mode ?? DEFAULT_ORCHESTRATION_CONFIG.planning_evidence_mode),
    max_evidence_items: envNumber("HIVO_MAX_PLANNING_EVIDENCE_ITEMS", input.max_evidence_items, DEFAULT_ORCHESTRATION_CONFIG.max_evidence_items),
    min_evidence_confidence: envNumber("HIVO_MIN_PLANNING_EVIDENCE_CONFIDENCE", input.min_evidence_confidence, DEFAULT_ORCHESTRATION_CONFIG.min_evidence_confidence),
    allow_mock_evidence: envBool("HIVO_ALLOW_MOCK_PLANNING_EVIDENCE", input.allow_mock_evidence, DEFAULT_ORCHESTRATION_CONFIG.allow_mock_evidence),
    prompt_writer_mode: envPromptWriterMode("HIVO_PROMPT_WRITER_MODE", input.prompt_writer_mode ?? DEFAULT_ORCHESTRATION_CONFIG.prompt_writer_mode),
    prompt_writer_provider_mode: envPromptWriterProviderMode("HIVO_PROMPT_WRITER_PROVIDER_MODE", input.prompt_writer_provider_mode ?? DEFAULT_ORCHESTRATION_CONFIG.prompt_writer_provider_mode),
    enable_team_sub_planning: envBool("HIVO_ENABLE_TEAM_SUB_PLANNING", input.enable_team_sub_planning, preset.enable_team_sub_planning ?? DEFAULT_ORCHESTRATION_CONFIG.enable_team_sub_planning),
    team_sub_planning_mode: envTeamSubPlanningMode("HIVO_TEAM_SUB_PLANNING_MODE", input.team_sub_planning_mode ?? DEFAULT_ORCHESTRATION_CONFIG.team_sub_planning_mode),
    max_team_sub_plans_per_run: envNumber("HIVO_MAX_TEAM_SUB_PLANS_PER_RUN", input.max_team_sub_plans_per_run, preset.max_team_sub_plans_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_team_sub_plans_per_run),
    max_team_sub_plan_tasks: envNumber("HIVO_MAX_TEAM_SUB_PLAN_TASKS", input.max_team_sub_plan_tasks, preset.max_team_sub_plan_tasks ?? DEFAULT_ORCHESTRATION_CONFIG.max_team_sub_plan_tasks),
    max_team_sub_plan_depth: envNumber("HIVO_MAX_TEAM_SUB_PLAN_DEPTH", input.max_team_sub_plan_depth, preset.max_team_sub_plan_depth ?? DEFAULT_ORCHESTRATION_CONFIG.max_team_sub_plan_depth),
    allow_provider_team_sub_planning: envBool("HIVO_ALLOW_PROVIDER_TEAM_SUB_PLANNING", input.allow_provider_team_sub_planning, DEFAULT_ORCHESTRATION_CONFIG.allow_provider_team_sub_planning),
    enable_team_task_adoption: envBool("HIVO_ENABLE_TEAM_TASK_ADOPTION", input.enable_team_task_adoption, preset.enable_team_task_adoption ?? DEFAULT_ORCHESTRATION_CONFIG.enable_team_task_adoption),
    team_task_adoption_mode: envTeamTaskAdoptionMode("HIVO_TEAM_TASK_ADOPTION_MODE", input.team_task_adoption_mode ?? DEFAULT_ORCHESTRATION_CONFIG.team_task_adoption_mode),
    max_adopted_tasks_per_run: envNumber("HIVO_MAX_ADOPTED_TASKS_PER_RUN", input.max_adopted_tasks_per_run, preset.max_adopted_tasks_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_adopted_tasks_per_run),
    max_adopted_tasks_per_team: envNumber("HIVO_MAX_ADOPTED_TASKS_PER_TEAM", input.max_adopted_tasks_per_team, preset.max_adopted_tasks_per_team ?? DEFAULT_ORCHESTRATION_CONFIG.max_adopted_tasks_per_team),
    allow_write_task_future_candidates: envBool("HIVO_ALLOW_WRITE_TASK_FUTURE_CANDIDATES", input.allow_write_task_future_candidates, DEFAULT_ORCHESTRATION_CONFIG.allow_write_task_future_candidates),
    allow_executable_adoption: envBool("HIVO_ALLOW_EXECUTABLE_ADOPTION", input.allow_executable_adoption, DEFAULT_ORCHESTRATION_CONFIG.allow_executable_adoption),
    enable_proposed_task_graph: envBool("HIVO_ENABLE_PROPOSED_TASK_GRAPH", input.enable_proposed_task_graph, preset.enable_proposed_task_graph ?? DEFAULT_ORCHESTRATION_CONFIG.enable_proposed_task_graph),
    proposed_task_graph_mode: envProposedTaskGraphMode("HIVO_PROPOSED_TASK_GRAPH_MODE", input.proposed_task_graph_mode ?? DEFAULT_ORCHESTRATION_CONFIG.proposed_task_graph_mode),
    max_proposed_nodes_per_run: envNumber("HIVO_MAX_PROPOSED_NODES_PER_RUN", input.max_proposed_nodes_per_run, preset.max_proposed_nodes_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_proposed_nodes_per_run),
    max_proposed_edges_per_run: envNumber("HIVO_MAX_PROPOSED_EDGES_PER_RUN", input.max_proposed_edges_per_run, preset.max_proposed_edges_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_proposed_edges_per_run),
    block_cycles: envBool("HIVO_BLOCK_PROPOSED_TASK_GRAPH_CYCLES", input.block_cycles, DEFAULT_ORCHESTRATION_CONFIG.block_cycles),
    dedupe_proposed_nodes: envBool("HIVO_DEDUPE_PROPOSED_TASK_NODES", input.dedupe_proposed_nodes, DEFAULT_ORCHESTRATION_CONFIG.dedupe_proposed_nodes),
    execution_readiness_gate_enabled: envBool("HIVO_EXECUTION_READINESS_GATE_ENABLED", input.execution_readiness_gate_enabled, preset.execution_readiness_gate_enabled ?? DEFAULT_ORCHESTRATION_CONFIG.execution_readiness_gate_enabled),
    execution_readiness_mode: envExecutionReadinessMode("HIVO_EXECUTION_READINESS_MODE", input.execution_readiness_mode ?? DEFAULT_ORCHESTRATION_CONFIG.execution_readiness_mode),
    allow_read_only_promotion_candidates: envBool("HIVO_ALLOW_READ_ONLY_PROMOTION_CANDIDATES", input.allow_read_only_promotion_candidates, DEFAULT_ORCHESTRATION_CONFIG.allow_read_only_promotion_candidates),
    allow_write_future_candidates: envBool("HIVO_ALLOW_WRITE_FUTURE_CANDIDATES", input.allow_write_future_candidates, DEFAULT_ORCHESTRATION_CONFIG.allow_write_future_candidates),
    require_human_approval_for_write: envBool("HIVO_REQUIRE_HUMAN_APPROVAL_FOR_WRITE", input.require_human_approval_for_write, DEFAULT_ORCHESTRATION_CONFIG.require_human_approval_for_write),
    allow_auto_approval_for_low_risk_read_only: envBool("HIVO_ALLOW_AUTO_APPROVAL_FOR_LOW_RISK_READ_ONLY", input.allow_auto_approval_for_low_risk_read_only, DEFAULT_ORCHESTRATION_CONFIG.allow_auto_approval_for_low_risk_read_only),
    max_nodes_evaluated_per_run: envNumber("HIVO_MAX_NODES_EVALUATED_PER_RUN", input.max_nodes_evaluated_per_run, preset.max_nodes_evaluated_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_nodes_evaluated_per_run),
    enable_execution_promotion_queue: envBool("HIVO_ENABLE_EXECUTION_PROMOTION_QUEUE", input.enable_execution_promotion_queue, preset.enable_execution_promotion_queue ?? DEFAULT_ORCHESTRATION_CONFIG.enable_execution_promotion_queue ?? true),
    promotion_queue_mode: envPromotionQueueMode("HIVO_PROMOTION_QUEUE_MODE", input.promotion_queue_mode ?? DEFAULT_ORCHESTRATION_CONFIG.promotion_queue_mode ?? "approval_records"),
    allow_read_only_queue_without_human_approval: envBool("HIVO_ALLOW_READ_ONLY_QUEUE_WITHOUT_HUMAN_APPROVAL", input.allow_read_only_queue_without_human_approval, DEFAULT_ORCHESTRATION_CONFIG.allow_read_only_queue_without_human_approval ?? true),
    approval_default_ttl_hours: envNumber("HIVO_APPROVAL_DEFAULT_TTL_HOURS", input.approval_default_ttl_hours, DEFAULT_ORCHESTRATION_CONFIG.approval_default_ttl_hours ?? 168),
    allow_test_fixture_approvals: envBool("HIVO_ALLOW_TEST_FIXTURE_APPROVALS", input.allow_test_fixture_approvals, DEFAULT_ORCHESTRATION_CONFIG.allow_test_fixture_approvals ?? false),
    track_blocked_promotion_requests: envBool("HIVO_TRACK_BLOCKED_PROMOTION_REQUESTS", input.track_blocked_promotion_requests, DEFAULT_ORCHESTRATION_CONFIG.track_blocked_promotion_requests ?? false),
    enable_execution_preparation: envBool("HIVO_ENABLE_EXECUTION_PREPARATION", input.enable_execution_preparation, preset.enable_execution_preparation ?? DEFAULT_ORCHESTRATION_CONFIG.enable_execution_preparation ?? true),
    execution_preparation_mode: envExecutionPreparationMode("HIVO_EXECUTION_PREPARATION_MODE", input.execution_preparation_mode ?? DEFAULT_ORCHESTRATION_CONFIG.execution_preparation_mode ?? "prepare_only"),
    max_preparation_plans_per_run: envNumber("HIVO_MAX_PREPARATION_PLANS_PER_RUN", input.max_preparation_plans_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_preparation_plans_per_run ?? 24),
    require_human_approval_for_write_preparation: envBool("HIVO_REQUIRE_HUMAN_APPROVAL_FOR_WRITE_PREPARATION", input.require_human_approval_for_write_preparation, DEFAULT_ORCHESTRATION_CONFIG.require_human_approval_for_write_preparation ?? true),
    allow_read_only_preparation_without_human_approval: envBool("HIVO_ALLOW_READ_ONLY_PREPARATION_WITHOUT_HUMAN_APPROVAL", input.allow_read_only_preparation_without_human_approval, DEFAULT_ORCHESTRATION_CONFIG.allow_read_only_preparation_without_human_approval ?? true),
    block_on_stale_context: envBool("HIVO_BLOCK_ON_STALE_CONTEXT", input.block_on_stale_context, DEFAULT_ORCHESTRATION_CONFIG.block_on_stale_context ?? false),
    block_on_prompt_quality_warning_for_write: envBool("HIVO_BLOCK_ON_PROMPT_QUALITY_WARNING_FOR_WRITE", input.block_on_prompt_quality_warning_for_write, DEFAULT_ORCHESTRATION_CONFIG.block_on_prompt_quality_warning_for_write ?? false),
    enable_one_writer_dry_run: envBool("HIVO_ENABLE_ONE_WRITER_DRY_RUN", input.enable_one_writer_dry_run, DEFAULT_ORCHESTRATION_CONFIG.enable_one_writer_dry_run ?? false),
    one_writer_dry_run_mode: envOneWriterDryRunMode("HIVO_ONE_WRITER_DRY_RUN_MODE", input.one_writer_dry_run_mode ?? DEFAULT_ORCHESTRATION_CONFIG.one_writer_dry_run_mode ?? "off"),
    allow_real_provider_dry_run: envBool("HIVO_ALLOW_REAL_PROVIDER_DRY_RUN", input.allow_real_provider_dry_run, DEFAULT_ORCHESTRATION_CONFIG.allow_real_provider_dry_run ?? false),
    max_dry_run_proposals_per_run: envNumber("HIVO_MAX_DRY_RUN_PROPOSALS_PER_RUN", input.max_dry_run_proposals_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_dry_run_proposals_per_run ?? 12),
    block_on_prompt_quality_warning_for_writer: envBool("HIVO_BLOCK_ON_PROMPT_QUALITY_WARNING_FOR_WRITER", input.block_on_prompt_quality_warning_for_writer, DEFAULT_ORCHESTRATION_CONFIG.block_on_prompt_quality_warning_for_writer ?? true),
    block_on_stale_context_for_writer: envBool("HIVO_BLOCK_ON_STALE_CONTEXT_FOR_WRITER", input.block_on_stale_context_for_writer, DEFAULT_ORCHESTRATION_CONFIG.block_on_stale_context_for_writer ?? false),
    enable_patch_proposal_review_gate: envBool("HIVO_ENABLE_PATCH_PROPOSAL_REVIEW_GATE", input.enable_patch_proposal_review_gate, DEFAULT_ORCHESTRATION_CONFIG.enable_patch_proposal_review_gate ?? false),
    patch_proposal_review_mode: envPatchProposalReviewMode("HIVO_PATCH_PROPOSAL_REVIEW_MODE", input.patch_proposal_review_mode ?? DEFAULT_ORCHESTRATION_CONFIG.patch_proposal_review_mode ?? "off"),
    allow_real_provider_review: envBool("HIVO_ALLOW_REAL_PROVIDER_REVIEW", input.allow_real_provider_review, DEFAULT_ORCHESTRATION_CONFIG.allow_real_provider_review ?? false),
    max_patch_proposal_reviews_per_run: envNumber("HIVO_MAX_PATCH_PROPOSAL_REVIEWS_PER_RUN", input.max_patch_proposal_reviews_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_patch_proposal_reviews_per_run ?? 12),
    require_specialist_review_for_high_risk: envBool("HIVO_REQUIRE_SPECIALIST_REVIEW_FOR_HIGH_RISK", input.require_specialist_review_for_high_risk, DEFAULT_ORCHESTRATION_CONFIG.require_specialist_review_for_high_risk ?? true),
    require_security_review_for_security_sensitive: envBool("HIVO_REQUIRE_SECURITY_REVIEW_FOR_SECURITY_SENSITIVE", input.require_security_review_for_security_sensitive, DEFAULT_ORCHESTRATION_CONFIG.require_security_review_for_security_sensitive ?? true),
    require_test_review_for_validation_risk: envBool("HIVO_REQUIRE_TEST_REVIEW_FOR_VALIDATION_RISK", input.require_test_review_for_validation_risk, DEFAULT_ORCHESTRATION_CONFIG.require_test_review_for_validation_risk ?? true),
    enable_validation_candidate_gate: envBool("HIVO_ENABLE_VALIDATION_CANDIDATE_GATE", input.enable_validation_candidate_gate, DEFAULT_ORCHESTRATION_CONFIG.enable_validation_candidate_gate ?? false),
    validation_candidate_mode: envValidationCandidateMode("HIVO_VALIDATION_CANDIDATE_MODE", input.validation_candidate_mode ?? DEFAULT_ORCHESTRATION_CONFIG.validation_candidate_mode ?? "preflight"),
    block_unknown_required_commands: envBool("HIVO_BLOCK_UNKNOWN_REQUIRED_COMMANDS", input.block_unknown_required_commands, DEFAULT_ORCHESTRATION_CONFIG.block_unknown_required_commands ?? true),
    require_command_inventory: envBool("HIVO_REQUIRE_COMMAND_INVENTORY", input.require_command_inventory, DEFAULT_ORCHESTRATION_CONFIG.require_command_inventory ?? false),
    require_environment_readiness: envBool("HIVO_REQUIRE_ENVIRONMENT_READINESS", input.require_environment_readiness, DEFAULT_ORCHESTRATION_CONFIG.require_environment_readiness ?? true),
    max_validation_candidates_per_run: envNumber("HIVO_MAX_VALIDATION_CANDIDATES_PER_RUN", input.max_validation_candidates_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_validation_candidates_per_run ?? 12),
    enable_patch_apply_sandbox: envBool("HIVO_ENABLE_PATCH_APPLY_SANDBOX", input.enable_patch_apply_sandbox, DEFAULT_ORCHESTRATION_CONFIG.enable_patch_apply_sandbox ?? false),
    patch_apply_sandbox_mode: envPatchApplySandboxMode("HIVO_PATCH_APPLY_SANDBOX_MODE", input.patch_apply_sandbox_mode ?? DEFAULT_ORCHESTRATION_CONFIG.patch_apply_sandbox_mode ?? "simulate_only"),
    sandbox_root: envString("HIVO_PATCH_APPLY_SANDBOX_ROOT", input.sandbox_root, DEFAULT_ORCHESTRATION_CONFIG.sandbox_root ?? ""),
    cleanup_sandbox_after_run: envBool("HIVO_CLEANUP_SANDBOX_AFTER_RUN", input.cleanup_sandbox_after_run, DEFAULT_ORCHESTRATION_CONFIG.cleanup_sandbox_after_run ?? true),
    max_sandbox_apply_per_run: envNumber("HIVO_MAX_SANDBOX_APPLY_PER_RUN", input.max_sandbox_apply_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_sandbox_apply_per_run ?? 12),
    require_clean_main_worktree_for_sandbox: envBool("HIVO_REQUIRE_CLEAN_MAIN_WORKTREE_FOR_SANDBOX", input.require_clean_main_worktree_for_sandbox, DEFAULT_ORCHESTRATION_CONFIG.require_clean_main_worktree_for_sandbox ?? false),
    verify_main_repo_unmodified: envBool("HIVO_VERIFY_MAIN_REPO_UNMODIFIED", input.verify_main_repo_unmodified, DEFAULT_ORCHESTRATION_CONFIG.verify_main_repo_unmodified ?? true),
    enable_sandbox_validation: envBool("HIVO_ENABLE_SANDBOX_VALIDATION", input.enable_sandbox_validation, DEFAULT_ORCHESTRATION_CONFIG.enable_sandbox_validation ?? false),
    sandbox_validation_mode: envSandboxValidationMode("HIVO_SANDBOX_VALIDATION_MODE", input.sandbox_validation_mode ?? DEFAULT_ORCHESTRATION_CONFIG.sandbox_validation_mode ?? "report_only"),
    max_sandbox_validation_per_run: envNumber("HIVO_MAX_SANDBOX_VALIDATION_PER_RUN", input.max_sandbox_validation_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_sandbox_validation_per_run ?? 12),
    sandbox_validation_command_timeout_ms: envNumber("HIVO_SANDBOX_VALIDATION_COMMAND_TIMEOUT_MS", input.sandbox_validation_command_timeout_ms, DEFAULT_ORCHESTRATION_CONFIG.sandbox_validation_command_timeout_ms ?? 30_000),
    block_on_optional_command_failure: envBool("HIVO_BLOCK_ON_OPTIONAL_COMMAND_FAILURE", input.block_on_optional_command_failure, DEFAULT_ORCHESTRATION_CONFIG.block_on_optional_command_failure ?? false),
    allow_network_in_sandbox_validation: envBool("HIVO_ALLOW_NETWORK_IN_SANDBOX_VALIDATION", input.allow_network_in_sandbox_validation, DEFAULT_ORCHESTRATION_CONFIG.allow_network_in_sandbox_validation ?? false),
    allow_dependency_install_in_sandbox_validation: envBool("HIVO_ALLOW_DEPENDENCY_INSTALL_IN_SANDBOX_VALIDATION", input.allow_dependency_install_in_sandbox_validation, DEFAULT_ORCHESTRATION_CONFIG.allow_dependency_install_in_sandbox_validation ?? false),
    enable_sandbox_integration_candidates: envBool("HIVO_ENABLE_SANDBOX_INTEGRATION_CANDIDATES", input.enable_sandbox_integration_candidates, DEFAULT_ORCHESTRATION_CONFIG.enable_sandbox_integration_candidates ?? false),
    sandbox_integration_candidate_mode: envSandboxIntegrationCandidateMode("HIVO_SANDBOX_INTEGRATION_CANDIDATE_MODE", input.sandbox_integration_candidate_mode ?? DEFAULT_ORCHESTRATION_CONFIG.sandbox_integration_candidate_mode ?? "report_only"),
    require_passed_sandbox_validation: envBool("HIVO_REQUIRE_PASSED_SANDBOX_VALIDATION", input.require_passed_sandbox_validation, DEFAULT_ORCHESTRATION_CONFIG.require_passed_sandbox_validation ?? true),
    require_post_integration_validation_plan: envBool("HIVO_REQUIRE_POST_INTEGRATION_VALIDATION_PLAN", input.require_post_integration_validation_plan, DEFAULT_ORCHESTRATION_CONFIG.require_post_integration_validation_plan ?? true),
    require_rollback_plan: envBool("HIVO_REQUIRE_ROLLBACK_PLAN", input.require_rollback_plan, DEFAULT_ORCHESTRATION_CONFIG.require_rollback_plan ?? true),
    max_integration_candidates_per_run: envNumber("HIVO_MAX_INTEGRATION_CANDIDATES_PER_RUN", input.max_integration_candidates_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_integration_candidates_per_run ?? 12),
    enable_goal_steward: envBool("HIVO_ENABLE_GOAL_STEWARD", input.enable_goal_steward, DEFAULT_ORCHESTRATION_CONFIG.enable_goal_steward ?? true),
    goal_steward_mode: envGoalStewardMode("HIVO_GOAL_STEWARD_MODE", input.goal_steward_mode ?? DEFAULT_ORCHESTRATION_CONFIG.goal_steward_mode ?? "strict"),
    require_active_project_goal_spec: envBool("HIVO_REQUIRE_ACTIVE_PROJECT_GOAL_SPEC", input.require_active_project_goal_spec, DEFAULT_ORCHESTRATION_CONFIG.require_active_project_goal_spec ?? false),
    enable_integration_apply_approval_gate: envBool("HIVO_ENABLE_INTEGRATION_APPLY_APPROVAL_GATE", input.enable_integration_apply_approval_gate, DEFAULT_ORCHESTRATION_CONFIG.enable_integration_apply_approval_gate ?? false),
    integration_apply_approval_mode: envIntegrationApplyApprovalMode("HIVO_INTEGRATION_APPLY_APPROVAL_MODE", input.integration_apply_approval_mode ?? DEFAULT_ORCHESTRATION_CONFIG.integration_apply_approval_mode ?? "report_only"),
    require_clean_worktree_for_apply_approval: envBool("HIVO_REQUIRE_CLEAN_WORKTREE_FOR_APPLY_APPROVAL", input.require_clean_worktree_for_apply_approval, DEFAULT_ORCHESTRATION_CONFIG.require_clean_worktree_for_apply_approval ?? false),
    allow_unrelated_dirty_worktree: envBool("HIVO_ALLOW_UNRELATED_DIRTY_WORKTREE", input.allow_unrelated_dirty_worktree, DEFAULT_ORCHESTRATION_CONFIG.allow_unrelated_dirty_worktree ?? true),
    block_dirty_overlap: envBool("HIVO_BLOCK_DIRTY_OVERLAP", input.block_dirty_overlap, DEFAULT_ORCHESTRATION_CONFIG.block_dirty_overlap ?? true),
    require_human_approval_for_main_repo_apply: envBool("HIVO_REQUIRE_HUMAN_APPROVAL_FOR_MAIN_REPO_APPLY", input.require_human_approval_for_main_repo_apply, DEFAULT_ORCHESTRATION_CONFIG.require_human_approval_for_main_repo_apply ?? true),
    apply_approval_default_ttl_hours: envNumber("HIVO_APPLY_APPROVAL_DEFAULT_TTL_HOURS", input.apply_approval_default_ttl_hours, DEFAULT_ORCHESTRATION_CONFIG.apply_approval_default_ttl_hours ?? 168),
    max_apply_approvals_per_run: envNumber("HIVO_MAX_APPLY_APPROVALS_PER_RUN", input.max_apply_approvals_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_apply_approvals_per_run ?? 12),
    enable_controlled_integration_apply: envBool("HIVO_ENABLE_CONTROLLED_INTEGRATION_APPLY", input.enable_controlled_integration_apply, DEFAULT_ORCHESTRATION_CONFIG.enable_controlled_integration_apply ?? false),
    controlled_apply_mode: envControlledIntegrationApplyMode("HIVO_CONTROLLED_APPLY_MODE", input.controlled_apply_mode ?? DEFAULT_ORCHESTRATION_CONFIG.controlled_apply_mode ?? "off"),
    require_human_approval_for_controlled_apply: envBool("HIVO_REQUIRE_HUMAN_APPROVAL_FOR_CONTROLLED_APPLY", input.require_human_approval_for_controlled_apply, DEFAULT_ORCHESTRATION_CONFIG.require_human_approval_for_controlled_apply ?? true),
    require_automatic_rollback: envBool("HIVO_REQUIRE_AUTOMATIC_ROLLBACK", input.require_automatic_rollback, DEFAULT_ORCHESTRATION_CONFIG.require_automatic_rollback ?? true),
    require_clean_candidate_paths: envBool("HIVO_REQUIRE_CLEAN_CANDIDATE_PATHS", input.require_clean_candidate_paths, DEFAULT_ORCHESTRATION_CONFIG.require_clean_candidate_paths ?? true),
    max_controlled_applies_per_run: envNumber("HIVO_MAX_CONTROLLED_APPLIES_PER_RUN", input.max_controlled_applies_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_controlled_applies_per_run ?? 4),
    controlled_apply_validation_timeout_ms: envNumber("HIVO_CONTROLLED_APPLY_VALIDATION_TIMEOUT_MS", input.controlled_apply_validation_timeout_ms, DEFAULT_ORCHESTRATION_CONFIG.controlled_apply_validation_timeout_ms ?? 30_000),
    enable_integration_finalization: envBool("HIVO_ENABLE_INTEGRATION_FINALIZATION", input.enable_integration_finalization, DEFAULT_ORCHESTRATION_CONFIG.enable_integration_finalization ?? true),
    integration_finalization_mode: envIntegrationFinalizationMode("HIVO_INTEGRATION_FINALIZATION_MODE", input.integration_finalization_mode ?? DEFAULT_ORCHESTRATION_CONFIG.integration_finalization_mode ?? "finalize_metadata"),
    create_integration_memory_entries: envBool("HIVO_CREATE_INTEGRATION_MEMORY_ENTRIES", input.create_integration_memory_entries, DEFAULT_ORCHESTRATION_CONFIG.create_integration_memory_entries ?? true),
    create_integration_lessons: envBool("HIVO_CREATE_INTEGRATION_LESSONS", input.create_integration_lessons, DEFAULT_ORCHESTRATION_CONFIG.create_integration_lessons ?? true),
    require_passed_post_apply_validation: envBool("HIVO_REQUIRE_PASSED_POST_APPLY_VALIDATION", input.require_passed_post_apply_validation, DEFAULT_ORCHESTRATION_CONFIG.require_passed_post_apply_validation ?? true),
    allow_partial_finalization_for_rollback: envBool("HIVO_ALLOW_PARTIAL_FINALIZATION_FOR_ROLLBACK", input.allow_partial_finalization_for_rollback, DEFAULT_ORCHESTRATION_CONFIG.allow_partial_finalization_for_rollback ?? true),
    max_finalizations_per_run: envNumber("HIVO_MAX_FINALIZATIONS_PER_RUN", input.max_finalizations_per_run, DEFAULT_ORCHESTRATION_CONFIG.max_finalizations_per_run ?? 4)
  };
  validateOrchestrationConfig(config);
  return config;
}

export function validateOrchestrationConfig(config: OrchestrationSafetyConfig) {
  const numericKeys: Array<keyof Pick<
    OrchestrationSafetyConfig,
    | "max_tasks_per_run"
    | "max_supported_logical_agents"
    | "max_swarm_parallel_agents"
    | "max_swarm_executors"
    | "max_parallel_tasks"
    | "max_attempts_per_task"
    | "max_repair_rounds"
    | "max_files_per_task"
    | "max_context_size"
    | "max_review_findings"
    | "max_validation_log_size"
    | "max_patch_bytes"
    | "lock_ttl_ms"
    | "validation_timeout"
    | "max_evidence_items"
    | "max_team_sub_plans_per_run"
    | "max_team_sub_plan_tasks"
    | "max_team_sub_plan_depth"
    | "max_adopted_tasks_per_run"
    | "max_adopted_tasks_per_team"
    | "max_proposed_nodes_per_run"
    | "max_proposed_edges_per_run"
    | "max_nodes_evaluated_per_run"
    | "approval_default_ttl_hours"
    | "max_preparation_plans_per_run"
    | "max_dry_run_proposals_per_run"
    | "max_patch_proposal_reviews_per_run"
    | "max_validation_candidates_per_run"
    | "max_sandbox_apply_per_run"
    | "max_sandbox_validation_per_run"
    | "sandbox_validation_command_timeout_ms"
    | "max_integration_candidates_per_run"
    | "apply_approval_default_ttl_hours"
    | "max_apply_approvals_per_run"
    | "max_controlled_applies_per_run"
    | "controlled_apply_validation_timeout_ms"
    | "max_finalizations_per_run"
  >> = [
    "max_tasks_per_run",
    "max_supported_logical_agents",
    "max_swarm_parallel_agents",
    "max_swarm_executors",
    "max_parallel_tasks",
    "max_attempts_per_task",
    "max_repair_rounds",
    "max_files_per_task",
    "max_context_size",
    "max_review_findings",
    "max_validation_log_size",
    "max_patch_bytes",
    "lock_ttl_ms",
    "validation_timeout",
    "max_evidence_items",
    "max_team_sub_plans_per_run",
    "max_team_sub_plan_tasks",
    "max_team_sub_plan_depth",
    "max_adopted_tasks_per_run",
    "max_adopted_tasks_per_team",
    "max_proposed_nodes_per_run",
    "max_proposed_edges_per_run",
    "max_nodes_evaluated_per_run",
    "approval_default_ttl_hours",
    "max_preparation_plans_per_run",
    "max_dry_run_proposals_per_run",
    "max_patch_proposal_reviews_per_run",
    "max_validation_candidates_per_run",
    "max_sandbox_apply_per_run",
    "max_sandbox_validation_per_run",
    "sandbox_validation_command_timeout_ms",
    "max_integration_candidates_per_run",
    "apply_approval_default_ttl_hours",
    "max_apply_approvals_per_run",
    "max_controlled_applies_per_run",
    "controlled_apply_validation_timeout_ms",
    "max_finalizations_per_run"
  ];
  for (const key of numericKeys) {
    const minValue = key === "max_repair_rounds" ? 0 : 1;
    const value = config[key];
    if (!Number.isFinite(value) || Number(value) < minValue) {
      throw new Error(`Invalid orchestration config ${key}: expected positive number`);
    }
  }
  if (!config.memory_path.trim()) throw new Error("Invalid orchestration config memory_path");
  if (!["fast", "deep", "exhaustive"].includes(config.execution_mode)) throw new Error("Invalid orchestration config execution_mode");
  if (!["basic", "standard", "strict"].includes(config.validation_level)) throw new Error("Invalid orchestration config validation_level");
  if (config.swarm_worker_mode !== "provider_read_only") throw new Error("Only provider_read_only swarm workers are supported.");
  if (!["off", "available", "require_for_provider_mode"].includes(config.planning_evidence_mode)) throw new Error("Invalid orchestration config planning_evidence_mode");
  if (!["off", "shadow", "advisory", "gated_adopt"].includes(config.prompt_writer_mode)) throw new Error("Invalid orchestration config prompt_writer_mode");
  if (!["deterministic", "provider_read_only", "auto"].includes(config.prompt_writer_provider_mode)) throw new Error("Invalid orchestration config prompt_writer_provider_mode");
  if (!["off", "deterministic", "provider_read_only", "auto"].includes(config.team_sub_planning_mode)) throw new Error("Invalid orchestration config team_sub_planning_mode");
  if (!["off", "metadata_only", "read_only_only", "gated_future_ready"].includes(config.team_task_adoption_mode)) throw new Error("Invalid orchestration config team_task_adoption_mode");
  if (!["off", "metadata_only", "read_only_ready"].includes(config.proposed_task_graph_mode)) throw new Error("Invalid orchestration config proposed_task_graph_mode");
  if (!["off", "report_only", "strict"].includes(config.execution_readiness_mode)) throw new Error("Invalid orchestration config execution_readiness_mode");
  if (!["off", "report_only", "approval_records", "queue_candidates"].includes(config.promotion_queue_mode ?? "off")) throw new Error("Invalid orchestration config promotion_queue_mode");
  if (!["off", "report_only", "prepare_only"].includes(config.execution_preparation_mode ?? "off")) throw new Error("Invalid orchestration config execution_preparation_mode");
  if (!["off", "fake_provider", "provider", "auto"].includes(config.one_writer_dry_run_mode ?? "off")) throw new Error("Invalid orchestration config one_writer_dry_run_mode");
  if (!["off", "deterministic", "fake_provider", "provider", "auto"].includes(config.patch_proposal_review_mode ?? "off")) throw new Error("Invalid orchestration config patch_proposal_review_mode");
  if (!["off", "report_only", "preflight"].includes(config.validation_candidate_mode ?? "off")) throw new Error("Invalid orchestration config validation_candidate_mode");
  if (!["off", "simulate_only", "temp_copy", "git_worktree_if_available"].includes(config.patch_apply_sandbox_mode ?? "off")) throw new Error("Invalid orchestration config patch_apply_sandbox_mode");
  if (!["off", "report_only", "execute_safe_commands"].includes(config.sandbox_validation_mode ?? "off")) throw new Error("Invalid orchestration config sandbox_validation_mode");
  if (!["off", "report_only", "create_candidates"].includes(config.sandbox_integration_candidate_mode ?? "off")) throw new Error("Invalid orchestration config sandbox_integration_candidate_mode");
  if (!["strict", "report_only"].includes(config.goal_steward_mode ?? "strict")) throw new Error("Invalid orchestration config goal_steward_mode");
  if (!["off", "report_only", "require_approval"].includes(config.integration_apply_approval_mode ?? "off")) throw new Error("Invalid orchestration config integration_apply_approval_mode");
  if (!["off", "report_only", "apply_with_approval"].includes(config.controlled_apply_mode ?? "off")) throw new Error("Invalid orchestration config controlled_apply_mode");
  if (!["off", "report_only", "finalize_metadata"].includes(config.integration_finalization_mode ?? "off")) throw new Error("Invalid orchestration config integration_finalization_mode");
  if (!Number.isFinite(config.min_evidence_confidence) || config.min_evidence_confidence < 0 || config.min_evidence_confidence > 1) {
    throw new Error("Invalid orchestration config min_evidence_confidence");
  }
  if (!Array.isArray(config.safe_commands_allowlist)) throw new Error("Invalid orchestration config safe_commands_allowlist");
  if (config.max_supported_logical_agents > 300) throw new Error("Invalid orchestration config max_supported_logical_agents: max is 300");
  if (config.max_swarm_executors > config.max_supported_logical_agents) throw new Error("Invalid orchestration config max_swarm_executors");
  return config;
}

function envNumber(name: string, value: number | undefined, fallback: number) {
  const raw = envRaw(name);
  if (raw === undefined || raw === "") return value ?? fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, value: boolean | undefined, fallback: boolean) {
  const raw = envRaw(name);
  if (raw === undefined || raw === "") return value ?? fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envList(name: string, value: string[] | undefined, fallback: string[]) {
  const raw = envRaw(name);
  if (raw === undefined || raw === "") return value ?? fallback;
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function envMode(name: string, fallback: ExecutionMode): ExecutionMode {
  const raw = envRaw(name);
  if (raw === "fast" || raw === "deep" || raw === "exhaustive") return raw;
  return fallback;
}

function envValidationLevel(name: string, fallback: ValidationLevel): ValidationLevel {
  const raw = envRaw(name);
  if (raw === "basic" || raw === "standard" || raw === "strict") return raw;
  return fallback;
}

function envSwarmWorkerMode(name: string, fallback: SwarmWorkerMode): SwarmWorkerMode {
  const raw = envRaw(name);
  if (raw === "provider_read_only") return raw;
  return fallback;
}

function envPlanningEvidenceMode(name: string, fallback: PlanningEvidenceMode): PlanningEvidenceMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "available" || raw === "require_for_provider_mode") return raw;
  return fallback;
}

function envPromptWriterMode(name: string, fallback: PromptWriterMode): PromptWriterMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "shadow" || raw === "advisory" || raw === "gated_adopt") return raw;
  return fallback;
}

function envPromptWriterProviderMode(name: string, fallback: PromptWriterProviderMode): PromptWriterProviderMode {
  const raw = envRaw(name);
  if (raw === "deterministic" || raw === "provider_read_only" || raw === "auto") return raw;
  return fallback;
}

function envTeamSubPlanningMode(name: string, fallback: TeamSubPlanningMode): TeamSubPlanningMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "deterministic" || raw === "provider_read_only" || raw === "auto") return raw;
  return fallback;
}

function envTeamTaskAdoptionMode(name: string, fallback: TeamTaskAdoptionMode): TeamTaskAdoptionMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "metadata_only" || raw === "read_only_only" || raw === "gated_future_ready") return raw;
  return fallback;
}

function envProposedTaskGraphMode(name: string, fallback: ProposedTaskGraphMode): ProposedTaskGraphMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "metadata_only" || raw === "read_only_ready") return raw;
  return fallback;
}

function envExecutionReadinessMode(name: string, fallback: ExecutionReadinessMode): ExecutionReadinessMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "strict") return raw;
  return fallback;
}

function envPromotionQueueMode(name: string, fallback: PromotionQueueMode): PromotionQueueMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "approval_records" || raw === "queue_candidates") return raw;
  return fallback;
}

function envExecutionPreparationMode(name: string, fallback: ExecutionPreparationMode): ExecutionPreparationMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "prepare_only") return raw;
  return fallback;
}

function envOneWriterDryRunMode(name: string, fallback: OneWriterDryRunMode): OneWriterDryRunMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "fake_provider" || raw === "provider" || raw === "auto") return raw;
  return fallback;
}

function envPatchProposalReviewMode(name: string, fallback: PatchProposalReviewMode): PatchProposalReviewMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "deterministic" || raw === "fake_provider" || raw === "provider" || raw === "auto") return raw;
  return fallback;
}

function envValidationCandidateMode(name: string, fallback: ValidationCandidateMode): ValidationCandidateMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "preflight") return raw;
  return fallback;
}

function envPatchApplySandboxMode(name: string, fallback: PatchApplySandboxMode): PatchApplySandboxMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "simulate_only" || raw === "temp_copy" || raw === "git_worktree_if_available") return raw;
  return fallback;
}

function envSandboxValidationMode(name: string, fallback: SandboxValidationMode): SandboxValidationMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "execute_safe_commands") return raw;
  return fallback;
}

function envSandboxIntegrationCandidateMode(name: string, fallback: SandboxIntegrationCandidateMode): SandboxIntegrationCandidateMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "create_candidates") return raw;
  return fallback;
}

function envGoalStewardMode(name: string, fallback: GoalStewardMode): GoalStewardMode {
  const raw = envRaw(name);
  if (raw === "strict" || raw === "report_only") return raw;
  return fallback;
}

function envIntegrationApplyApprovalMode(name: string, fallback: IntegrationApplyApprovalMode): IntegrationApplyApprovalMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "require_approval") return raw;
  return fallback;
}

function envControlledIntegrationApplyMode(name: string, fallback: ControlledIntegrationApplyMode): ControlledIntegrationApplyMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "apply_with_approval") return raw;
  return fallback;
}

function envIntegrationFinalizationMode(name: string, fallback: IntegrationFinalizationMode): IntegrationFinalizationMode {
  const raw = envRaw(name);
  if (raw === "off" || raw === "report_only" || raw === "finalize_metadata") return raw;
  return fallback;
}

function envString(name: string, value: string | undefined, fallback: string) {
  const raw = envRaw(name);
  return raw === undefined || raw === "" ? value ?? fallback : raw;
}

function envRaw(name: string) {
  return process.env[name] ?? process.env[name.replace(/^HIVO_/, "ORCHCODE_")];
}
