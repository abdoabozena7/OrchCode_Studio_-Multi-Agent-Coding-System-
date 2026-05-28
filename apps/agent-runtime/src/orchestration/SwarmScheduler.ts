import { randomUUID } from "node:crypto";
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
  private currentExecutorLimit: number;

  constructor(
    private readonly workspacePath: string,
    private readonly artifactStore: SwarmArtifactStore,
    private readonly lockManager: SchedulerLockManager,
    private readonly worker: SwarmWorker = defaultMockWorker
  ) {
    this.currentExecutorLimit = 1;
  }

  async run(input: {
    run: SwarmRun;
    staffingPlan: StaffingPlan;
    agentTemplates: AgentTemplate[];
    agentInstances: AgentInstance[];
    workItems: WorkItem[];
  }): Promise<SwarmSchedulerResult> {
    this.currentExecutorLimit = this.effectiveExecutorLimit(input.staffingPlan);
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

      const selection = this.selectBatch({
        ready,
        staffingPlan: input.staffingPlan,
        agentInstances,
        agentTemplates: input.agentTemplates
      });
      await this.trace(input.run.id, {
        decision: selection.selected.length ? "selected_ready_batch" : "deferred_ready_batch",
        reasoning: selection.reasoning,
        selected_work_items: selection.selected.map((entry) => entry.workItem.id),
        deferred_work_items: selection.deferred,
        active_agent_count: selection.selected.length,
        executor_concurrency: this.currentExecutorLimit
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
      for (const selected of selection.selected) {
        await this.executeSelected({
          run: input.run,
          staffingPlan: input.staffingPlan,
          workItems,
          agentInstances,
          agentTemplates: input.agentTemplates,
          workItem: selected.workItem,
          agent: selected.agent,
          template: selected.template
        });
      }
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
  }) {
    const selected: Array<{ workItem: WorkItem; agent: AgentInstance; template: AgentTemplate }> = [];
    const deferred: Array<{ id: string; reason: string }> = [];
    const maxParallel = Math.max(1, input.staffingPlan.max_parallel_agents);
    const activeRoleCounts: Record<string, number> = {};
    const batchWriteFiles = new Set<string>();

    for (const workItem of input.ready.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))) {
      if (selected.length >= maxParallel) {
        deferred.push({ id: workItem.id, reason: `max_parallel_agents ${maxParallel} reached` });
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
      const agent = findIdleAgent(input.agentInstances, workItem.required_role);
      if (!agent) {
        deferred.push({ id: workItem.id, reason: `no idle ${workItem.required_role} instance` });
        continue;
      }
      selected.push({ workItem, agent, template });
      activeRoleCounts[workItem.required_role] = (activeRoleCounts[workItem.required_role] ?? 0) + 1;
      for (const file of workItem.write_files) batchWriteFiles.add(file);
    }

    return {
      selected,
      deferred,
      reasoning: selected.length
        ? `Selected ${selected.length} work item(s) using dependency readiness, role limits, executor cap ${this.currentExecutorLimit}, and file-lock prechecks.`
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
  }) {
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
        return;
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
      await this.event(input.run.id, "swarm.executor.patch_proposed", `Executor prepared a scoped patch proposal for ${input.workItem.id}.`, {
        write_files: input.workItem.write_files
      }, input.workItem.id);
    }
    if (input.workItem.type === "test") {
      await this.event(input.run.id, "swarm.validation.started", `Validation started for ${input.workItem.id}.`, {
        commands: input.workItem.read_files
      }, input.workItem.id);
    }

    try {
      const result = await this.worker({
        workItem: input.workItem,
        agent: input.agent,
        template: input.template,
        run: input.run,
        staffingPlan: input.staffingPlan
      });
      const resultRef = await this.artifactStore.saveWorkItemResult(input.run.id, result, input.workItem.required_role, input.workItem.type);
      input.workItem.result_ref = resultRef;
      await this.handleResult(input, result);
    } finally {
      if (acquired) await this.lockManager.releaseByTask(input.workItem.id);
      releaseAgent(input.agent);
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

  private roleLimit(staffingPlan: StaffingPlan, role: string, type: WorkItem["type"]) {
    if (type === "execute") return Math.max(0, this.currentExecutorLimit);
    if (type === "test") return Math.max(1, staffingPlan.tester_limit);
    if (type === "review" || role.includes("Reviewer")) return Math.max(1, staffingPlan.reviewer_limit);
    return Math.max(1, staffingPlan.role_counts[role] ?? 1);
  }

  private effectiveExecutorLimit(plan: StaffingPlan) {
    if (plan.risk_level === "critical") return Math.min(plan.executor_limit, 1);
    if (plan.risk_level === "high") return Math.min(plan.executor_limit, 2);
    return Math.max(0, plan.executor_limit);
  }

  private async reduceConcurrency(runId: string, reason: string) {
    const previous = this.currentExecutorLimit;
    this.currentExecutorLimit = Math.max(1, this.currentExecutorLimit - 1);
    if (this.currentExecutorLimit < previous) {
      await this.event(runId, "swarm.concurrency.reduced", reason, {
        previous_executor_limit: previous,
        next_executor_limit: this.currentExecutorLimit
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

export async function defaultMockWorker(input: {
  workItem: WorkItem;
  agent: AgentInstance;
  template: AgentTemplate;
  run: SwarmRun;
  staffingPlan: StaffingPlan;
}): Promise<WorkItemResult> {
  const invalid = input.workItem.expected_output_schema === "InvalidOutput";
  const validationFailure = input.workItem.type === "test" && input.workItem.read_files.some((command) => /exit\(3\)|fail/i.test(command));
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    work_item_id: input.workItem.id,
    status: invalid || validationFailure ? "failed" : "succeeded",
    summary: `${input.agent.role} completed ${input.workItem.type} work for ${input.run.user_goal}.`,
    relevant_files: input.workItem.read_files.filter((file) => !looksLikeCommand(file)),
    findings: [
      `${input.workItem.type} work item used schema ${input.workItem.expected_output_schema}.`
    ],
    risks: input.workItem.risk_level === "low" ? [] : [`${input.workItem.risk_level} risk work requires review evidence.`],
    unknowns: [],
    validation_passed: input.workItem.type === "test" ? !validationFailure : undefined,
    structured_output_valid: !invalid,
    confidence: input.workItem.risk_level === "critical" ? 0.62 : input.workItem.risk_level === "high" ? 0.72 : 0.86
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

function findIdleAgent(instances: AgentInstance[], role: string) {
  return instances.find((agent) => agent.role === role && agent.status === "idle");
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

function looksLikeCommand(value: string) {
  return /\b(npm|node|cargo|python|pytest|vitest|tsc|eslint|pnpm|yarn)\b/.test(value);
}
