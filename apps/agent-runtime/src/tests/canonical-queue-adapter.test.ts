import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskGraph } from "@hivo/protocol";
import {
  QueueDrivenTaskScheduler,
  runQueueSchedulerThroughCanonicalGraph
} from "../orchestration/index.js";

test("canonical queue adapter runs QueueDrivenTaskScheduler through the shared graph lifecycle", async () => {
  const workspace = await fixtureWorkspace("canonical-queue-ok");
  try {
    const scheduler = queueScheduler(workspace, "session-queue-ok");
    const result = await runQueueSchedulerThroughCanonicalGraph({
      sessionId: "session-queue-ok",
      taskGraph: oneTaskGraph("session-queue-ok"),
      scheduler,
      handler: async () => ({
        status: "completed",
        outputSummary: "completed task-a",
        fingerprint: "completed task-a"
      })
    });

    assert.equal(result.graph.status, "awaiting_approval");
    assert.equal(result.graph.finalStatus, "needs_approval");
    assert.equal(result.taskExecution.completed, 1);
    assert.equal(result.taskExecution.failed, 0);
    assert.equal(result.events.some((event) => event.type === "task.completed"), true);
    scheduler.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical queue scheduler advances newly unblocked dependency tasks", async () => {
  const workspace = await fixtureWorkspace("canonical-queue-dependencies");
  try {
    const scheduler = queueScheduler(workspace, "session-queue-dependencies");
    const observedTasks: string[] = [];
    const graph = dependentTaskGraph("session-queue-dependencies");

    const result = await runQueueSchedulerThroughCanonicalGraph({
      sessionId: "session-queue-dependencies",
      taskGraph: graph,
      scheduler,
      handler: async (task) => {
        observedTasks.push(task.id);
        return {
          status: "completed",
          outputSummary: `completed ${task.id}`,
          fingerprint: `completed ${task.id}`
        };
      }
    });

    assert.deepEqual(observedTasks, ["task-a", "task-b"]);
    assert.equal(result.graph.status, "awaiting_approval");
    assert.equal(result.graph.finalStatus, "needs_approval");
    assert.equal(result.taskExecution.completed, 2);
    assert.equal(result.taskExecution.failed, 0);
    assert.equal(graph.nodes.find((node) => node.id === "task-b")?.status, "completed");
    scheduler.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical queue scheduler blocks pending tasks with unresolved dependency state", async () => {
  const workspace = await fixtureWorkspace("canonical-queue-unresolved");
  try {
    const scheduler = queueScheduler(workspace, "session-queue-unresolved");
    const graph = dependentTaskGraph("session-queue-unresolved");
    graph.nodes[0]!.status = "failed";
    let executed = false;

    const result = await runQueueSchedulerThroughCanonicalGraph({
      sessionId: "session-queue-unresolved",
      taskGraph: graph,
      scheduler,
      handler: async () => {
        executed = true;
        return { status: "completed", outputSummary: "should not run" };
      }
    });

    assert.equal(executed, false);
    assert.equal(result.graph.status, "blocked");
    assert.equal(result.graph.finalStatus, "failed");
    assert.equal(result.taskExecution.completed, 0);
    assert.equal(result.taskExecution.failed, 1);
    assert.equal(graph.nodes.find((node) => node.id === "task-b")?.status, "blocked");
    assert.match(result.blockingReasons.join("\n"), /queued task\(s\) failed/);
    scheduler.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical queue adapter converts exhausted queue failures into graph review blockers", async () => {
  const workspace = await fixtureWorkspace("canonical-queue-fail");
  try {
    const scheduler = queueScheduler(workspace, "session-queue-fail");
    const result = await runQueueSchedulerThroughCanonicalGraph({
      sessionId: "session-queue-fail",
      taskGraph: oneTaskGraph("session-queue-fail"),
      scheduler,
      handler: async () => ({
        status: "failed",
        outputSummary: "failed task-a",
        error: "fixture failure",
        fingerprint: "failed task-a"
      })
    });

    assert.equal(result.graph.status, "blocked");
    assert.equal(result.graph.finalStatus, "failed");
    assert.equal(result.taskExecution.completed, 0);
    assert.equal(result.taskExecution.failed, 1);
    assert.match(result.blockingReasons.join("\n"), /queued task\(s\) failed/);
    scheduler.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("queue scheduler uses canonical lock snapshots during task execution", async () => {
  const workspace = await fixtureWorkspace("canonical-queue-locks");
  try {
    const scheduler = queueScheduler(workspace, "session-queue-locks");
    const graph = oneTaskGraph("session-queue-locks");
    graph.nodes[0]!.fileLocks = ["src/a.ts"];
    let observedLocks: Record<string, string> = {};

    const result = await runQueueSchedulerThroughCanonicalGraph({
      sessionId: "session-queue-locks",
      taskGraph: graph,
      scheduler,
      handler: async () => {
        observedLocks = scheduler.lockSnapshot();
        return {
          status: "completed",
          outputSummary: "completed task-a",
          fingerprint: "completed task-a"
        };
      }
    });

    assert.equal(result.graph.status, "awaiting_approval");
    assert.equal(observedLocks["src/a.ts"], "task-a");
    assert.deepEqual(scheduler.lockSnapshot(), {});
    scheduler.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical queue adapter blocks malformed task graphs before queue execution", async () => {
  const workspace = await fixtureWorkspace("canonical-queue-invalid");
  try {
    const scheduler = queueScheduler(workspace, "session-queue-invalid");
    let executed = false;
    const graph = oneTaskGraph("session-queue-invalid");
    graph.nodes[0]!.dependsOn = ["missing-task"];

    const result = await runQueueSchedulerThroughCanonicalGraph({
      sessionId: "session-queue-invalid",
      taskGraph: graph,
      scheduler,
      handler: async () => {
        executed = true;
        return { status: "completed", outputSummary: "should not run" };
      }
    });

    assert.equal(executed, false);
    assert.equal(result.graph.status, "blocked");
    assert.equal(result.graph.finalStatus, "failed");
    assert.match(result.blockingReasons.join("\n"), /missing-task/);
    scheduler.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, ".agent_memory"), { recursive: true });
  return workspace;
}

function queueScheduler(workspace: string, sessionId: string) {
  return new QueueDrivenTaskScheduler(
    {
      queueDir: path.join(workspace, ".agent_memory"),
      sessionId,
      orchestratorName: "CanonicalQueueAdapterTest",
      maxParallelTasks: 1,
      taskQueuePollMs: 1
    },
    {
      enable_task_queue: true,
      enable_suspend_hydrate: false,
      enable_circuit_breaker: true,
      task_queue_max_attempts: 1,
      max_bankruptcy_attempts: 5,
      max_circuit_breaker_duplicate_outputs: 5,
      max_circuit_breaker_stagnant_rounds: 5
    }
  );
}

function oneTaskGraph(sessionId: string): TaskGraph {
  return {
    sessionId,
    nodes: [{
      id: "task-a",
      title: "Task A",
      description: "Run task A",
      assignedAgent: "WorkerAgent",
      status: "pending",
      dependsOn: [],
      fileLocks: [],
      expectedOutput: "WorkerOutput",
      riskLevel: "low"
    }],
    edges: []
  };
}

function dependentTaskGraph(sessionId: string): TaskGraph {
  const graph = oneTaskGraph(sessionId);
  graph.nodes.push({
    id: "task-b",
    title: "Task B",
    description: "Run task B after task A",
    assignedAgent: "WorkerAgent",
    status: "pending",
    dependsOn: ["task-a"],
    fileLocks: [],
    expectedOutput: "WorkerOutput",
    riskLevel: "low"
  });
  graph.edges.push({ from: "task-a", to: "task-b" });
  return graph;
}
