import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { buildServer } from "../server.js";

class TimeoutProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    if (schemaName(schema) === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    throw new Error("real_provider.timeout: Ollama request timed out");
  }

  async generateText(): Promise<string> {
    throw new Error("real_provider.timeout: Ollama request timed out");
  }
}

class UngroundedProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    if (schemaName(schema) === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    return {
      answerMarkdown: "DBSCAN is used here, and the implementation is definitely correct.",
      usedEvidenceRefs: [],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    return "DBSCAN is used here, and the implementation is definitely correct.";
  }
}

function schemaName(schema: unknown) {
  return typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
}

function intentDecisionForPrompt(prompt: string) {
  const message = prompt.match(/Classify this single user message before retrieval:\n([\s\S]*?)\n\nReturn JSON/i)?.[1]?.trim() ?? prompt;
  return {
    kind: "workspace_question",
    language: /[\u0600-\u06ff]/.test(message) ? "arabic" : "english",
    needsWorkspace: true,
    confidence: "high",
    rationale: "The provider classified this as a project explanation question.",
    workspaceMessage: message
  };
}

const validOllamaConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "tiny-test-model",
  isValid: true
};

test("real provider required without config fails with provider_missing", async () => {
  const fixture = await createDbscanFixture("provider-gate-missing");
  try {
    const runtime = await createRuntime(fixture.storageDir);
    await assert.rejects(
      () => runtime.createSession({
        workspacePath: fixture.workspace,
        mode: "real_provider",
        requireRealProvider: true,
        activeProviderSource: "explicit_cli",
        accessProfile: "full_access",
        userPrompt: "How is DBSCAN applied here?"
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "provider_missing");
        return true;
      }
    );
  } finally {
    await fixture.close();
  }
});

test("real provider required forbids mock mode and MockProvider factories", async () => {
  const fixture = await createDbscanFixture("provider-gate-mock-forbidden");
  try {
    const runtime = await createRuntime(fixture.storageDir);
    await assert.rejects(
      () => runtime.createSession({
        workspacePath: fixture.workspace,
        mode: "demo_mock",
        requireRealProvider: true,
        activeProviderSource: "runtime_default",
        accessProfile: "full_access",
        userPrompt: "How is DBSCAN applied here?"
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "provider_mock_forbidden");
        return true;
      }
    );

    const runtimeWithMockFactory = await createRuntime(fixture.storageDir, () => new MockLlmProvider());
    const created = await runtimeWithMockFactory.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      requireRealProvider: true,
      providerConfig: validOllamaConfig,
      activeProviderSource: "session_override",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });
    const session = requireSession(runtimeWithMockFactory.getSession(created.sessionId));
    assert.throws(
      () => (runtimeWithMockFactory as unknown as { getProvider(session: AgentRuntimeSession): LlmProvider }).getProvider(session),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "provider_mock_forbidden");
        return true;
      }
    );
  } finally {
    await fixture.close();
  }
});

test("real provider requested and mock fallback attempt fails the session clearly", async () => {
  const fixture = await createDbscanFixture("provider-gate-runtime-mock-forbidden");
  try {
    const runtime = await createRuntime(fixture.storageDir, () => new MockLlmProvider());
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      requireRealProvider: true,
      providerConfig: validOllamaConfig,
      activeProviderSource: "session_override",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });

    const turn = await runtime.runTurn(created.sessionId, "How is DBSCAN applied here?");
    const session = requireSession(runtime.getSession(created.sessionId));
    const answer = session.messages.at(-1)?.content ?? "";

    assert.equal(turn.status, "failed_provider");
    assert.equal(session.status, "failed_provider");
    assert.match(answer, /real model provider was required|MockProvider/i);
    assert.equal(session.providerTelemetry?.activeProviderSource, "session_override");
    assert.equal(session.providerTelemetry?.mockProviderUsed, false);
    assert.equal(session.providerTelemetry?.mockProviderRequestCount, 0);
    assert.equal(session.providerTelemetry?.providerRequestCount, 0);
    assert.equal(session.providerTelemetry?.fallbackUsed, true);
    assert.match(session.providerTelemetry?.lastError ?? "", /MockProvider is forbidden/i);
  } finally {
    await fixture.close();
  }
});

