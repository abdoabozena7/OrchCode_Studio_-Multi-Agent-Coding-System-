import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract } from "@hivo/protocol";
import { createProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimeIntentContractService } from "../runtime/RuntimeIntentContractService.js";
import { SessionManager } from "../runtime/SessionManager.js";
import type { UserIntentCompilationResult } from "../orchestration/UserIntentCompiler.js";

test("RuntimeIntentContractService reuses an existing ready contract without provider work", async () => {
  const fixture = await intentContractFixture("ready");
  try {
    const contract = intentContract("cached_ready", "ready");
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.intentContract = contract;
      draft.intent_contract_ref = contract.artifact_ref;
      draft.intent_contract_status = "ready";
    });
    const provider = new ThrowingProvider();
    const result = await new RuntimeIntentContractService(fixture.manager).compile({
      sessionId: fixture.session.id,
      originalRequest: "Build the thing",
      provider,
      parentContext: { route: "simple_run" }
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.contract_id, "cached_ready");
    assert.equal(provider.calls, 0);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
    await rm(fixture.storageDir, { recursive: true, force: true });
  }
});

test("RuntimeIntentContractService blocks planning on clarification contracts", async () => {
  const fixture = await intentContractFixture("clarify");
  try {
    const contract = intentContract("needs_clarification_contract", "needs_clarification");
    const compilation: UserIntentCompilationResult = {
      ready: false,
      contract,
      blockingQuestions: ["Which API should be integrated?"],
      validationErrors: [],
      errors: []
    };
    const result = await new RuntimeIntentContractService(fixture.manager).blockPlanning({
      sessionId: fixture.session.id,
      originalRequest: "Build the integration",
      compilation,
      providerTelemetry: createProviderTelemetryRecorder({ mode: "real_provider" })
    });
    const session = fixture.manager.getSession(fixture.session.id)!;

    assert.equal(result.status, "needs_approval");
    assert.equal(session.status, "needs_approval");
    assert.equal(session.lifecycleStage, "PLAN");
    assert.equal(session.intent_contract_status, "needs_clarification");
    assert.equal(session.nextAction?.kind, "clarify_request");
    assert.equal(session.runSummary?.gates[0]?.name, "Intent contract gate");
    assert.match(session.messages.at(-1)?.content ?? "", /Which API should be integrated/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
    await rm(fixture.storageDir, { recursive: true, force: true });
  }
});

async function intentContractFixture(label: string) {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-intent-contract-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-intent-contract-storage-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "Build the integration"
  });
  return { workspace, storageDir, manager, session };
}

function intentContract(id: string, status: IntentContract["status"]): IntentContract {
  return {
    schema_version: 1,
    contract_id: id,
    run_id: "session_intent_contract_test",
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: "Build the integration",
    precise_rewrite: "Build the integration",
    assumptions: [],
    missing_questions: status === "needs_clarification"
      ? [{ question: "Which API should be integrated?", reason: "Planning depends on the target API.", blocking: true }]
      : [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced." },
      quality: { score: 80, rationale: "Important." },
      realism: { score: 70, rationale: "Use current project facts." },
      fun: { score: 40, rationale: "Not central." },
      security: { score: 80, rationale: "Preserve safety gates." },
      cost: { score: 50, rationale: "Balanced." }
    },
    definition_of_done: ["Intent contract fixture is accepted."],
    non_goals: [],
    conflict_rules: ["Preserve existing behavior unless explicitly changed."],
    status,
    artifact_ref: `.agent_memory/runtime_intents/session_intent_contract_test/intent/${id}.json`,
    summary_ref: `.agent_memory/runtime_intents/session_intent_contract_test/intent/${id}.md`,
    created_at: "2026-06-30T00:00:00.000Z",
    metadata_json: {}
  };
}

class ThrowingProvider implements LlmProvider {
  calls = 0;

  async generateStructured<T>(_input: LlmRequest): Promise<T> {
    this.calls += 1;
    throw new Error("provider should not be called");
  }

  async generateText(_input: LlmRequest): Promise<string> {
    this.calls += 1;
    throw new Error("provider should not be called");
  }
}
