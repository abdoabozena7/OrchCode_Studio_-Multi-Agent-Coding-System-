import { createHash } from "node:crypto";
import { FactoryMetadataStore } from "./FactoryMetadataStore.js";
import type { AgentRoleName, ContextPack, Task } from "./OrchestrationModels.js";

export const PROMPT_RENDERER_VERSION = "factory-prompt-renderer-v1";
export const ROLE_PROMPT_INPUT_SCHEMA_VERSION = "role-prompt-input-v1";

export type PromptTemplateId =
  | "factory.role.scout"
  | "factory.role.planner"
  | "factory.role.executor"
  | "factory.role.reviewer"
  | "factory.role.tester"
  | "factory.role.reporter"
  | "factory.role.repair"
  | "factory.role.generic"
  | "factory.swarm.scout"
  | "factory.swarm.planner"
  | "factory.swarm.risk_analyst"
  | "factory.swarm.reviewer"
  | "factory.swarm.specialist"
  | "factory.swarm.tester_planner"
  | "factory.swarm.reporter"
  | "factory.swarm.generic_read_only_worker"
  | (string & {});
export type PromptTemplateVersion = string;
export type PromptType = "role_invocation" | "swarm_instruction" | "repair" | "report" | (string & {});

export type PromptTemplateInput = Record<string, unknown>;

export type PromptTemplate = {
  template_id: PromptTemplateId;
  version: PromptTemplateVersion;
  description: string;
  target_role: AgentRoleName | "generic" | string;
  prompt_type: PromptType;
  required_input_fields: string[];
  optional_input_fields: string[];
  output_schema_name: string;
  created_at: string;
  render(input: PromptTemplateInput): string;
};

export type RenderedPrompt = {
  prompt_id: string;
  run_id: string;
  task_id: string;
  agent_id?: string;
  agent_role: AgentRoleName | string;
  prompt_type: PromptType;
  template_id: PromptTemplateId;
  template_version: PromptTemplateVersion;
  renderer_version: string;
  template_input_schema_version: string;
  input_hash: string;
  rendered_prompt_hash: string;
  text: string;
  context_pack_ref: string;
  output_schema_name: string;
  created_at: string;
  source_component: string;
  metadata_json: Record<string, unknown>;
};

export type PromptArtifactMetadata = Omit<RenderedPrompt, "text"> & {
  artifact_ref: string;
};

export type PromptRenderError = {
  code: "missing_template" | "missing_required_input";
  message: string;
  template_id: PromptTemplateId;
  template_version?: PromptTemplateVersion;
  missing_fields?: string[];
  run_id?: string;
  task_id?: string;
  agent_role?: string;
};

export type PromptRenderResult =
  | { ok: true; rendered: RenderedPrompt; template: PromptTemplate }
  | { ok: false; error: PromptRenderError };

export type RolePromptInput = {
  run_id: string;
  task_id: string;
  agent_role: AgentRoleName | string;
  task_title: string;
  task_objective: string;
  context_pack_ref: string;
  allowed_files: string[];
  forbidden_files: string[];
  relevant_files: string[];
  validation_requirements: string[];
  expected_output_schema: string;
  output_schema_name: string;
  source_component?: string;
  agent_id?: string;
  metadata_json?: Record<string, unknown>;
};

export type PromptMetadataForRun = {
  prompt_id: string;
  template_id: string;
  template_version: string;
  input_hash: string;
  rendered_hash: string;
  artifact_ref: string;
  context_pack_ref: string;
  task_id: string;
  agent_role: string;
  output_schema_name: string;
};

export class PromptTemplateRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  registerPromptTemplate(template: PromptTemplate) {
    this.templates.set(templateKey(template.template_id, template.version), template);
  }

  getPromptTemplate(templateId: PromptTemplateId, version?: PromptTemplateVersion) {
    if (version) return this.templates.get(templateKey(templateId, version));
    return [...this.templates.values()]
      .filter((template) => template.template_id === templateId)
      .sort((left, right) => right.version.localeCompare(left.version))[0];
  }

  clear() {
    this.templates.clear();
  }
}

