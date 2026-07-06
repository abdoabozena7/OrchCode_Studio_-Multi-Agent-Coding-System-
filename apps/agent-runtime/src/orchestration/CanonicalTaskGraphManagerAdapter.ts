import type { TaskGraph, TaskNodeStatus } from "@hivo/protocol";
import type { Task, TaskStatus } from "./OrchestrationModels.js";
import {
  type CanonicalOrchestrationState,
  type CanonicalTaskExecutionResult
} from "./CanonicalOrchestrationGraph.js";
import { runCanonicalExecutionAdapter } from "./CanonicalExecutionAdapter.js";
import { createCanonicalTaskGraph } from "./CanonicalTaskGraphBuilder.js";

export type CanonicalTaskGraphManagerExecutionInput = {
  sessionId: string;
  tasks: Task[];
  executeTasks: (taskGraph: TaskGraph) => Promise<Task[]>;
};

export type CanonicalTaskGraphManagerExecutionResult = {
  taskGraph: TaskGraph;
  graph: CanonicalOrchestrationState;
  tasks: Task[];
  taskExecution: CanonicalTaskExecutionResult;
  blockingReasons: string[];
};

export async function runTaskGraphManagerThroughCanonicalGraph(
  input: CanonicalTaskGraphManagerExecutionInput
): Promise<CanonicalTaskGraphManagerExecutionResult> {
  const taskGraph = taskGraphManagerTasksToTaskGraph(input.sessionId, input.tasks);
  const result = await runCanonicalExecutionAdapter<Task[]>({
    sessionId: input.sessionId,
    taskGraph,
    execute: input.executeTasks,
    taskExecutionFromOutput: taskGraphManagerTasksToTaskExecution,
    outputWhenExecutionSkipped: () => input.tasks,
    missingOutputError: "Canonical TaskGraphManager adapter finished without execution output.",
    review: {
      missingExecutionMessage: "TaskGraphManager execution did not return task state.",
      failedExecutionMessage: (failedCount) => `${failedCount} TaskGraphManager task(s) failed or blocked.`,
      extraBlockingReasons: taskGraphManagerBlockingReasons,
      includeFailedWhenBlockingReasonsExist: false
    }
  });

  return {
    taskGraph: result.taskGraph,
    graph: result.graph,
    tasks: result.output,
    taskExecution: result.taskExecution,
    blockingReasons: result.blockingReasons
  };
}

export function taskGraphManagerTasksToTaskGraph(sessionId: string, tasks: Task[]): TaskGraph {
  return createCanonicalTaskGraph({
    sessionId,
    nodes: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.objective,
      assignedAgent: task.role_required,
      status: mapTaskStatus(task.status),
      dependsOn: task.dependencies,
      fileLocks: task.allowed_files_to_edit,
      expectedOutput: task.expected_output_schema,
      riskLevel: task.role_required === "ExecutorAgent" || task.role_required === "IntegratorAgent" ? "medium" : "low"
    }))
  });
}

export function taskGraphManagerTasksToTaskExecution(tasks: Task[]): CanonicalTaskExecutionResult {
  return {
    completed: tasks.filter((task) => task.status === "succeeded" || task.status === "skipped").length,
    failed: tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
    bankruptcyErrors: []
  };
}

export function taskGraphManagerBlockingReasons(tasks: Task[] | undefined): string[] {
  return (tasks ?? [])
    .filter((task) => task.status === "failed" || task.status === "blocked")
    .map((task) => {
      const summary = task.result_summary?.trim();
      return summary
        ? `TaskGraphManager task ${task.id} ${task.status}: ${summary}`
        : `TaskGraphManager task ${task.id} ${task.status}.`;
    });
}

function mapTaskStatus(status: TaskStatus): TaskNodeStatus {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "cancelled";
  if (status === "running") return "running";
  return "pending";
}
