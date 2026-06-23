import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  ProviderAuthoredResult,
  ReasoningDirective,
  ReasoningStep,
  SanitizedProviderConfig,
  TurnUnderstanding
} from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { appendProviderEvidenceLinks } from "../runtime/ProviderEvidenceLinks.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { registerReasoningCertification } from "../evals/ReasoningCertificationRegistry.js";
import { ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";

const providerConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "decision-pipeline-test",
  isValid: true
};

test("provider evidence refs are appended as hivo-file links without local claims", () => {
  const answer = appendProviderEvidenceLinks(
    "The provider-authored answer cites the project evidence.",
    ["evidence_readme"],
    [{
      id: "evidence_readme",
      sourceType: "workspace_file",
      path: "README.md",
      startLine: 3,
      endLine: 5,
      summary: "README explains the project goal.",
      createdAt: "2026-01-01T00:00:00.000Z"
    }],
    "english"
  );

  assert.match(answer, /### Evidence/);
  assert.match(answer, /\[README\.md:3-5\]\(hivo-file:README\.md:3-5\)/);
  assert.match(answer, /README explains the project goal\./);
});

test("provider evidence refs do not duplicate existing hivo-file links", () => {
  const answer = appendProviderEvidenceLinks(
    "Already linked [README.md:3](hivo-file:README.md:3).",
    ["evidence_readme"],
    [{
      id: "evidence_readme",
      sourceType: "workspace_file",
      path: "README.md",
      startLine: 3,
      summary: "README explains the project goal.",
      createdAt: "2026-01-01T00:00:00.000Z"
    }],
    "english"
  );

  assert.equal(answer.match(/hivo-file:README\.md:3/g)?.length, 1);
  assert.doesNotMatch(answer, /### Evidence/);
});

test("unexpected Arabic general question is understood and answered entirely by the provider", async () => {
  const storageDir = await temporaryStorage("provider-authored-direct");
  try {
    const provider = new DirectAnswerProvider();
    const runtime = await createRuntime(storageDir, () => provider);
    const prompt = "أخبرني عن مجموعة التقنيات الكاملة";
    const created = await runtime.createSession({
      workspacePath: path.join(os.tmpdir(), `missing-workspace-${Date.now()}`),
      mode: "real_provider",
      providerConfig,
      userPrompt: prompt
    });

    await runtime.runTurn(created.sessionId, prompt);
    const session = requireSession(runtime.getSession(created.sessionId));
    const assistantMessages = session.messages.filter((message) => message.role === "assistant");

    assert.equal(session.status, "completed");
    assert.equal(assistantMessages.length, 1);
    assert.equal(assistantMessages[0]?.content, DirectAnswerProvider.answer);
    assert.equal(session.latestDecisionPipeline?.query.source, "provider");
    assert.equal(session.latestDecisionPipeline?.turnUnderstanding?.goal, "Explain the meaning of a complete technology stack.");
    assert.equal(session.latestDecisionPipeline?.finalResponseSource, "provider");
    assert.equal(session.providerTelemetry?.finalResponseSource, "provider");
    assert.deepEqual(provider.schemas, ["initial-reasoning-decision", "answer-verification"]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("same-session Arabic follow-up context reaches route and compose provider calls", async () => {
  const storageDir = await temporaryStorage("same-chat-follow-up");
  try {
    const provider = new SameChatFollowUpProvider();
    const runtime = await createRuntime(storageDir, () => provider);
    const firstPrompt = "Explain the ReasoningKernel briefly.";
    const created = await runtime.createSession({
      workspacePath: path.join(os.tmpdir(), `missing-workspace-${Date.now()}`),
      mode: "real_provider",
      providerConfig,
      userPrompt: firstPrompt
    });

    await runtime.runTurn(created.sessionId, firstPrompt);
    await runtime.runTurn(created.sessionId, SameChatFollowUpProvider.followUpPrompt);

    const session = requireSession(runtime.getSession(created.sessionId));
    const assistantMessages = session.messages.filter((message) => message.role === "assistant");
    const secondRouteContext = conversationContextFrom(provider.routeRequests.at(-1));
    const composeContext = conversationContextFrom(provider.composeRequests.at(-1));

    assert.equal(session.status, "completed");
    assert.equal(assistantMessages.length, 2);
    assert.equal(secondRouteContext?.source, "same_session_messages");
    assert.equal(secondRouteContext?.maxMessages, 8);
    assert.equal(secondRouteContext?.maxChars, 12_000);
    assert.equal(secondRouteContext?.omittedMessageCount, 0);
    assert.deepEqual(secondRouteContext?.messages.map((message) => message.role), ["user", "assistant"]);
    assert.deepEqual(secondRouteContext?.messages.map((message) => message.content), [
      firstPrompt,
      SameChatFollowUpProvider.firstAnswer
    ]);
    assert.equal(secondRouteContext?.messages.some((message) => message.content === SameChatFollowUpProvider.followUpPrompt), false);
    assert.deepEqual(composeContext?.messages.map((message) => message.content), [
      firstPrompt,
      SameChatFollowUpProvider.firstAnswer
    ]);
    assert.deepEqual(provider.schemas, [
      "initial-reasoning-decision",
      "answer-verification",
      "initial-reasoning-decision",
      "provider-authored-result",
      "answer-verification"
    ]);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("provider failure after bounded retries fails the session without a local assistant message", async () => {
  const storageDir = await temporaryStorage("provider-terminal-failure");
  try {
    const provider = new AlwaysFailingProvider();
    const runtime = await createRuntime(storageDir, () => provider);
    const prompt = "hello";
    const created = await runtime.createSession({
      workspacePath: path.join(os.tmpdir(), `missing-workspace-${Date.now()}`),
      mode: "real_provider",
      providerConfig,
      userPrompt: prompt
    });

    await runtime.runTurn(created.sessionId, prompt);
    const session = requireSession(runtime.getSession(created.sessionId));

    assert.equal(session.status, "failed_provider");
    assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0);
    assert.equal(provider.calls, 4);
    assert.equal(session.providerTelemetry?.providerRequestCount, 4);
    assert.equal(session.providerTelemetry?.finalResponseSource, "none");
    assert.match(session.providerTelemetry?.terminalFailure ?? "", /provider_failed_after_retries/i);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("malformed provider understanding is repaired then fails explicitly without local fallback", async () => {
  const storageDir = await temporaryStorage("provider-malformed");
  try {
    const runtime = await createRuntime(storageDir, () => new MalformedProvider());
    const prompt = "hello";
    const created = await runtime.createSession({
      workspacePath: path.join(os.tmpdir(), `missing-workspace-${Date.now()}`),
      mode: "real_provider",
      providerConfig,
      userPrompt: prompt
    });

    await runtime.runTurn(created.sessionId, prompt);
    const session = requireSession(runtime.getSession(created.sessionId));

    assert.equal(session.status, "failed_provider");
    assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0);
    assert.equal(session.providerTelemetry?.repairAttempts, 3);
    assert.equal(session.latestDecisionPipeline, undefined);
    assert.match(session.providerTelemetry?.terminalFailure ?? "", /invalid_provider_output/i);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("legacy demo sessions cannot be created", async () => {
  const storageDir = await temporaryStorage("provider-demo-rejected");
  try {
    const runtime = await createRuntime(storageDir, () => new DirectAnswerProvider());
    await assert.rejects(
      runtime.createSession({
        workspacePath: os.tmpdir(),
        mode: "demo_mock",
        providerConfig,
        userPrompt: "hello"
      }),
      /Demo and mock sessions are no longer supported/
    );
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("a certified action reasoning profile uses the adaptive kernel and produces only an approval-gated provider patch", async () => {
  const storageDir = await temporaryStorage("certified-action-storage");
  const workspace = await temporaryStorage("certified-action-workspace");
  try {
    const memory = await ensureMemoryLayout(workspace);
    const certificationReport = path.join(memory.evalsDir, "certified-action", "summary.json");
    await writeJson(certificationReport, {
      certified: true,
      split: "holdout",
      gate: "action_reasoning",
      corpusHash: "certified-corpus",
      modelProfile: {
        providerType: "ollama",
        routerModel: providerConfig.routerModel ?? providerConfig.selectedModel,
        authorModel: providerConfig.selectedModel,
        verifierModel: providerConfig.verifierModel ?? providerConfig.selectedModel,
        capabilities: {
          readReasoning: false,
          actionReasoning: true,
          readonlySwarm: true,
          embeddings: false
        }
      },
      gates: { allRequiredGatesPassed: true }
    });
    await registerReasoningCertification(workspace, {
      providerType: "ollama",
      routerModel: providerConfig.routerModel ?? providerConfig.selectedModel,
      authorModel: providerConfig.selectedModel,
      verifierModel: providerConfig.verifierModel ?? providerConfig.selectedModel,
      capabilities: {
        readReasoning: false,
        actionReasoning: true,
        readonlySwarm: true,
        embeddings: false
      },
      gate: "action_reasoning",
      corpusHash: "certified-corpus",
      reportPath: certificationReport,
      certifiedAt: new Date().toISOString()
    });
    const provider = new CertifiedActionProvider();
    const runtime = await createRuntime(storageDir, () => provider);
    const prompt = "Create a small note file.";
    const created = await runtime.createSession({ workspacePath: workspace, providerConfig, userPrompt: prompt });

    await runtime.runTurn(created.sessionId, prompt);
    const session = requireSession(runtime.getSession(created.sessionId));

    assert.equal(session.status, "needs_approval");
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.patchProposals[0]?.status, "proposed");
    assert.equal(session.latestDecisionPipeline?.reasoningTrace?.toolResults[0]?.status, "approval_required");
    assert.equal(session.providerTelemetry?.modelCertification.status, "certified");
    assert.ok(provider.schemas.every((name) => !["run-plan", "run-patch", "agent-plan"].includes(name)));
  } finally {
    await rm(storageDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

class DirectAnswerProvider implements LlmProvider {
  static readonly answer = "المقصود بمجموعة التقنيات الكاملة هو كل اللغات والأطر وقواعد البيانات وأدوات التشغيل المستخدمة لبناء النظام.";
  readonly schemas: string[] = [];

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") return directInitialDecision() as T;
    if (name === "turn-understanding") {
      return {
        originalRequest: "أخبرني عن مجموعة التقنيات الكاملة",
        cleanedRequest: "أخبرني عن مجموعة التقنيات الكاملة",
        language: "arabic",
        intentKind: "direct_conversation",
        route: "chat",
        needsWorkspace: false,
        goal: "Explain the meaning of a complete technology stack.",
        ambiguities: [],
        requiredEvidence: [],
        risk: "low",
        confidence: "high",
        rationale: "This is a general knowledge question, not a request about the current workspace."
      } satisfies TurnUnderstanding as T;
    }
    if (name === "reasoning-directive") {
      return {
        action: "answer",
        rationale: "Answer the general question directly without workspace tools.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Explain the concept in Arabic."]
      } satisfies ReasoningDirective as T;
    }
    if (name === "provider-authored-result") {
      return {
        decision: "ANSWER",
        answerMarkdown: DirectAnswerProvider.answer,
        claims: [],
        evidenceRefs: [],
        unknowns: [],
        rationale: "Answered the general question directly."
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") {
      return {
        verdict: "pass",
        rationale: "The general answer is internally consistent and does not make workspace claims.",
        supportedClaims: [],
        unsupportedClaims: [],
        missingFacts: [],
        evidenceRefs: []
      } as T;
    }
    throw new Error(`Unexpected schema: ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class SameChatFollowUpProvider implements LlmProvider {
  static readonly followUpPrompt = "\u0641\u0635\u0644";
  static readonly firstAnswer = "The ReasoningKernel classifies the turn, chooses evidence steps, composes, and verifies the answer.";
  readonly schemas: string[] = [];
  readonly routeRequests: LlmRequest[] = [];
  readonly composeRequests: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") {
      this.routeRequests.push(input);
      return (input.userPrompt.includes(SameChatFollowUpProvider.followUpPrompt)
        ? followUpInitialDecision()
        : firstTurnInitialDecision()) as T;
    }
    if (name === "provider-authored-result") {
      this.composeRequests.push(input);
      return {
        decision: "ANSWER",
        answerMarkdown: "More detail: the previous answer can be expanded because the same-session context is present.",
        claims: [],
        evidenceRefs: [],
        unknowns: [],
        rationale: "Expanded the prior same-session answer."
      } satisfies ProviderAuthoredResult as T;
    }
    if (name === "answer-verification") {
      return {
        verdict: "pass",
        rationale: "The answer is relevant to the same-session follow-up and makes no workspace claims.",
        supportedClaims: [],
        unsupportedClaims: [],
        missingFacts: [],
        evidenceRefs: []
      } as T;
    }
    throw new Error(`Unexpected schema: ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class CertifiedActionProvider implements LlmProvider {
  readonly schemas: string[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const name = schemaName(schema);
    this.schemas.push(name);
    if (name === "initial-reasoning-decision") return actionInitialDecision() as T;
    if (name === "turn-understanding") {
      return {
        originalRequest: "Create a small note file.",
        cleanedRequest: "Create a small note file.",
        language: "english",
        intentKind: "workspace_action",
        route: "simple_run",
        needsWorkspace: true,
        goal: "Create a small note file.",
        ambiguities: [],
        requiredEvidence: [],
        risk: "low",
        confidence: "high",
        rationale: "The user requested a bounded workspace change."
      } satisfies TurnUnderstanding as T;
    }
    if (name === "reasoning-directive") {
      return {
        action: "execute",
        rationale: "Propose the requested patch through the approval boundary.",
        toolRequests: [{
          id: "propose_note",
          kind: "propose_patch",
          reason: "Create the requested note.",
          patch: {
            title: "Create note",
            summary: "Creates NOTE.md.",
            filesChanged: [{ path: "NOTE.md", changeType: "create", summary: "Requested note." }],
            unifiedDiff: "diff --git a/NOTE.md b/NOTE.md\nnew file mode 100644\n--- /dev/null\n+++ b/NOTE.md\n@@ -0,0 +1 @@\n+Provider-authored note.\n",
            riskLevel: "low",
            rollbackPlan: "Delete NOTE.md."
          }
        }],
        missingFacts: [],
        successCriteria: ["A reviewable patch is proposed."]
      } satisfies ReasoningDirective as T;
    }
    if (name === "reasoning-step") {
      const evidenceId = (input.context as { allowedEvidenceIds: string[] }).allowedEvidenceIds[0]!;
      return {
        id: "await_patch_approval",
        kind: "escalate",
        rationale: "The provider-authored patch requires approval.",
        toolRequests: [],
        missingFacts: ["Patch approval is pending."],
        successCriteria: ["Rust authority applies the approved patch."],
        result: {
          decision: "ESCALATE",
          answerMarkdown: "The provider-authored patch is ready for approval.",
          claims: [],
          evidenceRefs: [evidenceId],
          unknowns: ["The patch has not been applied."],
          rationale: "Patch application is controlled by the approval boundary."
        }
      } as T;
    }
    throw new Error(`Unexpected schema: ${name}`);
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

class AlwaysFailingProvider implements LlmProvider {
  calls = 0;

  async generateStructured<T>(): Promise<T> {
    this.calls += 1;
    throw new Error("provider offline");
  }

  async generateText(): Promise<string> {
    throw new Error("provider offline");
  }
}

class MalformedProvider implements LlmProvider {
  async generateStructured<T>(): Promise<T> {
    return { invalid: true } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("Unexpected text request");
  }
}

function directInitialDecision() {
  return {
    understanding: {
      originalRequest: "general Arabic technology-stack question",
      cleanedRequest: "general Arabic technology-stack question",
      language: "arabic",
      intentKind: "direct_conversation",
      route: "chat",
      needsWorkspace: false,
      goal: "Explain the meaning of a complete technology stack.",
      ambiguities: [],
      requiredEvidence: [],
      risk: "low",
      confidence: "high",
      rationale: "This is a general knowledge question, not a request about the current workspace."
    } satisfies TurnUnderstanding,
    step: {
      id: "answer_directly",
      kind: "final",
      rationale: "Answer the general question directly without workspace tools.",
      toolRequests: [],
      missingFacts: [],
      successCriteria: ["Explain the concept in Arabic."],
      result: {
        decision: "ANSWER",
        answerMarkdown: DirectAnswerProvider.answer,
        claims: [],
        evidenceRefs: [],
        unknowns: [],
        rationale: "Answered the general question directly."
      } satisfies ProviderAuthoredResult
    }
  };
}

function firstTurnInitialDecision() {
  return {
    understanding: {
      originalRequest: "Explain the ReasoningKernel briefly.",
      cleanedRequest: "Explain the ReasoningKernel briefly.",
      language: "english",
      intentKind: "direct_conversation",
      route: "chat",
      needsWorkspace: false,
      goal: "Briefly explain the ReasoningKernel.",
      ambiguities: [],
      requiredEvidence: [],
      risk: "low",
      confidence: "high",
      rationale: "This fixture treats the first turn as a direct explanatory answer."
    } satisfies TurnUnderstanding,
    step: {
      id: "answer_first_turn",
      kind: "final",
      rationale: "Answer the first turn directly.",
      toolRequests: [],
      missingFacts: [],
      successCriteria: ["Give a brief answer."],
      result: {
        decision: "ANSWER",
        answerMarkdown: SameChatFollowUpProvider.firstAnswer,
        claims: [],
        evidenceRefs: [],
        unknowns: [],
        rationale: "Answered the first turn."
      } satisfies ProviderAuthoredResult
    } satisfies ReasoningStep
  };
}

function followUpInitialDecision() {
  return {
    understanding: {
      originalRequest: SameChatFollowUpProvider.followUpPrompt,
      cleanedRequest: "Expand the previous same-session answer.",
      language: "arabic",
      intentKind: "direct_conversation",
      route: "chat",
      needsWorkspace: false,
      goal: "Expand the previous same-session explanation.",
      ambiguities: [],
      requiredEvidence: [],
      risk: "low",
      confidence: "high",
      rationale: "The short Arabic follow-up is clear when same-session context is available."
    } satisfies TurnUnderstanding,
    step: {
      id: "compose_follow_up",
      kind: "final",
      rationale: "Compose an expanded answer from the same-session context.",
      toolRequests: [],
      missingFacts: [],
      successCriteria: ["Expand the previous answer without asking a redundant clarification."]
    } satisfies ReasoningStep
  };
}

function actionInitialDecision() {
  return {
    understanding: {
      originalRequest: "Create a small note file.",
      cleanedRequest: "Create a small note file.",
      language: "english",
      intentKind: "workspace_action",
      route: "simple_run",
      needsWorkspace: true,
      goal: "Create a small note file.",
      ambiguities: [],
      requiredEvidence: [],
      risk: "low",
      confidence: "high",
      rationale: "The user requested a bounded workspace change."
    } satisfies TurnUnderstanding,
    step: {
      id: "propose_note_step",
      kind: "tool_batch",
      rationale: "Propose the requested patch through the approval boundary.",
      toolRequests: [{
        id: "propose_note",
        kind: "propose_patch",
        reason: "Create the requested note.",
        patch: {
          title: "Create note",
          summary: "Creates NOTE.md.",
          filesChanged: [{ path: "NOTE.md", changeType: "create", summary: "Requested note." }],
          unifiedDiff: "diff --git a/NOTE.md b/NOTE.md\nnew file mode 100644\n--- /dev/null\n+++ b/NOTE.md\n@@ -0,0 +1 @@\n+Provider-authored note.\n",
          riskLevel: "low",
          rollbackPlan: "Delete NOTE.md."
        }
      }],
      missingFacts: [],
      successCriteria: ["A reviewable patch is proposed."]
    }
  };
}

async function createRuntime(storageDir: string, providerFactory: (session: AgentRuntimeSession) => LlmProvider) {
  const manager = new SessionManager(storageDir, new EventBus());
  await manager.load();
  return new AgentRuntime({ ...loadConfig(), storageDir }, manager, { providerFactory });
}

async function temporaryStorage(label: string) {
  const storageDir = path.join(os.tmpdir(), `hivo-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(storageDir, { recursive: true });
  return storageDir;
}

function schemaName(schema: unknown) {
  return typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
}

function conversationContextFrom(request: LlmRequest | undefined) {
  const context = request?.context;
  if (!context || typeof context !== "object" || !("conversationContext" in context)) return undefined;
  return (context as {
    conversationContext?: {
      source: string;
      maxMessages: number;
      maxChars: number;
      omittedMessageCount: number;
      messages: Array<{ role: string; content: string }>;
    };
  }).conversationContext;
}

function requireSession(session: AgentRuntimeSession | undefined) {
  assert.ok(session);
  return session;
}