export const defaultPromptTemplateRegistry = new PromptTemplateRegistry();

export function registerPromptTemplate(template: PromptTemplate, registry = defaultPromptTemplateRegistry) {
  registry.registerPromptTemplate(template);
}

export function getPromptTemplate(templateId: PromptTemplateId, version?: PromptTemplateVersion, registry = defaultPromptTemplateRegistry) {
  return registry.getPromptTemplate(templateId, version);
}

export function renderPromptTemplate(
  templateId: PromptTemplateId,
  input: PromptTemplateInput,
  options: {
    version?: PromptTemplateVersion;
    registry?: PromptTemplateRegistry;
    rendererVersion?: string;
    templateInputSchemaVersion?: string;
    sourceComponent?: string;
  } = {}
): PromptRenderResult {
  const registry = options.registry ?? defaultPromptTemplateRegistry;
  const template = registry.getPromptTemplate(templateId, options.version);
  if (!template) {
    return {
      ok: false,
      error: {
        code: "missing_template",
        message: `Prompt template not found: ${templateId}${options.version ? `@${options.version}` : ""}.`,
        template_id: templateId,
        template_version: options.version,
        run_id: stringInput(input, "run_id"),
        task_id: stringInput(input, "task_id"),
        agent_role: stringInput(input, "agent_role")
      }
    };
  }
  const missing = template.required_input_fields.filter((field) => input[field] === undefined || input[field] === null);
  if (missing.length) {
    return {
      ok: false,
      error: {
        code: "missing_required_input",
        message: `Prompt template ${template.template_id}@${template.version} is missing required input field(s): ${missing.join(", ")}.`,
        template_id: template.template_id,
        template_version: template.version,
        missing_fields: missing,
        run_id: stringInput(input, "run_id"),
        task_id: stringInput(input, "task_id"),
        agent_role: stringInput(input, "agent_role")
      }
    };
  }
  const text = template.render(input);
  const inputHash = hashPromptInput(input);
  const renderedHash = hashRenderedPrompt(text);
  const runId = requiredString(input, "run_id");
  const taskId = requiredString(input, "task_id");
  const agentRole = requiredString(input, "agent_role");
  const contextPackRef = requiredString(input, "context_pack_ref");
  const outputSchemaName = requiredString(input, "output_schema_name");
  return {
    ok: true,
    template,
    rendered: {
      prompt_id: `prompt_${hashRenderedPrompt([runId, taskId, agentRole, template.template_id, template.version, inputHash, renderedHash].join("\0")).slice(0, 24)}`,
      run_id: runId,
      task_id: taskId,
      agent_id: stringInput(input, "agent_id"),
      agent_role: agentRole,
      prompt_type: template.prompt_type,
      template_id: template.template_id,
      template_version: template.version,
      renderer_version: options.rendererVersion ?? PROMPT_RENDERER_VERSION,
      template_input_schema_version: options.templateInputSchemaVersion ?? ROLE_PROMPT_INPUT_SCHEMA_VERSION,
      input_hash: inputHash,
      rendered_prompt_hash: renderedHash,
      text,
      context_pack_ref: contextPackRef,
      output_schema_name: outputSchemaName,
      created_at: new Date().toISOString(),
      source_component: options.sourceComponent ?? stringInput(input, "source_component") ?? "PromptSystem",
      metadata_json: asRecord(input.metadata_json) ?? {}
    }
  };
}

export function renderRolePrompt(input: RolePromptInput, options: { registry?: PromptTemplateRegistry } = {}) {
  const templateId = roleTemplateId(input.agent_role);
  const result = renderPromptTemplate(templateId, input, {
    registry: options.registry,
    sourceComponent: input.source_component ?? "CoreOrchestrator"
  });
  if (result.ok) return result;
  if (result.error.code !== "missing_template" || templateId === "factory.role.generic") return result;
  return renderPromptTemplate("factory.role.generic", input, {
    registry: options.registry,
    sourceComponent: input.source_component ?? "CoreOrchestrator"
  });
}

