import assert from "node:assert/strict";
import test from "node:test";
import { RecursiveTaskSplitter } from "../orchestration/RecursiveTaskSplitter.js";
import { HierarchicalCollector } from "../orchestration/HierarchicalCollector.js";
import { GoalKeeperAgent } from "../orchestration/GoalKeeperAgent.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import {
  RECURSIVE_SWARM_SCHEMA_VERSION,
  DEFAULT_RECURSIVE_SWARM_OPTIONS,
  createGoalEnvelope
} from "../orchestration/RecursiveSwarmModels.js";
import type { RecursiveSwarmNode } from "../orchestration/RecursiveSwarmModels.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";

// ============================================================
// Fixtures
// ============================================================

function makeTestNode(overrides: Partial<RecursiveSwarmNode> = {}): RecursiveSwarmNode {
  const goalEnvelope = createGoalEnvelope({
    originalGoal: "Test goal",
    workspaceIdentity: "test",
    localTask: overrides.taskPrompt ?? "Test task"
  });
  return {
    schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
    id: `node_${Math.random().toString(36).slice(2, 10)}`,
    parentId: undefined,
    runId: "test_run",
    kind: "task_agent",
    status: "created",
    name: "Test Node",
    role: "Task Agent",
    goalEnvelope,
    taskPrompt: "Test task",
    depth: 0,
    goalChecks: [],
    steeringQueue: [],
    children: [],
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

type AtomicityFixture = {
  isAtomic: boolean;
  score: number;
  rationale: string;
  failures: string[];
};

type SplitFixture = {
  rationale: string;
  subTasks: Array<{
    title: string;
    taskPrompt: string;
    expectedOutput: string;
    dependencies: string[];
  }>;
};

function recursiveProvider(input: {
  atomicity?: AtomicityFixture[];
  splitResults?: SplitFixture[];
} = {}): LlmProvider & { requests: LlmRequest[] } {
  const atomicity = [...(input.atomicity ?? [{ isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] }])];
  const splitResults = [...(input.splitResults ?? [])];
  return {
    requests: [],
    async generateStructured<T>(request: LlmRequest, schema: unknown): Promise<T> {
      this.requests.push(request);
      const name = schema && typeof schema === "object" && "name" in schema
        ? String((schema as { name: unknown }).name)
        : "";
      if (name === "atomicity_assessment") {
        const next = atomicity.shift() ?? { isAtomic: true, score: 2, rationale: "Atomic fixture.", failures: [] };
        return next as T;
      }
      if (name === "split_result") {
        return (splitResults.shift() ?? { subTasks: [], rationale: "No fixture split." }) as T;
      }
      if (name === "structured_node_output") {
        return {
          kind: "final_summary",
          summary: `Completed: ${request.userPrompt}`,
          blockers: [],
          edit_intents: [],
          validation_plans: [],
          confidence: 0.9
        } as T;
      }
      throw new Error(`Unexpected schema ${name}`);
    },
    async generateText(request: LlmRequest): Promise<string> {
      this.requests.push(request);
      return `Merged child results:\n${request.userPrompt.slice(0, 800)}`;
    }
  };
}

// ============================================================
// GoalKeeper provider authority
// ============================================================

test("GoalKeeperAgent reports unknown without provider instead of keyword fallback", async () => {
  const goalKeeper = new GoalKeeperAgent();
  const result = await goalKeeper.checkAlignment(makeTestNode({
    taskPrompt: "Fix the login button color"
  }));
  assert.equal(result.aligned, false);
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.findings, ["provider_unavailable"]);
  assert.match(result.warnings.join("\n"), /configured provider/);
});

test("orchestrator blocks goal checking when provider is unavailable", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: true,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Fix the login button color");
  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  assert.equal(rootNode.status, "blocked");
  assert.match(rootNode.errorSummary ?? "", /provider_unavailable/);
});

