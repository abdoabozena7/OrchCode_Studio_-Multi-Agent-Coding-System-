import type { TaskGraph, TaskNodeStatus } from "@hivo/protocol";
import {
  type CanonicalOrchestrationState,
  type CanonicalTaskExecutionResult
} from "./CanonicalOrchestrationGraph.js";
import { runCanonicalExecutionAdapter } from "./CanonicalExecutionAdapter.js";
import { createCanonicalTaskGraph } from "./CanonicalTaskGraphBuilder.js";
import type { SwarmScheduler, SwarmSchedulerResult } from "./SwarmScheduler.js";
import type {
  AgentInstance,
  AgentTemplate,
  StaffingPlan,
  SwarmRun,
  WorkItem,
  WorkItemStatus
} from "./SwarmModels.js";
import { SWARM_SCHEMA_VERSION, type SwarmMetrics } from "./SwarmModels.js";

export type CanonicalSwarmExecutionInput = {
  scheduler: SwarmScheduler;
  run: SwarmRun;
  staffingPlan: StaffingPlan;
  agentTemplates: AgentTemplate[];
  agentInstances: AgentInstance[];
  workItems: WorkItem[];
};

export type CanonicalSwarmExecutionResult = {
  taskGraph: TaskGraph;
  graph: CanonicalOrchestrationState;
  scheduled: SwarmSchedulerResult;
  taskExecution: CanonicalTaskExecutionResult;
  blockingReasons: string[];
};

export async function runSwarmSchedulerThroughCanonicalGraph(
  input: CanonicalSwarmExecutionInput
): Promise<CanonicalSwarmExecutionResult> {
  const taskGraph = swarmWorkItemsToTaskGraph(input.run.id, input.workItems);

  const result = await runCanonicalExecutionAdapter<SwarmSchedulerResult>({
    sessionId: input.run.id,
    taskGraph,
    execute: () => input.scheduler.run({
      run: input.run,
      staffingPlan: input.staffingPlan,
      agentTemplates: input.agentTemplates,
      agentInstances: input.agentInstances,
      workItems: input.workItems
    }),
    taskExecutionFromOutput: swarmSchedulerResultToTaskExecution,
    outputWhenExecutionSkipped: () => ({
      workItems: input.workItems,
      agentInstances: input.agentInstances,
      metrics: blockedSwarmMetrics(input.run, input.staffingPlan, input.workItems)
    }),
    missingOutputError: "Canonical swarm adapter finished without scheduler output.",
    review: {
      missingExecutionMessage: "Swarm scheduler did not return a result.",
      failedExecutionMessage: (failedCount) => `${failedCount} swarm work item(s) failed.`,
      extraBlockingReasons: (scheduled) => scheduled ? swarmBlockingReasons(scheduled.workItems) : [],
      includeFailedWhenBlockingReasonsExist: false
    }
  });

  return {
    taskGraph: result.taskGraph,
    graph: result.graph,
    scheduled: result.output,
    taskExecution: result.taskExecution,
    blockingReasons: result.blockingReasons
  };
}

export function swarmWorkItemsToTaskGraph(sessionId: string, workItems: WorkItem[]): TaskGraph {
  return createCanonicalTaskGraph({
    sessionId,
    nodes: workItems.map((item) => ({
      id: item.id,
      title: `${item.type}: ${item.id}`,
      description: `${item.required_role} ${item.type} work item`,
      assignedAgent: item.required_role,
      status: mapWorkItemStatus(item.status),
      dependsOn: item.dependencies,
      fileLocks: item.write_files,
      expectedOutput: item.expected_output_schema,
      riskLevel: item.risk_level === "critical" ? "high" : item.risk_level
    }))
  });
}

function swarmSchedulerResultToTaskExecution(result: SwarmSchedulerResult): CanonicalTaskExecutionResult {
  const failed = result.workItems.filter((item) => item.status === "failed" || item.status === "blocked").length;
  return {
    completed: result.workItems.filter((item) => item.status === "succeeded").length,
    failed,
    bankruptcyErrors: []
  };
}

function swarmBlockingReasons(workItems: WorkItem[]): string[] {
  return workItems
    .filter((item) => item.status === "failed" || item.status === "blocked")
    .map((item) => `Swarm work item ${item.id} ended ${item.status}.`);
}

function mapWorkItemStatus(status: WorkItemStatus): TaskNodeStatus {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "cancelled";
  if (status === "leased" || status === "running") return "running";
  return "pending";
}

function blockedSwarmMetrics(run: SwarmRun, staffingPlan: StaffingPlan, workItems: WorkItem[]): SwarmMetrics {
  const validationItems = workItems.filter((item) => item.type === "test");
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    swarm_run_id: run.id,
    staffing_plan_ref: run.staffing_plan_ref,
    effective_total_logical_agents: run.effective_total_logical_agents,
    peak_active_agents: 0,
    role_distribution: {},
    executor_peak_count: 0,
    reviewer_peak_count: 0,
    scout_peak_count: 0,
    work_items_created: workItems.length,
    work_items_completed: 0,
    work_items_failed: 0,
    read_only_items: workItems.filter((item) => item.write_files.length === 0).length,
    edit_items: workItems.filter((item) => item.write_files.length > 0).length,
    review_items: workItems.filter((item) => item.type === "review").length,
    validation_items: validationItems.length,
    lock_wait_count: 0,
    retries: 0,
    repair_tasks: 0,
    invalid_structured_outputs: 0,
    consensus_groups: 0,
    validation_pass_rate: validationItems.length ? 0 : 1,
    conflicts_detected: 0,
    approval_gates_triggered: staffingPlan.requires_human_approval ? 1 : 0,
    bankruptcy_count: 0,
    generated_at: new Date().toISOString()
  };
}
