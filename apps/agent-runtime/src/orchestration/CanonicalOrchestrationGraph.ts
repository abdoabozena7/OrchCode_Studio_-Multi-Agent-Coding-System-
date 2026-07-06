import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { TaskGraph } from "@hivo/protocol";
import type { BranchBankruptcyError } from "./CircuitBreaker.js";
import { validateCanonicalTaskGraph } from "./CanonicalTaskGraphBuilder.js";

export type CanonicalOrchestrationStatus =
  | "created"
  | "validated"
  | "working"
  | "reviewing"
  | "awaiting_approval"
  | "blocked";

export type CanonicalFinalStatus = "needs_approval" | "failed";

export type CanonicalOrchestrationEvent = {
  phase: CanonicalOrchestrationStatus;
  message: string;
  createdAt: string;
};

export type CanonicalTaskExecutionResult = {
  completed: number;
  failed: number;
  bankruptcyErrors: BranchBankruptcyError[];
};

export type CanonicalReviewResult = {
  passed: boolean;
  blockingReasons: string[];
};

export type CanonicalOrchestrationServices = {
  executeTasks: (taskGraph: TaskGraph) => Promise<CanonicalTaskExecutionResult>;
  reviewExecution?: (input: {
    taskGraph: TaskGraph;
    taskExecution?: CanonicalTaskExecutionResult;
    errors: string[];
  }) => Promise<CanonicalReviewResult> | CanonicalReviewResult;
};

export type CanonicalExecutionReviewInput = {
  errors: string[];
  taskExecution?: CanonicalTaskExecutionResult;
  missingExecutionMessage?: string;
  failedExecutionMessage?: (failedCount: number) => string;
  bankruptcyMessage?: (error: BranchBankruptcyError) => string;
  extraBlockingReasons?: string[];
  includeFailedWhenBlockingReasonsExist?: boolean;
};

const CanonicalOrchestrationAnnotation = Annotation.Root({
  sessionId: Annotation<string>(),
  taskGraph: Annotation<TaskGraph>(),
  services: Annotation<CanonicalOrchestrationServices>(),
  status: Annotation<CanonicalOrchestrationStatus>({
    reducer: (_left, right) => right,
    default: () => "created"
  }),
  taskExecution: Annotation<CanonicalTaskExecutionResult | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  review: Annotation<CanonicalReviewResult | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  finalStatus: Annotation<CanonicalFinalStatus | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined
  }),
  errors: Annotation<string[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  }),
  events: Annotation<CanonicalOrchestrationEvent[]>({
    reducer: (left, right) => left.concat(right),
    default: () => []
  })
});

export type CanonicalOrchestrationState = typeof CanonicalOrchestrationAnnotation.State;

export async function runCanonicalOrchestrationGraph(input: {
  sessionId: string;
  taskGraph: TaskGraph;
  services: CanonicalOrchestrationServices;
}): Promise<CanonicalOrchestrationState> {
  const graph = buildCanonicalOrchestrationGraph();
  return graph.invoke({
    sessionId: input.sessionId,
    taskGraph: input.taskGraph,
    services: input.services
  });
}

export function buildCanonicalOrchestrationGraph() {
  return new StateGraph(CanonicalOrchestrationAnnotation)
    .addNode("validate_graph", validateGraphNode)
    .addNode("execute_tasks", executeTasksNode)
    .addNode("review_execution", reviewExecutionNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "validate_graph")
    .addConditionalEdges("validate_graph", routeAfterValidation, ["execute_tasks", "review_execution"])
    .addEdge("execute_tasks", "review_execution")
    .addEdge("review_execution", "finalize")
    .addEdge("finalize", END)
    .compile();
}

function validateGraphNode(state: CanonicalOrchestrationState) {
  const errors = validateCanonicalTaskGraph(state.taskGraph);
  return {
    status: errors.length ? "blocked" as const : "validated" as const,
    errors,
    events: [{
      phase: errors.length ? "blocked" as const : "validated" as const,
      message: errors.length
        ? `Task graph blocked before execution: ${errors.join("; ")}`
        : `Task graph validated with ${state.taskGraph.nodes.length} task(s).`,
      createdAt: new Date().toISOString()
    }]
  };
}

async function executeTasksNode(state: CanonicalOrchestrationState) {
  const taskExecution = await state.services.executeTasks(state.taskGraph);
  return {
    status: "working" as const,
    taskExecution,
    events: [event("working", `Task execution finished: ${taskExecution.completed} completed, ${taskExecution.failed} failed.`)]
  };
}

function routeAfterValidation(state: CanonicalOrchestrationState) {
  return state.errors.length > 0 ? "review_execution" : "execute_tasks";
}

async function reviewExecutionNode(state: CanonicalOrchestrationState) {
  const review = state.services.reviewExecution
    ? await state.services.reviewExecution({
      taskGraph: state.taskGraph,
      taskExecution: state.taskExecution,
      errors: state.errors
    })
    : defaultReviewExecution(state);
  return {
    status: review.passed ? "reviewing" as const : "blocked" as const,
    review,
    events: [event(review.passed ? "reviewing" : "blocked", review.passed
      ? "Execution review passed; downstream approval and quality gates may continue."
      : `Execution review blocked the run: ${review.blockingReasons.join("; ")}`)]
  };
}

function finalizeNode(state: CanonicalOrchestrationState) {
  const passed = state.review?.passed === true && state.errors.length === 0;
  return {
    status: passed ? "awaiting_approval" as const : "blocked" as const,
    finalStatus: passed ? "needs_approval" as const : "failed" as const,
    events: [event(passed ? "awaiting_approval" : "blocked", passed
      ? "Canonical orchestration graph stopped at the Rust-mediated approval boundary."
      : "Canonical orchestration graph stopped before approval because execution was not clean.")]
  };
}

function defaultReviewExecution(state: CanonicalOrchestrationState): CanonicalReviewResult {
  return reviewCanonicalTaskExecution({
    errors: state.errors,
    taskExecution: state.taskExecution
  });
}

export function reviewCanonicalTaskExecution(input: CanonicalExecutionReviewInput): CanonicalReviewResult {
  const blockingReasons = [
    ...input.errors,
    ...(input.extraBlockingReasons ?? [])
  ];
  const includeFailedWhenBlockingReasonsExist = input.includeFailedWhenBlockingReasonsExist ?? true;

  if (!input.taskExecution) {
    if (blockingReasons.length === 0) {
      blockingReasons.push(input.missingExecutionMessage ?? "Task execution did not run.");
    }
  } else {
    if (input.taskExecution.failed > 0 && (includeFailedWhenBlockingReasonsExist || blockingReasons.length === 0)) {
      blockingReasons.push(input.failedExecutionMessage?.(input.taskExecution.failed) ?? `${input.taskExecution.failed} task(s) failed.`);
    }
    for (const bankruptcy of input.taskExecution.bankruptcyErrors) {
      blockingReasons.push(input.bankruptcyMessage?.(bankruptcy) ?? `${bankruptcy.agent_name} became bankrupt: ${bankruptcy.last_error}`);
    }
  }

  return {
    passed: blockingReasons.length === 0,
    blockingReasons
  };
}

function event(phase: CanonicalOrchestrationStatus, message: string): CanonicalOrchestrationEvent {
  return { phase, message, createdAt: new Date().toISOString() };
}
