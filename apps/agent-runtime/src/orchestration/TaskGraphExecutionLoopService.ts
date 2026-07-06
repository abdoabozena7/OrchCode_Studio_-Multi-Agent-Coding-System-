import { randomUUID } from "node:crypto";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { DurableLockManager } from "./DurableLockManager.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { OrchestratorEvent, ParsedAgentOutput, Run, Task } from "./OrchestrationModels.js";
import { getAgentRole } from "./RoleRegistry.js";
import type { TaskGraphManager } from "./TaskGraphManager.js";

export type TaskGraphExecutionLoopInput = {
  run: Run;
  manager: TaskGraphManager;
  lockManager: DurableLockManager;
  config: Pick<OrchestrationSafetyConfig, "lock_ttl_ms">;
  executeTask: (task: Task) => Promise<ParsedAgentOutput>;
  writeCheckpoint: (label: string, notes: string[]) => Promise<void>;
  createEvent: (
    runId: string,
    type: OrchestratorEvent["type"],
    message: string,
    payload?: Record<string, unknown>,
    taskId?: string
  ) => OrchestratorEvent;
};

export type TaskGraphExecutionLoopResult = {
  outputs: ParsedAgentOutput[];
  tasks: Task[];
};

export class TaskGraphExecutionLoopService {
  constructor(private readonly artifactStore: OrchestrationArtifactStore) {}

  async execute(input: TaskGraphExecutionLoopInput): Promise<TaskGraphExecutionLoopResult> {
    const outputs: ParsedAgentOutput[] = [];
    const { run, manager, lockManager } = input;

    while (manager.listTasks().some((task) => !["succeeded", "failed", "skipped"].includes(task.status))) {
      const ready = manager.getReadyTasks();
      if (!ready.length) {
        for (const task of manager.listTasks().filter((candidate) => candidate.status === "pending")) {
          await manager.markStatus(task.id, "blocked", "No dependency path is available.");
        }
        break;
      }

      for (const task of ready) {
        await manager.markStatus(task.id, "ready", "Task is dependency-ready.");
        const lockResult = await this.acquireTaskLocks(input, task);
        if (lockResult && !lockResult.acquired) {
          await this.artifactStore.appendEvent(input.createEvent(run.id, "lock.conflict", `Task ${task.id} is blocked by active file locks.`, {
            requested_paths: lockResult.requested_paths,
            conflicts: lockResult.conflicts
          }, task.id));
          await manager.markStatus(task.id, "blocked", "Task is blocked by active file locks.");
          continue;
        }

        if (lockResult?.locks.length) {
          const lockRef = await this.artifactStore.saveLockSnapshot(run.id, `${task.id}_acquired`, lockResult.locks);
          task.artifacts.push(lockRef);
          task.artifacts.push(...lockResult.artifact_refs);
          await this.artifactStore.appendEvent(input.createEvent(run.id, "lock.acquired", `Acquired ${lockResult.locks.length} file lock(s) for ${task.id}.`, {
            locks: lockResult.locks,
            lock_ref: lockRef
          }, task.id));
        }

        try {
          await manager.markStatus(task.id, "running", `Invoking ${task.role_required}.`);
          const output = await input.executeTask(task);
          outputs.push(output);
          task.result_summary = output.summary;
          task.artifacts.push(...output.artifacts);
          if (output.status === "succeeded") {
            await manager.markStatus(task.id, "succeeded", output.summary);
          } else if (output.status === "blocked") {
            await manager.markStatus(task.id, "blocked", output.summary);
          } else {
            await manager.markStatus(task.id, "failed", output.summary);
          }
          await input.writeCheckpoint(`task_${task.id}`, [`Task ${task.id} ended with ${output.status}.`]);
        } finally {
          if (lockResult?.locks.length) {
            const released = await lockManager.releaseByTask(task.id);
            const lockRef = await this.artifactStore.saveLockSnapshot(run.id, `${task.id}_released`, released);
            task.artifacts.push(lockRef);
            await this.artifactStore.appendEvent(input.createEvent(run.id, "lock.released", `Released ${released.length} file lock(s) for ${task.id}.`, {
              locks: released,
              lock_ref: lockRef
            }, task.id));
          }
        }
      }
    }

    return { outputs, tasks: manager.listTasks() };
  }

  private async acquireTaskLocks(input: TaskGraphExecutionLoopInput, task: Task) {
    const lockScopes = taskEditLockScopes(task);
    if (!lockScopes.length) return undefined;
    const semanticScopes = [
      ...input.lockManager.deriveModuleLocksForTask(task),
      ...input.lockManager.deriveSemanticLocksForTask(task)
    ];
    return input.lockManager.acquireLocks({
      request_id: `lock_request_${randomUUID()}`,
      run_id: input.run.id,
      task_id: task.id,
      owner_component: "CoreOrchestrator",
      scopes: [
        ...lockScopes.map((scope) => input.lockManager.normalizeLockScope(scope, "write")),
        ...semanticScopes
      ],
      ttl_ms: input.config.lock_ttl_ms,
      reason: `Acquire durable locks before invoking ${task.role_required}.`,
      metadata_json: {
        role_required: task.role_required,
        allowed_files_to_edit: task.allowed_files_to_edit
      }
    });
  }
}

function taskEditLockScopes(task: Task) {
  const role = getAgentRole(task.role_required);
  if (!role.can_edit_files) return [];
  if (isReadOnlyObjective(task.objective)) return [];
  return task.allowed_files_to_edit.length ? task.allowed_files_to_edit : ["."];
}

function isReadOnlyObjective(objective: string) {
  return /\b(explain|inspect|summarize|review|scan|do not change|read-only)\b/i.test(objective);
}
