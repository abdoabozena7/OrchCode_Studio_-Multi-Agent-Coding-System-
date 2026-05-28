import type { AgentTemplate, SpecialistAgentDescriptor, SwarmRiskLevel, WorkItemType } from "./SwarmModels.js";
import { SWARM_SCHEMA_VERSION } from "./SwarmModels.js";

type TemplateInput = Omit<AgentTemplate, "schema_version">;

const CORE_TEMPLATES: TemplateInput[] = [
  {
    id: "template_scout",
    role: "ScoutAgent",
    purpose: "Read repository memory and selected files to gather grounded evidence before planning.",
    allowed_operations: ["read_repo_index", "read_workspace_files", "read_context_pack"],
    forbidden_operations: ["edit_files", "run_commands", "apply_patches", "invent_unread_file_details"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 12_000,
    default_output_schema: "ScoutResult",
    risk_level: "low",
    suitable_task_types: ["scout"]
  },
  {
    id: "template_context_builder",
    role: "ContextBuilderAgent",
    purpose: "Build narrow context packs and evidence slices for downstream workers.",
    allowed_operations: ["read_repo_index", "read_workspace_files", "read_context_pack"],
    forbidden_operations: ["edit_files", "run_commands", "apply_patches"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 16_000,
    default_output_schema: "ContextPackSummary",
    risk_level: "low",
    suitable_task_types: ["scout", "plan"]
  },
  {
    id: "template_planner",
    role: "PlannerAgent",
    purpose: "Convert evidence into dependency-aware work items with explicit merge constraints.",
    allowed_operations: ["read_context_pack", "propose_plan", "read_outputs"],
    forbidden_operations: ["edit_files", "run_commands", "create_unbounded_tasks"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 16_000,
    default_output_schema: "PlannerOutput",
    risk_level: "low",
    suitable_task_types: ["plan"]
  },
  {
    id: "template_architect",
    role: "ArchitectAgent",
    purpose: "Assess architecture impact, module boundaries, and safe implementation shape.",
    allowed_operations: ["read_repo_index", "read_workspace_files", "read_context_pack", "propose_plan"],
    forbidden_operations: ["edit_files", "run_commands", "apply_patches"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 20_000,
    default_output_schema: "ArchitectOutput",
    risk_level: "medium",
    suitable_task_types: ["plan", "risk_analysis"]
  },
  {
    id: "template_risk_analyzer",
    role: "RiskAnalyzerAgent",
    purpose: "Identify sensitive files, approval gates, lock risks, and validation intensity.",
    allowed_operations: ["read_repo_index", "read_workspace_files", "review_outputs"],
    forbidden_operations: ["edit_files", "run_commands", "approve_without_evidence"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 14_000,
    default_output_schema: "RiskAnalysisOutput",
    risk_level: "medium",
    suitable_task_types: ["risk_analysis", "review"]
  },
  {
    id: "template_executor",
    role: "ExecutorAgent",
    purpose: "Perform one scoped implementation or patch proposal under file locks.",
    allowed_operations: ["read_context_pack", "propose_patch", "request_safe_validation"],
    forbidden_operations: ["edit_files_outside_allowed_scope", "run_dangerous_commands", "bypass_file_locks"],
    can_read_files: true,
    can_edit_files: true,
    can_run_commands: false,
    max_context_size: 18_000,
    default_output_schema: "ExecutorOutput",
    risk_level: "high",
    suitable_task_types: ["execute"]
  },
  {
    id: "template_reviewer",
    role: "ReviewerAgent",
    purpose: "Review proposed outputs and patches for correctness, scope, safety, and maintainability.",
    allowed_operations: ["read_outputs", "read_run_artifacts", "review_outputs"],
    forbidden_operations: ["edit_files", "run_commands", "approve_without_evidence"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 16_000,
    default_output_schema: "ReviewerOutput",
    risk_level: "medium",
    suitable_task_types: ["review"]
  },
  {
    id: "template_tester",
    role: "TesterAgent",
    purpose: "Select and request safe validation commands and summarize outcomes.",
    allowed_operations: ["read_repo_index", "request_safe_validation", "summarize_results"],
    forbidden_operations: ["run_dangerous_commands", "hide_command_failures", "modify_files"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: true,
    max_context_size: 12_000,
    default_output_schema: "TesterOutput",
    risk_level: "medium",
    suitable_task_types: ["test"]
  },
  {
    id: "template_integrator",
    role: "IntegratorAgent",
    purpose: "Accept only reviewed and validated work into the integrated run result.",
    allowed_operations: ["read_outputs", "read_run_artifacts", "propose_patch", "summarize_results"],
    forbidden_operations: ["skip_review", "overwrite_unrelated_work", "bypass_file_locks"],
    can_read_files: true,
    can_edit_files: true,
    can_run_commands: false,
    max_context_size: 18_000,
    default_output_schema: "IntegratorOutput",
    risk_level: "high",
    suitable_task_types: ["integrate"]
  },
  {
    id: "template_memory_updater",
    role: "MemoryUpdaterAgent",
    purpose: "Record durable lessons, decisions, and run outcomes after integration.",
    allowed_operations: ["read_run_artifacts", "update_memory", "summarize_results"],
    forbidden_operations: ["edit_source_files", "run_commands", "hide_failures"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 10_000,
    default_output_schema: "MemoryUpdateOutput",
    risk_level: "low",
    suitable_task_types: ["memory_update"]
  },
  {
    id: "template_reporter",
    role: "ReporterAgent",
    purpose: "Produce the final human-readable report from run artifacts and metrics.",
    allowed_operations: ["read_run_artifacts", "summarize_results"],
    forbidden_operations: ["edit_files", "run_commands", "claim_unrun_validation"],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 12_000,
    default_output_schema: "FinalSwarmReport",
    risk_level: "low",
    suitable_task_types: ["summarize"]
  }
];

export function listCoreSwarmAgentTemplates(): AgentTemplate[] {
  return CORE_TEMPLATES.map(withSchema);
}

export function createSpecialistTemplate(specialist: SpecialistAgentDescriptor): AgentTemplate {
  const riskLevel: SwarmRiskLevel = specialist.role.includes("Security") || specialist.role.includes("Migration")
    ? "high"
    : "medium";
  return withSchema({
    id: `template_${specialist.id}`,
    role: specialist.role,
    purpose: specialist.purpose,
    allowed_operations: ["read_repo_index", "read_workspace_files", "read_outputs", "review_outputs"],
    forbidden_operations: [
      "edit_files",
      "run_commands",
      "apply_patches",
      "approve_without_evidence"
    ],
    can_read_files: true,
    can_edit_files: false,
    can_run_commands: false,
    max_context_size: 14_000,
    default_output_schema: specialist.output_schema,
    risk_level: riskLevel,
    suitable_task_types: ["review", "risk_analysis"] satisfies WorkItemType[]
  });
}

export function createSwarmAgentTemplates(specialists: SpecialistAgentDescriptor[]): AgentTemplate[] {
  return [
    ...listCoreSwarmAgentTemplates(),
    ...specialists.map(createSpecialistTemplate)
  ];
}

function withSchema(input: TemplateInput): AgentTemplate {
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    ...input
  };
}
