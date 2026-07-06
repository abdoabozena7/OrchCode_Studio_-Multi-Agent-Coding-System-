import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, IntentContract } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import type { ConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import { RuntimePlanningTurnService, type RuntimePlanningTurnServices } from "../runtime/RuntimePlanningTurnService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimePlanningTurnService compiles intent, dispatches planning branch, and records resolved mode", async () => {
  const fixture = await createFixture();
  try {
    const calls: string[] = [];
    const services = planningServices({
      calls,
      session: fixture.session,
      compileReady: true
    });
    const result = await new RuntimePlanningTurnService(fixture.manager, services).run({
      sessionId: fixture.session.id,
      session: fixture.session,
      prompt: "run tests",
      conversationUnderstanding: runRequestUnderstanding(),
      decisionPipelineId: "decision_pipeline_test",
      providerContext: providerContext(),
      swarmMode: "recursive_tree"
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["compile:run tests", "simple:run tests"]);
    assert.equal(fixture.manager.getSession(fixture.session.id)?.resolvedExecutionMode, "simple_mode");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("RuntimePlanningTurnService blocks before prelude when intent contract is not ready", async () => {
  const fixture = await createFixture();
  try {
    const calls: string[] = [];
    const services = planningServices({
      calls,
      session: fixture.session,
      compileReady: false
    });
    const result = await new RuntimePlanningTurnService(fixture.manager, services).run({
      sessionId: fixture.session.id,
      session: fixture.session,
      prompt: "build feature",
      conversationUnderstanding: runRequestUnderstanding(),
      decisionPipelineId: "decision_pipeline_blocked",
      providerContext: providerContext(),
      swarmMode: "recursive_tree"
    });

    assert.equal(result.status, "needs_approval");
    assert.deepEqual(calls, ["compile:build feature", "block:build feature"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-planning-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "auto_mode",
    userPrompt: "run tests"
  });
  return { workspace, manager, session };
}

function planningServices(input: {
  calls: string[];
  session: AgentRuntimeSession;
  compileReady: boolean;
}): RuntimePlanningTurnServices {
  const contract = intentContract(input.compileReady ? "ready" : "needs_clarification");
  return {
    intentContract: {
      compile: async ({ originalRequest }: { originalRequest: string }) => {
        input.calls.push(`compile:${originalRequest}`);
        return {
          ready: input.compileReady,
          contract,
          blockingQuestions: input.compileReady ? [] : ["What should be built?"],
          validationErrors: [],
          errors: []
        };
      },
      blockPlanning: async ({ originalRequest }: { originalRequest: string }) => {
        input.calls.push(`block:${originalRequest}`);
        return { sessionId: input.session.id, status: "needs_approval" };
      }
    },
    recursiveSwarm: {
      run: async () => {
        input.calls.push("recursive_swarm");
        return { ...input.session, status: "completed" };
      }
    },
    recursiveFactoryPlanning: {
      startRecursiveFactory: async () => {
        input.calls.push("recursive_factory");
        return { ...input.session, status: "completed" };
      }
    },
    providerBackedSwarm: {
      run: async () => {
        input.calls.push("provider_backed_swarm");
        return { ...input.session, status: "completed" };
      }
    },
    runEngine: {
      run: async ({ prompt }: { prompt: string }) => {
        input.calls.push(`simple:${prompt}`);
        return { ...input.session, status: "completed" };
      }
    }
  } as unknown as RuntimePlanningTurnServices;
}

function intentContract(status: IntentContract["status"]): IntentContract {
  return {
    version: 1,
    status,
    original_user_request: "run tests",
    precise_rewrite: "run tests",
    task_type: "run",
    target_files: [],
    acceptance_criteria: [],
    constraints: [],
    assumptions: [],
    risks: [],
    blocking_questions: status === "ready" ? [] : ["What should be built?"],
    non_blocking_questions: [],
    provider_request_refs: [],
    created_at: new Date().toISOString()
  } as unknown as IntentContract;
}

function runRequestUnderstanding(): ConversationUnderstanding {
  return {
    originalMessage: "run tests",
    workspaceMessage: "run tests",
    preparedPrompt: {
      originalMessage: "run tests",
      workspaceMessage: "run tests",
      droppedPreamble: ""
    },
    intentDecision: {
      kind: "run_request",
      language: "english",
      needsWorkspace: true,
      confidence: "high",
      rationale: "Provider classified this as a run request."
    },
    routeDecision: {
      route: "simple_run",
      confidence: "high",
      language: "english",
      normalizedPrompt: "run tests",
      workspacePrompt: "run tests",
      rationale: "Provider classified this as a run request."
    }
  };
}

function providerContext() {
  return {
    provider: {},
    routerProvider: {},
    verifierProvider: {},
    telemetry: {
      snapshot: () => ({
        providerRequestRefs: [],
        providerRequestCount: 0,
        providerFailureCount: 0,
        providerTimeoutCount: 0,
        reasoningAttempts: 0,
        repairAttempts: 0,
        finalResponseSource: "none"
      })
    }
  } as never;
}
