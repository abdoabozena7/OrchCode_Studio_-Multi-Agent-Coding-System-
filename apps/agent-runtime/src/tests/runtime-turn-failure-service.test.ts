import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { EventBus } from "../runtime/EventBus.js";
import { ProviderConfigurationError } from "../runtime/RuntimeProviderGate.js";
import { RuntimeTurnFailureService } from "../runtime/RuntimeTurnFailureService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimeTurnFailureService records provider gate failures as failed_provider", async () => {
  const fixture = await failureFixture("provider-gate");
  try {
    const service = new RuntimeTurnFailureService(fixture.manager);
    const result = await service.record({
      sessionId: fixture.session.id,
      baseSession: fixture.session,
      error: new ProviderConfigurationError("provider_missing", "real_provider requires a provider configuration."),
      providerTelemetry: telemetry()
    });
    const session = fixture.manager.getSession(fixture.session.id)!;

    assert.equal(result.status, "failed_provider");
    assert.equal(session.status, "failed_provider");
    assert.equal(session.lifecycleStage, "FAILED");
    assert.match(session.providerTelemetry?.terminalFailure ?? "", /real_provider requires a provider configuration/);
    assert.equal(session.providerTelemetry?.finalResponseSource, "none");
    assert.equal(session.runSummary?.gates[0]?.name, "Runtime turn");
    assert.match(session.messages.at(-1)?.content ?? "", /provider gate failed/i);
    assert.equal(session.messages.at(-1)?.role, "system");
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
    await rm(fixture.storageDir, { recursive: true, force: true });
  }
});

test("RuntimeTurnFailureService records ordinary runtime failures without provider status", async () => {
  const fixture = await failureFixture("runtime-failure");
  try {
    const service = new RuntimeTurnFailureService(fixture.manager);
    const result = await service.record({
      sessionId: fixture.session.id,
      baseSession: fixture.session,
      error: new Error("unexpected lifecycle failure"),
      providerTelemetry: telemetry()
    });
    const session = fixture.manager.getSession(fixture.session.id)!;

    assert.equal(result.status, "failed");
    assert.equal(session.status, "failed");
    assert.equal(session.lifecycleStage, "FAILED");
    assert.equal(session.runSummary?.summary, "unexpected lifecycle failure");
    assert.match(session.messages.at(-1)?.content ?? "", /runtime failed before it could complete/i);
    assert.doesNotMatch(session.messages.at(-1)?.content ?? "", /provider gate failed/i);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
    await rm(fixture.storageDir, { recursive: true, force: true });
  }
});

async function failureFixture(label: string) {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-turn-failure-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-turn-failure-storage-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "Run a failure test"
  });
  return { workspace, storageDir, manager, session };
}

function telemetry() {
  return createProviderTelemetryRecorder({
    mode: "real_provider",
    activeProviderSource: "session_override"
  });
}
