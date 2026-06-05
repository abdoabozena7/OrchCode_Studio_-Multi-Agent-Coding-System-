import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { loadConfig } from "../config.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { createConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import { routeConversation } from "../runtime/ConversationRouter.js";
import { EventBus } from "../runtime/EventBus.js";
import { classifyAgenticTaskIntent } from "../runtime/AgenticIntentClassifier.js";
import { decideIntentBeforeRetrieval, prepareWorkspacePromptForUnderstanding } from "../runtime/IntentDecisionEngine.js";
import { classifyRunIntent } from "../runtime/ProjectIntake.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { inferWorkspaceIntent } from "../runtime/WorkspaceReasoningPipeline.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

const MOJIBAKE_PATTERN = /ط§|ظ„|ظپ|ظ…|ï؟½|\uFFFD/;

test("ConversationRouter routes unknown and normal Arabic prompts to chat", () => {
  assert.equal(routeConversation("blorx zindle maybe?").route, "chat");
  assert.equal(routeConversation("\u0639\u0627\u0645\u0644 \u0627\u064a\u0647 \u0627\u0644\u0646\u0647\u0627\u0631\u062f\u0647\u061f").route, "chat");
});

test("ConversationRouter sends deep architecture questions to read-only swarm and keeps bounded changes simple", () => {
  assert.equal(routeConversation("How does the provider telemetry work in this project?").route, "swarm_readonly");
  assert.equal(routeConversation("امتى الـ orchestrator يعمل direct dispatch؟ وامتى يحوّل لـ human review حتى لو فيه agents بتقترح action؟").route, "swarm_readonly");
  assert.equal(routeConversation("Fix one file so the status label handles provider failure").route, "simple_run");
  assert.equal(routeConversation("Refactor auth, database, and frontend state across many files").route, "orchestrated_run");
  assert.equal(routeConversation("Audit the whole repo read-only with swarm scouts").route, "swarm_readonly");
  assert.notEqual(routeConversation("Review this component quickly").route, "swarm_readonly");
});

test("IntentDecisionEngine routes social messages without workspace retrieval", () => {
  for (const message of ["هاي", "hi", "hello", "صباح الخير", "شكرا"]) {
    const decision = decideIntentBeforeRetrieval(message);
    assert.equal(decision.kind, "direct_conversation", message);
    assert.equal(decision.needsWorkspace, false, message);
  }
});

test("IntentDecisionEngine routes mixed social project requests to workspace paths", () => {
  assert.equal(decideIntentBeforeRetrieval("هاي ازاي الfeedback بيتطبق؟").kind, "workspace_question");
  assert.equal(decideIntentBeforeRetrieval("hi explain this project").kind, "workspace_question");
  assert.equal(decideIntentBeforeRetrieval("شغل المشروع").kind, "run_request");
  assert.equal(classifyRunIntent("هاي"), "unknown");
  assert.equal(classifyRunIntent("شغل المشروع"), "run_to_green");
});

test("workspace understanding drops social preambles before choosing topic terms", () => {
  assert.equal(prepareWorkspacePromptForUnderstanding("hi explain this project").workspaceMessage, "explain this project");
  assert.deepEqual(inferWorkspaceIntent("hi explain this project").topicTerms, []);
  assert.equal(inferWorkspaceIntent("هاي ازاي الfeedback بيتطبق؟").topicPhrase, "feedback");
});

test("agentic task intent uses the same cleaned workspace prompt", () => {
  const intent = classifyAgenticTaskIntent("هاي ازاي الfeedback بيتطبق؟");
  assert.equal(intent.language, "arabic");
  assert.equal(intent.mode, "feature_explain");
  assert.equal(intent.terms.includes("هاي"), false);
  assert.ok(intent.terms.some((term) => /feedback/i.test(term)));
});

