import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderAuthoredResult, ReasoningEvidenceRef } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import type { IntentDecision } from "../runtime/IntentDecisionEngine.js";
import {
  citedEvidenceTargetFiles,
  RuntimeDirectTurnService
} from "../runtime/RuntimeDirectTurnService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimeDirectTurnService records provider progress and direct answer lifecycle", async () => {
  const fixture = await directTurnFixture();
  try {
    const service = new RuntimeDirectTurnService(fixture.manager);
    await service.addProviderProgressEvent(fixture.session.id, {
      stage: "planning",
      status: "running",
      title: "Understanding request with provider",
      summary: "Waiting for provider."
    });

    const progress = fixture.manager.getSession(fixture.session.id)?.progressEvents ?? [];
    assert.equal(progress.length, 1);
    assert.equal(progress[0]?.agentName, "ReasoningKernel");

    const result = await service.completeDirectConversationTurn({
      sessionId: fixture.session.id,
      message: "Explain src/main.ts",
      decision: intentDecision(),
      result: providerResult(),
      evidenceRefs: evidenceRefs()
    });
    const session = fixture.manager.getSession(fixture.session.id)!;

    assert.equal(result.status, "completed");
    assert.equal(session.status, "completed");
    assert.equal(session.lifecycleStage, "DONE");
    assert.equal(session.messages.at(-1)?.role, "assistant");
    assert.match(session.messages.at(-1)?.content ?? "", /Provider-authored answer/);
    assert.equal(session.runSummary?.gates[0]?.name, "Pre-retrieval intent decision");
    assert.equal(session.progressEvents.some((event) => event.role === "Direct Conversation" && event.targetFiles.includes("src/main.ts")), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
    await rm(fixture.storageDir, { recursive: true, force: true });
  }
});

test("citedEvidenceTargetFiles returns normalized unique cited workspace paths", () => {
  assert.deepEqual(citedEvidenceTargetFiles(["e1", "e2", "missing"], evidenceRefs()), [
    "src/main.ts",
    "src/other.ts"
  ]);
});

async function directTurnFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-direct-turn-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-direct-turn-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "Explain src/main.ts"
  });
  await manager.updateSession(session.id, (draft) => {
    draft.providerTelemetry = {
      providerMode: "real_provider",
      providerName: "test-provider",
      modelName: "test-model",
      providerRequestCount: 1,
      realProviderRequestCount: 1,
      providerResponseCount: 1,
      providerFailureCount: 0,
      providerTimeoutCount: 0,
      totalProviderLatencyMs: 1,
      totalProviderPromptChars: 10,
      totalProviderResponseChars: 10,
      totalProviderContextChars: 0,
      perPromptProviderLatencyMs: [],
      reasoningAttempts: 1,
      repairAttempts: 0,
      providerRequestRefs: ["provider_request_test_1"],
      finalResponseSource: "provider",
      modelCertification: { status: "uncertified" },
      activeProviderSource: "session_override",
      updatedAt: "2026-06-29T00:00:00.000Z"
    };
  });
  return { workspace, storageDir, manager, session };
}

function intentDecision(): IntentDecision {
  return {
    kind: "workspace_question",
    language: "english",
    needsWorkspace: true,
    confidence: "high",
    rationale: "The user asked for a grounded workspace answer."
  };
}

function providerResult(): ProviderAuthoredResult {
  return {
    decision: "ANSWER",
    answerMarkdown: "Provider-authored answer.",
    claims: [],
    evidenceRefs: ["e1", "e2"],
    unknowns: [],
    rationale: "The provider answered from cited evidence."
  };
}

function evidenceRefs(): ReasoningEvidenceRef[] {
  return [
    {
      id: "e1",
      sourceType: "workspace_file",
      summary: "Main file",
      path: "./src/main.ts",
      createdAt: "2026-06-29T00:00:00.000Z"
    },
    {
      id: "e2",
      sourceType: "workspace_file",
      summary: "Other file",
      path: "src\\other.ts",
      createdAt: "2026-06-29T00:00:00.000Z"
    },
    {
      id: "e3",
      sourceType: "workspace_file",
      summary: "Uncited file",
      path: "src/uncited.ts",
      createdAt: "2026-06-29T00:00:00.000Z"
    }
  ];
}
