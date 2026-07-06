import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract, ProjectMap } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { OrchestratedPlanningRecorder, formatOrchestratedPlanModeMessage } from "../runtime/OrchestratedPlanningRecorder.js";
import { OrchestratedPlanningService } from "../runtime/OrchestratedPlanningService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("orchestrated planning recorder persists planning lifecycle and queued work", async () => {
  const fixture = await createFixture("record");
  try {
    const planning = new OrchestratedPlanningService().plan({
      sessionId: fixture.sessionId,
      workspacePath: fixture.workspace,
      intentContract: readyIntentContract(fixture.sessionId),
      projectMap: projectMap()
    });
    const recorder = new OrchestratedPlanningRecorder(fixture.manager);

    await recorder.start(fixture.sessionId);
    await recorder.record({ sessionId: fixture.sessionId, planning });

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.status, "running");
    assert.equal(session.lifecycleStage, "PLAN");
    assert.equal(session.agentName, "Dynamic Working Team");
    assert.equal(session.orchestration?.productBrief?.goal, "Build a small feature");
    assert.equal(session.orchestration?.businessBrief?.acceptanceCriteria.length, 2);
    assert.equal(session.orchestration?.technicalPlan?.taskGraph.nodes.length, planning.engineering.technicalPlan.taskGraph.nodes.length);
    assert.deepEqual(session.orchestration?.selectedWorkerAgents, planning.engineering.delegationDecision.selectedAgentRoles);
    assert.equal(session.orchestration?.agentRuns.length, 3);
    assert.equal(session.agentWorkStatuses.length, planning.engineering.workOrders.length);
    assert.ok(session.orchestration?.orchestrationEvents.some((event) => event.type === "technical_plan.created"));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("orchestrated planning recorder stops plan mode at confirmation boundary", async () => {
  const fixture = await createFixture("plan-mode");
  try {
    const planning = new OrchestratedPlanningService().plan({
      sessionId: fixture.sessionId,
      workspacePath: fixture.workspace,
      intentContract: readyIntentContract(fixture.sessionId),
      projectMap: projectMap()
    });
    const recorder = new OrchestratedPlanningRecorder(fixture.manager);

    await recorder.stopForPlanConfirmation({
      sessionId: fixture.sessionId,
      planning,
      orchestrationMessage: "Build a small feature"
    });

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.status, "needs_approval");
    assert.equal(session.lifecycleStage, "PLAN");
    assert.equal(session.nextAction?.kind, "confirm_plan");
    assert.equal(session.messages.at(-1)?.role, "system");
    assert.match(session.messages.at(-1)?.content ?? "", /Work Breakdown/);
    assert.match(formatOrchestratedPlanModeMessage(planning, "Build a small feature"), /Acceptance Criteria/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-planning-recorder-${name}-${Date.now()}`);
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
  return { workspace, manager, sessionId: session.id };
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
      quality: { score: 80, rationale: "Expect useful planning." },
      realism: { score: 70, rationale: "Match request." },
      fun: { score: 40, rationale: "Not central." },
      security: { score: 70, rationale: "Approval remains gated." },
      cost: { score: 50, rationale: "Fixture does not optimize cost." }
    },
    definition_of_done: ["Feature is implemented", "Tests are identified"],
    non_goals: [],
    conflict_rules: ["Preserve existing behavior unless explicitly changed."],
    status: "ready",
    created_at: now,
    metadata_json: {
      product_brief_user_intent: "add_feature"
    }
  };
}
