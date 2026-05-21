import type { AgentRole, AgentRoleName } from "./OrchestrationModels.js";
import { assertValid, validateAgentRole } from "./Validation.js";

export const ROLE_REGISTRY: Record<AgentRoleName, AgentRole> = {
  ScoutAgent: {
    name: "ScoutAgent",
    purpose: "Find relevant files, symbols, commands, and project patterns before planning.",
    allowed_operations: ["read_repo_index", "read_file_summaries", "read_command_inventory", "read_workspace_files"],
    forbidden_operations: ["edit_files", "run_commands", "apply_patches", "invent_unread_file_details"],
    default_prompt: "Map the relevant repository evidence for the task. Return file paths, symbols, commands, and unknowns.",
    expected_output_schema: "ScoutOutput",
    can_edit_files: false,
    can_run_commands: false,
    review_required: false,
    required_output_format: "JSON object with summary, relevant_files, commands, risks, and unknowns.",
    success_criteria: [
      "Relevant files are grounded in the repo index or snippets.",
      "Validation commands come from command inventory when available.",
      "Unknowns are explicit instead of guessed."
    ]
  },
  ArchitectAgent: {
    name: "ArchitectAgent",
    purpose: "Identify the safest implementation approach and architectural risks.",
    allowed_operations: ["read_context_pack", "read_architecture_docs", "read_repo_index"],
    forbidden_operations: ["edit_files", "run_commands", "apply_patches", "broaden_scope_without_evidence"],
    default_prompt: "Assess architecture impact, constraints, and safest implementation boundaries.",
    expected_output_schema: "ArchitectOutput",
    can_edit_files: false,
    can_run_commands: false,
    review_required: false,
    required_output_format: "JSON object with approach, affected_areas, risks, constraints, and recommended_tasks.",
    success_criteria: [
      "Approach preserves existing behavior.",
      "Risks name concrete files or contracts.",
      "Recommended tasks are narrow and verifiable."
    ]
  },
  PlannerAgent: {
    name: "PlannerAgent",
    purpose: "Break a user request into small, explicit, dependency-aware tasks.",
    allowed_operations: ["read_context_pack", "create_tasks", "link_dependencies"],
    forbidden_operations: ["edit_files", "run_commands", "create_unbounded_tasks"],
    default_prompt: "Create a narrow task graph with explicit dependencies, roles, edit scopes, and validation.",
    expected_output_schema: "PlannerOutput",
    can_edit_files: false,
    can_run_commands: false,
    review_required: false,
    required_output_format: "JSON object with tasks, dependencies, allowed_files_to_edit, forbidden_files, and validation_commands.",
    success_criteria: [
      "Tasks are small enough for one role.",
      "Executor tasks include allowed edit scope.",
      "Dependencies are acyclic and auditable."
    ]
  },
  ExecutorAgent: {
    name: "ExecutorAgent",
    purpose: "Perform one narrow code modification or inspection through the existing coding-agent path.",
    allowed_operations: ["read_context_pack", "use_existing_coding_agent", "propose_patch", "request_safe_validation"],
    forbidden_operations: ["edit_files_outside_allowed_scope", "run_dangerous_commands", "apply_patches_directly", "ignore_context_constraints"],
    default_prompt: "Execute only the assigned narrow task using the provided context and allowed edit scope.",
    expected_output_schema: "ExecutorOutput",
    can_edit_files: true,
    can_run_commands: false,
    review_required: true,
    required_output_format: "JSON object with summary, proposed_changes, files_touched, validation_requested, risks, and status.",
    success_criteria: [
      "No direct file writes outside patch authority.",
      "Any proposed patch only touches allowed files.",
      "Output includes validation and unresolved risks."
    ]
  },
  ReviewerAgent: {
    name: "ReviewerAgent",
    purpose: "Review outputs and diffs for bugs, scope creep, maintainability, and consistency.",
    allowed_operations: ["read_outputs", "read_diffs", "read_context_pack"],
    forbidden_operations: ["edit_files", "run_commands", "approve_without_evidence"],
    default_prompt: "Review the task output against scope, correctness, maintainability, and test coverage.",
    expected_output_schema: "ReviewerOutput",
    can_edit_files: false,
    can_run_commands: false,
    review_required: false,
    required_output_format: "JSON object with verdict, findings, required_changes, and residual_risks.",
    success_criteria: [
      "Findings reference concrete files or artifacts.",
      "Scope creep is called out.",
      "Missing validation is explicit."
    ]
  },
  TesterAgent: {
    name: "TesterAgent",
    purpose: "Select and run validation commands.",
    allowed_operations: ["read_command_inventory", "request_commands", "summarize_command_results"],
    forbidden_operations: ["run_dangerous_commands", "hide_command_failures", "modify_files"],
    default_prompt: "Select the narrowest safe validation commands and summarize results.",
    expected_output_schema: "TesterOutput",
    can_edit_files: false,
    can_run_commands: true,
    review_required: false,
    required_output_format: "JSON object with commands, results, failures, and confidence.",
    success_criteria: [
      "Commands come from command inventory when possible.",
      "Dangerous commands are rejected.",
      "Failures include next diagnostic action."
    ]
  },
  IntegratorAgent: {
    name: "IntegratorAgent",
    purpose: "Merge successful outputs into a coherent final result.",
    allowed_operations: ["read_outputs", "read_reports", "propose_integration_patch"],
    forbidden_operations: ["edit_files_outside_allowed_scope", "skip_review", "overwrite_unrelated_work"],
    default_prompt: "Integrate successful task outputs while preserving ownership boundaries and review evidence.",
    expected_output_schema: "IntegratorOutput",
    can_edit_files: true,
    can_run_commands: false,
    review_required: true,
    required_output_format: "JSON object with integrated_summary, files_changed, conflicts, and review_needed.",
    success_criteria: [
      "Only successful task outputs are integrated.",
      "Conflicts are explicit.",
      "Integration respects allowed files."
    ]
  },
  ReporterAgent: {
    name: "ReporterAgent",
    purpose: "Produce final human-readable run reports.",
    allowed_operations: ["read_run_artifacts", "read_task_history", "summarize_results"],
    forbidden_operations: ["edit_files", "run_commands", "claim_unrun_validation"],
    default_prompt: "Create a concise final report from persisted run artifacts and known limitations.",
    expected_output_schema: "FinalRunReport",
    can_edit_files: false,
    can_run_commands: false,
    review_required: false,
    required_output_format: "FinalRunReport JSON plus optional human summary.",
    success_criteria: [
      "Report lists tasks created/completed/failed.",
      "Validation is reported only if actually run or requested.",
      "Limitations and next recommendations are explicit."
    ]
  }
};

export function getAgentRole(name: AgentRoleName): AgentRole {
  const role = ROLE_REGISTRY[name];
  return assertValid(`AgentRole ${name}`, role, validateAgentRole);
}

export function listAgentRoles() {
  return Object.values(ROLE_REGISTRY).map((role) => assertValid(`AgentRole ${role.name}`, role, validateAgentRole));
}
