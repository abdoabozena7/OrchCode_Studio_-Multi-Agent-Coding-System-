import path from "node:path";
import type { TaskGraph, TaskNode } from "@hivo/protocol";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { SqliteTaskQueueBackend } from "./AgentTaskQueue.js";
import type { QueueJobPriority } from "./TaskQueueTypes.js";
import { SuspendHydrateManager, suspendOrchestrator, resumeOrchestrator } from "./SuspendHydrateManager.js";
import { AgentCircuitBreaker } from "./CircuitBreaker.js";
import type { BranchBankruptcyError, CircuitBreakerConfig } from "./CircuitBreaker.js";
import { OrchestrationFileLockManager } from "./FileLockManager.js";

export type QueueDrivenTaskConfig = {
  queueDir: string;
  workspacePath?: string;
  sessionId: string;
  orchestratorName: string;
  maxParallelTasks: number;
  taskQueuePollMs: number;
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
};

export type QueueDrivenTaskState = {
  taskGraph: TaskGraph;
  pendingJobIds: string[];
  scheduledTaskIds: string[];
  completedJobIds: string[];
  failedJobs: Array<{ jobId: string; error: string }>;
  failureReasons: string[];
  bankruptcyErrors: BranchBankruptcyError[];
  currentPhase: string;
};

export enum QueueDrivenTaskEventType {
  TASK_ENQUEUED = "task.enqueued",
  TASK_DEQUEUED = "task.dequeued",
  TASK_COMPLETED = "task.completed",
  TASK_FAILED = "task.failed",
  TASK_BANKRUPT = "task.bankrupt",
  PHASE_SUSPEND = "phase.suspend",
  PHASE_RESUME = "phase.resume",
  PHASE_COMPLETED = "phase.completed",
}

export type QueueDrivenTaskEvent = {
  type: QueueDrivenTaskEventType;
  taskId?: string;
  jobId?: string;
  agentName?: string;
  message: string;
  timestamp: string;
};

export type TaskExecutionHandler = (task: TaskNode) => Promise<{
  status: "completed" | "failed";
  outputSummary: string;
  error?: string;
  fingerprint?: string;
}>;

export class QueueDrivenTaskScheduler {
  readonly events: QueueDrivenTaskEvent[] = [];
  private readonly queue: SqliteTaskQueueBackend;
  private readonly suspendManager: SuspendHydrateManager;
  private readonly lockManager: OrchestrationFileLockManager;
  private readonly circuitBreakers: Map<string, AgentCircuitBreaker> = new Map();
  private readonly state: QueueDrivenTaskState;

  constructor(
    private readonly config: QueueDrivenTaskConfig,
    private readonly safetyConfig: Pick<OrchestrationSafetyConfig,
      | "enable_task_queue"
      | "enable_suspend_hydrate"
      | "enable_circuit_breaker"
      | "task_queue_max_attempts"
      | "max_bankruptcy_attempts"
      | "max_circuit_breaker_duplicate_outputs"
      | "max_circuit_breaker_stagnant_rounds"
    >
  ) {
    this.queue = new SqliteTaskQueueBackend(this.config.queueDir);
    this.suspendManager = new SuspendHydrateManager(this.config.queueDir);
    this.lockManager = new OrchestrationFileLockManager(this.config.workspacePath ?? inferWorkspacePathFromQueueDir(this.config.queueDir));
    this.state = {
      taskGraph: { sessionId: config.sessionId, nodes: [], edges: [] },
      pendingJobIds: [],
      scheduledTaskIds: [],
      completedJobIds: [],
      failedJobs: [],
      failureReasons: [],
      bankruptcyErrors: [],
      currentPhase: "initialized"
    };
  }

  private getOrCreateBreaker(task: TaskNode): AgentCircuitBreaker {
    const key = `${task.assignedAgent}:${task.id}`;
    if (!this.circuitBreakers.has(key)) {
      this.circuitBreakers.set(key, new AgentCircuitBreaker(
        task.id,
        task.assignedAgent,
        {
          max_bankruptcy_attempts: this.safetyConfig.max_bankruptcy_attempts,
          max_repair_rounds: this.config.maxParallelTasks,
          max_duplicate_outputs: this.safetyConfig.max_circuit_breaker_duplicate_outputs,
          max_stagnant_rounds: this.safetyConfig.max_circuit_breaker_stagnant_rounds,
          stagnation_window_ms: 120_000,
          fingerprint_similarity_threshold: 0.85
        }
      ));
    }
    return this.circuitBreakers.get(key)!;
  }

