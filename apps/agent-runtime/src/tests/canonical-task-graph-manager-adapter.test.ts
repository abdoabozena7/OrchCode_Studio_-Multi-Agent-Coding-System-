import assert from "node:assert/strict";
import test from "node:test";
import {
  runTaskGraphManagerThroughCanonicalGraph,
  taskGraphManagerBlockingReasons,
  taskGraphManagerTasksToTaskExecution,
  taskGraphManagerTasksToTaskGraph
} from "../orchestration/CanonicalTaskGraphManagerAdapter.js";
import { ORCHESTRATION_SCHEMA_VERSION, type AgentRoleName, type Task, type TaskStatus } from "../orchestration/OrchestrationModels.js";

test("canonical TaskGraphManager adapter converts tasks to the shared task graph shape", () => {
  const tasks = [
    task("map", "ScoutAgent", "succeeded"),
    task("implement", "ExecutorAgent", "pending", ["map"], ["src/app.ts"])
  ];

  const graph = taskGraphManagerTasksToTaskGraph("run_task_graph", tasks);

  assert.equal(graph.sessionId, "run_task_graph");
  assert.deepEqual(graph.nodes.map((node) => node.id), ["map", "implement"]);
  assert.equal(graph.nodes.find((node) => node.id === "map")?.status, "completed");
  assert.equal(graph.nodes.find((node) => node.id === "implement")?.riskLevel, "medium");
  assert.deepEqual(graph.nodes.find((node) => node.id === "implement")?.fileLocks, ["src/app.ts"]);
  assert.deepEqual(graph.edges, [{ from: "map", to: "implement" }]);
});

test("canonical TaskGraphManager adapter executes legacy task state through the shared lifecycle graph", async () => {
  const tasks = [task("task-a", "ScoutAgent", "pending")];
  let executed = false;

  const result = await runTaskGraphManagerThroughCanonicalGraph({
    sessionId: "run_task_graph",
    tasks,
    executeTasks: async (graph) => {
      executed = true;
      assert.equal(graph.nodes[0]?.id, "task-a");
      return [{ ...tasks[0]!, status: "succeeded" }];
    }
  });

  assert.equal(executed, true);
  assert.equal(result.graph.status, "awaiting_approval");
  assert.equal(result.graph.finalStatus, "needs_approval");
  assert.equal(result.taskExecution.completed, 1);
  assert.equal(result.taskExecution.failed, 0);
  assert.deepEqual(result.blockingReasons, []);
});

test("canonical TaskGraphManager adapter reports blocked or failed task state as graph blockers", async () => {
  const tasks = [task("task-a", "ExecutorAgent", "pending")];

  const result = await runTaskGraphManagerThroughCanonicalGraph({
    sessionId: "run_task_graph",
    tasks,
    executeTasks: async () => [{ ...tasks[0]!, status: "blocked", result_summary: "Waiting on unsafe lock conflict." }]
  });

  assert.equal(result.graph.status, "blocked");
  assert.equal(result.graph.finalStatus, "failed");
  assert.equal(result.taskExecution.completed, 0);
  assert.equal(result.taskExecution.failed, 1);
  assert.deepEqual(result.blockingReasons, [
    "TaskGraphManager task task-a blocked: Waiting on unsafe lock conflict."
  ]);
});

test("canonical TaskGraphManager adapter blocks malformed dependencies before execution", async () => {
  const tasks = [task("task-a", "ScoutAgent", "pending", ["missing-task"])];
  let executed = false;

  const result = await runTaskGraphManagerThroughCanonicalGraph({
    sessionId: "run_task_graph",
    tasks,
    executeTasks: async () => {
      executed = true;
      return tasks;
    }
  });

  assert.equal(executed, false);
  assert.equal(result.graph.status, "blocked");
  assert.equal(result.graph.finalStatus, "failed");
  assert.equal(result.taskExecution.completed, 0);
  assert.equal(result.taskExecution.failed, 0);
  assert.match(result.blockingReasons.join("\n"), /missing-task/);
});

test("canonical TaskGraphManager execution summary treats skipped tasks as completed", () => {
  assert.deepEqual(taskGraphManagerTasksToTaskExecution([
    task("done", "ScoutAgent", "succeeded"),
    task("skip", "ScoutAgent", "skipped"),
    task("block", "ExecutorAgent", "blocked")
  ]), {
    completed: 2,
    failed: 1,
    bankruptcyErrors: []
  });
});

test("canonical TaskGraphManager blockers preserve per-task failure summaries", () => {
  assert.deepEqual(taskGraphManagerBlockingReasons([
    task("done", "ScoutAgent", "succeeded"),
    { ...task("blocked", "ExecutorAgent", "blocked"), result_summary: "Dependency never completed." },
    task("failed", "IntegratorAgent", "failed")
  ]), [
    "TaskGraphManager task blocked blocked: Dependency never completed.",
    "TaskGraphManager task failed failed."
  ]);
});

function task(
  id: string,
  role: AgentRoleName,
  status: TaskStatus,
  dependencies: string[] = [],
  allowedFiles: string[] = []
): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: "run_task_graph",
    title: `Task ${id}`,
    objective: `Complete ${id}`,
    role_required: role,
    status,
    dependencies,
    relevant_files: allowedFiles,
    allowed_files_to_edit: allowedFiles,
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}
