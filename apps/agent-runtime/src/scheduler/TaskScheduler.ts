import type { TaskGraph, TaskNode } from "@orchcode/protocol";
import { FileLockManager } from "./FileLockManager.js";
import { getReadyTasks, markTask } from "./TaskGraph.js";

export type SchedulerEvent =
  | { type: "task.started"; task: TaskNode }
  | { type: "task.completed"; task: TaskNode }
  | { type: "task.blocked"; task: TaskNode; reason: string }
  | { type: "file_lock.acquired"; task: TaskNode; files: string[] }
  | { type: "file_lock.waiting"; task: TaskNode; files: string[]; conflict: { path: string; ownerTaskId: string } }
  | { type: "file_lock.released"; task: TaskNode; files: string[] };

export class TaskScheduler {
  readonly events: SchedulerEvent[] = [];

  constructor(
    private readonly graph: TaskGraph,
    private readonly locks: FileLockManager,
    private readonly maxParallelAgents = 3
  ) {}

  runAll(execute: (task: TaskNode) => void) {
    while (this.graph.nodes.some((node) => node.status === "pending")) {
      const ready = getReadyTasks(this.graph).slice(0, this.maxParallelAgents);
      if (!ready.length) {
        for (const node of this.graph.nodes.filter((candidate) => candidate.status === "pending")) {
          markTask(this.graph, node.id, "blocked");
          this.events.push({ type: "task.blocked", task: node, reason: "No dependency progress possible" });
        }
        break;
      }
      for (const task of ready) {
        const lockResult = this.locks.detectConflict(task.fileLocks)
          ? { acquired: false, conflict: this.locks.detectConflict(task.fileLocks) }
          : { acquired: true };
        if (!lockResult.acquired) {
          markTask(this.graph, task.id, "blocked");
          this.events.push({
            type: "task.blocked",
            task,
            reason: `File lock conflict on ${lockResult.conflict?.path}`
          });
          continue;
        }
        this.events.push({ type: "file_lock.acquired", task, files: task.fileLocks });
        markTask(this.graph, task.id, "running");
        this.events.push({ type: "task.started", task });
        execute(task);
        markTask(this.graph, task.id, "completed");
        this.events.push({ type: "task.completed", task });
        this.locks.releaseLocks(task.id);
        this.events.push({ type: "file_lock.released", task, files: task.fileLocks });
      }
    }
    return this.graph;
  }

  async runAllAsync(execute: (task: TaskNode, runningTaskIds: string[]) => void | Promise<void>) {
    const running = new Map<string, Promise<void>>();
    const launch = async (task: TaskNode) => {
      const lockResult = await this.locks.acquireLocks(task.id, task.fileLocks, {
        timeoutMs: 30_000,
        onWait: async (conflict) => {
          this.events.push({ type: "file_lock.waiting", task, files: task.fileLocks, conflict });
        }
      });
      if (!lockResult.acquired) {
        markTask(this.graph, task.id, "blocked");
        this.events.push({
          type: "task.blocked",
          task,
          reason: `File lock conflict on ${lockResult.conflict?.path}`
        });
        return;
      }
      this.events.push({ type: "file_lock.acquired", task, files: task.fileLocks });
      markTask(this.graph, task.id, "running");
      this.events.push({ type: "task.started", task });
      try {
        await execute(task, [...running.keys()]);
        markTask(this.graph, task.id, "completed");
        this.events.push({ type: "task.completed", task });
      } catch (error) {
        markTask(this.graph, task.id, "failed");
        this.events.push({ type: "task.blocked", task, reason: String(error) });
      } finally {
        this.locks.releaseLocks(task.id);
        this.events.push({ type: "file_lock.released", task, files: task.fileLocks });
      }
    };

    while (this.graph.nodes.some((node) => node.status === "pending") || running.size > 0) {
      const ready = getReadyTasks(this.graph).slice(0, Math.max(0, this.maxParallelAgents - running.size));
      if (!ready.length) {
        if (running.size) {
          await Promise.race(running.values());
          continue;
        }
        for (const node of this.graph.nodes.filter((candidate) => candidate.status === "pending")) {
          markTask(this.graph, node.id, "blocked");
          this.events.push({ type: "task.blocked", task: node, reason: "No dependency progress possible" });
        }
        break;
      }
      for (const task of ready) {
        const promise = launch(task).finally(() => running.delete(task.id));
        running.set(task.id, promise);
      }
      if (running.size) await Promise.race(running.values());
    }
    return this.graph;
  }
}
