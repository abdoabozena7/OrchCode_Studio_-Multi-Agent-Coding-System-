import type { TaskGraph, TaskNode } from "@orchcode/protocol";
import { FileLockManager } from "./FileLockManager.js";
import { getReadyTasks, markTask } from "./TaskGraph.js";

export type SchedulerEvent =
  | { type: "task.started"; task: TaskNode }
  | { type: "task.completed"; task: TaskNode }
  | { type: "task.blocked"; task: TaskNode; reason: string }
  | { type: "file_lock.acquired"; task: TaskNode; files: string[] }
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
        const lockResult = this.locks.acquireLocks(task.id, task.fileLocks);
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
}