test("ConversationUnderstanding carries one cleaned prompt into downstream classifiers", () => {
  const question = createConversationUnderstanding("هاي ازاي الfeedback بيتطبق؟");
  assert.equal(question.intentDecision.kind, "workspace_question");
  assert.equal(question.workspaceMessage, "ازاي الfeedback بيتطبق؟");
  assert.equal(question.workspaceIntent?.topicPhrase, "feedback");
  assert.equal(question.workspaceIntent?.topicTerms.includes("هاي"), false);

  const run = createConversationUnderstanding("هاي شغل المشروع");
  assert.equal(run.intentDecision.kind, "run_request");
  assert.equal(run.workspaceMessage, "شغل المشروع");
  assert.equal(classifyRunIntent("هاي شغل المشروع", run), "run_to_green");
});

test("real-provider direct conversation uses local intent gate before provider or workspace retrieval", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-provider-intent-storage-${Date.now()}`);
  const provider = new NoProviderCallsFixture();
  const runtime = await createRuntime(storageDir, provider);
  const created = await runtime.createSession({
    workspacePath: path.join(os.tmpdir(), `missing-workspace-${Date.now()}`),
    mode: "real_provider",
    providerConfig: validProviderConfig,
    userPrompt: "هاي"
  });

  await runtime.runTurn(created.sessionId, "هاي");
  const session = runtime.getSession(created.sessionId);
  const answer = session?.messages.at(-1)?.content ?? "";

  assert.equal(provider.calls, 0);
  assert.equal(session?.status, "completed");
  assert.equal(session?.projectIntake, undefined);
  assert.equal(session?.artifacts.some((artifact) => artifact.type === "project_intake"), false);
  assert.equal(session?.progressEvents[0]?.taskTitle, "رد مباشر");
  assert.match(answer, /أهلًا|موجود/);
  assert.doesNotMatch(answer, /Workspace used for this answer/);
  assert.doesNotMatch(answer, MOJIBAKE_PATTERN);

  await rm(storageDir, { recursive: true, force: true });
});

test("real-provider direct conversation is not blocked by provider failure", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-provider-intent-fail-storage-${Date.now()}`);
  const provider = new NoProviderCallsFixture(new Error("provider unavailable"));
  const runtime = await createRuntime(storageDir, provider);
  const created = await runtime.createSession({
    workspacePath: path.join(os.tmpdir(), `missing-workspace-${Date.now()}`),
    mode: "real_provider",
    providerConfig: validProviderConfig,
    userPrompt: "هاي"
  });

  await runtime.runTurn(created.sessionId, "هاي");
  const session = runtime.getSession(created.sessionId);
  const answer = session?.messages.at(-1)?.content ?? "";

  assert.equal(provider.calls, 0);
  assert.equal(session?.status, "completed");
  assert.equal(session?.projectIntake, undefined);
  assert.equal(session?.artifacts.some((artifact) => artifact.type === "project_intake" || artifact.type === "project_explain_report"), false);
  assert.equal(session?.progressEvents.at(-1)?.taskTitle, "رد مباشر");
  assert.match(session?.progressEvents.at(-1)?.summary ?? "", /لا تطلب كود|مش محتاجة بحث/);
  assert.match(answer, /أهلًا|موجود/);
  assert.doesNotMatch(answer, /Workspace used for this answer|لقيت|Workspace snapshot/i);
  assert.doesNotMatch(answer, MOJIBAKE_PATTERN);
  assert.doesNotMatch(session?.progressEvents.at(-1)?.taskTitle ?? "", MOJIBAKE_PATTERN);
  assert.doesNotMatch(session?.progressEvents.at(-1)?.summary ?? "", MOJIBAKE_PATTERN);
  assert.doesNotMatch(session?.runSummary?.summary ?? "", MOJIBAKE_PATTERN);

  await rm(storageDir, { recursive: true, force: true });
});

async function createRuntime(storageDir: string, provider: LlmProvider) {
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  return new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
}

class NoProviderCallsFixture implements LlmProvider {
  calls = 0;

  constructor(private readonly error?: Error) {}

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    this.calls += 1;
    if (this.error) throw this.error;
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "unknown";
    throw new Error(`Unexpected provider structured call after intent gate: ${schemaName}`);
  }

  async generateText(): Promise<string> {
    this.calls += 1;
    if (this.error) throw this.error;
    throw new Error("Unexpected provider text call after intent gate");
  }
}
