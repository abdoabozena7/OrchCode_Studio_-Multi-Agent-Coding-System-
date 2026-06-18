import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { BusinessOrchestrator } from "../orchestrators/BusinessOrchestrator.js";
import { EngineeringOrchestrator } from "../orchestrators/EngineeringOrchestrator.js";
import { ProductOrchestrator } from "../orchestrators/ProductOrchestrator.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { createSimpleDelegationDecision } from "../runtime/delegation.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { buildServer } from "../server.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

test("auto mode keeps small tasks in a single agent", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-auto-simple-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-auto-simple-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  let app: Awaited<ReturnType<typeof buildServer>>["app"] | undefined;
  try {
    const server = await buildServer({ ...loadConfig(), storageDir });
    app = server.app;
    const created = await server.runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      executionMode: "auto_mode",
      userPrompt: "fix the button alignment in css"
    });
    await server.runtime.runTurn(created.sessionId, "fix the button alignment in css");
    const session = server.runtime.getSession(created.sessionId);

    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.tasks.length, 1);
    assert.equal(session?.tasks[0]?.agentRole, "Implementation Worker");
  } finally {
    await app?.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("auto mode chooses orchestrated workers dynamically and respects explicit count", () => {
  const prompt = "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs";
  const projectMap = {
    stack: [],
    packageManagers: [],
    testCommands: [],
    entryPoints: [],
    importantFiles: ["README.md"]
  };
  const productBrief = new ProductOrchestrator().createBrief(prompt);
  const businessBrief = new BusinessOrchestrator().createBrief(productBrief);
  const engineering = new EngineeringOrchestrator().createTechnicalPlan({
    sessionId: "test_session",
    productBrief,
    businessBrief,
    projectMap
  });
  const delegation = createSimpleDelegationDecision({ prompt, projectMap });

  assert.equal(delegation.resolvedMode, "orchestrated_mode");
  assert.equal(delegation.requestedAgentCount, 3);
  assert.equal(engineering.delegationDecision.selectedAgentCount, 3);
  assert.deepEqual(engineering.delegationDecision.selectedAgentRoles, [
    "GameLogicAgent",
    "ThreeJsRenderingAgent",
    "FrontendIntegrationAgent"
  ]);
  assert.equal(engineering.workOrders.length, 3);
});

test("real-provider architecture questions use provider-backed read-only swarm instead of deterministic mock workers", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-real-orch-stop-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-real-orch-stop-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await writeFile(path.join(workspace, "src", "policy.ts"), "export const policy = { directDispatch: true, humanReview: true };\n", "utf8");

  const provider = new FakeSwarmProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "explain the policy names direct dispatch versus human review from src/policy.ts";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    executionMode: "orchestrated_mode",
    accessProfile: "full_access",
    userPrompt: prompt
  });
  const turn = await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);

  assert.equal(turn.status, "completed");
  assert.equal(session?.status, "completed");
  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.equal((session?.orchestration?.workerOutputs.length ?? 0) > 1, true);
  assert.equal((session?.orchestration?.agentRuns.length ?? 0) > 1, true);
  assert.equal(session?.patchProposals.length, 0);
  assert.equal((session?.providerTelemetry?.providerRequestCount ?? 0) > 1, true);
  assert.equal(session?.providerTelemetry?.terminalFailure, undefined);
  assert.equal(provider.calls.length > 1, true);
  const answer = session?.messages.at(-1)?.content ?? "";
  assert.match(answer, /\*\*Answer\*\*/i);
  assert.doesNotMatch(answer, /Provider-backed swarm completed successfully/i);
  assert.doesNotMatch(answer, /\*\*Runtime truth:\*\*/i);
  assert.doesNotMatch(answer, /Answer from provider worker evidence|Internal Swarm Autopilot Report/i);
  assert.doesNotMatch(answer, /stopped before starting|deterministic\/mock-worker based/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("auto real-provider Arabic orchestration questions route to provider-backed read-only swarm", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-auto-real-arabic-swarm-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-auto-real-arabic-swarm-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(path.join(workspace, "backend", "routes.py"), "from backend.services.policy import choose_route\n", "utf8");
  await writeFile(
    path.join(workspace, "backend", "services", "policy.py"),
    "def choose_route(agent_consensus, score):\n    if agent_consensus < 0.60: return 'human review'\n    return 'direct dispatch'\n",
    "utf8"
  );
  await writeFile(path.join(workspace, "backend", "services", "agents.py"), "def build_default_agents(): return []\n", "utf8");
  await writeFile(path.join(workspace, "backend", "services", "action_executor.py"), "class ActionExecutor: pass\n", "utf8");

  const provider = new FakeSwarmProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "امتى الـ orchestrator يعمل direct dispatch؟ وامتى يحوّل لـ human review حتى لو فيه agents بتقترح action؟";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: prompt
  });
  const turn = await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const answer = session?.messages.at(-1)?.content ?? "";

  assert.equal(turn.status, "completed");
  assert.equal(session?.status, "completed");
  assert.equal(session?.agentName, "Provider-Backed Swarm");
  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.equal(session?.providerTelemetry?.terminalFailure, undefined);
  assert.equal((session?.providerTelemetry?.providerRequestCount ?? 0) > 1, true);
  assert.equal((session?.orchestration?.workerOutputs.length ?? 0) > 1, true);
  assert.equal((session?.orchestration?.agentRuns.length ?? 0) > 1, true);
  assert.match(answer, /الخلاصة|الإجابة|الشرح/);
  assert.doesNotMatch(answer, /Provider-backed swarm completed successfully/i);
  assert.doesNotMatch(answer, /Runtime truth/i);
  assert.doesNotMatch(answer, /Answer from provider worker evidence|Internal Swarm Autopilot Report/i);
  assert.doesNotMatch(answer, /Local Run|provider_validation_notice|local synthesis was not used|human_review_loop/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("provider-backed swarm synthesizes artifact inventory into a deduped evidence table", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-provider-swarm-artifacts-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-provider-swarm-artifacts-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await mkdir(path.join(workspace, "backend", "data"), { recursive: true });
  await writeFile(
    path.join(workspace, "backend", "services", "clustering.py"),
    "CLUSTERING_MODEL_PATH = 'models/customer_segments.joblib'\ndef train_model():\n    return CLUSTERING_MODEL_PATH\n",
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "action_executor.py"),
    "ACTION_LOG_PATH = 'data/action_log.csv'\ndef record_action(row):\n    return ACTION_LOG_PATH\n",
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "data_loader.py"),
    "CUSTOMER_DATA_PATH = 'data/customers.csv'\ndef load_customers():\n    return CUSTOMER_DATA_PATH\n",
    "utf8"
  );

  const provider = new ArtifactInventoryProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "Which project files produce durable artifacts such as models, data, and logs? What is the difference between training artifacts and runtime logs? Answer from current project files only.";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: prompt
  });
  const turn = await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const answer = session?.messages.at(-1)?.content ?? "";

  assert.equal(turn.status, "completed");
  assert.equal(session?.agentName, "Provider-Backed Swarm");
  assert.match(answer, /\| Category \| File \| Produced artifact\/state \| Evidence \| Notes \|/);
  assert.match(answer, /Model\/state/);
  assert.match(answer, /Data\/state/);
  assert.match(answer, /Runtime log/);
  assert.match(answer, /models\/customer_segments\.joblib/);
  assert.match(answer, /data\/customers\.csv/);
  assert.match(answer, /data\/action_log\.csv/);
  assert.doesNotMatch(answer, /\|[^|\n]*logs\//i);
  assert.doesNotMatch(answer, /Answer from provider worker evidence|Internal Swarm Autopilot Report/i);
  assert.equal((answer.match(/backend\/services\/action_executor\.py/g) ?? []).length, 1);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("provider-backed swarm schema failures do not surface as completed answers", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-provider-swarm-invalid-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-provider-swarm-invalid-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }), "utf8");
  await writeFile(path.join(workspace, "src", "policy.ts"), "export const policy = { directDispatch: true, humanReview: true };\n", "utf8");

  const provider = new InvalidSwarmProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "explain the policy names direct dispatch versus human review from src/policy.ts";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    executionMode: "orchestrated_mode",
    accessProfile: "full_access",
    userPrompt: prompt
  });
  const turn = await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const content = session?.messages.at(-1)?.content ?? "";

  assert.equal(turn.status, "failed");
  assert.equal(session?.status, "failed");
  assert.match(content, /\*\*Answer\*\*/i);
  assert.doesNotMatch(content, /Provider-backed swarm failed before producing an accepted answer/i);
  assert.doesNotMatch(content, /Provider-backed swarm completed/i);
  assert.doesNotMatch(content, /Provider output schema failed|Runtime truth|logical agents|provider requests|invalid structured outputs/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("non-completed Arabic provider-backed swarm synthesizes a clean Arabic answer without debug metadata", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-provider-swarm-ar-blocked-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-provider-swarm-ar-blocked-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(
    path.join(workspace, "backend", "services", "policy.py"),
    "def choose_next(drift_score, fcm_membership):\n    if drift_score > 0.4 or max(fcm_membership) < 0.55: return 're-cluster'\n    return 'offer'\n",
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "clustering.py"),
    "def fcm_membership(customer): return [0.52, 0.48]\n",
    "utf8"
  );

  const provider = new PartialBlockedArabicSwarmProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "\u0645\u062a\u0649 \u0627\u0644\u0646\u0638\u0627\u0645 \u064a\u0642\u0631\u0631 Re-cluster \u0628\u062f\u0644 \u0645\u0627 \u064a\u0628\u0639\u062a offer\u061f \u0627\u0631\u0628\u0637 \u0625\u062c\u0627\u0628\u062a\u0643 \u0628\u064a\u0646 drift detection \u0648 FCM membership \u0648 policy rules.";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: prompt
  });
  const turn = await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const answer = session?.messages.at(-1)?.content ?? "";

  assert.equal(turn.status === "blocked" || turn.status === "failed", true);
  assert.equal(session?.status === "blocked" || session?.status === "failed", true);
  assert.equal(session?.responseLanguage, "ar");
  assert.match(answer, /الخلاصة/);
  assert.match(answer, /منطق القرار خطوة بخطوة/);
  assert.match(answer, /Re-cluster/);
  assert.match(answer, /drift detection|FCM membership|policy rules/i);
  assert.doesNotMatch(answer, /Provider-backed swarm|Runtime truth|logical agents|provider requests|invalid structured outputs|Internal Swarm Autopilot Report|Provider output schema failed/i);
  assert.equal((answer.match(/[\u0600-\u06ff]/g) ?? []).length > 40, true);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("explicit one-agent request still uses one worker plus mandatory gates", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-one-agent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-one-agent-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: "use 1 agent to make a html css js 3d snake game with threejs"
  });
  await runtime.runTurn(created.sessionId, "use 1 agent to make a html css js 3d snake game with threejs");
  const session = runtime.getSession(created.sessionId);

  assert.ok((session?.tasks.length ?? 0) >= 1);
  assert.equal(session?.status, "failed");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("orchestrated planning uses cleaned conversation request for task graph", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-orch-clean-preamble-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-orch-clean-preamble-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const prompt = "هاي use 3 agents to make a html css js 3d snake game with threejs";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "orchestrated_mode",
    accessProfile: "full_access",
    thinkFirst: true,
    userPrompt: prompt
  });
  await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const taskText = session?.tasks.map((task) => `${task.title} ${task.agentRole}`).join("\n") ?? "";
  const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

  assert.equal(session?.status, "needs_approval");
  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.ok((session?.tasks.length ?? 0) > 0);
  assert.doesNotMatch(taskText, /هاي/);
  assert.doesNotMatch(assistantMessage, /هاي use 3 agents/);
  assert.doesNotMatch(assistantMessage, /هاي/);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("explicit three-agent single-file pygame request requires plan confirmation instead of failing", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-three-agent-pygame-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-three-agent-pygame-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const prompt = "use 3 agents to make a one python code for a 3d snake game with py game";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: prompt
  });
  await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.status, "needs_approval");
  assert.equal(session?.nextAction?.kind, "confirm_plan");
  assert.match(session?.nextAction?.message ?? "", /Python file/i);
  assert.notEqual(session?.status, "failed");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("think first stops after planning and waits for confirmation", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-think-first-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-think-first-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  let app: Awaited<ReturnType<typeof buildServer>>["app"] | undefined;
  try {
    const server = await buildServer({ ...loadConfig(), storageDir });
    app = server.app;
    const prompt = "add a settings page in react";
    const created = await server.runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      executionMode: "auto_mode",
      thinkFirst: true,
      userPrompt: prompt
    });
    await server.runtime.runTurn(created.sessionId, prompt);
    const session = server.runtime.getSession(created.sessionId);

    assert.equal(session?.status, "needs_approval");
    assert.equal(session?.nextAction?.kind, "confirm_plan");
    assert.ok((session?.tasks.length ?? 0) > 0);
  } finally {
    await app?.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

class FakeSwarmProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "swarm_specialist_output";
    if (schemaName === "conversation-intent-decision") {
      return {
        kind: "workspace_question",
        language: /[\u0600-\u06ff]/.test(input.userPrompt) ? "arabic" : "english",
        needsWorkspace: true,
        confidence: "high",
        rationale: "The provider classified this as a read-only workspace architecture question.",
        workspaceMessage: input.userPrompt.match(/Classify this single user message before retrieval:\n([\s\S]*?)\n\nReturn JSON/i)?.[1]?.trim() ?? input.userPrompt
      } as T;
    }
    return validSwarmOutput(schemaName) as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify(validSwarmOutput("swarm_scout_output"));
  }
}

class InvalidSwarmProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest): Promise<T> {
    this.calls.push(input);
    return {
      findings: "not an array",
      relevant_files: "not an array",
      risks: "not an array",
      unknowns: "not an array",
      suggested_next_steps: "not an array",
      confidence: Number.NaN
    } as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify({
      findings: "not an array",
      relevant_files: "not an array",
      risks: "not an array",
      unknowns: "not an array",
      suggested_next_steps: "not an array",
      confidence: "bad"
    });
  }
}

class PartialBlockedArabicSwarmProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "swarm_specialist_output";
    if (schemaName === "swarm_scout_output") return validReclusterDecisionOutput() as T;
    return {
      findings: "not an array",
      relevant_files: "not an array",
      risks: "not an array",
      unknowns: "not an array",
      suggested_next_steps: "not an array",
      confidence: Number.NaN
    } as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify(validReclusterDecisionOutput());
  }
}

class ArtifactInventoryProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "swarm_specialist_output";
    return validArtifactInventoryOutput(schemaName) as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify(validArtifactInventoryOutput("swarm_scout_output"));
  }
}

function validReclusterDecisionOutput(): Record<string, unknown> {
  return {
    findings: [
      "backend/services/policy.py routes to re-cluster when drift_score is high or FCM membership confidence is low, otherwise it returns offer.",
      "backend/services/clustering.py exposes FCM membership values used by the policy decision rule."
    ],
    relevant_files: [
      "backend/services/policy.py",
      "backend/services/clustering.py"
    ],
    risks: ["Exact production thresholds may differ if more rule files exist outside this fixture."],
    unknowns: [],
    suggested_next_steps: ["Synthesize an Arabic explanation instead of exposing worker diagnostics."],
    confidence: 0.82
  };
}

