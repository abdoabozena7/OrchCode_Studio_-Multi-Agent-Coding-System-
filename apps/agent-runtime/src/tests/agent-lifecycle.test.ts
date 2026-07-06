import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

test("agent lifecycle uses real-provider sessions without demo mock artifacts", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-agent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-agent-storage-${Date.now()}`);
  try {
    await mkdir(workspace, { recursive: true });
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => new ScriptedProvider()
    });
    const prompt = "create a new README note";
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.status, "needs_approval");
    assert.equal(session?.mode, "real_provider");
    assert.equal(session?.providerTelemetry?.terminalFailure, undefined);
    assert.ok(session?.plan);
    assert.equal((session?.toolIntents.length ?? 0) >= 1, true);
    assert.ok((session?.artifacts.length ?? 0) >= 1);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.patchProposals[0]?.status, "proposed");
    assert.equal(session?.patchProposals[0]?.requiresApproval, true);
    assert.equal(session?.commandRequests.length, 1);
    assert.equal(session?.commandRequests[0]?.status, "requested");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});