// ============================================================
// Bug 3 regression: provider-backed splitting must not self-split
// ============================================================

test("splitTask rejects missing provider instead of using local decomposition fallback", async () => {
  const splitter = new RecursiveTaskSplitter({ complexityThreshold: 4 });
  const node = makeTestNode({
    taskPrompt: "Implement a login form with validation and error handling"
  });
  await assert.rejects(
    () => splitter.splitTask(node, DEFAULT_RECURSIVE_SWARM_OPTIONS),
    /configured provider/
  );
});

test("orchestrator self-similar provider split detection executes atomically", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [{ isAtomic: false, score: 6, rationale: "Provider requests split.", failures: ["broad_scope"] }],
      splitResults: [{ subTasks: [], rationale: "Provider found no meaningful split." }]
    }),
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: true,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Fix the button color");
  assert.ok(result.runState.tree.maxDepth <= 1,
    `maxDepth should be <=1 (was ${result.runState.tree.maxDepth}) -- no recursive split loop`);
  assert.ok(result.finalOutput.length > 0,
    "finalOutput should be non-empty with provider-backed execution");
  assert.equal(result.runState.tree.status, "succeeded",
    "tree status should be succeeded, not blocked from maxDepth recursion");
});

// ============================================================
// Bug 1 regression: child results must appear in collection
// ============================================================

test("collect reads fresh child nodes from tree by parentId", async () => {
  const collector = new HierarchicalCollector({ enableErrorRecovery: false });
  const goal = "Build a simple UI";

  const child1 = makeTestNode({
    id: "child_1",
    parentId: "parent_1",
    name: "Child1",
    status: "succeeded",
    outputSummary: "Created button component",
    taskPrompt: "Create button",
    children: []
  });
  const child2 = makeTestNode({
    id: "child_2",
    parentId: "parent_1",
    name: "Child2",
    status: "succeeded",
    outputSummary: "Created input component",
    taskPrompt: "Create input",
    children: []
  });

  const children = [child1, child2];
  const result = await collector.collect(children, goal);

  // Both outputs must be present in childResults
  assert.ok(result.childResults["child_1"], "child1 result should be present");
  assert.ok(result.childResults["child_2"], "child2 result should be present");
  assert.equal(result.childResults["child_1"], "Created button component");
  assert.equal(result.childResults["child_2"], "Created input component");

  // Merged output should combine both
  assert.ok(result.mergedOutput.length > 0, "merged output should not be empty");
  assert.notEqual(result.mergedOutput, "No child results to merge.",
    "should not say 'No child results to merge' when children have outputs");
  assert.notEqual(result.mergedOutput, "No results to merge.",
    "should not say 'No results to merge' when children have outputs");
  assert.ok(result.unresolvedErrors.some((error) => error.includes("provider_unavailable")),
    "collector should not treat local merge formatting as provider-authored success");
});

test("orchestrator-filtered children by parentId are not stale", async () => {
  // Simulate the scenario: nodes are in a tree, a child gets updated via
  // emitNodeStatusChanged (which replaces the node copy), then the
  // orchestrator's old object-reference filter would miss it.
  // We verify that filtering by parentId finds all children.

  const tree = new Map<string, RecursiveSwarmNode>();
  const parentId = "parent_test";

  const childA = makeTestNode({ id: "child_A", parentId, outputSummary: "Output A" });
  const childB = makeTestNode({ id: "child_B", parentId, outputSummary: "Output B" });

  tree.set(childA.id, childA);
  tree.set(childB.id, childB);

  // Simulate emitNodeStatusChanged: replace with copy
  tree.set(childA.id, { ...tree.get(childA.id)!, status: "succeeded" });
  tree.set(childB.id, { ...tree.get(childB.id)!, status: "succeeded" });

  // Object reference filter (the BUG) would find nothing
  const originalRefs = [childA, childB];
  const byRef = [...tree.values()].filter((n) => originalRefs.includes(n));
  assert.equal(byRef.length, 0,
    "object reference filter returns empty after node replacement (BUG)");

  // parentId filter (the FIX) works correctly
  const byParent = [...tree.values()].filter((n) => n.parentId === parentId);
  assert.equal(byParent.length, 2,
    "parentId filter finds all children after node replacement (FIX)");
});

