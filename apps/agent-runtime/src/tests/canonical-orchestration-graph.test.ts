import assert from "node:assert/strict";
import test from "node:test";
import type { TaskGraph } from "@hivo/protocol";
import { runCanonicalOrchestrationGraph } from "../orchestration/CanonicalOrchestrationGraph.js";

test("canonical orchestration graph validates, executes, reviews, and stops at approval boundary", async () => {
  const graph = oneTaskGraph();
  let executed = false;

  const result = await runCanonicalOrchestrationGraph({
    sessionId: graph.sessionId,
    taskGraph: graph,
    services: {
      executeTasks: async (taskGraph) => {
        executed = true;
        assert.equal(taskGraph.nodes[0]?.id, "task-a");
        return { completed: 1, failed: 0, bankruptcyErrors: [] };
      }
    }
  });

  assert.equal(executed, true);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.finalStatus, "needs_approval");
  assert.equal(result.review?.passed, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.events.map((event) => event.phase), [
    "validated",
    "working",
    "reviewing",
    "awaiting_approval"
  ]);
});

test("canonical orchestration graph blocks malformed task graphs before worker execution", async () => {
  const graph = oneTaskGraph();
  graph.nodes[0]!.dependsOn = ["missing-task"];
  let executed = false;

  const result = await runCanonicalOrchestrationGraph({
    sessionId: graph.sessionId,
    taskGraph: graph,
    services: {
      executeTasks: async () => {
        executed = true;
        return { completed: 1, failed: 0, bankruptcyErrors: [] };
      }
    }
  });

  assert.equal(executed, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.finalStatus, "failed");
  assert.match(result.errors.join("\n"), /missing-task/);
  assert.equal(result.review?.passed, false);
  assert.deepEqual(result.events.map((event) => event.phase), [
    "blocked",
    "blocked",
    "blocked"
  ]);
  assert.doesNotMatch(result.events.map((event) => event.message).join("\n"), /Task execution finished/);
});

test("canonical orchestration graph treats failed task execution as blocked", async () => {
  const graph = oneTaskGraph();

  const result = await runCanonicalOrchestrationGraph({
    sessionId: graph.sessionId,
    taskGraph: graph,
    services: {
      executeTasks: async () => ({ completed: 0, failed: 1, bankruptcyErrors: [] })
    }
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.finalStatus, "failed");
  assert.equal(result.review?.passed, false);
  assert.match(result.review?.blockingReasons.join("\n") ?? "", /1 task\(s\) failed/);
});

test("canonical orchestration graph rejects dependency edges that do not match dependsOn", async () => {
  const graph = oneTaskGraph();
  graph.nodes.push({
    id: "task-b",
    title: "Task B",
    description: "Do task B",
    assignedAgent: "ReviewerAgent",
    status: "pending",
    dependsOn: [],
    fileLocks: [],
    expectedOutput: "notes",
    riskLevel: "low"
  });
  graph.edges.push({ from: "task-a", to: "task-b" });
  let executed = false;

  const result = await runCanonicalOrchestrationGraph({
    sessionId: graph.sessionId,
    taskGraph: graph,
    services: {
      executeTasks: async () => {
        executed = true;
        return { completed: 2, failed: 0, bankruptcyErrors: [] };
      }
    }
  });

  assert.equal(executed, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.finalStatus, "failed");
  assert.match(result.errors.join("\n"), /not mirrored by task task-b dependsOn/);
});

test("canonical orchestration graph rejects dependsOn entries without matching edges", async () => {
  const graph = oneTaskGraph();
  graph.nodes.push({
    id: "task-b",
    title: "Task B",
    description: "Do task B",
    assignedAgent: "ReviewerAgent",
    status: "pending",
    dependsOn: ["task-a"],
    fileLocks: [],
    expectedOutput: "notes",
    riskLevel: "low"
  });
  let executed = false;

  const result = await runCanonicalOrchestrationGraph({
    sessionId: graph.sessionId,
    taskGraph: graph,
    services: {
      executeTasks: async () => {
        executed = true;
        return { completed: 2, failed: 0, bankruptcyErrors: [] };
      }
    }
  });

  assert.equal(executed, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.finalStatus, "failed");
  assert.match(result.errors.join("\n"), /missing edge task-a -> task-b/);
});

function oneTaskGraph(): TaskGraph {
  return {
    sessionId: "session-canonical",
    nodes: [{
      id: "task-a",
      title: "Task A",
      description: "Do task A",
      assignedAgent: "ReviewerAgent",
      status: "pending",
      dependsOn: [],
      fileLocks: [],
      expectedOutput: "notes",
      riskLevel: "low"
    }],
    edges: []
  };
}
