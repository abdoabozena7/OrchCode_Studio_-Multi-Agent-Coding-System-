import { randomUUID } from "node:crypto";
import { availableParallelism, cpus, loadavg } from "node:os";
import type { LockAcquisitionResult } from "./FactoryLockModels.js";
import type { FileLockRecord, LockAcquireResult } from "./FileLockManager.js";
import type { SwarmArtifactStore } from "./SwarmArtifactStore.js";
import type {
  AgentInstance,
  AgentTemplate,
  SchedulerTraceEntry,
  StaffingPlan,
  SwarmEvent,
  SwarmMetrics,
  SwarmRun,
  WorkItem,
  WorkItemResult
} from "./SwarmModels.js";
import { SWARM_SCHEMA_VERSION } from "./SwarmModels.js";
import { IntentHandoffGate, intentGateBlockedWorkItemResult } from "./IntentHandoffGate.js";

export type SwarmWorker = (input: {
  workItem: WorkItem;
  agent: AgentInstance;
  template: AgentTemplate;
  run: SwarmRun;
  staffingPlan: StaffingPlan;
}) => Promise<WorkItemResult>;

export type SwarmSchedulerResult = {
  workItems: WorkItem[];
  agentInstances: AgentInstance[];
  metrics: SwarmMetrics;
};

export type SchedulerLockManager = {
  acquire(runId: string, taskId: string, requestedScopes: string[]): LockAcquireResult | Promise<LockAcquireResult | LockAcquisitionResult>;
  releaseByTask(taskId: string): FileLockRecord[] | Promise<unknown[]>;
};

export type SchedulerResourceSnapshot = {
  available_parallelism: number;
  load_average_1m?: number;
  cpu_pressure?: number;
  recommended_parallelism?: number;
  reason?: string;
};

export type SchedulerResourceMonitor = (input: {
  run: SwarmRun;
  staffingPlan: StaffingPlan;
  readyCount: number;
  tick: number;
  currentParallelLimit: number;
  currentExecutorLimit: number;
}) => SchedulerResourceSnapshot | Promise<SchedulerResourceSnapshot>;

export type SwarmSchedulerOptions = {
  resourceMonitor?: SchedulerResourceMonitor;
  now?: () => number;
};

type SelectedWorkItem = { workItem: WorkItem; agent: AgentInstance; template: AgentTemplate };

export class SwarmScheduler {
  private tick = 0;
  private lockWaitCount = 0;
  private retryCount = 0;
  private repairTasks = 0;
  private invalidStructuredOutputs = 0;
  private conflictsDetected = 0;
  private approvalGatesTriggered = 0;
  private peakActiveAgents = 0;
  private executorPeakCount = 0;
  private reviewerPeakCount = 0;
  private scoutPeakCount = 0;
  private currentParallelLimit: number;
  private currentExecutorLimit: number;
  private minimumExecutorLimit = 0;
  private parallelBackpressure = 0;
  private executorBackpressure = 0;
  private healthyBatchStreak = 0;
  private readonly deferralAging = new Map<string, number>();
  private readonly resourceMonitor: SchedulerResourceMonitor;
  private readonly now: () => number;

  constructor(
    private readonly workspacePath: string,
    private readonly artifactStore: SwarmArtifactStore,
    private readonly lockManager: SchedulerLockManager,
    private readonly worker: SwarmWorker = providerRequiredWorker,
    options: SwarmSchedulerOptions = {}
  ) {
    this.currentParallelLimit = 1;
    this.currentExecutorLimit = 0;
    this.resourceMonitor = options.resourceMonitor ?? defaultSchedulerResourceMonitor;
    this.now = options.now ?? Date.now;
  }

