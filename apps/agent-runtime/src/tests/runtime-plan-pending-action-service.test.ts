import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimePlanPendingActionService } from "../runtime/RuntimePlanPendingActionService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("runtime plan pending action records selected clarification and resumes planning", async () => {
  const fixture = await createFixture("clarify");
  const recorded: string[] = [];
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.nextAction = {
        kind: "clarify_plan",
        message: "Choose plan focus.",
        options: [{
          id: "architecture",
          label: "Architecture",
          prompt: "Focus on architecture and data flow."
        }],
        allowCustom: true
      };
    });

    const result = await new RuntimePlanPendingActionService(fixture.manager, async (_session, term, definition, source) => {
      recorded.push(`${term}:${definition}:${source}`);
    }).handle(fixture.manager.getSession(fixture.sessionId)!, "architecture");

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(result.matched, true);
    assert.equal(result.handled, false);
    assert.match(result.resumePrompt ?? "", /Plan mode clarification: Focus on architecture/);
    assert.equal(session.nextAction, undefined);
    assert.equal(session.thinkFirst, true);
    assert.match(session.userPrompt, /Plan mode clarification: Focus on architecture/);
    assert.deepEqual(recorded, ["plan_mode_clarification:Focus on architecture and data flow.:plan_clarification"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("runtime plan pending action proceeds from confirm plan", async () => {
  const fixture = await createFixture("confirm-proceed");
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.thinkFirst = true;
      draft.nextAction = { kind: "confirm_plan", message: "Plan is ready." };
    });

    const result = await new RuntimePlanPendingActionService(fixture.manager)
      .handle(fixture.manager.getSession(fixture.sessionId)!, "go ahead and implement");

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(result.matched, true);
    assert.equal(result.handled, false);
    assert.equal(result.resumePrompt, "Build a small feature");
    assert.equal(session.nextAction, undefined);
    assert.equal(session.thinkFirst, false);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("runtime plan pending action keeps waiting when confirmation is not approval", async () => {
  const fixture = await createFixture("confirm-wait");
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.nextAction = { kind: "confirm_plan", message: "Plan is ready." };
    });

    const result = await new RuntimePlanPendingActionService(fixture.manager)
      .handle(fixture.manager.getSession(fixture.sessionId)!, "not yet");

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(result.matched, true);
    assert.equal(result.handled, true);
    assert.equal(session.nextAction?.kind, "confirm_plan");
    assert.equal(session.messages.at(-1)?.role, "system");
    assert.match(session.messages.at(-1)?.content ?? "", /Review the plan/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-plan-pending-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