function validSwarmOutput(schemaName: string): Record<string, unknown> {
  if (schemaName === "swarm_scout_output") {
    return {
      findings: ["Found policy evidence in src/policy.ts."],
      relevant_files: ["src/policy.ts"],
      risks: [],
      unknowns: [],
      suggested_next_steps: ["Ask planner and reviewer to verify human-review boundaries."],
      confidence: 0.88
    };
  }
  if (schemaName === "swarm_planner_output") {
    return {
      plan_summary: "Explain direct dispatch versus human review using provider-backed read-only evidence.",
      task_drafts: ["Map policy", "Compare review gate conditions"],
      dependencies: ["repo index", "scout findings"],
      risks: [],
      validation_strategy: ["No validation commands are required for a read-only explanation."],
      assumptions: ["No writes are needed"],
      confidence: 0.82
    };
  }
  if (schemaName === "swarm_risk_analyst_output") {
    return {
      risks: ["Write-capable actions still require explicit approval."],
      severity: "medium",
      impacted_files_or_modules: ["src/policy.ts"],
      mitigation: ["Keep this run read-only."],
      blockers: [],
      confidence: 0.75
    };
  }
  if (schemaName === "swarm_reviewer_output") {
    return {
      decision: "accepted",
      findings: ["Provider-backed worker output stayed read-only."],
      severity: "low",
      required_changes: [],
      validation_recommendations: ["Do not claim command validation was run."],
      confidence: 0.8
    };
  }
  if (schemaName === "swarm_tester_planner_output") {
    return {
      recommended_validation: [],
      required_commands: [],
      optional_commands: [],
      smoke_checks: ["Canonical session should show multiple provider worker outputs."],
      blocked_or_missing_validation: [],
      confidence: 0.83
    };
  }
  if (schemaName === "swarm_reporter_output") {
    return {
      summary: "Provider-backed read-only swarm answered from worker artifacts.",
      evidence_refs: ["src/policy.ts"],
      unresolved_risks: [],
      next_steps: ["Use explicit approval before any action proposal."],
      confidence: 0.86
    };
  }
  return {
    specialty: "architecture",
    findings: ["Architecture specialist reviewed orchestration boundaries."],
    recommendations: ["Use human review when action authority is unclear."],
    risks: [],
    confidence: 0.81
  };
}

