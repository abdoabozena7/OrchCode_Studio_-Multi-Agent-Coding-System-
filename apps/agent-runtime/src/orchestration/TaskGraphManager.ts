import { randomUUID } from "node:crypto";
import { appendRunHistory } from "../memory/ProjectMemory.js";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestratorEvent, type Task, type TaskStatus } from "./OrchestrationModels.js";
import { assertValid, validateTask } from "./Validation.js";

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["ready", "blocked", "skipped"],
  ready: ["running", "blocked", "skipped"],
  running: ["succeeded", "failed", "blocked"],
  blocked: ["ready", "failed", "skipped"],
  succeeded: [],
  failed: [],
  skipped: []
};

export type CreateTaskInput = Omit<Task, "schema_version" | "status" | "attempt_count" | "artifacts" | "created_at" | "updated_at"> & {
  status?: TaskStatus;
  attempt_count?: number;
  artifacts?: string[];
};

export class TaskGraphManager {
  constructor(
    private readonly runId: string,
    private readonly workspacePath: string,
    private readonly artifactStore: OrchestrationArtifactStore,
    private readonly memoryDir?: string,
    private readonly tasks: Task[] = []
  ) {}

  listTasks() {
    return [...this.tasks];
  }

  createTask(input: CreateTaskInput): Task {
    const now = new Date().toISOString();
    const task: Task = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      status: input.status ?? "pending",
      attempt_count: input.attempt_count ?? 0,
      artifacts: input.artifacts ?? [],
      created_at: now,
      updated_at: now,
      ...input
    };
    assertValid("Task", task, validateTask);
    this.ensureUniqueTask(task.id);
    this.tasks.push(task);
    return task;
  }

  linkDependency(taskId: string, dependencyId: string) {
    const task = this.requireTask(taskId);
    this.requireTask(dependencyId);
    if (!task.dependencies.includes(dependencyId)) task.dependencies.push(dependencyId);
    this.assertAcyclic();
    task.updated_at = new Date().toISOString();
  }

  getReadyTasks() {
    return this.tasks.filter((task) => {
      if (task.status !== "pending" && task.status !== "ready") return false;
      return task.dependencies.every((dependency) => this.requireTask(dependency).status === "succeeded");
    });
  }

  async markStatus(taskId: string, nextStatus: TaskStatus, message?: string) {
    const task = this.requireTask(taskId);
    if (task.status === nextStatus) return task;
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`Invalid task transition ${task.status} -> ${nextStatus} for ${task.id}`);
    }
    const previousStatus = task.status;
    task.status = nextStatus;
    task.updated_at = new Date().toISOString();
    if (nextStatus === "running") task.attempt_count += 1;
    await this.persist();
    await this.artifactStore.appendEvent(this.event("task.status_changed", message ?? `Task ${task.id}: ${previousStatus} -> ${nextStatus}`, task.id, {
      previous_status: previousStatus,
      next_status: nextStatus
    }));
    const typedEvent = statusEventType(nextStatus);
    if (typedEvent) {
      await this.artifactStore.appendEvent(this.event(typedEvent, message ?? `Task ${task.id} is ${nextStatus}.`, task.id, {
        previous_status: previousStatus,
        next_status: nextStatus
      }));
    }
    await appendRunHistory(this.workspacePath, {
      task: task.title,
      status: nextStatus === "succeeded" ? "completed" : nextStatus === "failed" ? "failed" : nextStatus === "blocked" ? "blocked" : "noted",
      summary: message ?? `Task moved from ${previousStatus} to ${nextStatus}.`,
      relatedFiles: task.relevant_files,
      commands: task.validation_commands
    }, this.memoryDir);
    return task;
  }

  async persist() {
    await this.artifactStore.saveTasks(this.runId, this.tasks);
  }

  async recordCreatedEvents() {
    for (const task of this.tasks) {
      await this.artifactStore.appendEvent(this.event("task.created", `Task created: ${task.title}`, task.id, {
        role_required: task.role_required,
        dependencies: task.dependencies
      }));
    }
    await this.persist();
  }

  requireTask(taskId: string) {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private ensureUniqueTask(taskId: string) {
    if (this.tasks.some((task) => task.id === taskId)) throw new Error(`Duplicate task id: ${taskId}`);
  }

  private assertAcyclic() {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      if (visiting.has(taskId)) throw new Error(`Task dependency cycle detected at ${taskId}`);
      visiting.add(taskId);
      for (const dependency of this.requireTask(taskId).dependencies) visit(dependency);
      visiting.delete(taskId);
      visited.add(taskId);
    };
    for (const task of this.tasks) visit(task.id);
  }

  private event(type: OrchestratorEvent["type"], message: string, taskId?: string, payload?: Record<string, unknown>): OrchestratorEvent {
    return {
      id: `event_${randomUUID()}`,
      run_id: this.runId,
      task_id: taskId,
      type,
      message,
      created_at: new Date().toISOString(),
      payload
    };
  }
}

function statusEventType(status: TaskStatus): OrchestratorEvent["type"] | undefined {
  if (status === "ready") return "task.ready";
  if (status === "running") return "task.started";
  if (status === "succeeded") return "task.succeeded";
  if (status === "failed") return "task.failed";
  if (status === "blocked") return "task.blocked";
  return undefined;
}
