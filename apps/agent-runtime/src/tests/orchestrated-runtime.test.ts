import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract, ProjectMap, TaskGraph } from "@hivo/protocol";
import type { OrchestratedPlanningResult } from "../runtime/OrchestratedPlanningService.js";
import { EventBus } from "../runtime/EventBus.js";
import { OrchestratedRuntime } from "../runtime/OrchestratedRuntime.js";
import type { OrchestratedCompletionInput, OrchestratedCompletionResult } from "../runtime/OrchestratedCompletionService.js";
import type { OrchestratedQueueExecutionInput, OrchestratedQueueExecutionResult } from "../runtime/OrchestratedQueueExecutionService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("OrchestratedRuntime composes injected planning, queue execution, and completion services", async () => {
  const fixture = await createFixture("facade");
  const intentContract = readyIntentContract(fixture.sessionId, "Refactor ordinary orchestration facade");
  await fixture.manager.updateSession(fixture.sessionId, (draft) => {
    draft.intentContract = intentContract;
    draft.intent_contract_status = "ready";
  });

  const taskGraph = simpleTaskGraph(fixture.sessionId);
  const projectMap: ProjectMap = {
    stack: ["typescript"],
    packageManagers: ["npm"],
    testCommands: ["npm run typecheck"],
    entryPoints: ["apps/agent-runtime/src/runtime/OrchestratedRuntime.ts"],
    importantFiles: ["apps/agent-runtime/src/runtime/OrchestratedRuntime.ts"]
  };
  const calls: string[] = [];
  let observedQueueInput: OrchestratedQueueExecutionInput | undefined;
  let observedCompletionInput: OrchestratedCompletionInput | undefined;

  try {
    const runtime = new OrchestratedRuntime(fixture.manager, {
      planningRecorder: {
        start: async (sessionId) => {
          calls.push(`planning.start:${sessionId}`);
        },
        record: async () => {
          calls.push("planning.record");
        },
        stopForPlanConfirmation: async () => {
          calls.push("planning.stop");
        }
      },
      planningService: {
        plan: (input) => {
          calls.push(`planning.plan:${input.intentContract.contract_id}`);
          return planningResult(projectMap, taskGraph);
        }
      },
      queueExecutionService: {
        run: async (input) => {
          observedQueueInput = input;
          calls.push(`queue.run:${input.taskGraph.nodes.length}`);
          return queueResult(taskGraph);
        }
      },
      completionService: {
        complete: async (input) => {
          observedCompletionInput = input;
          calls.push(`completion.complete:${input.canonicalGraphStatus}`);
          return {} as OrchestratedCompletionResult;
        }
      }
    });

    const result = await runtime.run(fixture.sessionId, "Refactor ordinary orchestration facade", {
      projectMap,
      intentContract
    });

    assert.equal(result.id, fixture.sessionId);
    assert.deepEqual(calls, [
      `planning.start:${fixture.sessionId}`,
      `planning.plan:${intentContract.contract_id}`,
      "planning.record",
      "queue.run:1",
      "completion.complete:awaiting_approval"
    ]);
    assert.equal(observedQueueInput?.orchestrationMessage, intentContract.precise_rewrite);
    assert.equal(observedQueueInput?.projectMap, projectMap);
    assert.equal(observedCompletionInput?.taskGraph, taskGraph);
    assert.equal(observedCompletionInput?.taskExecution.completed, 1);
    assert.deepEqual(observedCompletionInput?.canonicalBlockingReasons, []);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-orchestrated-runtime-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "orchestrated_mode",
    userPrompt: "Refactor ordinary orchestration facade"
  });
  return { workspace, manager, sessionId: session.id };
}

function planningResult(projectMap: ProjectMap, taskGraph: TaskGraph): OrchestratedPlanningResult {
  return {
    projectMap,
    productBrief: {
      goal: "Refactor ordinary orchestration facade",
      userIntent: "refactor",
      scope: ["runtime facade"],
      constraints: ["Preserve approval boundary"],
      successCriteria: ["Facade delegates to services"],
      clarifyingQuestions: [],
      assumptions: []
    },
    businessBrief: {
      targetUser: "operator",
      valueProposition: "Simpler orchestration extension point",
      userJourneys: [],
      risks: [],
      priorities: []
    },
    engineering: {
      assignmentPlan: {
        id: "assignment-plan",
        sessionId: taskGraph.sessionId,
        trustProfile: "restricted",
        workerSpecs: [],
        rationale: "Fixture assignment plan.",
        createdAt: new Date().toISOString()
      },
      delegationDecision: {
        resolvedMode: "orchestrated_mode",
        selectedAgentCount: 1,
        selectedAgentRoles: ["TestAgent"],
        agentRoleReasons: [],
        estimatedComplexity: "low",
        rationale: "Fixture delegation."
      },
      technicalPlan: {
        id: "technical-plan",
        sessionId: taskGraph.sessionId,
        summary: "Fixture technical plan.",
        tasks: [],
        taskGraph,
        risks: [],
        createdAt: new Date().toISOString()
      },
      workOrders: []
    }
  } as unknown as OrchestratedPlanningResult;
}

function queueResult(taskGraph: TaskGraph): OrchestratedQueueExecutionResult {
  return {
    canonicalResult: {
      taskGraph,
      graph: {
        sessionId: taskGraph.sessionId,
        taskGraph,
        services: {
          executeTasks: async () => ({ completed: 1, failed: 0, bankruptcyErrors: [] })
        },
        status: "awaiting_approval",
        taskExecution: { completed: 1, failed: 0, bankruptcyErrors: [] },
        review: { passed: true, blockingReasons: [] },
        finalStatus: "needs_approval",
        errors: [],
        events: []
      },
      taskExecution: { completed: 1, failed: 0, bankruptcyErrors: [] },
      events: [],
      blockingReasons: []
    },
    taskExecution: { completed: 1, failed: 0, bankruptcyErrors: [] },
    outputs: [],
    lockedFiles: {}
  };
}

function simpleTaskGraph(sessionId: string): TaskGraph {
  return {
    sessionId,
    nodes: [{
      id: "task-a",
      title: "Task A",
      description: "Run task A",
      assignedAgent: "TestAgent",
      status: "completed",
      dependsOn: [],
      fileLocks: [],
      expectedOutput: "WorkerOutput",
      riskLevel: "low"
    }],
    edges: []
  };
}

function readyIntentContract(sessionId: string, request: string): IntentContract {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    contract_id: `contract_${sessionId}`,
    run_id: sessionId,
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: request,
    precise_rewrite: request,
    assumptions: ["Fixture supplies a ready provider-authored intent contract."],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced fixture priority." },
      quality: { score: 80, rationale: "Expect useful planning." },
      realism: { score: 70, rationale: "Match request." },
      fun: { score: 20, rationale: "Not relevant." },
      security: { score: 90, rationale: "Approval remains gated." },
      cost: { score: 50, rationale: "Fixture does not optimize cost." }
    },
    definition_of_done: ["Facade delegates to injected services."],
    non_goals: [],
    conflict_rules: ["Preserve existing behavior unless explicitly changed."],
    status: "ready",
    created_at: now,
    metadata_json: {}
  };
}
