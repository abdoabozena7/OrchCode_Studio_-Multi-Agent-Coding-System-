import assert from "node:assert/strict";
import test from "node:test";
import type { RecursiveBranchExecutionRecord, RecursiveBranchStatus } from "@hivo/protocol";
import {
  recursiveBranchExecutionsToTaskGraph,
  runRecursiveBranchesThroughCanonicalGraph
} from "../orchestration/CanonicalRecursiveAdapter.js";

test("canonical recursive adapter maps branch executions into the shared graph lifecycle", async () => {
  const branches = [
    branch("branch-a", "completed"),
    branch("branch-b", "ready", { dependencies: ["branch-a"], writeBranch: true })
  ];

  const result = await runRecursiveBranchesThroughCanonicalGraph({
    sessionId: "session-recursive",
    branches,
    executeBranches: async () => branches.map((record) =>
      record.branchId === "branch-b"
        ? { ...record, status: "patch_proposed", proposedPatchId: "patch_1", reviewStatus: "pending" }
        : record
    )
  });

  assert.equal(result.graph.status, "awaiting_approval");
  assert.equal(result.graph.finalStatus, "needs_approval");
  assert.equal(result.branches.find((record) => record.branchId === "branch-b")?.status, "patch_proposed");
  assert.equal(result.taskExecution.failed, 0);
  assert.deepEqual(result.blockingReasons, []);
});

test("canonical recursive adapter blocks malformed branch dependencies before execution", async () => {
  let executed = false;
  const branches = [branch("branch-a", "ready", { dependencies: ["missing-branch"] })];

  const result = await runRecursiveBranchesThroughCanonicalGraph({
    sessionId: "session-recursive",
    branches,
    executeBranches: async () => {
      executed = true;
      return branches;
    }
  });

  assert.equal(executed, false);
  assert.equal(result.graph.status, "blocked");
  assert.equal(result.graph.finalStatus, "failed");
  assert.match(result.blockingReasons.join("\n"), /missing-branch/);
});

test("recursive branch graph conversion preserves dependencies and write locks", () => {
  const graph = recursiveBranchExecutionsToTaskGraph("session-recursive", [
    branch("reader", "completed"),
    branch("writer", "ready", { dependencies: ["reader"], writeBranch: true, fileScopes: ["src/app.ts"] })
  ]);

  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.nodes.find((node) => node.id === "writer")?.dependsOn, ["reader"]);
  assert.deepEqual(graph.nodes.find((node) => node.id === "writer")?.fileLocks, ["src/app.ts"]);
  assert.deepEqual(graph.edges, [{ from: "reader", to: "writer" }]);
});

function branch(
  branchId: string,
  status: RecursiveBranchStatus,
  options: {
    dependencies?: string[];
    writeBranch?: boolean;
    fileScopes?: string[];
  } = {}
): RecursiveBranchExecutionRecord {
  const now = new Date().toISOString();
  const fileScopes = options.fileScopes ?? [`src/${branchId}.ts`];
  return {
    branchId,
    sessionId: "session-recursive",
    title: `Branch ${branchId}`,
    status,
    active: status === "running",
    executionContext: {
      branchObjective: `Implement ${branchId}`,
      approvedProductSpecSummary: "Approved product spec",
      approvedTechnicalPlanSummary: "Approved technical plan",
      fileScopes,
      semanticScopes: [],
      lockScopes: fileScopes,
      dependencies: options.dependencies ?? [],
      evidenceContextPack: []
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: options.writeBranch ?? false
    },
    reviewStatus: "not_started",
    validationStatus: "unverified",
    validationPlan: ["npm run test"],
    patchApplied: false,
    createdAt: now,
    updatedAt: now
  };
}
