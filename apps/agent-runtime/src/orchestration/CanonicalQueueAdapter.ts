import type { TaskGraph } from "@hivo/protocol";
import {
  type CanonicalOrchestrationState,
  type CanonicalTaskExecutionResult
} from "./CanonicalOrchestrationGraph.js";
import { runCanonicalExecutionAdapter } from "./CanonicalExecutionAdapter.js";
import type {
  QueueDrivenTaskEvent,
  QueueDrivenTaskScheduler,
  TaskExecutionHandler
} from "./QueueDrivenTaskScheduler.js";

export type CanonicalQueueExecutionInput = {
  sessionId: string;
  taskGraph: TaskGraph;
  scheduler: QueueDrivenTaskScheduler;
  handler: TaskExecutionHandler;
};

export type CanonicalQueueExecutionResult = {
  taskGraph: TaskGraph;
  graph: CanonicalOrchestrationState;
  taskExecution: CanonicalTaskExecutionResult;
  events: QueueDrivenTaskEvent[];
  blockingReasons: string[];
};

export async function runQueueSchedulerThroughCanonicalGraph(
  input: CanonicalQueueExecutionInput
): Promise<CanonicalQueueExecutionResult> {
  const result = await runCanonicalExecutionAdapter<CanonicalTaskExecutionResult>({
    sessionId: input.sessionId,
    taskGraph: input.taskGraph,
    execute: (validatedGraph) => input.scheduler.executeViaQueue(validatedGraph, input.handler),
    taskExecutionFromOutput: (taskExecution) => taskExecution,
    outputWhenExecutionSkipped: () => ({ completed: 0, failed: 0, bankruptcyErrors: [] }),
    missingOutputError: "Canonical queue adapter finished without scheduler output.",
    review: {
      missingExecutionMessage: "Queue scheduler did not return a result.",
      failedExecutionMessage: (failedCount) => `${failedCount} queued task(s) failed.`,
      extraBlockingReasons: () => input.scheduler.failureReasons()
    }
  });

  return {
    taskGraph: result.taskGraph,
    graph: result.graph,
    taskExecution: result.taskExecution,
    events: input.scheduler.events,
    blockingReasons: result.blockingReasons
  };
}