  checkCircuitBreakers(): BranchBankruptcyError[] {
    const errors: BranchBankruptcyError[] = [];
    for (const breaker of this.circuitBreakers.values()) {
      const bankruptcy = breaker.checkBankruptcy();
      if (bankruptcy) {
        errors.push(bankruptcy);
        this.state.bankruptcyErrors.push(bankruptcy);
        this.emitEvent(QueueDrivenTaskEventType.TASK_BANKRUPT, bankruptcy.branch_id, undefined, bankruptcy.agent_name, bankruptcy.last_error);
      }
    }
    return errors;
  }

  async enqueueTasks(tasks: TaskNode[], priority: QueueJobPriority = 3): Promise<string[]> {
    const jobIds: string[] = [];
    for (const task of tasks) {
      if (this.state.scheduledTaskIds.includes(task.id)) continue;
      const jobId = await this.queue.enqueue({
        queue_name: `orchestrated:${this.config.sessionId}`,
        job_type: "agent_task",
        payload: { task, sessionId: this.config.sessionId },
        priority,
        max_attempts: this.safetyConfig.task_queue_max_attempts
      });
      jobIds.push(jobId);
      this.state.scheduledTaskIds.push(task.id);
      this.state.pendingJobIds.push(jobId);
      this.emitEvent(QueueDrivenTaskEventType.TASK_ENQUEUED, task.id, jobId, task.assignedAgent, `Enqueued: ${task.title}`);
    }
    return jobIds;
  }