test("valid provider config creates real-provider sessions with provider truth source", async () => {
  const fixture = await createDbscanFixture("provider-gate-valid-config");
  try {
    const runtime = await createRuntime(fixture.storageDir, () => new UngroundedProvider());
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      requireRealProvider: true,
      providerConfig: validOllamaConfig,
      activeProviderSource: "explicit_cli",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });
    const session = requireSession(runtime.getSession(created.sessionId));
    assert.equal(session.mode, "real_provider");
    assert.equal(session.requireRealProvider, true);
    assert.equal(session.providerConfig?.providerName, "Ollama");
    assert.equal(session.activeProviderSource, "explicit_cli");
  } finally {
    await fixture.close();
  }
});

test("real-provider inspect/explain stops local synthesis after provider timeout and excludes generated audit evidence", async () => {
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
    assert.equal(telemetry.activeProviderSource, "session_override");
    assert.equal(telemetry.providerBaseUrl, "http://127.0.0.1:11434");
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
    const answerStrategy = answerArtifact.payload.answerStrategy as { strategy: string; finalAnswerSource: string; providerDraftStatus: string };
    assert.equal(answerStrategy.strategy, "provider_failed_notice");
    assert.equal(answerStrategy.finalAnswerSource, "local_notice");
    assert.equal(answerStrategy.providerDraftStatus, "failed");
    assert.match(String(answerArtifact.payload.answerMarkdown), /will not synthesize a local answer|provider failed/i);
    assert.doesNotMatch(String(answerArtifact.payload.answerMarkdown), /The code applies DBSCAN|DBSCAN\.fit_predict|strongest local evidence/i);
    assert.equal(String(answerArtifact.payload.answerMarkdown).includes("tmp/root-cause-audit/explain-repro-results.json"), false);
  } finally {
    await fixture.close();
  }
});

test("real-provider inspect/explain stops local synthesis after provider answer fails validation", async () => {
  const fixture = await createDbscanFixture("provider-truth-validation-failure");
  try {
    const runtime = await createRuntime(fixture.storageDir, () => new UngroundedProvider());
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
    const answerArtifact = session.artifacts.find((artifact) => artifact.type === "project_explain_answer");
    assert.ok(answerArtifact);
    const answerStrategy = answerArtifact.payload.answerStrategy as { strategy: string; finalAnswerSource: string; providerDraftStatus: string };
    assert.equal(answerStrategy.strategy, "provider_validation_notice");
    assert.equal(answerStrategy.finalAnswerSource, "local_notice");
    assert.equal(answerStrategy.providerDraftStatus, "failed_local_validation");
    assert.match(String(answerArtifact.payload.answerMarkdown), /provider answer failed validation|will not synthesize a local answer/i);
    assert.doesNotMatch(String(answerArtifact.payload.answerMarkdown), /DBSCAN\.fit_predict|strongest local evidence|The code applies DBSCAN/i);
  } finally {
    await fixture.close();
  }
});

