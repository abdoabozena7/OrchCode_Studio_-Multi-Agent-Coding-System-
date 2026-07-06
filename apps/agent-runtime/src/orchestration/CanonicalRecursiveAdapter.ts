import type {
  RecursiveBranchExecutionRecord,
  RecursiveBranchStatus,
  TaskGraph,
  TaskNodeStatus
} from "@hivo/protocol";
import {
  type CanonicalOrchestrationState,
  type CanonicalTaskExecutionResult
} from "./CanonicalOrchestrationGraph.js";
import { runCanonicalExecutionAdapter } from "./CanonicalExecutionAdapter.js";
import { createCanonicalTaskGraph } from "./CanonicalTaskGraphBuilder.js";

export type CanonicalRecursiveExecutionInput = {
  sessionId: string;
  branches: RecursiveBranchExecutionRecord[];
  executeBranches: (taskGraph: TaskGraph) => Promise<RecursiveBranchExecutionRecord[]>;
};

export type CanonicalRecursiveExecutionResult = {
  taskGraph: TaskGraph;
  graph: CanonicalOrchestrationState;
  branches: RecursiveBranchExecutionRecord[];
  taskExecution: CanonicalTaskExecutionResult;
  blockingReasons: string[];
};

export async function runRecursiveBranchesThroughCanonicalGraph(
  input: CanonicalRecursiveExecutionInput
): Promise<CanonicalRecursiveExecutionResult> {
  const taskGraph = recursiveBranchExecutionsToTaskGraph(input.sessionId, input.branches);

  const result = await runCanonicalExecutionAdapter<RecursiveBranchExecutionRecord[]>({
    sessionId: input.sessionId,
    taskGraph,
    execute: input.executeBranches,
    taskExecutionFromOutput: recursiveBranchesToTaskExecution,
    outputWhenExecutionSkipped: () => input.branches,
    missingOutputError: "Canonical recursive adapter finished without scheduler output.",
    review: {
      missingExecutionMessage: "Recursive branch scheduler did not return a result.",
      failedExecutionMessage: (failedCount) => `${failedCount} recursive branch(es) failed or blocked.`,
      extraBlockingReasons: (branches) => branches ? recursiveBranchBlockingReasons(branches) : [],
      includeFailedWhenBlockingReasonsExist: false
    }
  });

  return {
    taskGraph: result.taskGraph,
    graph: result.graph,
    branches: result.output,
    taskExecution: result.taskExecution,
    blockingReasons: result.blockingReasons
  };
}

export function recursiveBranchExecutionsToTaskGraph(
  sessionId: string,
  branches: RecursiveBranchExecutionRecord[]
): TaskGraph {
  return createCanonicalTaskGraph({
    sessionId,
    nodes: branches.map((branch) => ({
      id: branch.branchId,
      title: branch.title,
      description: branch.executionContext.branchObjective,
      assignedAgent: branch.schedulerDecision.writeBranch ? "RecursiveWriteBranch" : "RecursiveReadBranch",
      status: mapRecursiveBranchStatus(branch.status),
      dependsOn: branch.executionContext.dependencies,
      fileLocks: branch.executionContext.lockScopes.length
        ? branch.executionContext.lockScopes
        : branch.executionContext.fileScopes,
      expectedOutput: branch.validationPlan.join("; ") || "Recursive branch result",
      riskLevel: branch.schedulerDecision.writeBranch ? "medium" : "low"
    }))
  });
}

function recursiveBranchesToTaskExecution(branches: RecursiveBranchExecutionRecord[]): CanonicalTaskExecutionResult {
  return {
    completed: branches.filter((branch) =>
      branch.status === "completed"
      || branch.status === "patch_proposed"
      || branch.status === "validation_pending"
      || branch.status === "reviewing"
    ).length,
    failed: branches.filter((branch) => isBlockingRecursiveStatus(branch.status)).length,
    bankruptcyErrors: []
  };
}

function recursiveBranchBlockingReasons(branches: RecursiveBranchExecutionRecord[]): string[] {
  return branches
    .filter((branch) => isBlockingRecursiveStatus(branch.status))
    .map((branch) => `Recursive branch ${branch.branchId} ended ${branch.status}: ${branch.blockedReason ?? branch.conflictReason ?? "no reason recorded"}`);
}

function mapRecursiveBranchStatus(status: RecursiveBranchStatus): TaskNodeStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "blocked_conflict" || status === "blocked_failed_dependency") return "blocked";
  if (status === "skipped" || status === "planned_only") return "cancelled";
  if (status === "running" || status === "patch_proposed" || status === "reviewing" || status === "validation_pending") return "running";
  return "pending";
}

function isBlockingRecursiveStatus(status: RecursiveBranchStatus): boolean {
  return status === "failed" || status === "blocked" || status === "blocked_conflict" || status === "blocked_failed_dependency";
}
