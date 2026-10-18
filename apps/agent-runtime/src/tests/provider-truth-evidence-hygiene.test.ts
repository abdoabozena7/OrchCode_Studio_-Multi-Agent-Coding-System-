import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import { ProviderFailureError, userPromptWithContext, type LlmProvider, type LlmRequest } from "../llm/LlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";
import { TelemetryLlmProvider, createProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { buildServer } from "../server.js";

class TimeoutProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    if (schemaName(schema) === "initial-reasoning-decision") {
      return initialReasoningForPrompt(input.userPrompt) as T;
    }
    if (schemaName(schema) === "intent-contract") {
      return intentContractForPrompt(input) as T;
    }
    if (schemaName(schema) === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    throw new Error("real_provider.timeout: Ollama request timed out");
  }

  async generateText(): Promise<string> {
    throw new Error("real_provider.timeout: Ollama request timed out");
  }
}

class EchoTextProvider implements LlmProvider {
  async generateStructured<T>(): Promise<T> {
    return { ok: true } as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    return `echo:${input.userPrompt}`;
  }
}

test("Ollama provider uses configured provider timeout as the local request floor", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduledTimeouts: number[] = [];
  try {
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      scheduledTimeouts.push(Number(timeout));
      return originalSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timeoutId: NodeJS.Timeout | number | undefined) => {
      if (timeoutId !== undefined) originalClearTimeout(timeoutId as NodeJS.Timeout);
    }) as typeof clearTimeout;
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: "provider-authored reply" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

    const provider = new OllamaProvider("http://127.0.0.1:11434", "local-model", 180_000);
    const result = await provider.generateText({
      systemPrompt: "system",
      userPrompt: "user",
      timeoutMs: 20_000
    });

    assert.equal(result, "provider-authored reply");
    assert.equal(scheduledTimeouts[0], 180_000);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("Ollama local structured calls use bounded JSON mode and the requested output budget", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { content: '{"answer":"ok"}' } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const provider = new OllamaProvider("http://127.0.0.1:11434", "gemma4:e4b", 20_000, undefined, 16_384);
    const result = await provider.generateStructured(
      { systemPrompt: "Return JSON.", userPrompt: "Return answer=ok.", maxOutputTokens: 64 },
      {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"]
      }
    );

    const options = requestBody?.options as Record<string, unknown> | undefined;
    assert.deepEqual(result, { answer: "ok" });
    assert.equal(requestBody?.format, "json");
    assert.equal(options?.num_predict, 64);
    assert.ok(Number(options?.num_ctx) <= 16_384);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama cloud-tagged structured calls retain native schema mode", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { content: '{"answer":"ok"}' } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const provider = new OllamaProvider("http://127.0.0.1:11434", "gpt-oss:120b-cloud", 20_000, undefined, 16_384);
    const result = await provider.generateStructured(
      { systemPrompt: "Return JSON.", userPrompt: "Return answer=ok.", maxOutputTokens: 64 },
      {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"]
      }
    );

    assert.deepEqual(result, { answer: "ok" });
    assert.equal(typeof requestBody?.format, "object");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama cloud structured repair makes at most one JSON repair request", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  try {
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      const content = calls === 1 ? "{\"answer\":\"broken" : "{\"answer\":\"ok\"}";
      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const provider = new OllamaProvider("http://127.0.0.1:11434", "gpt-oss:120b-cloud", 20_000);
    const result = await provider.generateStructured(
      { systemPrompt: "Return JSON.", userPrompt: "Return answer=ok.", maxOutputTokens: 64 },
      {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"]
      }
    );

    assert.deepEqual(result, { answer: "ok" });
    assert.equal(calls, 2);
    assert.equal(typeof requestBodies[0]?.format, "object");
    assert.equal(requestBodies[1]?.format, "json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama cloud malformed JSON fails after the bounded repair without a long backoff", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const startedAt = Date.now();
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ message: { content: "{\"answer\":\"broken" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const provider = new OllamaProvider("http://127.0.0.1:11434", "gpt-oss:120b-cloud", 20_000);
    await assert.rejects(
      () => provider.generateStructured(
        { systemPrompt: "Return JSON.", userPrompt: "Return answer=ok.", maxOutputTokens: 64 },
        { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderFailureError);
        assert.equal(error.providerFailure.failureClass, "invalid_json");
        assert.equal(error.providerFailure.attempts, 2);
        assert.equal(error.providerFailure.retryable, true);
        return true;
      }
    );
    assert.equal(calls, 2);
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ollama cloud transport failures do not fan out into automatic retries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("network unavailable");
    }) as typeof fetch;

    const provider = new OllamaProvider("http://127.0.0.1:11434", "gpt-oss:120b-cloud", 20_000);
    await assert.rejects(
      () => provider.generateStructured(
        { systemPrompt: "Return JSON.", userPrompt: "Return answer=ok.", maxOutputTokens: 64 },
        { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
      ),
      /network unavailable/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider telemetry exposes actionable structured failure details", async () => {
  class FailedProvider implements LlmProvider {
    async generateStructured<T>(): Promise<T> {
      throw new ProviderFailureError("real_provider.invalid_json: malformed", {
        failureClass: "invalid_json",
        stage: "route",
        attempts: 1,
        elapsedMs: 1234,
        responseExcerpt: "{broken",
        retryable: true
      });
    }

    async generateText(): Promise<string> {
      throw new Error("not used");
    }
  }

  const recorder = createProviderTelemetryRecorder({
    mode: "real_provider",
    providerConfig: validOllamaConfig,
    activeProviderSource: "explicit_cli"
  });
  const provider = new TelemetryLlmProvider(new FailedProvider(), recorder);
  await assert.rejects(provider.generateStructured({ systemPrompt: "system", userPrompt: "route" }, { type: "object" }));
  assert.deepEqual(recorder.snapshot().lastFailure, {
    failureClass: "invalid_json",
    stage: "route",
    attempts: 1,
    elapsedMs: 1234,
    responseExcerpt: "{broken",
    retryable: true
  });
});

test("provider telemetry records prompt context and response character volume", async () => {
  const recorder = createProviderTelemetryRecorder({
    mode: "real_provider",
    providerConfig: validOllamaConfig,
    activeProviderSource: "explicit_cli"
  });
  const provider = new TelemetryLlmProvider(new EchoTextProvider(), recorder);

  await provider.generateText({
    systemPrompt: "system prompt",
    userPrompt: "explain the workspace",
    context: { files: ["backend/main.py", "frontend/app.js"], evidence: { count: 2 } }
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.providerRequestCount, 1);
  assert.equal(snapshot.totalProviderPromptChars > "system prompt".length + "explain the workspace".length, true);
  assert.equal(snapshot.totalProviderContextChars > 0, true);
  assert.equal(snapshot.totalProviderResponseChars > 0, true);
  assert.equal(snapshot.perPromptProviderLatencyMs[0]?.promptChars, snapshot.totalProviderPromptChars);
  assert.equal(snapshot.perPromptProviderLatencyMs[0]?.contextChars, snapshot.totalProviderContextChars);
  assert.equal(snapshot.perPromptProviderLatencyMs[0]?.responseChars, snapshot.totalProviderResponseChars);
});

test("provider telemetry clears recovered last errors after a later provider success", async () => {
  class RecoveringProvider implements LlmProvider {
    private calls = 0;

    async generateStructured<T>(): Promise<T> {
      throw new Error("Unexpected structured request");
    }

    async generateText(): Promise<string> {
      this.calls += 1;
      if (this.calls === 1) throw new Error("real_provider.malformed_response: missing message.content");
      return "provider-authored recovery";
    }
  }

  const recorder = createProviderTelemetryRecorder({
    mode: "real_provider",
    providerConfig: validOllamaConfig,
    activeProviderSource: "explicit_cli"
  });
  const provider = new TelemetryLlmProvider(new RecoveringProvider(), recorder);
  const request = { systemPrompt: "system", userPrompt: "answer" };

  await assert.rejects(provider.generateText(request), /missing message\.content/);
  await provider.generateText(request);

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.providerFailureCount, 1);
  assert.equal(snapshot.providerResponseCount, 1);
  assert.equal(snapshot.lastError, undefined);
  assert.equal(snapshot.lastFailure, undefined);
  assert.equal(snapshot.perPromptProviderLatencyMs.some((entry) => entry.status === "failure"), true);
});

test("provider user prompt includes serialized context so real models can inspect evidence", () => {
  const prompt = userPromptWithContext({
    systemPrompt: "system",
    userPrompt: "answer from the evidence",
    context: {
      file_excerpts: [
        {
          path: "src/runtime.ts",
          content: "export const routingPolicy = 'direct dispatch or human review';"
        }
      ]
    }
  });

  assert.match(prompt, /Provider context/);
  assert.match(prompt, /src\/runtime\.ts/);
  assert.match(prompt, /routingPolicy/);
  assert.match(prompt, /direct dispatch or human review/);
});

class UngroundedProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    if (schemaName(schema) === "initial-reasoning-decision") {
      return initialReasoningForPrompt(input.userPrompt) as T;
    }
    if (schemaName(schema) === "intent-contract") {
      return intentContractForPrompt(input) as T;
    }
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

function initialReasoningForPrompt(prompt: string) {
  const intent = intentDecisionForPrompt(prompt);
  const message = intent.workspaceMessage;
  return {
    understanding: {
      originalRequest: message,
      cleanedRequest: message,
      language: intent.language,
      intentKind: "workspace_question",
      route: "inspect_explain",
      needsWorkspace: true,
      goal: message,
      ambiguities: [],
      requiredEvidence: ["current workspace evidence"],
      risk: "medium",
      confidence: "high",
      rationale: intent.rationale
    },
    step: {
      id: "provider_truth_inspect_explain",
      kind: "final",
      rationale: "Route the workspace question to inspect/explain.",
      toolRequests: [],
      missingFacts: [],
      successCriteria: ["Answer only from provider-authored project explanation or report a provider failure."]
    }
  };
}

function intentContractForPrompt(input: LlmRequest) {
  const original = typeof input.context === "object" && input.context && "original_user_request" in input.context
    ? String((input.context as { original_user_request?: unknown }).original_user_request)
    : intentDecisionForPrompt(input.userPrompt).workspaceMessage;
  const priority = (score: number, rationale: string) => ({ score, rationale });
  return {
    original_user_request: original,
    precise_rewrite: original,
    assumptions: ["Answer from current workspace evidence only."],
    missing_questions: [],
    tradeoffs: [{ name: "Provider truth over local synthesis", options: ["provider answer", "provider failure notice"], preferred: "provider failure notice when provider fails", rationale: "The runtime must not synthesize semantic answers locally." }],
    priorities: {
      speed: priority(50, "Keep the inspect/explain run bounded."),
      quality: priority(90, "Prefer verified provider-authored answers."),
      realism: priority(90, "Use current workspace files and provider telemetry."),
      fun: priority(10, "No special presentation requirement."),
      security: priority(80, "Avoid fabricated local answers."),
      cost: priority(60, "Do not over-read beyond the bounded evidence report.")
    },
    definition_of_done: ["Return a provider-authored project answer or a clear provider failure notice artifact."],
    non_goals: ["Do not fabricate a local semantic answer."],
    conflict_rules: ["Provider truth and evidence hygiene override convenience."]
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

test("real provider required forbids legacy mock mode", async () => {
  const fixture = await createDbscanFixture("provider-gate-mock-forbidden");
  try {
    const runtime = await createRuntime(fixture.storageDir);
    await assert.rejects(
      () => runtime.createSession({
        workspacePath: fixture.workspace,
        mode: "demo_mock",
        activeProviderSource: "runtime_default",
        accessProfile: "full_access",
        userPrompt: "How is DBSCAN applied here?"
      } as unknown as Parameters<typeof runtime.createSession>[0]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "provider_mock_forbidden");
        return true;
      }
    );

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
      providerConfig: validOllamaConfig,
      activeProviderSource: "explicit_cli",
      accessProfile: "full_access",
      userPrompt: "How is DBSCAN applied here?"
    });
    const session = requireSession(runtime.getSession(created.sessionId));
    assert.equal(session.mode, "real_provider");
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
    assert.equal(telemetry.providerRequestCount > 0, true);
    assert.equal(telemetry.providerFailureCount > 0, true);
    assert.equal(telemetry.providerTimeoutCount > 0, true);
    assert.equal(telemetry.finalResponseSource, "none");
    assert.match(telemetry.terminalFailure ?? telemetry.lastError ?? "", /timeout|provider failed/i);
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

test("runtime health default stays separate from active desktop provider source", async () => {
  const fixture = await createDbscanFixture("provider-truth-health");
  const server = await buildServer({
    ...loadConfig(),
    defaultMode: "real_provider",
    storageDir: fixture.storageDir
  });
  try {
    const health = await server.app.inject({ method: "GET", url: "/health" });
    const healthBody = JSON.parse(health.body);
    assert.equal(healthBody.mode, "real_provider");
    assert.equal(typeof healthBody.startedAt, "string");
    assert.ok(Number.isFinite(Date.parse(healthBody.startedAt)));
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
      defaultMode: "real_provider",
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