export function renderPromptText(templateId: PromptTemplateId, input: PromptTemplateInput) {
  const result = renderPromptTemplate(templateId, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.rendered.text;
}

export function renderPromptWithMetadata(templateId: PromptTemplateId, input: PromptTemplateInput) {
  const result = renderPromptTemplate(templateId, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.rendered;
}

export function rolePromptInputFromTask(input: {
  runId: string;
  task: Task;
  pack: ContextPack;
  contextPackRef: string;
  sourceComponent?: string;
}): RolePromptInput {
  return {
    run_id: input.runId,
    task_id: input.task.id,
    agent_role: input.task.role_required,
    task_title: input.task.title,
    task_objective: input.task.objective,
    context_pack_ref: input.contextPackRef,
    allowed_files: input.pack.allowed_files_to_edit,
    forbidden_files: input.pack.forbidden_files,
    relevant_files: input.pack.relevant_files,
    validation_requirements: input.pack.validation_requirements,
    expected_output_schema: input.task.expected_output_schema,
    output_schema_name: input.task.expected_output_schema,
    source_component: input.sourceComponent ?? "CoreOrchestrator",
    metadata_json: {
      context_pack_id: input.pack.id,
      context_retrieval_summary: input.pack.retrieval_summary,
      team_context: input.pack.team_context ? {
        team_id: input.pack.team_context.scope.team_id,
        parent_team_id: input.pack.team_context.scope.parent_team_id,
        memory_scope: input.pack.team_context.scope.memory_scope,
        team_context_scope_ref: input.pack.team_context.scope.artifact_ref,
        team_context_summary_ref: input.pack.team_context.scope.summary_ref,
        team_memory_query_refs: input.pack.team_context.memory_queries.map((query) => query.artifact_ref ?? query.query_id),
        warning_count: input.pack.team_context.warnings.length,
        fallback_used: input.pack.team_context.fallback_used
      } : undefined
    }
  };
}

export function swarmPromptTemplateIdForRole(role: string, workItemType?: string): PromptTemplateId {
  if (workItemType === "scout" || role === "ScoutAgent") return "factory.swarm.scout";
  if (workItemType === "plan" || role === "PlannerAgent" || role === "ArchitectAgent") return "factory.swarm.planner";
  if (workItemType === "risk_analysis" || role === "RiskAnalyzerAgent") return "factory.swarm.risk_analyst";
  if (workItemType === "test" || role === "TesterAgent") return "factory.swarm.tester_planner";
  if (workItemType === "summarize" || role === "ReporterAgent") return "factory.swarm.reporter";
  if (workItemType === "review" || role === "ReviewerAgent") return "factory.swarm.reviewer";
  if (/Reviewer|Security|Accessibility|Migration|Performance|Database|Dependency|Specialist/i.test(role)) return "factory.swarm.specialist";
  return "factory.swarm.generic_read_only_worker";
}

export function hashPromptInput(input: PromptTemplateInput) {
  return sha256(stableStringify(input));
}

export function hashRenderedPrompt(text: string) {
  return sha256(text);
}

export function createPromptArtifact(renderedPrompt: RenderedPrompt, artifactRef: string): PromptArtifactMetadata {
  const { text: _text, ...metadata } = renderedPrompt;
  return {
    ...metadata,
    artifact_ref: artifactRef
  };
}

export async function reconstructPromptMetadataForRun(input: {
  workspacePath: string;
  memoryDir?: string;
  runId: string;
  taskId?: string;
}): Promise<PromptMetadataForRun[]> {
  const store = await FactoryMetadataStore.open({
    workspacePath: input.workspacePath,
    memoryDir: input.memoryDir,
    readOnly: true
  });
  try {
    const rows = input.taskId
      ? store.all<Record<string, unknown>>(
        "SELECT * FROM factory_prompts WHERE run_id = ? AND task_id = ? ORDER BY created_at, id",
        input.runId,
        input.taskId
      )
      : store.all<Record<string, unknown>>(
        "SELECT * FROM factory_prompts WHERE run_id = ? ORDER BY created_at, id",
        input.runId
      );
    return rows.map((row) => ({
      prompt_id: String(row.prompt_id ?? row.id),
      template_id: String(row.template_id ?? ""),
      template_version: String(row.template_version ?? ""),
      input_hash: String(row.input_hash ?? ""),
      rendered_hash: String(row.rendered_prompt_hash ?? row.prompt_hash ?? ""),
      artifact_ref: String(row.artifact_ref ?? ""),
      context_pack_ref: String(row.context_pack_ref ?? ""),
      task_id: String(row.task_id ?? ""),
      agent_role: String(row.agent_role ?? row.role ?? ""),
      output_schema_name: String(row.output_schema_name ?? "")
    }));
  } finally {
    store.close();
  }
}

function registerBuiltInTemplates() {
  for (const [role, templateId, description] of [
    ["ScoutAgent", "factory.role.scout", "Scout role prompt template."],
    ["PlannerAgent", "factory.role.planner", "Planner role prompt template."],
    ["ExecutorAgent", "factory.role.executor", "Executor role prompt template."],
    ["ReviewerAgent", "factory.role.reviewer", "Reviewer role prompt template."],
    ["TesterAgent", "factory.role.tester", "Tester role prompt template."],
    ["ReporterAgent", "factory.role.reporter", "Reporter role prompt template."],
    ["IntegratorAgent", "factory.role.repair", "Repair and integration role prompt template."],
    ["generic", "factory.role.generic", "Generic role fallback prompt template."]
  ] as const) {
    registerPromptTemplate({
      template_id: templateId,
      version: "1.0.0",
      description,
      target_role: role,
      prompt_type: "role_invocation",
      required_input_fields: [
        "run_id",
        "task_id",
        "agent_role",
        "task_title",
        "task_objective",
        "context_pack_ref",
        "allowed_files",
        "forbidden_files",
        "relevant_files",
        "validation_requirements",
        "expected_output_schema",
        "output_schema_name"
      ],
      optional_input_fields: ["agent_id", "metadata_json", "source_component"],
      output_schema_name: "ParsedAgentOutput",
      created_at: "2026-05-25T00:00:00.000Z",
      render: renderLegacyRolePrompt
    });
  }
  for (const [role, templateId, description, outputSchema] of [
    ["ScoutAgent", "factory.swarm.scout", "Read-only swarm scout prompt template.", "swarm_scout_output"],
    ["PlannerAgent", "factory.swarm.planner", "Read-only swarm planner prompt template.", "swarm_planner_output"],
    ["RiskAnalyzerAgent", "factory.swarm.risk_analyst", "Read-only swarm risk analyst prompt template.", "swarm_risk_analyst_output"],
    ["ReviewerAgent", "factory.swarm.reviewer", "Read-only swarm reviewer prompt template.", "swarm_reviewer_output"],
    ["generic", "factory.swarm.specialist", "Read-only swarm specialist reviewer prompt template.", "swarm_specialist_output"],
    ["TesterAgent", "factory.swarm.tester_planner", "Read-only swarm tester planner prompt template.", "swarm_tester_planner_output"],
    ["ReporterAgent", "factory.swarm.reporter", "Read-only swarm reporter prompt template.", "swarm_reporter_output"],
    ["generic", "factory.swarm.generic_read_only_worker", "Generic read-only swarm worker prompt template.", "swarm_specialist_output"]
  ] as const) {
    registerPromptTemplate({
      template_id: templateId,
      version: "1.0.0",
      description,
      target_role: role,
      prompt_type: "swarm_instruction",
      required_input_fields: [
        "run_id",
        "task_id",
        "agent_role",
        "task_title",
        "task_objective",
        "context_pack_ref",
        "allowed_files",
        "forbidden_files",
        "relevant_files",
        "validation_requirements",
        "expected_output_schema",
        "output_schema_name"
      ],
      optional_input_fields: ["agent_id", "metadata_json", "source_component"],
      output_schema_name: outputSchema,
      created_at: "2026-05-25T00:00:00.000Z",
      render: renderSwarmReadOnlyPrompt
    });
  }
}

function renderLegacyRolePrompt(input: PromptTemplateInput) {
  const role = requiredString(input, "agent_role");
  const title = requiredString(input, "task_title");
  const objective = requiredString(input, "task_objective");
  const allowed = requiredStringArray(input, "allowed_files");
  const forbidden = requiredStringArray(input, "forbidden_files");
  const relevant = requiredStringArray(input, "relevant_files");
  const validation = requiredStringArray(input, "validation_requirements");
  return [
    `Role: ${role}`,
    `Task: ${title}`,
    `Objective: ${objective}`,
    "",
    "Allowed files to edit:",
    ...(allowed.length ? allowed.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Forbidden files:",
    ...(forbidden.length ? forbidden.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Relevant files:",
    ...(relevant.length ? relevant.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Validation requirements:",
    ...(validation.length ? validation.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Return structured output and do not claim validation that was not run."
  ].join("\n");
}

function renderSwarmReadOnlyPrompt(input: PromptTemplateInput) {
  const base = renderLegacyRolePrompt(input);
  const schema = requiredString(input, "output_schema_name");
  return [
    base,
    "",
    "Read-only swarm worker constraints:",
    "- Do not edit files.",
    "- Do not create patches or diffs.",
    "- Do not run shell commands.",
    "- Treat all files as reference context only.",
    "- Do not claim validation passed unless a validation artifact proves it.",
    "",
    `Return strict JSON matching schema: ${schema}.`,
    "Use exactly these top-level keys for the selected schema:",
    readOnlySchemaKeyInstruction(schema),
    "Do not wrap the JSON in markdown. Do not return an answer key instead of the schema keys."
  ].join("\n");
}

function readOnlySchemaKeyInstruction(schema: string) {
  switch (schema) {
    case "swarm_scout_output":
      return '{"findings":["..."],"relevant_files":["path/or/module"],"risks":[],"unknowns":[],"suggested_next_steps":[],"confidence":0.7}';
    case "swarm_planner_output":
      return '{"plan_summary":"...","task_drafts":["..."],"dependencies":[],"risks":[],"validation_strategy":[],"assumptions":[],"confidence":0.7}';
    case "swarm_risk_analyst_output":
      return '{"risks":["..."],"severity":"low|medium|high|critical","impacted_files_or_modules":[],"mitigation":[],"blockers":[],"confidence":0.7}';
    case "swarm_reviewer_output":
      return '{"decision":"accepted|needs_changes|blocked","severity":"low|medium|high|critical","findings":["..."],"required_changes":[],"validation_recommendations":[],"confidence":0.7}';
    case "swarm_tester_planner_output":
      return '{"recommended_validation":[],"required_commands":[],"optional_commands":[],"smoke_checks":[],"blocked_or_missing_validation":[],"confidence":0.7}';
    case "swarm_reporter_output":
      return '{"summary":"...","evidence_refs":[],"unresolved_risks":[],"next_steps":[],"confidence":0.7}';
    case "swarm_specialist_output":
    default:
      return '{"specialty":"...","findings":["..."],"recommendations":[],"risks":[],"confidence":0.7}';
  }
}

function roleTemplateId(role: string): PromptTemplateId {
  if (role === "ScoutAgent") return "factory.role.scout";
  if (role === "PlannerAgent") return "factory.role.planner";
  if (role === "ExecutorAgent") return "factory.role.executor";
  if (role === "ReviewerAgent") return "factory.role.reviewer";
  if (role === "TesterAgent") return "factory.role.tester";
  if (role === "ReporterAgent") return "factory.role.reporter";
  if (role === "IntegratorAgent") return "factory.role.repair";
  return "factory.role.generic";
}

function requiredString(input: PromptTemplateInput, field: string) {
  const value = input[field];
  if (typeof value !== "string" || !value.length) throw new Error(`Prompt input field ${field} must be a non-empty string.`);
  return value;
}

function stringInput(input: PromptTemplateInput, field: string) {
  const value = input[field];
  return typeof value === "string" ? value : undefined;
}

function requiredStringArray(input: PromptTemplateInput, field: string) {
  const value = input[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Prompt input field ${field} must be a string array.`);
  }
  return value as string[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function templateKey(templateId: PromptTemplateId, version: PromptTemplateVersion) {
  return `${templateId}@${version}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

registerBuiltInTemplates();