  async run(input: {
    run: SwarmRun;
    staffingPlan: StaffingPlan;
    agentTemplates: AgentTemplate[];
    agentInstances: AgentInstance[];
    workItems: WorkItem[];
  }): Promise<SwarmSchedulerResult> {
    this.resetRunState(input.run, input.staffingPlan);
    const workItems = input.workItems;
    const agentInstances = input.agentInstances;
    await this.persist(input.run.id, workItems, agentInstances);

    while (hasOpenWork(workItems)) {
      this.tick += 1;
      const ready = readyWorkItems(workItems);
      if (!ready.length) {
        const openQueued = workItems.filter((item) => item.status === "queued" || item.status === "ready");
        for (const item of openQueued) {
          item.status = "blocked";
          item.updated_at = new Date().toISOString();
          await this.event(input.run.id, "swarm.work_item.failed", `Work item ${item.id} blocked because dependencies cannot be satisfied.`, {
            dependencies: item.dependencies
          }, item.id);
        }
        break;
      }

      const resourceSnapshot = await this.resourceMonitor({
        run: input.run,
        staffingPlan: input.staffingPlan,
        readyCount: ready.length,
        tick: this.tick,
        currentParallelLimit: this.currentParallelLimit,
        currentExecutorLimit: this.currentExecutorLimit
      });
      await this.updateAdaptiveLimits(input.run, input.staffingPlan, ready.length, resourceSnapshot);
      const selection = this.selectBatch({
        ready,
        staffingPlan: input.staffingPlan,
        agentInstances,
        agentTemplates: input.agentTemplates,
        parallelLimit: this.currentParallelLimit
      });
      await this.trace(input.run.id, {
        decision: selection.selected.length ? "selected_ready_batch" : "deferred_ready_batch",
        reasoning: selection.reasoning,
        selected_work_items: selection.selected.map((entry) => entry.workItem.id),
        deferred_work_items: selection.deferred,
        active_agent_count: selection.selected.length,
        executor_concurrency: this.currentExecutorLimit,
        parallel_limit: this.currentParallelLimit,
        queue_depth: ready.length,
        resource_snapshot: resourceSnapshot,
        aging_deferrals: selection.agingDeferrals,
        selected_role_distribution: roleDistributionForWorkItems(selection.selected.map((entry) => entry.workItem)),
        deferred_count_by_reason: countDeferredReasons(selection.deferred),
        parallel_backpressure: this.parallelBackpressure,
        executor_backpressure: this.executorBackpressure
      });

      if (!selection.selected.length) {
        for (const deferred of selection.deferred) {
          const item = workItems.find((candidate) => candidate.id === deferred.id);
          if (!item) continue;
          item.status = "blocked";
          item.updated_at = new Date().toISOString();
          await this.event(input.run.id, "swarm.work_item.failed", `Work item ${item.id} blocked: ${deferred.reason}`, {}, item.id);
        }
        break;
      }

      this.recordPeaks(selection.selected.map((entry) => entry.workItem));
      const batchStartedAt = this.now();
      const results = await Promise.all(selection.selected.map((selected) =>
        this.executeSelected({
          run: input.run,
          staffingPlan: input.staffingPlan,
          workItems,
          agentInstances,
          agentTemplates: input.agentTemplates,
          workItem: selected.workItem,
          agent: selected.agent,
          template: selected.template
        })
      ));
      await this.recordBatchHealth(input.run.id, results, this.now() - batchStartedAt);
      await this.persist(input.run.id, workItems, agentInstances);
    }

    const metrics = this.computeMetrics(input.run, input.staffingPlan, agentInstances, workItems);
    await this.artifactStore.saveMetrics(input.run.id, metrics);
    return { workItems, agentInstances, metrics };
  }

  private selectBatch(input: {
    ready: WorkItem[];
    staffingPlan: StaffingPlan;
    agentInstances: AgentInstance[];
    agentTemplates: AgentTemplate[];
    parallelLimit: number;
  }) {
    const selected: SelectedWorkItem[] = [];
    const deferred: Array<{ id: string; reason: string }> = [];
    const maxParallel = Math.max(1, input.parallelLimit);
    const activeRoleCounts: Record<string, number> = {};
    const batchWriteFiles = new Set<string>();
    const reservedAgentIds = new Set<string>();
    const orderedReady = [...input.ready].sort((left, right) =>
      this.effectivePriority(left) - this.effectivePriority(right)
      || left.priority - right.priority
      || left.id.localeCompare(right.id)
    );

    for (const workItem of orderedReady) {
      if (selected.length >= maxParallel) {
        deferred.push({ id: workItem.id, reason: `parallel limit ${maxParallel} reached` });
        continue;
      }
      if (isForbiddenWrite(workItem)) {
        deferred.push({ id: workItem.id, reason: "forbidden write path requested" });
        continue;
      }
      const template = findTemplate(input.agentTemplates, workItem.required_role, workItem.type);
      if (!template) {
        deferred.push({ id: workItem.id, reason: `no template for role ${workItem.required_role}` });
        continue;
      }
      const roleLimit = this.roleLimit(input.staffingPlan, workItem.required_role, workItem.type);
      if ((activeRoleCounts[workItem.required_role] ?? 0) >= roleLimit) {
        deferred.push({ id: workItem.id, reason: `role limit ${roleLimit} reached for ${workItem.required_role}` });
        continue;
      }
      if (workItem.type === "execute" && activeTypeCount(selected, "execute") >= this.currentExecutorLimit) {
        deferred.push({ id: workItem.id, reason: `executor limit ${this.currentExecutorLimit} reached` });
        continue;
      }
      if (isWriteWork(workItem)) {
        const overlap = workItem.write_files.find((file) => batchWriteFiles.has(file));
        if (overlap) {
          this.conflictsDetected += 1;
          deferred.push({ id: workItem.id, reason: `batch write conflict on ${overlap}` });
          continue;
        }
      }
      const agent = findIdleAgent(input.agentInstances, workItem.required_role, reservedAgentIds);
      if (!agent) {
        deferred.push({ id: workItem.id, reason: `no idle ${workItem.required_role} instance` });
        continue;
      }
      selected.push({ workItem, agent, template });
      reservedAgentIds.add(agent.id);
      activeRoleCounts[workItem.required_role] = (activeRoleCounts[workItem.required_role] ?? 0) + 1;
      for (const file of workItem.write_files) batchWriteFiles.add(file);
    }

    this.recordAging(selected, deferred);
    return {
      selected,
      deferred,
      agingDeferrals: agingSnapshot(this.deferralAging, orderedReady),
      reasoning: selected.length
        ? `Selected ${selected.length} work item(s) using dependency readiness, adaptive parallel limit ${maxParallel}, priority aging, role limits, executor cap ${this.currentExecutorLimit}, and file-lock prechecks.`
        : `No ready work item could be selected; ${deferred.length} item(s) were deferred by safety or capacity constraints.`
    };
  }

