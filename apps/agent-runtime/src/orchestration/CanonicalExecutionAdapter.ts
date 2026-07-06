import type { TaskGraph } from "@hivo/protocol";
import {
  runCanonicalOrchestrationGraph,
  reviewCanonicalTaskExecution,
  type CanonicalExecutionReviewInput,
  type CanonicalOrchestrationState,
  type CanonicalTaskExecutionResult
} from "./CanonicalOrchestrationGraph.js";

export type CanonicalExecutionAdapterReview<TOutput> = Omit<
  CanonicalExecutionReviewInput,
  "errors" | "taskExecution" | "extraBlockingReasons"
> & {
  extraBlockingReasons?: (output: TOutput | undefined) => string[];
};

export type CanonicalExecutionAdapterInput<TOutput> = {
  sessionId: string;
  taskGraph: TaskGraph;
  execute: (taskGraph: TaskGraph) => Promise<TOutput>;
  taskExecutionFromOutput: (output: TOutput) => CanonicalTaskExecutionResult;
  outputWhenExecutionSkipped?: () => TOutput;
  missingOutputError: string;
  review?: CanonicalExecutionAdapterReview<TOutput>;
};

export type CanonicalExecutionAdapterResult<TOutput> = {
  taskGraph: TaskGraph;
  graph: CanonicalOrchestrationState;
  output: TOutput;
  taskExecution: CanonicalTaskExecutionResult;
  blockingReasons: string[];
};

const EMPTY_TASK_EXECUTION: CanonicalTaskExecutionResult = {
  completed: 0,
  failed: 0,
  bankruptcyErrors: []
};

export async function runCanonicalExecutionAdapter<TOutput>(
  input: CanonicalExecutionAdapterInput<TOutput>
): Promise<CanonicalExecutionAdapterResult<TOutput>> {
  let output: TOutput | undefined;
  let hasOutput = false;

  const graph = await runCanonicalOrchestrationGraph({
    sessionId: input.sessionId,
    taskGraph: input.taskGraph,
    services: {
      executeTasks: async (validatedGraph) => {
        output = await input.execute(validatedGraph);
        hasOutput = true;
        return input.taskExecutionFromOutput(output);
      },
      reviewExecution: ({ taskExecution, errors }) => reviewCanonicalTaskExecution({
        ...input.review,
        errors,
        taskExecution,
        extraBlockingReasons: input.review?.extraBlockingReasons?.(output) ?? []
      })
    }
  });

  if (!hasOutput && graph.errors.length > 0 && input.outputWhenExecutionSkipped) {
    output = input.outputWhenExecutionSkipped?.();
    hasOutput = true;
  }
  if (!hasOutput) {
    throw new Error(input.missingOutputError);
  }

  return {
    taskGraph: input.taskGraph,
    graph,
    output: output as TOutput,
    taskExecution: graph.taskExecution ?? (graph.errors.length > 0 ? EMPTY_TASK_EXECUTION : input.taskExecutionFromOutput(output as TOutput)),
    blockingReasons: graph.review?.blockingReasons ?? []
  };
}
