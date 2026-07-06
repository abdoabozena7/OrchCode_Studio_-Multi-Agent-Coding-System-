import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimePendingActionService } from "../runtime/RuntimePendingActionService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimePendingActionService routes preview confirmation through command approval", async () => {
  const fixture = await createFixture("preview");
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.nextAction = {
        kind: "confirm_preview",
        message: "Open preview?",
        preview: {
          type: "url",
          description: "Local dev server",
          command: "npm run dev",
          target: "http://localhost:5173"
        }
      };
    });

    const result = await new RuntimePendingActionService(fixture.manager)
      .handle(fixture.manager.getSession(fixture.sessionId)!, "yes run it");

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(result.handled, true);
    assert.equal(session.nextAction?.kind, "preview_ready");
    assert.equal(session.commandRequests.length, 1);
    assert.equal(session.commandRequests[0]?.status, "requested");
    assert.equal(session.commandRequests[0]?.provenance?.executionAuthority, undefined);
    assert.match(session.commandRequests[0]?.reason ?? "", /Rust terminal authority/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("RuntimePendingActionService records semantic conflict resolution without running execution", async () => {
  const fixture = await createFixture("semantic-conflict");
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.nextAction = {
        kind: "resolve_semantic_conflict",
        message: "Resolve conflict",
        decisionId: "decision_1",
        question: "Which goal wins?",
        options: [],
        evidenceRefs: []
      };
      const now = new Date().toISOString();
      draft.recursiveFactory = {
        phase: "branch_execution_blocked",
        executionStarted: false,
        updatedAt: now,
        semanticConflictDecisions: [{
          schema_version: 1,
          decision_id: "decision_1",
          batch_id: "batch_1",
          run_id: fixture.sessionId,
          phase: "planning",
          severity: "blocking",
          status: "requires_user_approval",
          source_a: "branch_a",
          source_b: "branch_b",
          root_intent: "Build feature",
          conflict: "Conflicting goals",
          reason: "Need user decision.",
          decision: "needs_user",
          requires_user_approval: true,
          question: "Which goal wins?",
          options: [],
          source_refs: [],
          evidence_refs: [],
          metadata_json: {},
          created_at: now
        }],
        semanticConflictBatches: [{
          schema_version: 1,
          batch_id: "batch_1",
          run_id: fixture.sessionId,
          phase: "planning",
          root_intent: "Build feature",
          status: "requires_user_approval",
          decisions: [],
          decision_ids: ["decision_1"],
          unresolved_decision_ids: ["decision_1"],
          provider_used: true,
          metadata_json: {},
          created_at: now
        }]
      };
      const factory = draft.recursiveFactory;
      factory.semanticConflictBatches![0]!.decisions = factory.semanticConflictDecisions!;
    });

    const result = await new RuntimePendingActionService(fixture.manager)
      .handle(fixture.manager.getSession(fixture.sessionId)!, "Prioritize reliability.");

    const session = fixture.manager.getSession(fixture.sessionId)!;
    const decision = session.recursiveFactory?.semanticConflictDecisions?.[0];
    const batch = session.recursiveFactory?.semanticConflictBatches?.[0];
    assert.equal(result.handled, true);
    assert.equal(session.nextAction, undefined);
    assert.equal(session.status, "needs_approval");
    assert.equal(decision?.requires_user_approval, false);
    assert.equal(decision?.status, "resolved");
    assert.equal(batch?.status, "resolved");
    assert.deepEqual(batch?.unresolved_decision_ids, []);
    assert.match(session.messages.at(-1)?.content ?? "", /Semantic conflict resolution recorded/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-pending-action-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
