import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { MergedPlan } from "./MultiPlanModels.js";
import { type OrchestratorEvent, type Run } from "./OrchestrationModels.js";
import { getAgentRole } from "./RoleRegistry.js";
import {
  taskDecompositionFromTasks,
  validateStructuredOutput
} from "./StructuredOutputs.js";
import { TaskGraphManager } from "./TaskGraphManager.js";
import { assertValid, validateTask } from "./Validation.js";

export type CoreTaskGraphCreationInput = {
  run: Run;
  repoIndex: RepoIndex;
  commandInventory: CommandInventory;
  mergedPlan?: MergedPlan;
  planningRequest?: string;
  maxTaskAttempts: number;
};

export class CoreTaskGraphCreationService {
  constructor(
    private readonly workspacePath: string,
    private readonly artifactStore: OrchestrationArtifactStore,
    private readonly memoryDir?: string
  ) {}

  async create(input: CoreTaskGraphCreationInput) {
    const planningRequest = input.planningRequest ?? input.run.user_request;
    const manager = new TaskGraphManager(input.run.id, this.workspacePath, this.artifactStore, this.memoryDir);
    const validationCommands = [
      ...input.commandInventory.byKind.test.slice(0, 1),
      ...input.commandInventory.byKind.typecheck.slice(0, 1),
      ...input.commandInventory.byKind.build.slice(0, 1)
    ].slice(0, 2);
    const forbiddenFiles = [
      ".env",
      "node_modules/",
      "dist/",
      "build/",
      "target/",
      ".git/",
      ".agent_memory/"
    ];
    const highSignalFiles = chooseHighSignalFiles(planningRequest, input.repoIndex);
    const scout = manager.createTask({
      id: `task_scout_${shortId()}`,
      run_id: input.run.id,
      title: "Scout repository evidence",
      objective: `Find relevant files, symbols, commands, and patterns for: ${planningRequest}`,
      role_required: "ScoutAgent",
      dependencies: [],
      relevant_files: highSignalFiles,
      allowed_files_to_edit: [],
      forbidden_files: forbiddenFiles,
      input_context: input.mergedPlan
        ? `Use Phase 1 repo memory and snippets. Read-only. Advisory merged plan artifact: ${input.mergedPlan.artifact_ref}.`
        : "Use Phase 1 repo memory and snippets. Read-only.",
      expected_output_schema: getAgentRole("ScoutAgent").expected_output_schema,
      validation_commands: validationCommands,
      max_attempts: input.maxTaskAttempts
    });
    const planner = manager.createTask({
      id: `task_planner_${shortId()}`,
      run_id: input.run.id,
      parent_id: scout.id,
      title: "Create narrow execution plan",
      objective: `Break the request into explicit, scoped work for: ${planningRequest}`,
      role_required: "PlannerAgent",
      dependencies: [scout.id],
      relevant_files: highSignalFiles,
      allowed_files_to_edit: [],
      forbidden_files: forbiddenFiles,
      input_context: input.mergedPlan
        ? `Use Scout output, repo memory, command inventory, and advisory merged plan ${input.mergedPlan.merged_plan_id}. Read-only; do not create new executor autonomy from this artifact.`
        : "Use Scout output, repo memory, and command inventory. Read-only.",
      expected_output_schema: getAgentRole("PlannerAgent").expected_output_schema,
      validation_commands: validationCommands,
      max_attempts: input.maxTaskAttempts
    });
    const executorObjectives = splitExecutorObjectives(planningRequest);
    const executorTasks = executorObjectives.map((objective, index) => manager.createTask({
      id: `task_executor_${index + 1}_${shortId()}`,
      run_id: input.run.id,
      parent_id: planner.id,
      title: executorObjectives.length > 1 ? `Execute narrow task ${index + 1}` : "Execute first narrow task",
      objective,
      role_required: "ExecutorAgent",
      dependencies: [planner.id],
      relevant_files: highSignalFiles,
      allowed_files_to_edit: inferAllowedEditScope(objective, highSignalFiles),
      forbidden_files: forbiddenFiles,
      input_context: input.mergedPlan
        ? `Use existing SeniorCodingAgent path. Do not write files directly. Merged plan is advisory only: ${input.mergedPlan.artifact_ref}.`
        : "Use existing SeniorCodingAgent path. Do not write files directly.",
      expected_output_schema: getAgentRole("ExecutorAgent").expected_output_schema,
      validation_commands: validationCommands,
      max_attempts: input.maxTaskAttempts
    }));
    manager.createTask({
      id: `task_reporter_${shortId()}`,
      run_id: input.run.id,
      parent_id: planner.id,
      title: "Produce final run report",
      objective: `Summarize Phase 4 orchestration artifacts for: ${planningRequest}`,
      role_required: "ReporterAgent",
      dependencies: executorTasks.map((task) => task.id),
      relevant_files: [],
      allowed_files_to_edit: [],
      forbidden_files: forbiddenFiles,
      input_context: "Use persisted run artifacts only. Read-only.",
      expected_output_schema: getAgentRole("ReporterAgent").expected_output_schema,
      validation_commands: [],
      max_attempts: 1
    });
    for (const task of manager.listTasks()) assertValid("Task", task, validateTask);
    await manager.recordCreatedEvents();
    const decomposition = taskDecompositionFromTasks(manager.listTasks());
    const decompositionValidation = validateStructuredOutput("TaskDecompositionResult", decomposition);
    if (!decompositionValidation.valid) {
      throw new Error(`TaskDecompositionResult validation failed: ${decompositionValidation.errors.join("; ")}`);
    }
    const decompositionRef = await this.artifactStore.saveParsedOutput(input.run.id, "task_decomposition", decomposition);
    await this.artifactStore.appendEvent(this.event(input.run.id, "agent.output_parsed", "Validated task decomposition result.", {
      schema: "TaskDecompositionResult",
      parsed_output_ref: decompositionRef
    }));
    return manager;
  }

  private event(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
    return {
      id: `event_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      type,
      message,
      created_at: new Date().toISOString(),
      payload
    };
  }
}

export function chooseHighSignalFiles(request: string, repoIndex: RepoIndex) {
  const normalized = request.toLowerCase();
  const directMatches = repoIndex.sourceFiles
    .filter((file) => normalized.includes(path.basename(file).replace(path.extname(file), "").toLowerCase()))
    .slice(0, 6);
  return uniqueStrings([
    ...directMatches,
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.docFiles
  ]).slice(0, 8);
}

export function splitExecutorObjectives(userRequest: string) {
  const normalized = userRequest.trim();
  const parts = normalized
    .split(/\bthen\b|;|\n/gi)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12)
    .slice(0, 3);
  if (parts.length > 1) {
    return parts.map((part) => `Execute this narrow slice only: ${part}`);
  }
  if (/\b(refactor|rewrite|whole|entire|all)\b/i.test(normalized)) {
    return [
      `Inspect and propose the smallest safe first step for: ${normalized}`,
      `Execute only the first scoped implementation step for: ${normalized}`
    ];
  }
  return [`Execute the first narrow, auditable task for: ${normalized}`];
}

export function inferAllowedEditScope(objective: string, highSignalFiles: string[]) {
  if (/\b(explain|inspect|summarize|review|scan)\b/i.test(objective)) return [];
  return highSignalFiles.filter((file) => /\.(ts|tsx|js|jsx|rs|py|md|json)$/i.test(file)).slice(0, 4);
}

function shortId() {
  return randomUUID().slice(0, 8);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
