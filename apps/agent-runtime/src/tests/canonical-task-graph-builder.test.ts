import assert from "node:assert/strict";
import test from "node:test";
import {
  createCanonicalTaskGraph,
  validateCanonicalTaskGraph
} from "../orchestration/CanonicalTaskGraphBuilder.js";

test("canonical task graph builder creates dependency edges from known dependencies", () => {
  const graph = createCanonicalTaskGraph({
    sessionId: "session-builder",
    nodes: [
      node("task-a"),
      node("task-b", ["task-a"])
    ]
  });

  assert.equal(graph.sessionId, "session-builder");
  assert.deepEqual(graph.nodes.map((task) => task.id), ["task-a", "task-b"]);
  assert.deepEqual(graph.nodes.find((task) => task.id === "task-b")?.dependsOn, ["task-a"]);
  assert.deepEqual(graph.edges, [{ from: "task-a", to: "task-b" }]);
  assert.deepEqual(validateCanonicalTaskGraph(graph), []);
});

test("canonical task graph builder preserves missing dependencies for graph validation", () => {
  const graph = createCanonicalTaskGraph({
    sessionId: "session-builder",
    nodes: [node("task-a", ["missing-task"])]
  });

  assert.deepEqual(graph.nodes[0]?.dependsOn, ["missing-task"]);
  assert.deepEqual(graph.edges, []);
  assert.match(validateCanonicalTaskGraph(graph).join("\n"), /missing-task/);
});

test("canonical task graph validator rejects dependency edge mismatches", () => {
  const graph = createCanonicalTaskGraph({
    sessionId: "session-builder",
    nodes: [
      node("task-a"),
      node("task-b", ["task-a"])
    ]
  });
  graph.nodes[1]!.dependsOn = [];

  assert.match(validateCanonicalTaskGraph(graph).join("\n"), /not mirrored by task task-b dependsOn/);
});

test("canonical task graph validator rejects dependency cycles", () => {
  const graph = createCanonicalTaskGraph({
    sessionId: "session-builder",
    nodes: [
      node("task-a", ["task-b"]),
      node("task-b", ["task-a"])
    ]
  });

  assert.match(validateCanonicalTaskGraph(graph).join("\n"), /Task dependency cycle/);
});

function node(id: string, dependsOn: string[] = []) {
  return {
    id,
    title: id,
    description: `Run ${id}`,
    assignedAgent: "WorkerAgent",
    status: "pending" as const,
    dependsOn,
    fileLocks: [],
    expectedOutput: "WorkerOutput",
    riskLevel: "low" as const
  };
}