  private async executeSelected(input: {
    run: SwarmRun;
    staffingPlan: StaffingPlan;
    workItems: WorkItem[];
    agentInstances: AgentInstance[];
    agentTemplates: AgentTemplate[];
    workItem: WorkItem;
    agent: AgentInstance;
    template: AgentTemplate;
  }): Promise<WorkItemResult> {
    const leaseId = `lease_${randomUUID()}`;
    input.workItem.status = "leased";
    input.workItem.lease_id = leaseId;
    input.workItem.updated_at = new Date().toISOString();
    input.agent.status = "leased";
    input.agent.current_work_item_id = input.workItem.id;
    input.agent.lease_id = leaseId;
    input.agent.last_heartbeat_at = new Date().toISOString();
    await this.event(input.run.id, "swarm.work_item.leased", `Leased ${input.workItem.id} to ${input.agent.id}.`, {
      agent_id: input.agent.id,
      role: input.agent.role,
      lease_id: leaseId
    }, input.workItem.id);

    let acquired = false;
    if (isWriteWork(input.workItem)) {
      await this.event(input.run.id, "swarm.lock.requested", `Requesting write locks for ${input.workItem.id}.`, {
        write_files: input.workItem.write_files
      }, input.workItem.id);
      const lock = await this.lockManager.acquire(input.run.id, input.workItem.id, input.workItem.write_files);
      if (!lock.acquired) {
        this.lockWaitCount += 1;
        this.conflictsDetected += lock.conflicts.length;
        input.workItem.status = "blocked";
        input.workItem.updated_at = new Date().toISOString();
        await this.event(input.run.id, "swarm.lock.denied", `Write lock denied for ${input.workItem.id}.`, {
          requested_paths: lock.requested_paths,
          conflicts: lock.conflicts
        }, input.workItem.id);
        releaseAgent(input.agent);
        return {
          schema_version: SWARM_SCHEMA_VERSION,
          work_item_id: input.workItem.id,
          status: "blocked",
          summary: `Write lock denied for ${input.workItem.id}.`,
          relevant_files: input.workItem.read_files.filter((file) => !looksLikeCommand(file)),
          findings: [],
          risks: ["write_lock_denied"],
          unknowns: [],
          structured_output_valid: true,
          confidence: 0.2
        };
      }
      acquired = true;
      await this.event(input.run.id, "swarm.lock.acquired", `Write locks acquired for ${input.workItem.id}.`, {
        locks: lock.locks
      }, input.workItem.id);
    }

    input.workItem.status = "running";
    input.workItem.attempt_count += 1;
    input.workItem.updated_at = new Date().toISOString();
    input.agent.status = "running";
    input.agent.last_heartbeat_at = new Date().toISOString();
    await this.event(input.run.id, "swarm.work_item.started", `Started ${input.workItem.id} with ${input.agent.role}.`, {
      attempt_count: input.workItem.attempt_count
    }, input.workItem.id);
    if (input.workItem.type === "execute") {
      await this.event(input.run.id, "swarm.executor.patch_proposed", `Executor started with planned write targets for ${input.workItem.id}; no patch has been accepted or applied yet.`, {
        write_files: input.workItem.write_files,
        planned_only: true,
        patch_accepted: false,
        patch_applied: false
      }, input.workItem.id);
    }
    if (input.workItem.type === "test") {
      await this.event(input.run.id, "swarm.validation.started", `Validation started for ${input.workItem.id}.`, {
        commands: input.workItem.read_files
      }, input.workItem.id);
    }

    try {
      const invoked = await this.invokeWorker(input);
      const result = await this.applyIntentHandoffGate(input, invoked);
      const resultRef = await this.artifactStore.saveWorkItemResult(input.run.id, result, input.workItem.required_role, input.workItem.type);
      input.workItem.result_ref = resultRef;
      await this.handleResult(input, result);
      return result;
    } finally {
      if (acquired) await this.lockManager.releaseByTask(input.workItem.id);
      releaseAgent(input.agent);
    }
  }