  async executeViaQueue(
    taskGraph: TaskGraph,
    handler: TaskExecutionHandler
  ): Promise<{ completed: number; failed: number; bankruptcyErrors: BranchBankruptcyError[] }> {
    this.state.taskGraph = taskGraph;
    this.state.currentPhase = "dispatching";
    const jobIds = await this.enqueueReadyTasks(taskGraph);

    if (this.safetyConfig.enable_suspend_hydrate && jobIds.length > 0) {
      const snapshotId = await suspendOrchestrator(this.suspendManager, {
        sessionId: this.config.sessionId,
        orchestratorName: this.config.orchestratorName,
        phase: "awaiting_task_completion",
        state: this.state,
        context: { config: this.config },
        pendingJobIds: jobIds
      });
      this.state.currentPhase = "suspended";
      this.emitEvent(QueueDrivenTaskEventType.PHASE_SUSPEND, undefined, undefined, undefined, `Suspended with snapshot ${snapshotId}, awaiting ${jobIds.length} tasks`);
    }

    let completed = 0;
    let failed = 0;

    while (this.state.pendingJobIds.length > 0) {
      const bankruptcyErrors = this.checkCircuitBreakers();
      if (bankruptcyErrors.length > 0) {
        for (const err of bankruptcyErrors) {
          const idx = this.state.pendingJobIds.findIndex((jid) => jid === err.branch_id);
          if (idx !== -1) {
            this.state.pendingJobIds.splice(idx, 1);
            this.state.failedJobs.push({ jobId: err.branch_id, error: err.last_error });
            failed += 1;
          }
        }
        continue;
      }

      const dequeued = await this.queue.dequeue(
        `orchestrated:${this.config.sessionId}`,
        this.config.taskQueuePollMs
      );

      if (!dequeued) {
        if (this.state.pendingJobIds.length === 0) break;
        await this.sleep(this.config.taskQueuePollMs);
        continue;
      }

      const task = (JSON.parse(dequeued.job.payload_json) as { task: TaskNode }).task;
      this.emitEvent(QueueDrivenTaskEventType.TASK_DEQUEUED, task.id, dequeued.job.id, task.assignedAgent, `Dequeued: ${task.title}`);
      this.markTaskCompleted(taskGraph, task.id, "running");

      try {
        const lockResult = this.lockManager.acquire(this.config.sessionId, task.id, task.fileLocks);
        if (!lockResult.acquired) {
          this.recordFailureReason("File lock conflict");
          const status = await this.queue.nack(dequeued.job.id, dequeued.lease_id, "File lock conflict");
          if (status === "dead_letter") {
            this.recordDeadLetteredTask(taskGraph, task, dequeued.job.id, "File lock conflict");
            failed += 1;
          }
          continue;
        }

        let result: Awaited<ReturnType<TaskExecutionHandler>>;
        try {
          result = await handler(task);
        } finally {
          this.lockManager.releaseByTask(task.id);
        }

        if (result.status === "completed") {
          await this.queue.ack(dequeued.job.id, dequeued.lease_id);
          this.markTaskCompleted(taskGraph, task.id, "completed");
          completed += 1;
          this.state.completedJobIds.push(dequeued.job.id);
          this.state.pendingJobIds = this.state.pendingJobIds.filter((id) => id !== dequeued.job.id);
          this.emitEvent(QueueDrivenTaskEventType.TASK_COMPLETED, task.id, dequeued.job.id, task.assignedAgent, `Completed: ${task.title}`);

          const breaker = this.getOrCreateBreaker(task);
          if (result.fingerprint) breaker.recordAttempt(result.fingerprint, "", result.outputSummary);
          breaker.recordProgress();

          await this.enqueueReadyTasks(taskGraph);
          this.checkpoint();
        } else {
          const breaker = this.getOrCreateBreaker(task);
          this.recordFailureReason(result.error ?? result.outputSummary);
          const fingerprint = result.fingerprint ?? AgentCircuitBreaker.createFingerprint(result.outputSummary);
          breaker.recordAttempt(fingerprint, result.error ?? "Unknown failure", result.outputSummary);
          breaker.recordStagnantRound();

          const bankruptcy = breaker.checkBankruptcy();
          if (bankruptcy) {
            await this.queue.deadLetter(dequeued.job.id, dequeued.lease_id, bankruptcy.last_error);
            this.state.bankruptcyErrors.push(bankruptcy);
            this.state.failedJobs.push({ jobId: dequeued.job.id, error: bankruptcy.last_error });
            failed += 1;
            this.state.pendingJobIds = this.state.pendingJobIds.filter((id) => id !== dequeued.job.id);
            this.markTaskCompleted(taskGraph, task.id, "failed");
            this.emitEvent(QueueDrivenTaskEventType.TASK_BANKRUPT, task.id, dequeued.job.id, task.assignedAgent, bankruptcy.last_error);
            await this.enqueueReadyTasks(taskGraph);
          } else {
            const status = await this.queue.nack(dequeued.job.id, dequeued.lease_id, result.error);
            if (status === "dead_letter") {
              this.recordDeadLetteredTask(taskGraph, task, dequeued.job.id, result.error ?? "Task failed and exhausted queue attempts");
              failed += 1;
              await this.enqueueReadyTasks(taskGraph);
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.recordFailureReason(errorMessage);
        const status = await this.queue.nack(dequeued.job.id, dequeued.lease_id, errorMessage);
        if (status === "dead_letter") {
          this.recordDeadLetteredTask(taskGraph, task, dequeued.job.id, errorMessage);
          failed += 1;
          await this.enqueueReadyTasks(taskGraph);
        } else {
          this.markTaskCompleted(taskGraph, task.id, "pending");
          this.emitEvent(QueueDrivenTaskEventType.TASK_FAILED, task.id, dequeued.job.id, task.assignedAgent, errorMessage);
        }
      }
    }

    const unresolved = this.blockUnresolvedPendingTasks(taskGraph);
    failed += unresolved;
    this.state.currentPhase = "completed";
    this.emitEvent(QueueDrivenTaskEventType.PHASE_COMPLETED, undefined, undefined, undefined, `Completed: ${completed} succeeded, ${failed} failed, ${this.state.bankruptcyErrors.length} bankruptcies`);
    return { completed, failed, bankruptcyErrors: this.state.bankruptcyErrors };
  }

  async resumeFromSnapshot(snapshotId: string): Promise<QueueDrivenTaskState> {
    const context = await resumeOrchestrator<QueueDrivenTaskState, { config: QueueDrivenTaskConfig }>(
      this.suspendManager,
      snapshotId
    );
    Object.assign(this.state, context.state);

    this.emitEvent(QueueDrivenTaskEventType.PHASE_RESUME, undefined, undefined, undefined,
      `Resumed snapshot ${snapshotId} with ${this.state.pendingJobIds.length} pending jobs`
    );
    return this.state;
  }

  private async checkpoint(): Promise<void> {
    if (!this.safetyConfig.enable_suspend_hydrate) return;
    await this.suspendManager.saveCheckpoint({
      sessionId: this.config.sessionId,
      orchestratorName: this.config.orchestratorName,
      phase: this.state.currentPhase,
      state: this.state,
      context: { config: this.config },
      pendingJobIds: this.state.pendingJobIds
    });
  }

  private getReadyTasks(graph: TaskGraph): TaskNode[] {
    return graph.nodes.filter((node) => {
      if (node.status !== "pending") return false;
      if (this.state.scheduledTaskIds.includes(node.id)) return false;
      return node.dependsOn.every((depId) => {
        const dep = graph.nodes.find((n) => n.id === depId);
        return dep?.status === "completed";
      });
    }).slice(0, this.config.maxParallelTasks);
  }

  private async enqueueReadyTasks(graph: TaskGraph) {
    const availableSlots = Math.max(0, this.config.maxParallelTasks - this.state.pendingJobIds.length);
    if (availableSlots === 0) return [];
    return this.enqueueTasks(this.getReadyTasks(graph).slice(0, availableSlots));
  }

  private markTaskCompleted(graph: TaskGraph, taskId: string, status: TaskNode["status"]) {
    const node = graph.nodes.find((n) => n.id === taskId);
    if (node) node.status = status;
  }

  private recordDeadLetteredTask(taskGraph: TaskGraph, task: TaskNode, jobId: string, reason: string) {
    this.markTaskCompleted(taskGraph, task.id, "failed");
    this.state.failedJobs.push({ jobId, error: reason });
    this.state.pendingJobIds = this.state.pendingJobIds.filter((id) => id !== jobId);
    this.emitEvent(QueueDrivenTaskEventType.TASK_FAILED, task.id, jobId, task.assignedAgent, reason);
  }

  private blockUnresolvedPendingTasks(taskGraph: TaskGraph) {
    let blocked = 0;
    for (const task of taskGraph.nodes) {
      if (task.status !== "pending") continue;
      const missingDependencies = task.dependsOn.filter((dependency) => {
        const dep = taskGraph.nodes.find((node) => node.id === dependency);
        return dep?.status !== "completed";
      });
      const reason = missingDependencies.length
        ? `Unresolved task dependencies: ${missingDependencies.join(", ")}`
        : "Task was not scheduled before the queue completed.";
      this.markTaskCompleted(taskGraph, task.id, "blocked");
      this.recordFailureReason(reason);
      this.state.failedJobs.push({ jobId: task.id, error: reason });
      this.emitEvent(QueueDrivenTaskEventType.TASK_FAILED, task.id, undefined, task.assignedAgent, reason);
      blocked += 1;
    }
    return blocked;
  }

  private emitEvent(type: QueueDrivenTaskEventType, taskId?: string, jobId?: string, agentName?: string, message?: string) {
    this.events.push({
      type,
      taskId,
      jobId,
      agentName,
      message: message ?? type,
      timestamp: new Date().toISOString()
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  close() {
    this.queue.close();
    this.suspendManager.close();
  }

  lockSnapshot(): Record<string, string> {
    return Object.fromEntries(this.lockManager.snapshot().map((lock) => [lock.path, lock.owner_task_id]));
  }

  failureReasons(): string[] {
    return [...new Set([
      ...(this.state.failureReasons ?? []),
      ...this.state.failedJobs.map((job) => job.error)
    ].filter(Boolean))];
  }

  private recordFailureReason(reason: string | undefined) {
    const trimmed = reason?.trim();
    if (!trimmed) return;
    (this.state.failureReasons ??= []).push(trimmed);
  }
}

function inferWorkspacePathFromQueueDir(queueDir: string) {
  return path.basename(queueDir) === ".agent_memory" ? path.dirname(queueDir) : queueDir;
}
