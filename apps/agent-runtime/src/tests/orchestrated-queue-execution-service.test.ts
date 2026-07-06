import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentAssignmentPlan,
  IntentContract,
  ProjectMap,
  TaskGraph,
  WorkerOutput,
  WorkOrder
} from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { OrchestratedQueueExecutionService } from "../runtime/OrchestratedQueueExecutionService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("orchestrated queue execution service runs task graph through canonical queue path", async () => {
  const fixture = await createFixture("ok");
  try {
    const output = workerOutput(fixture.sessionId, "completed");
    const service = new OrchestratedQueueExecutionService(fixture.manager, undefined, {
      createWorkerExecution: () => ({
        createHandler: () => async () => ({
          status: "completed",
          outputSummary: "completed task-a",
          fingerprint: "completed task-a"
        }),
        snapshot: () => ({ outputs: [output], artifacts: [] })
      })
    });

    const result = await service.run(input(fixture, taskGraph(fixture.sessionId)));

    assert.equal(result.canonicalResult.graph.status, "awaiting_approval");
    assert.equal(result.taskExecution.completed, 1);
    assert.equal(result.taskExecution.failed, 0);
    assert.deepEqual(result.outputs, [output]);
    assert.deepEqual(result.lockedFiles, {});
    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.ok(session.orchestration?.orchestrationEvents.some((event) => event.type === "task.completed"));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("orchestrated queue execution service returns canonical blockers for failed tasks", async () => {
  const fixture = await createFixture("failed");
  try {
    const service = new OrchestratedQueueExecutionService(fixture.manager, undefined, {
      createWorkerExecution: () => ({
        createHandler: () => async () => ({
          status: "failed",
          outputSummary: "failed task-a",
          error: "fixture failure",
          fingerprint: "failed task-a"
        }),
        snapshot: () => ({ outputs: [workerOutput(fixture.sessionId, "failed")], artifacts: [] })
      })
    });

    const result = await service.run(input(fixture, taskGraph(fixture.sessionId)));

    assert.equal(result.canonicalResult.graph.status, "blocked");
    assert.equal(result.canonicalResult.graph.finalStatus, "failed");
    assert.equal(result.taskExecution.failed, 1);
    assert.match(result.canonicalResult.blockingReasons.join("\n"), /queued task\(s\) failed/);
    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.ok(session.orchestration?.orchestrationEvents.some((event) => event.type === "task.failed"));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("orchestrated queue execution service blocks when worker execution is not injected", async () => {
  const fixture = await createFixture("unconfigured");
  try {
    const service = new OrchestratedQueueExecutionService(fixture.manager);

    const result = await service.run(input(fixture, taskGraph(fixture.sessionId)));

    assert.equal(result.canonicalResult.graph.status, "blocked");
    assert.equal(result.taskExecution.completed, 0);
    assert.equal(result.taskExecution.failed, 1);
    assert.deepEqual(result.outputs, []);
    assert.match(result.canonicalResult.blockingReasons.join("\n"), /queued task\(s\) failed/);
    assert.match(result.canonicalResult.blockingReasons.join("\n"), /requires an injected provider-backed worker execution service/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-queue-execution-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, ".agent_memory"), { recursive: true });
  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "orchestrated_mode",
    userPrompt: "Build a small feature"
  });
  return { workspace, manager, sessionId: session.id, session };
}

function input(fixture: Awaited<ReturnType<typeof createFixture>>, graph: TaskGraph) {
  return {
    sessionId: fixture.sessionId,
    session: fixture.session,
    intentContract: readyIntentContract(fixture.sessionId),
    orchestrationMessage: "Build a small feature",
    projectMap: projectMap(),
    assignmentPlan: assignmentPlan(fixture),
    workOrders: [workOrder(fixture.sessionId)],
    taskGraph: graph
  };
}

function taskGraph(sessionId: string): TaskGraph {
  return {
    sessionId,
    nodes: [{
      id: "task-a",
      title: "Task A",
      description: "Run task A",
      assignedAgent: "ImplementationAgent",
      status: "pending",
      dependsOn: [],
      fileLocks: ["src/app.ts"],
      expectedOutput: "WorkerOutput",
      riskLevel: "low"
    }],
    edges: []
  };
}

function assignmentPlan(fixture: Awaited<ReturnType<typeof createFixture>>): AgentAssignmentPlan {
  return {
    id: "assignment-a",
    sessionId: fixture.sessionId,
    trustProfile: fixture.session.trustProfile,
    workerSpecs: [],
    rationale: "Fixture assignment plan.",
    createdAt: new Date().toISOString()
  };
}

function workOrder(sessionId: string): WorkOrder {
  return {
    id: "work-task-a",
    sessionId,
    agentName: "ImplementationAgent",
    dynamicRole: "Implementation",
    objective: "Implement the requested change",
    acceptanceCriteria: ["Change is implemented"],
    requiredArtifacts: ["src/app.ts"],
    allowedTools: ["read", "patch"],
    dependsOn: []
  };
}

function workerOutput(sessionId: string, status: WorkerOutput["status"]): WorkerOutput {
  return {
    id: `output-${status}`,
    sessionId,
    taskId: "task-a",
    agentName: "ImplementationAgent",
    summary: `${status} output`,
    details: [],
    patchProposalIds: [],
    commandRequestIds: [],
    risks: status === "completed" ? [] : ["fixture failure"],
    status,
    createdAt: new Date().toISOString()
  };
}

function projectMap(): ProjectMap {
  return {
    stack: ["typescript"],
    packageManagers: ["npm"],
    testCommands: ["npm test"],
    entryPoints: ["src/main.ts"],
    importantFiles: ["package.json", "src/main.ts"]
  };
}

function readyIntentContract(runId: string): IntentContract {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    contract_id: `contract_${runId}`,
    run_id: runId,
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: "Build a small feature",
    precise_rewrite: "Build a small feature",
    assumptions: ["Fixture supplies a ready provider-authored intent contract."],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced fixture priority." },
      quality: { score: 80, rationale: "Expect useful execution." },
      realism: { score: 70, rationale: "Match request." },
      fun: { score: 40, rationale: "Not central." },
      security: { score: 70, rationale: "Approval remains gated." },
      cost: { score: 50, rationale: "Fixture does not optimize cost." }
    },
    definition_of_done: ["Feature is implemented"],
    non_goals: [],
    conflict_rules: ["Preserve existing behavior unless explicitly changed."],
    status: "ready",
    created_at: now,
    metadata_json: {
      product_brief_user_intent: "add_feature"
    }
  };
}