test("real-provider concept-not-found questions still call provider before final notice", async () => {
  const fixture = await createDbscanFixture("provider-truth-concept-not-found");
  try {
    const runtime = await createRuntime(fixture.storageDir, () => new TimeoutProvider());
    const prompt = "How is rarePaymentGatewayAdapter applied here?";
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validOllamaConfig,
      activeProviderSource: "session_override",
      accessProfile: "full_access",
      userPrompt: prompt
    });

    await runtime.runTurn(created.sessionId, prompt);
    const session = requireSession(runtime.getSession(created.sessionId));
    const answerArtifact = session.artifacts.find((artifact) => artifact.type === "project_explain_answer");
    assert.ok(answerArtifact);
    const answerStrategy = answerArtifact.payload.answerStrategy as { strategy: string; finalAnswerSource: string; providerDraftStatus: string };
    assert.equal(answerStrategy.strategy, "provider_failed_notice");
    assert.equal(answerStrategy.finalAnswerSource, "local_notice");
    assert.equal(answerStrategy.providerDraftStatus, "failed");
    assert.doesNotMatch(String(answerArtifact.payload.answerMarkdown), /rarePaymentGatewayAdapter.*not found.*workspace evidence/i);
    assert.match(String(answerArtifact.payload.answerMarkdown), /will not synthesize a local answer|provider failed/i);
    assert.equal((session.providerTelemetry?.providerRequestCount ?? 0) >= 1, true);
  } finally {
    await fixture.close();
  }
});

test("real-provider multi-agent questions do not fall back to canned local synthesis after provider failure", async () => {
  const fixture = await createMultiAgentFixture("provider-truth-multi-agent-timeout");
  try {
    const runtime = await createRuntime(fixture.storageDir, () => new TimeoutProvider());
    const prompt = "ازاي الmulti agentic system هنا بيتطبق وهل دا المنطقي ولا هو متطبق بشكل غلط؟";
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validOllamaConfig,
      activeProviderSource: "session_override",
      accessProfile: "full_access",
      userPrompt: prompt
    });

    await runtime.runTurn(created.sessionId, prompt);
    const session = requireSession(runtime.getSession(created.sessionId));
    const answerArtifact = session.artifacts.find((artifact) => artifact.type === "project_explain_answer");
    assert.ok(answerArtifact);
    const answerStrategy = answerArtifact.payload.answerStrategy as { strategy: string; finalAnswerSource: string; providerDraftStatus: string };
    const artifactAnswer = String(answerArtifact.payload.answerMarkdown);
    const visibleAnswer = session.messages.at(-1)?.content ?? "";
    assert.equal(answerStrategy.strategy, "provider_failed_notice");
    assert.equal(answerStrategy.finalAnswerSource, "local_notice");
    assert.equal(answerStrategy.providerDraftStatus, "failed");
    assert.match(artifactAnswer, /مش هطلع شرح تخميني|provider failed|will not synthesize a local answer/i);
    assert.doesNotMatch(artifactAnswer, /multi-agentic decision-support|agents متخصصة|orchestrator مركزي|النظام هنا متطبق كـ multi-agentic/i);
    assert.doesNotMatch(visibleAnswer, /local evidence graph synthesis|multi-agentic decision-support|agents متخصصة|orchestrator مركزي/i);
    assert.match(visibleAnswer, /local synthesis was not used/i);
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

async function createMultiAgentFixture(label: string) {
  const workspace = path.join(os.tmpdir(), `hivo-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-${label}-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: label, private: true }, null, 2), "utf8");
  await writeFile(
    path.join(workspace, "backend", "services", "agents.py"),
    [
      "class RetentionAgent:",
      "    def recommend(self, customer):",
      "        return {'agent': 'retention', 'action': 'offer_discount'}",
      "",
      "class RiskAgent:",
      "    def recommend(self, customer):",
      "        return {'agent': 'risk', 'action': 'request_review'}",
      "",
      "def build_default_agents():",
      "    return [RetentionAgent(), RiskAgent()]"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "orchestrator.py"),
    [
      "from .agents import build_default_agents",
      "",
      "class ReActOrchestrator:",
      "    def __init__(self):",
      "        self.agents = build_default_agents()",
      "",
      "    def decide(self, customer):",
      "        recommendations = [agent.recommend(customer) for agent in self.agents]",
      "        return {'agent_recommendations': recommendations, 'selected_action': recommendations[0]['action']}"
    ].join("\n"),
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