  private async invokeWorker(input: {
    run: SwarmRun;
    staffingPlan: StaffingPlan;
    workItem: WorkItem;
    agent: AgentInstance;
    template: AgentTemplate;
  }): Promise<WorkItemResult> {
    try {
      return await this.worker({
        workItem: input.workItem,
        agent: input.agent,
        template: input.template,
        run: input.run,
        staffingPlan: input.staffingPlan
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.event(input.run.id, "swarm.work_item.failed", `Worker exception in ${input.workItem.id}: ${message}`, {
        exception: message
      }, input.workItem.id);
      return {
        schema_version: SWARM_SCHEMA_VERSION,
        work_item_id: input.workItem.id,
        status: "failed",
        summary: `Worker exception: ${message}`,
        relevant_files: input.workItem.read_files.filter((file) => !looksLikeCommand(file)),
        findings: [],
        risks: ["worker_exception"],
        unknowns: [],
        structured_output_valid: false,
        confidence: 0
      };
    }
  }

  private async applyIntentHandoffGate(input: {
    run: SwarmRun;
    staffingPlan: StaffingPlan;
    workItems: WorkItem[];
    agentInstances: AgentInstance[];
    agentTemplates: AgentTemplate[];
    workItem: WorkItem;
    agent: AgentInstance;
    template: AgentTemplate;
  }, result: WorkItemResult): Promise<WorkItemResult> {
    if (result.status !== "succeeded") return result;
    if (result.intent_handoff_gate_status === "passed" && result.intent_handoff_gate_ref) return result;
    try {
      const gateService = new IntentHandoffGate({
        workspacePath: this.workspacePath,
        sourceComponent: "SwarmScheduler"
      });
      const frame = await gateService.swarmFrame(input.run, input.workItem);
      const gate = await gateService.evaluate({
        runId: input.run.id,
        runKind: "swarm",
        artifactsPath: input.run.artifacts_path,
        layer: "swarm",
        taskId: input.workItem.id,
        frame,
        alignment: result.intent_alignment,
        candidate: result,
        reviewedArtifactRefs: [input.workItem.result_ref ?? ""],
        target: "output"
      });
      if (gate.passed) {
        return {
          ...result,
          intent_handoff_gate_ref: gate.artifact_ref,
          intent_handoff_gate_status: gate.status
        };
      }
      return intentGateBlockedWorkItemResult(result, gate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...result,
        status: "blocked",
        structured_output_valid: false,
        risks: uniqueStrings([...result.risks, `Intent handoff gate could not run: ${message}`])
      };
    }
  }

  private async handleResult(input: {
    run: SwarmRun;
    staffingPlan: StaffingPlan;
    workItems: WorkItem[];
    agentInstances: AgentInstance[];
    agentTemplates: AgentTemplate[];
    workItem: WorkItem;
    agent: AgentInstance;
    template: AgentTemplate;
  }, result: WorkItemResult) {
    if (!result.structured_output_valid) {
      this.invalidStructuredOutputs += 1;
      await this.event(input.run.id, "swarm.output_validation.failed", `Structured output validation failed for ${input.workItem.id}.`, {
        result_ref: input.workItem.result_ref,
        attempt_count: input.workItem.attempt_count
      }, input.workItem.id);
      if (input.workItem.attempt_count < input.workItem.max_attempts) {
        this.retryCount += 1;
        input.workItem.status = "queued";
        input.workItem.updated_at = new Date().toISOString();
        await this.reduceConcurrency(input.run.id, "Invalid structured output triggered retry and executor backpressure.");
        return;
      }
    }

    if (result.status === "succeeded" && result.structured_output_valid) {
      input.workItem.status = "succeeded";
      input.agent.completed_work_item_count += 1;
      await this.event(input.run.id, "swarm.work_item.succeeded", `Work item ${input.workItem.id} succeeded.`, {
        result_ref: input.workItem.result_ref,
        confidence: result.confidence
      }, input.workItem.id);
      if (input.workItem.type === "execute") {
        await this.event(input.run.id, "swarm.patch.accepted", `Scoped patch proposal accepted for review flow: ${input.workItem.id}.`, {
          write_files: input.workItem.write_files
        }, input.workItem.id);
      }
      if (input.workItem.type === "test") {
        await this.event(input.run.id, "swarm.validation.completed", `Validation completed for ${input.workItem.id}.`, {
          passed: result.validation_passed !== false
        }, input.workItem.id);
      }
      input.workItem.updated_at = new Date().toISOString();
      return;
    }

    input.agent.failure_count += 1;
    if (input.workItem.attempt_count < input.workItem.max_attempts && result.structured_output_valid) {
      this.retryCount += 1;
      input.workItem.status = "queued";
      input.workItem.updated_at = new Date().toISOString();
      await this.reduceConcurrency(input.run.id, `Failure in ${input.workItem.id} triggered retry and reduced executor concurrency.`);
      return;
    }

    input.workItem.status = result.status === "blocked" ? "blocked" : "failed";
    input.workItem.updated_at = new Date().toISOString();
    await this.event(input.run.id, "swarm.work_item.failed", `Work item ${input.workItem.id} ${input.workItem.status}.`, {
      result_ref: input.workItem.result_ref,
      summary: result.summary
    }, input.workItem.id);
    if (input.workItem.type === "execute") {
      await this.event(input.run.id, "swarm.patch.rejected", `Scoped patch proposal rejected for ${input.workItem.id}.`, {
        summary: result.summary
      }, input.workItem.id);
    }
    if (input.workItem.type === "test") {
      await this.event(input.run.id, "swarm.validation.completed", `Validation failed for ${input.workItem.id}.`, {
        passed: false,
        summary: result.summary
      }, input.workItem.id);
    }
    if (result.validation_passed === false) {
      await this.createRepairItem(input.run.id, input.workItems, input.workItem);
    }
    await this.reduceConcurrency(input.run.id, `Terminal failure in ${input.workItem.id} reduced executor concurrency.`);
  }

  private async createRepairItem(runId: string, workItems: WorkItem[], failedItem: WorkItem) {
    if (workItems.some((item) => item.id.startsWith(`swarm_repair_${failedItem.id}`))) return;
    const now = new Date().toISOString();
    const repair: WorkItem = {
      schema_version: SWARM_SCHEMA_VERSION,
      id: `swarm_repair_${failedItem.id}_${randomUUID().slice(0, 8)}`,
      swarm_run_id: runId,
      type: "execute",
      priority: failedItem.priority + 1,
      dependencies: [],
      required_role: "ExecutorAgent",
      read_files: failedItem.read_files,
      write_files: failedItem.write_files,
      risk_level: failedItem.risk_level,
      expected_output_schema: "RepairOutput",
      status: "queued",
      attempt_count: 0,
      max_attempts: 1,
      created_at: now,
      updated_at: now
    };
    workItems.push(repair);
    this.repairTasks += 1;
    await this.event(runId, "swarm.repair_item.created", `Repair work item created after failed validation: ${repair.id}.`, {
      failed_work_item_id: failedItem.id,
      repair_work_item_id: repair.id
    }, repair.id);
  }

  private resetRunState(run: SwarmRun, staffingPlan: StaffingPlan) {
    this.tick = 0;
    this.lockWaitCount = 0;
    this.retryCount = 0;
    this.repairTasks = 0;
    this.invalidStructuredOutputs = 0;
    this.conflictsDetected = 0;
    this.approvalGatesTriggered = 0;
    this.peakActiveAgents = 0;
    this.executorPeakCount = 0;
    this.reviewerPeakCount = 0;
    this.scoutPeakCount = 0;
    this.parallelBackpressure = 0;
    this.executorBackpressure = 0;
    this.healthyBatchStreak = 0;
    this.deferralAging.clear();
    this.currentParallelLimit = 1;
    this.minimumExecutorLimit = staffingPlan.executor_limit > 0 && staffingPlan.executor_count > 0 && run.scheduler_config.executor_limit > 0 ? 1 : 0;
    this.currentExecutorLimit = this.effectiveExecutorLimit(staffingPlan, run.scheduler_config);
  }

  private async updateAdaptiveLimits(
    run: SwarmRun,
    staffingPlan: StaffingPlan,
    readyCount: number,
    resourceSnapshot: SchedulerResourceSnapshot
  ) {
    const previousParallel = this.currentParallelLimit;
    const previousExecutor = this.currentExecutorLimit;
    const planParallel = Math.max(1, Math.min(
      staffingPlan.max_parallel_agents,
      run.scheduler_config.max_parallel_agents
    ));
    const resourceParallel = Math.max(1, Math.floor(
      resourceSnapshot.recommended_parallelism
      ?? resourceSnapshot.available_parallelism
      ?? 1
    ));
    const parallelCeiling = Math.max(1, Math.min(planParallel, resourceParallel));
    this.currentParallelLimit = Math.max(1, Math.min(
      readyCount || 1,
      Math.max(1, parallelCeiling - this.parallelBackpressure)
    ));

    const executorCeiling = this.effectiveExecutorLimit(staffingPlan, run.scheduler_config, resourceSnapshot);
    const executorFloor = Math.min(this.minimumExecutorLimit, executorCeiling);
    this.currentExecutorLimit = Math.max(executorFloor, Math.min(executorCeiling, executorCeiling - this.executorBackpressure));

    if (this.currentParallelLimit > previousParallel || this.currentExecutorLimit > previousExecutor) {
      await this.event(run.id, "swarm.concurrency.increased", "Adaptive scheduler increased available concurrency.", {
        previous_parallel_limit: previousParallel,
        next_parallel_limit: this.currentParallelLimit,
        previous_executor_limit: previousExecutor,
        next_executor_limit: this.currentExecutorLimit,
        resource_snapshot: resourceSnapshot,
        parallel_backpressure: this.parallelBackpressure,
        executor_backpressure: this.executorBackpressure
      });
    }
    if (
      (this.currentParallelLimit < previousParallel || this.currentExecutorLimit < previousExecutor)
      && (this.parallelBackpressure > 0 || this.executorBackpressure > 0 || resourceParallel < planParallel)
    ) {
      await this.event(run.id, "swarm.scheduler.backpressure_applied", "Adaptive scheduler constrained concurrency from resource or failure pressure.", {
        previous_parallel_limit: previousParallel,
        next_parallel_limit: this.currentParallelLimit,
        previous_executor_limit: previousExecutor,
        next_executor_limit: this.currentExecutorLimit,
        plan_parallel_limit: planParallel,
        resource_parallel_limit: resourceParallel,
        parallel_backpressure: this.parallelBackpressure,
        executor_backpressure: this.executorBackpressure
      });
    }
  }

  private async recordBatchHealth(runId: string, results: WorkItemResult[], durationMs: number) {
    const unhealthy = results.filter((result) => result.status !== "succeeded" || !result.structured_output_valid).length;
    const averageDurationMs = results.length ? durationMs / results.length : 0;
    const slowBatch = averageDurationMs > 15_000;
    if (unhealthy || slowBatch) {
      this.healthyBatchStreak = 0;
      if (slowBatch) this.parallelBackpressure = Math.min(8, this.parallelBackpressure + 1);
      return;
    }
    this.healthyBatchStreak += 1;
    const previousParallelBackpressure = this.parallelBackpressure;
    const previousExecutorBackpressure = this.executorBackpressure;
    this.parallelBackpressure = Math.max(0, this.parallelBackpressure - 1);
    this.executorBackpressure = Math.max(0, this.executorBackpressure - 1);
    if (this.parallelBackpressure < previousParallelBackpressure || this.executorBackpressure < previousExecutorBackpressure) {
      await this.event(runId, "swarm.concurrency.increased", "Healthy batch reduced scheduler backpressure for the next tick.", {
        previous_parallel_backpressure: previousParallelBackpressure,
        next_parallel_backpressure: this.parallelBackpressure,
        previous_executor_backpressure: previousExecutorBackpressure,
        next_executor_backpressure: this.executorBackpressure,
        batch_duration_ms: Math.round(durationMs)
      });
    }
  }

  private effectivePriority(workItem: WorkItem) {
    return workItem.priority - ((this.deferralAging.get(workItem.id) ?? 0) * 5);
  }

  private recordAging(selected: SelectedWorkItem[], deferred: Array<{ id: string; reason: string }>) {
    for (const entry of selected) this.deferralAging.delete(entry.workItem.id);
    for (const entry of deferred) {
      if (!isAgingEligibleDeferral(entry.reason)) continue;
      this.deferralAging.set(entry.id, (this.deferralAging.get(entry.id) ?? 0) + 1);
    }
  }

  private roleLimit(staffingPlan: StaffingPlan, role: string, type: WorkItem["type"]) {
    if (type === "execute") return Math.max(0, this.currentExecutorLimit);
    if (type === "test") return Math.max(1, staffingPlan.tester_limit);
    if (type === "review" || role.includes("Reviewer")) return Math.max(1, staffingPlan.reviewer_limit);
    return Math.max(1, staffingPlan.role_counts[role] ?? 1);
  }

  private effectiveExecutorLimit(plan: StaffingPlan, config: SwarmRun["scheduler_config"], resourceSnapshot?: SchedulerResourceSnapshot) {
    if (plan.executor_limit <= 0 || plan.executor_count <= 0) return 0;
    const resourceLimit = resourceSnapshot
      ? Math.max(0, Math.floor(resourceSnapshot.recommended_parallelism ?? resourceSnapshot.available_parallelism ?? plan.executor_limit))
      : plan.executor_limit;
    const configuredLimit = Math.max(0, Math.min(plan.executor_limit, config.executor_limit, resourceLimit));
    if (plan.risk_level === "critical") return Math.min(configuredLimit, 1);
    if (plan.risk_level === "high") return Math.min(configuredLimit, 2);
    return configuredLimit;
  }

  private async reduceConcurrency(runId: string, reason: string) {
    const previous = this.currentExecutorLimit;
    this.parallelBackpressure = Math.min(8, this.parallelBackpressure + 1);
    if (this.currentExecutorLimit > 0) this.executorBackpressure = Math.min(8, this.executorBackpressure + 1);
    this.currentExecutorLimit = Math.max(this.minimumExecutorLimit, this.currentExecutorLimit - 1);
    if (this.currentExecutorLimit < previous) {
      await this.event(runId, "swarm.concurrency.reduced", reason, {
        previous_executor_limit: previous,
        next_executor_limit: this.currentExecutorLimit,
        parallel_backpressure: this.parallelBackpressure,
        executor_backpressure: this.executorBackpressure
      });
    }
  }

  private recordPeaks(items: WorkItem[]) {
    this.peakActiveAgents = Math.max(this.peakActiveAgents, items.length);
    this.executorPeakCount = Math.max(this.executorPeakCount, items.filter((item) => item.type === "execute").length);
    this.reviewerPeakCount = Math.max(this.reviewerPeakCount, items.filter((item) => item.type === "review").length);
    this.scoutPeakCount = Math.max(this.scoutPeakCount, items.filter((item) => item.type === "scout").length);
  }

  private computeMetrics(run: SwarmRun, staffingPlan: StaffingPlan, agentInstances: AgentInstance[], workItems: WorkItem[]): SwarmMetrics {
    const validationItems = workItems.filter((item) => item.type === "test");
    const validationPassed = validationItems.filter((item) => item.status === "succeeded").length;
    return {
      schema_version: SWARM_SCHEMA_VERSION,
      swarm_run_id: run.id,
      staffing_plan_ref: run.staffing_plan_ref,
      effective_total_logical_agents: run.effective_total_logical_agents,
      peak_active_agents: this.peakActiveAgents,
      role_distribution: roleDistribution(agentInstances),
      executor_peak_count: this.executorPeakCount,
      reviewer_peak_count: this.reviewerPeakCount,
      scout_peak_count: this.scoutPeakCount,
      work_items_created: workItems.length,
      work_items_completed: workItems.filter((item) => item.status === "succeeded").length,
      work_items_failed: workItems.filter((item) => item.status === "failed" || item.status === "blocked").length,
      read_only_items: workItems.filter((item) => item.write_files.length === 0).length,
      edit_items: workItems.filter((item) => item.write_files.length > 0).length,
      review_items: workItems.filter((item) => item.type === "review").length,
      validation_items: validationItems.length,
      lock_wait_count: this.lockWaitCount,
      retries: this.retryCount,
      repair_tasks: this.repairTasks,
      invalid_structured_outputs: this.invalidStructuredOutputs,
      consensus_groups: 0,
      validation_pass_rate: validationItems.length ? Math.round((validationPassed / validationItems.length) * 100) / 100 : 1,
      conflicts_detected: this.conflictsDetected,
      approval_gates_triggered: this.approvalGatesTriggered,
      generated_at: new Date().toISOString()
    };
  }

  private async persist(runId: string, workItems: WorkItem[], agentInstances: AgentInstance[]) {
    await this.artifactStore.saveWorkItems(runId, workItems);
    await this.artifactStore.saveAgentInstances(runId, agentInstances);
    await this.artifactStore.saveLeases(runId, agentInstances
      .filter((agent) => agent.lease_id)
      .map((agent) => ({
        lease_id: agent.lease_id,
        agent_id: agent.id,
        work_item_id: agent.current_work_item_id,
        heartbeat_at: agent.last_heartbeat_at
      })));
  }

  private async trace(runId: string, input: Omit<SchedulerTraceEntry, "id" | "swarm_run_id" | "tick" | "created_at">) {
    await this.artifactStore.appendSchedulerTrace({
      id: `trace_${randomUUID()}`,
      swarm_run_id: runId,
      tick: this.tick,
      created_at: new Date().toISOString(),
      ...input
    });
  }

  private async event(runId: string, type: SwarmEvent["type"], message: string, payload?: Record<string, unknown>, workItemId?: string) {
    await this.artifactStore.appendEvent({
      id: `event_${randomUUID()}`,
      swarm_run_id: runId,
      work_item_id: workItemId,
      type,
      message,
      created_at: new Date().toISOString(),
      payload
    });
  }
}

export function createAgentInstancesForPlan(input: {
  runId: string;
  staffingPlan: StaffingPlan;
  templates: AgentTemplate[];
}): AgentInstance[] {
  const now = new Date().toISOString();
  const instances: AgentInstance[] = [];
  for (const template of input.templates) {
    const count = input.staffingPlan.role_counts[template.role] ?? 0;
    for (let index = 0; index < count; index += 1) {
      instances.push({
        schema_version: SWARM_SCHEMA_VERSION,
        id: `agent_${template.role}_${index + 1}_${randomUUID().slice(0, 8)}`,
        template_id: template.id,
        role: template.role,
        status: "idle",
        created_at: now,
        last_heartbeat_at: now,
        failure_count: 0,
        completed_work_item_count: 0
      });
    }
  }
  return instances.slice(0, input.staffingPlan.recommended_total_logical_agents);
}

async function providerRequiredWorker(input: Parameters<SwarmWorker>[0]): Promise<WorkItemResult> {
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    work_item_id: input.workItem.id,
    status: "failed",
    summary: "A real provider-backed swarm worker is required.",
    relevant_files: input.workItem.read_files.filter((file) => !looksLikeCommand(file)),
    findings: [],
    risks: ["provider_required"],
    unknowns: [],
    structured_output_valid: false,
    confidence: 0
  };
}

function readyWorkItems(workItems: WorkItem[]) {
  return workItems.filter((item) => {
    if (item.status !== "queued" && item.status !== "ready") return false;
    return item.dependencies.every((dependency) => workItems.find((candidate) => candidate.id === dependency)?.status === "succeeded");
  });
}

function hasOpenWork(workItems: WorkItem[]) {
  return workItems.some((item) => item.status === "queued" || item.status === "ready" || item.status === "leased" || item.status === "running");
}

function findTemplate(templates: AgentTemplate[], role: string, type: WorkItem["type"]) {
  return templates.find((template) => template.role === role && template.suitable_task_types.includes(type))
    ?? templates.find((template) => template.role === role);
}

function findIdleAgent(instances: AgentInstance[], role: string, reservedAgentIds: Set<string>) {
  return instances.find((agent) => agent.role === role && agent.status === "idle" && !reservedAgentIds.has(agent.id));
}

function activeTypeCount(selected: Array<{ workItem: WorkItem }>, type: WorkItem["type"]) {
  return selected.filter((entry) => entry.workItem.type === type).length;
}

function isWriteWork(workItem: WorkItem) {
  return workItem.write_files.length > 0;
}

function isForbiddenWrite(workItem: WorkItem) {
  return workItem.write_files.some((file) => /(^|\/)(\.agent_memory|node_modules|dist|build|target|\.git|\.env)(\/|$)/i.test(file));
}

function releaseAgent(agent: AgentInstance) {
  agent.status = "idle";
  agent.current_work_item_id = undefined;
  agent.lease_id = undefined;
  agent.last_heartbeat_at = new Date().toISOString();
}

function roleDistribution(instances: AgentInstance[]) {
  const distribution: Record<string, number> = {};
  for (const instance of instances) distribution[instance.role] = (distribution[instance.role] ?? 0) + 1;
  return distribution;
}

function roleDistributionForWorkItems(workItems: WorkItem[]) {
  const distribution: Record<string, number> = {};
  for (const item of workItems) distribution[item.required_role] = (distribution[item.required_role] ?? 0) + 1;
  return distribution;
}

function countDeferredReasons(deferred: Array<{ reason: string }>) {
  const counts: Record<string, number> = {};
  for (const item of deferred) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}

function agingSnapshot(aging: Map<string, number>, ready: WorkItem[]) {
  const readyIds = new Set(ready.map((item) => item.id));
  const snapshot: Record<string, number> = {};
  for (const [id, count] of aging.entries()) {
    if (readyIds.has(id) && count > 0) snapshot[id] = count;
  }
  return snapshot;
}

function isAgingEligibleDeferral(reason: string) {
  return /parallel limit|role limit|executor limit|batch write conflict|no idle/i.test(reason);
}

function defaultSchedulerResourceMonitor(): SchedulerResourceSnapshot {
  const available = Math.max(1, safeAvailableParallelism());
  const [loadAverage] = loadavg();
  const pressure = loadAverage > 0 ? loadAverage / available : 0;
  const recommended = pressure >= 1.5
    ? Math.max(1, Math.floor(available * 0.25))
    : pressure >= 1
      ? Math.max(1, Math.floor(available * 0.5))
      : Math.max(1, available - 1);
  return {
    available_parallelism: available,
    load_average_1m: roundNumber(loadAverage),
    cpu_pressure: roundNumber(pressure),
    recommended_parallelism: recommended,
    reason: pressure >= 1 ? "load_adjusted" : "available_parallelism"
  };
}

function safeAvailableParallelism() {
  try {
    return availableParallelism();
  } catch {
    return cpus().length || 1;
  }
}

function roundNumber(value: number) {
  return Math.round(value * 100) / 100;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function looksLikeCommand(value: string) {
  return /\b(npm|node|cargo|python|pytest|vitest|tsc|eslint|pnpm|yarn)\b/.test(value);
}