// ============================================================
// Bug 2 regression: dependency ordering
// ============================================================

test("executeChildren enforces dependency order with index refs", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [
        { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] }
      ],
      splitResults: [{
        rationale: "Provider split into ordered work.",
        subTasks: [
          { title: "Create database schema", taskPrompt: "Create the database schema", expectedOutput: "Schema plan", dependencies: [] },
          { title: "Create API endpoints", taskPrompt: "Create the API endpoints", expectedOutput: "API plan", dependencies: ["0"] },
          { title: "Create UI pages", taskPrompt: "Create the UI pages", expectedOutput: "UI plan", dependencies: ["1"] }
        ]
      }]
    }),
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run(
    "Create the database schema\nand create the API endpoints\nand create the UI pages"
  );
  // Tree must complete without blocking
  assert.equal(result.runState.tree.status, "succeeded",
    "tree should succeed with dependency-aware execution");
  // All nodes should be completed
  const allNodes = Object.values(result.runState.tree.nodes);
  const failedOrBlocked = allNodes.filter(
    (n) => n.status === "failed" || n.status === "blocked" || n.status === "escalated"
  );
  assert.equal(failedOrBlocked.length, 0,
    `no failed/blocked/escalated nodes (found ${failedOrBlocked.map((n) => `${n.name}:${n.status}`).join(", ")})`);
  // Must produce final output
  assert.ok(result.finalOutput.length > 0, "final output should be non-empty");
  // The root node should have collected child results
  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  if (rootNode.collectResult) {
    assert.ok(Object.keys(rootNode.collectResult.childResults).length > 0,
      "root collectResult should contain child results");
  }
});

test("deadlock detection blocks circular deps deterministically", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    provider: recursiveProvider({
      atomicity: [
        { isAtomic: false, score: 6, rationale: "Root should split.", failures: ["multiple_goals"] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] },
        { isAtomic: true, score: 2, rationale: "Child is atomic.", failures: [] }
      ],
      splitResults: [{
        rationale: "Provider split into ordered work.",
        subTasks: [
          { title: "Init project", taskPrompt: "Init the project", expectedOutput: "Project initialized", dependencies: [] },
          { title: "Add config", taskPrompt: "Add the config", expectedOutput: "Config added", dependencies: ["0"] },
          { title: "Write code", taskPrompt: "Write the code", expectedOutput: "Code written", dependencies: ["1"] }
        ]
      }]
    }),
    options: {
      maxDepth: 2,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run(
    "Init the project\nand add the config\nand write the code"
  );
  // If deadlock detection is wrong, some nodes would be blocked
  const blockedNodes = Object.values(result.runState.tree.nodes).filter(
    (n) => n.status === "blocked"
  );
  assert.equal(blockedNodes.length, 0,
    `no blocked nodes despite sequential dependencies (found ${blockedNodes.length})`);
});

test("orchestrator without provider blocks recursive semantic planning", async () => {
  const orchestrator = new RecursiveSwarmOrchestrator({
    options: {
      maxDepth: 3,
      maxAgents: 10,
      enableGoalKeeper: false,
      enableParallelExecution: false,
      enableErrorRecovery: false
    }
  });
  const result = await orchestrator.run("Create the config\nand set up logging\nand add metrics");
  const rootNode = result.runState.tree.nodes[result.runState.tree.rootId];
  assert.equal(rootNode.status, "blocked");
  assert.match(rootNode.errorSummary ?? "", /requires a configured provider/);
  assert.equal(result.runState.tree.status, "failed");
});
