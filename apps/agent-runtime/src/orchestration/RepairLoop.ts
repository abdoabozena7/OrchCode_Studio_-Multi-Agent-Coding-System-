import { randomUUID } from "node:crypto";
import type { Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { TaskGraphManager } from "./TaskGraphManager.js";

export type RepairFailureInput = {
  reason: string;
  required_changes: string[];
  validation_logs: string[];
  previous_patch_fingerprint?: string;
};

export class PatchFingerprintTracker {
  private readonly failedFingerprints = new Map<string, Set<string>>();

  recordFailedFingerprint(taskId: string, fingerprint: string) {
    if (!fingerprint) return false;
    const set = this.failedFingerprints.get(taskId) ?? new Set<string>();
    const repeated = set.has(fingerprint);
    set.add(fingerprint);
    this.failedFingerprints.set(taskId, set);
    return repeated;
  }

  hasFailedFingerprint(taskId: string, fingerprint: string) {
    return this.failedFingerprints.get(taskId)?.has(fingerprint) ?? false;
  }
}

export function canCreateRepairTask(input: {
  originalTask: Task;
  existingTasks: Task[];
  config: Pick<OrchestrationSafetyConfig, "max_repair_rounds">;
}) {
  if (input.originalTask.title.startsWith("Repair ")) return false;
  const repairs = input.existingTasks.filter((task) => task.parent_id === input.originalTask.id && task.title.startsWith("Repair "));
  return repairs.length < input.config.max_repair_rounds;
}

export function createRepairTask(input: {
  manager: TaskGraphManager;
  originalTask: Task;
  failure: RepairFailureInput;
  config: Pick<OrchestrationSafetyConfig, "max_repair_rounds" | "max_attempts_per_task">;
}): Task | undefined {
  if (!canCreateRepairTask({
    originalTask: input.originalTask,
    existingTasks: input.manager.listTasks(),
    config: input.config
  })) {
    return undefined;
  }
  const id = `task_repair_${randomUUID().slice(0, 8)}`;
  return input.manager.createTask({
    id,
    run_id: input.originalTask.run_id,
    parent_id: input.originalTask.id,
    title: `Repair ${input.originalTask.title}`,
    objective: [
      `Repair the failed task: ${input.originalTask.objective}`,
      `Failure reason: ${input.failure.reason}`,
      input.failure.required_changes.length ? `Required changes: ${input.failure.required_changes.join("; ")}` : "Required changes: none listed.",
      input.failure.previous_patch_fingerprint ? `Previous patch fingerprint: ${input.failure.previous_patch_fingerprint}` : "Previous patch fingerprint: none."
    ].join("\n"),
    role_required: "ExecutorAgent",
    dependencies: input.originalTask.dependencies,
    relevant_files: input.originalTask.relevant_files,
    allowed_files_to_edit: input.originalTask.allowed_files_to_edit,
    forbidden_files: input.originalTask.forbidden_files,
    input_context: [
      input.originalTask.input_context ?? "",
      "This is a repair task. Address only the listed failure details.",
      ...input.failure.validation_logs.map((log) => `Validation log: ${log}`)
    ].filter(Boolean).join("\n"),
    expected_output_schema: input.originalTask.expected_output_schema,
    validation_commands: input.originalTask.validation_commands,
    max_attempts: input.config.max_attempts_per_task
  });
}
