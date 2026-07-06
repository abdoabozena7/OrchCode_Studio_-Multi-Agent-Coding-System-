import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppEvent, ProjectMap } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimeRecursiveFactoryPlanningService } from "../runtime/RuntimeRecursiveFactoryPlanningService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimeRecursiveFactoryPlanningService starts planning and advances approvals to recursive graph", async () => {
  const fixture = await recursiveFactoryFixture();
  try {
    const session = await fixture.service.startRecursiveFactory(fixture.sessionId, detailedPrompt(), projectMap());
    assert.equal(session.status, "needs_approval");
    assert.equal(session.recursiveFactory?.phase, "product_spec_approval");
    assert.equal(session.nextAction?.kind, "approve_product_spec");
    assert.equal(session.artifacts.some((artifact) => artifact.type === "product_spec"), true);

    await fixture.service.decideProductSpec(fixture.sessionId, { decision: "approved" });
    let updated = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(updated.recursiveFactory?.productSpec?.status, "approved");
    assert.equal(updated.recursiveFactory?.phase, "technical_plan_approval");
    assert.equal(updated.nextAction?.kind, "approve_technical_plan");
    assert.equal(updated.artifacts.some((artifact) => artifact.type === "technical_plan"), true);

    await fixture.service.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    updated = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(updated.recursiveFactory?.technicalPlan?.status, "approved");
    assert.ok(updated.recursiveFactory?.recursiveGraph);
    assert.equal(updated.recursiveFactory?.executionStarted, false);
    assert.equal(updated.commandRequests.length, 0);
    assert.equal(updated.patchProposals.length, 0);
    assert.equal(updated.artifacts.some((artifact) => artifact.type === "recursive_graph"), true);
    assert.equal(updated.artifacts.some((artifact) => artifact.type === "branch_orchestrator"), true);
    assert.deepEqual(fixture.events.filter(isFactoryPlanningEvent).map((event) => event.type), [
      "runtime.product_spec.proposed",
      "runtime.product_spec.approved",
      "runtime.technical_plan.proposed",
      "runtime.technical_plan.approved",
      "runtime.recursive_graph.proposed",
      "runtime.recursive_graph.ready"
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("RuntimeRecursiveFactoryPlanningService records revision feedback without execution", async () => {
  const fixture = await recursiveFactoryFixture();
  try {
    await fixture.service.startRecursiveFactory(fixture.sessionId, detailedPrompt(), projectMap());
    await fixture.service.decideProductSpec(fixture.sessionId, {
      decision: "changes_requested",
      feedback: "Make operators the primary users."
    });
    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.status, "needs_approval");
    assert.equal(session.recursiveFactory?.productSpec?.revision, 2);
    assert.match(session.messages.at(-1)?.content ?? "", /Revision feedback/);
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.patchProposals.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

async function recursiveFactoryFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-recursive-factory-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-recursive-factory-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const events: AppEvent[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe((event) => events.push(event));
  const manager = new SessionManager(storageDir, eventBus, {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: detailedPrompt()
  });
  return {
    workspace,
    storageDir,
    events,
    manager,
    sessionId: session.id,
    service: new RuntimeRecursiveFactoryPlanningService(manager),
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

function detailedPrompt() {
  return "Build an operator dashboard feature for team users that must show status, audit history, and pass tests when done.";
}

function projectMap(): ProjectMap {
  return {
    stack: ["typescript"],
    packageManagers: ["npm"],
    testCommands: ["npm test"],
    entryPoints: ["src/main.ts"],
    importantFiles: ["src/main.ts", "src/dashboard.ts", "package.json"]
  };
}

function isFactoryPlanningEvent(event: AppEvent) {
  return event.type === "runtime.product_spec.proposed"
    || event.type === "runtime.product_spec.approved"
    || event.type === "runtime.technical_plan.proposed"
    || event.type === "runtime.technical_plan.approved"
    || event.type === "runtime.recursive_graph.proposed"
    || event.type === "runtime.recursive_graph.ready";
}
