import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
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

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "auto_mode",
    userPrompt: "fix the button alignment in css"
  });
  await runtime.runTurn(created.sessionId, "fix the button alignment in css");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.tasks.length, 1);
  assert.equal(session?.tasks[0]?.agentRole, "Implementation Worker");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("auto mode chooses orchestrated workers dynamically and respects explicit count", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-auto-orch-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-auto-orch-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs"
  });
  await runtime.runTurn(created.sessionId, "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.ok((session?.tasks.length ?? 0) >= 3);
  assert.equal(session?.status, "failed");
  assert.ok(session?.runSummary);
  assert.equal((session?.runSummary?.filesChanged.length ?? 0) > 0, true);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("real-provider architecture questions use provider-backed read-only swarm instead of deterministic mock workers", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-real-orch-stop-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-real-orch-stop-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");
  await writeFile(path.join(workspace, "src", "runtime.ts"), "export const orchestrator = { directDispatch: true, humanReview: true };\n", "utf8");

  const provider = new FakeSwarmProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "use 1 agent to explain when the orchestrator uses direct dispatch versus human review";
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
  assert.equal(session?.providerTelemetry?.fallbackUsed, false);
  assert.equal(provider.calls.length > 1, true);
  assert.match(session?.messages.at(-1)?.content ?? "", /Provider-backed swarm completed successfully/i);
  assert.doesNotMatch(session?.messages.at(-1)?.content ?? "", /stopped before starting|deterministic\/mock-worker based/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("auto real-provider Arabic orchestration questions route to provider-backed read-only swarm", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-auto-real-arabic-swarm-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-auto-real-arabic-swarm-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(path.join(workspace, "backend", "routes.py"), "from backend.services.orchestrator import choose_route\n", "utf8");
  await writeFile(
    path.join(workspace, "backend", "services", "orchestrator.py"),
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
  assert.equal(session?.providerTelemetry?.fallbackUsed, false);
  assert.equal((session?.providerTelemetry?.providerRequestCount ?? 0) > 1, true);
  assert.equal((session?.orchestration?.workerOutputs.length ?? 0) > 1, true);
  assert.equal((session?.orchestration?.agentRuns.length ?? 0) > 1, true);
  assert.match(answer, /Provider-backed swarm completed successfully/i);
  assert.doesNotMatch(answer, /Local Run|provider_validation_notice|local synthesis was not used|human_review_loop/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("provider-backed swarm schema failures do not surface as completed answers", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-provider-swarm-invalid-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-provider-swarm-invalid-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }), "utf8");
  await writeFile(path.join(workspace, "src", "runtime.ts"), "export const orchestrator = { directDispatch: true, humanReview: true };\n", "utf8");

  const provider = new InvalidSwarmProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "use 1 agent to explain when the orchestrator uses direct dispatch versus human review";
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
  assert.match(content, /Provider-backed swarm failed before producing an accepted answer/i);
  assert.doesNotMatch(content, /Provider-backed swarm completed/i);
  assert.match(content, /Provider output schema failed/i);

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
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n", "utf8");
  await writeFile(path.join(workspace, "src", "App.tsx"), "export function App(){return null}\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "auto_mode",
    thinkFirst: true,
    userPrompt: "add a settings page in react"
  });
  await runtime.runTurn(created.sessionId, "add a settings page in react");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.status, "needs_approval");
  assert.equal(session?.nextAction?.kind, "confirm_plan");
  assert.ok((session?.tasks.length ?? 0) > 0);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

class FakeSwarmProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "swarm_specialist_output";
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

function validSwarmOutput(schemaName: string): Record<string, unknown> {
  if (schemaName === "swarm_scout_output") {
    return {
      findings: ["Found runtime/orchestrator evidence in src/runtime.ts."],
      relevant_files: ["src/runtime.ts"],
      risks: [],
      unknowns: [],
      suggested_next_steps: ["Ask planner and reviewer to verify human-review boundaries."],
      confidence: 0.88
    };
  }
  if (schemaName === "swarm_planner_output") {
    return {
      plan_summary: "Explain direct dispatch versus human review using provider-backed read-only evidence.",
      task_drafts: ["Map runtime policy", "Compare review gate conditions"],
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
      impacted_files_or_modules: ["src/runtime.ts"],
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
      evidence_refs: ["src/runtime.ts"],
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