function validArtifactInventoryOutput(schemaName: string): Record<string, unknown> {
  const findings = [
    "backend/services/clustering.py defines CLUSTERING_MODEL_PATH = models/customer_segments.joblib and saves fitted clustering model state.",
    "backend/services/action_executor.py defines ACTION_LOG_PATH = data/action_log.csv and writes action outcomes during runtime.",
    "backend/services/data_loader.py defines CUSTOMER_DATA_PATH = data/customers.csv and reads the customer dataset."
  ];
  const relevant_files = [
    "backend/services/clustering.py",
    "backend/services/action_executor.py",
    "backend/services/data_loader.py"
  ];
  if (schemaName === "swarm_scout_output") {
    return {
      findings,
      relevant_files,
      risks: [],
      unknowns: ["No code evidence proves a logs/ directory."],
      suggested_next_steps: ["Synthesize a table instead of repeating worker outputs."],
      confidence: 0.91
    };
  }
  if (schemaName === "swarm_planner_output") {
    return {
      plan_summary: "Classify durable artifacts by model state, data/state, and runtime log evidence.",
      task_drafts: findings,
      dependencies: relevant_files,
      risks: [],
      validation_strategy: ["Check that logs/ is not invented."],
      assumptions: [],
      confidence: 0.88
    };
  }
  if (schemaName === "swarm_risk_analyst_output") {
    return {
      risks: ["Do not call data/action_log.csv a logs/ directory."],
      severity: "medium",
      impacted_files_or_modules: relevant_files,
      mitigation: ["Only name paths present in accepted findings."],
      blockers: [],
      confidence: 0.82
    };
  }
  if (schemaName === "swarm_reviewer_output") {
    return {
      decision: "accepted",
      findings,
      severity: "low",
      required_changes: [],
      validation_recommendations: ["Ensure final answer is deduped."],
      confidence: 0.87
    };
  }
  if (schemaName === "swarm_tester_planner_output") {
    return {
      recommended_validation: ["Assert markdown table exists."],
      required_commands: [],
      optional_commands: [],
      smoke_checks: findings,
      blocked_or_missing_validation: [],
      confidence: 0.86
    };
  }
  if (schemaName === "swarm_reporter_output") {
    return {
      summary: findings.join(" "),
      evidence_refs: relevant_files,
      unresolved_risks: [],
      next_steps: [],
      confidence: 0.9
    };
  }
  return {
    specialty: "artifact inventory",
    findings,
    recommendations: ["Present one final classification table."],
    risks: [],
    confidence: 0.89
  };
}
