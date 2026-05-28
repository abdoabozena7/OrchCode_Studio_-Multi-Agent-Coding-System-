import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { buildServer } from "../server.js";

class TimeoutProvider implements LlmProvider {
  async generateStructured(): Promise<never> {
    throw new Error("real_provider.timeout: Ollama request timed out");
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

const validOllamaConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "tiny-test-model",
  isValid: true
};

test("inspect/explain records provider timeout fallback and excludes generated audit evidence", async () => {
  const fixture = await createDbscanFixture("provider-truth-timeout");
  try {
    const runtime = await createRuntime(fixture.storageDir, () => new TimeoutProvider());
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validOllamaConfig,
      activeProviderSource: "session_override",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });

    await runtime.runTurn(created.sessionId, "How is DBSCAN applied here?");
    const session = requireSession(runtime.getSession(created.sessionId));
    const telemetry = session.providerTelemetry;
    const evidenceReport = session.evidenceReport;
    assert.ok(telemetry);
    assert.ok(evidenceReport);
    assert.equal(telemetry.providerMode, "real_provider");
    assert.equal(telemetry.realProviderUsed, true);
    assert.equal(telemetry.mockProviderUsed, false);
    assert.equal(telemetry.providerRequestCount > 0, true);
    assert.equal(telemetry.providerFailureCount > 0, true);
    assert.equal(telemetry.providerTimeoutCount > 0, true);
    assert.equal(telemetry.fallbackUsed, true);
    assert.match(telemetry.fallbackReason ?? "", /timeout|provider failed/i);
    assert.equal(evidenceReport.excludedEvidenceCandidates.some((file) => file.includes("tmp/root-cause-audit/explain-repro-results.json")), true);
    assert.equal(evidenceReport.finalEvidenceFilesActuallyUsed.some((file) => file.includes("tmp/root-cause-audit")), false);
    assert.equal(evidenceReport.evidenceFilesByTier.source_code.some((file) => file === "src/clustering.py"), true);

    const answerArtifact = session.artifacts.find((artifact) => artifact.type === "project_explain_answer");
    assert.ok(answerArtifact);
    assert.ok(answerArtifact.payload.providerTelemetry);
    assert.ok(answerArtifact.payload.evidenceReport);
    assert.equal(String(answerArtifact.payload.answerMarkdown).includes("tmp/root-cause-audit/explain-repro-results.json"), false);
  } finally {
    await fixture.close();
  }
});

test("mock inspect/explain telemetry is marked as mock, not real", async () => {
  const fixture = await createDbscanFixture("provider-truth-mock");
  try {
    const runtime = await createRuntime(fixture.storageDir);
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      activeProviderSource: "runtime_default",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });

    await runtime.runTurn(created.sessionId, "How is DBSCAN applied here?");
    const telemetry = requireSession(runtime.getSession(created.sessionId)).providerTelemetry;
    assert.ok(telemetry);
    assert.equal(telemetry.providerMode, "demo_mock");
    assert.equal(telemetry.mockProviderUsed, true);
    assert.equal(telemetry.realProviderUsed, false);
    assert.equal(telemetry.mockProviderRequestCount, telemetry.providerRequestCount);
    assert.equal(telemetry.realProviderRequestCount, 0);
  } finally {
    await fixture.close();
  }
});

test("runtime health default stays separate from active desktop provider source", async () => {
  const fixture = await createDbscanFixture("provider-truth-health");
  const server = await buildServer({
    ...loadConfig(),
    defaultMode: "demo_mock",
    storageDir: fixture.storageDir
  });
  try {
    const health = await server.app.inject({ method: "GET", url: "/health" });
    assert.equal(JSON.parse(health.body).mode, "demo_mock");
    const created = await server.runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validOllamaConfig,
      activeProviderSource: "desktop_saved_provider",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });
    const session = requireSession(server.runtime.getSession(created.sessionId));
    assert.equal(session.mode, "real_provider");
    assert.equal(session.activeProviderSource, "desktop_saved_provider");
  } finally {
    await server.app.close();
    await fixture.close();
  }
});

async function createRuntime(storageDir: string, providerFactory?: (session: AgentRuntimeSession) => LlmProvider) {
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  return new AgentRuntime(
    {
      ...loadConfig(),
      defaultMode: "demo_mock",
      storageDir
    },
    sessionManager,
    providerFactory ? { providerFactory } : {}
  );
}

async function createDbscanFixture(label: string) {
  const workspace = path.join(os.tmpdir(), `hivo-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-${label}-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tmp", "root-cause-audit"), { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: label, private: true }, null, 2), "utf8");
  await writeFile(
    path.join(workspace, "src", "clustering.py"),
    [
      "from sklearn.cluster import DBSCAN",
      "",
      "def apply_dbscan(features):",
      "    labels = DBSCAN(eps=0.35, min_samples=5).fit_predict(features)",
      "    noise_mask = labels == -1",
      "    return labels, noise_mask"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "tmp", "root-cause-audit", "explain-repro-results.json"),
    JSON.stringify({ fakeProof: "DBSCAN is implemented only in generated audit output" }, null, 2),
    "utf8"
  );
  return {
    workspace,
    storageDir,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

function requireSession(session: AgentRuntimeSession | undefined) {
  assert.ok(session);
  return session;
}
