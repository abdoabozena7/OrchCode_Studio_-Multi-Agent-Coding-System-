import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { BusinessOrchestrator } from "../orchestrators/BusinessOrchestrator.js";
import { EngineeringOrchestrator } from "../orchestrators/EngineeringOrchestrator.js";
import { ProductOrchestrator } from "../orchestrators/ProductOrchestrator.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { createSimpleDelegationDecision } from "../runtime/delegation.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";
import { CROSSY_SINGLE_FILE_PROMPT } from "./fixtures/crossySingleFilePrompt.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

async function createScriptedRuntime(storageDir: string): Promise<AgentRuntime> {
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  return new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => new ScriptedProvider()
  });
}

function assertProviderGatedProposal(session: ReturnType<AgentRuntime["getSession"]>, expectedTaskCount: number) {
  assert.equal(session?.mode, "real_provider");
  assert.equal(session?.status, "needs_approval");
  assert.equal(session?.agentName, "Provider-Backed Swarm + Local Run");
  assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
  assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "intent_contract"));
  assert.equal(session?.tasks.length, expectedTaskCount);
  assert.equal(session?.patchProposals.length, 1);
  assert.equal(session?.patchProposals[0]?.requiresApproval, true);
  assert.equal(session?.commandRequests.length, 1);
  assert.equal(session?.commandRequests[0]?.status, "requested");
}

function readyIntentContract(runId: string, request: string, definitionOfDone: string[]): IntentContract {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    contract_id: `contract_${runId}`,
    run_id: runId,
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: request,
    precise_rewrite: request,
    assumptions: ["Test fixture supplies an already-ready provider-authored intent contract."],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced test fixture priority." },
      quality: { score: 80, rationale: "The test expects a useful plan." },
      realism: { score: 70, rationale: "The generated plan should match the request." },
      fun: { score: 60, rationale: "The snake game request has a playful outcome." },
      security: { score: 70, rationale: "Workspace writes remain gated." },
      cost: { score: 50, rationale: "Fixture does not optimize cost." }
    },
    definition_of_done: definitionOfDone,
    non_goals: [],
    conflict_rules: ["Preserve existing behavior unless explicitly changed."],
    status: "ready",
    created_at: now,
    metadata_json: {
      product_brief_user_intent: "add_feature"
    }
  };
}

test("auto mode keeps small provider-backed tasks in simple mode", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-auto-simple-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-auto-simple-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "auto_mode",
      userPrompt: "fix the button alignment in css"
    });
    const turn = await runtime.runTurn(created.sessionId, "fix the button alignment in css");
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.mode, "real_provider");
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "intent_contract"));
    assert.equal(session?.tasks.length, 1);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.patchProposals[0]?.requiresApproval, true);
    assert.equal(session?.commandRequests.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("provider-authored simple route for file creation is not rewritten to orchestrated mode", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-provider-simple-file-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-provider-simple-file-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  try {
    const provider = new ProviderSimpleRouteNewFileProvider();
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => provider
    });
    const prompt = "make a single html file";
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "simple_mode",
      accessProfile: "full_access",
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.notEqual(session?.agentName, "Provider-Backed Swarm");
    assert.notEqual(session?.agentName, "Provider-Backed Swarm + Local Run");
    assert.equal(session?.tasks.length, 1);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.patchProposals[0]?.requiresApproval, true);
  } finally {
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
  const productBrief = new ProductOrchestrator().createBrief(readyIntentContract("test_session", prompt, [
    "Creates index.html, styles.css, and main.js",
    "Renders a nonblank Three.js scene",
    "Implements snake movement controlled by arrow keys",
    "Implements food spawning and growth",
    "Shows and updates score",
    "Handles wall or self collision by resetting the game",
    "Can be previewed locally without a build step"
  ]));
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
  assert.match(answer, /# Internal Swarm Autopilot Report/i);
  assert.match(answer, /## User Goal/i);
  assert.match(answer, /- Terminal status: succeeded/i);
  assert.doesNotMatch(answer, /\*\*Answer\*\*/i);
  assert.doesNotMatch(answer, /\*\*Runtime truth:\*\*/i);
  assert.doesNotMatch(answer, /Answer from provider worker evidence/i);
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
  assert.match(answer, /# Internal Swarm Autopilot Report/i);
  assert.match(answer, /direct dispatch/i);
  assert.match(answer, /human review/i);
  assert.match(answer, /- Terminal status: succeeded/i);
  assert.doesNotMatch(answer, /Runtime truth/i);
  assert.doesNotMatch(answer, /Answer from provider worker evidence/i);
  assert.doesNotMatch(answer, /Local Run|provider_validation_notice|local synthesis was not used|human_review_loop/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("orchestrated build handoff continues through local run when provider swarm is read-only", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-swarm-handoff-build-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-swarm-handoff-build-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const provider = new SwarmHandoffBuildProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
  const prompt = "Use multi-agent orchestration. Build a feature-complete browser 3D Crossy Road style game with Three.js in this empty workspace. Include keyboard controls, scoring, collisions, README, and a runnable start script.";
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

  assert.equal(turn.status, "needs_approval");
  assert.equal(session?.status, "needs_approval");
  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.equal(session?.agentName, "Provider-Backed Swarm + Local Run");
  assert.ok((session?.orchestration?.agentRuns.length ?? 0) > 1);
  assert.ok((session?.orchestration?.workerOutputs.length ?? 0) > 0);
  assert.ok((session?.patchProposals.length ?? 0) > 0);
  assert.ok(session?.patchProposals[0]?.filesChanged.some((file) => file.path === "src/main.js"));
  assert.ok(session?.reasoningSummaries.some((entry) => /handed write-capable execution/i.test(entry)));
  assert.ok(session?.runSummary?.gates.some((gate) => gate.name === "Read-only swarm handoff"));

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("RunEngine respects cloud retry policy through telemetry without outer plan repairs", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-run-engine-cloud-policy-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run-engine-cloud-policy-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  try {
    const provider = new CloudPolicyRunPlanFailureProvider();
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => provider
    });
    const prompt = "Create app.ts with one exported greeting function.";
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "simple_mode",
      accessProfile: "full_access",
      userPrompt: prompt
    });

    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "failed");
    assert.equal(provider.runPlanCalls, 1);
    assert.equal(session?.providerTelemetry?.repairAttempts, 0);
    assert.match(provider.runPlanRequest?.userPrompt ?? "", /BEGIN QUOTED SOURCE REQUEST[\s\S]*Create app\.ts[\s\S]*END QUOTED SOURCE REQUEST/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("full Crossy single-file request uses read-only preflight and proposes only index.html", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-crossy-single-file-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-crossy-single-file-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  try {
    const provider = new SingleFileCrossyProvider();
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => provider
    });
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "auto_mode",
      accessProfile: "full_access",
      userPrompt: CROSSY_SINGLE_FILE_PROMPT
    });

    const turn = await runtime.runTurn(created.sessionId, CROSSY_SINGLE_FILE_PROMPT);
    const session = runtime.getSession(created.sessionId);
    const proposal = session?.patchProposals[0];

    assert.equal(turn.status, "needs_approval", JSON.stringify({
      sessionStatus: session?.status,
      lastMessage: session?.messages.at(-1)?.content,
      terminalFailure: session?.providerTelemetry?.terminalFailure,
      lastError: session?.providerTelemetry?.lastError,
      runSummary: session?.runSummary
    }));
    assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
    assert.equal(session?.agentName, "Provider-Backed Swarm + Local Run");
    assert.deepEqual(proposal?.filesChanged.map((file) => file.path), ["index.html"]);
    assert.deepEqual(proposal?.artifacts?.map((artifact) => artifact.path), ["index.html"]);
    assert.match(proposal?.artifacts?.[0]?.content ?? "", /three@0\.160\.0\/build\/three\.min\.js/);
    const diffWithoutAllowedCdn = (proposal?.unifiedDiff ?? "").replaceAll("https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js", "");
    assert.doesNotMatch(diffWithoutAllowedCdn, /package\.json|src\/main\.js|src\/styles\.css|README\.md|\bnpm\b|\bvite\b/i);
    assert.equal(session?.orchestration?.agentRuns.some((agent) => /Executor|Integrator/i.test(agent.role)), false);
    assert.ok(session?.runSummary?.gates.some((gate) => gate.name === "Read-only swarm handoff"));
    assert.ok(provider.calls.some((call) => call.systemPrompt.includes("sole write-author")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("provider-backed swarm records artifact evidence without local inventory synthesis", async () => {
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
  assert.match(answer, /# Internal Swarm Autopilot Report/i);
  assert.doesNotMatch(answer, /\| Category \| File \| Produced artifact\/state \| Evidence \| Notes \|/);
  assert.doesNotMatch(answer, /Answer from provider worker evidence/i);
  const workerEvidence = JSON.stringify(session?.orchestration?.workerOutputs ?? []);
  assert.match(workerEvidence, /models\/customer_segments\.joblib/);
  assert.match(workerEvidence, /data\/customers\.csv/);
  assert.match(workerEvidence, /data\/action_log\.csv/);
  assert.match(workerEvidence, /backend\/services\/action_executor\.py/);

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

  assert.equal(turn.status, "failed_provider");
  assert.equal(session?.status, "failed_provider");
  assert.match(content, /real model provider was required/i);
  assert.match(content, /provider gate failed/i);
  assert.doesNotMatch(content, /Provider-backed swarm failed before producing an accepted answer/i);
  assert.doesNotMatch(content, /Provider-backed swarm completed/i);
  assert.doesNotMatch(content, /\*\*Answer\*\*/i);
  assert.doesNotMatch(content, /Provider output schema failed|Runtime truth|logical agents|provider requests|invalid structured outputs/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("non-completed Arabic provider-backed swarm records run report without local Arabic answer synthesis", async () => {
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

  assert.notEqual(turn.status, "completed");
  assert.notEqual(session?.status, "completed");
  assert.equal(session?.responseLanguage, "ar");
  assert.match(answer, /# Internal Swarm Autopilot Report/i);
  assert.match(answer, /Re-cluster/);
  assert.match(answer, /- Terminal status: blocked|- Terminal status: failed/i);
  assert.doesNotMatch(answer, /Runtime truth|provider requests|invalid structured outputs|Provider output schema failed/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("explicit one-agent request uses provider prelude without demo task fabrication", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-one-agent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-one-agent-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const prompt = "use 1 agent to make a html css js 3d snake game with threejs";
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

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
    assertProviderGatedProposal(session, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("orchestrated planning uses provider prelude after cleaned conversation request", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-orch-clean-preamble-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-orch-clean-preamble-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const runtime = await createScriptedRuntime(storageDir);
  const prompt = "هاي use 3 agents to make a html css js 3d snake game with threejs";
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    executionMode: "orchestrated_mode",
    accessProfile: "full_access",
    thinkFirst: true,
    userPrompt: prompt
  });
  const turn = await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

  assert.equal(turn.status, "needs_approval");
  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assertProviderGatedProposal(session, 3);
  assert.doesNotMatch(assistantMessage, /هاي use 3 agents/);
  assert.doesNotMatch(assistantMessage, /هاي/);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("explicit three-agent single-file pygame request stays provider-gated", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-three-agent-pygame-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-three-agent-pygame-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const runtime = await createScriptedRuntime(storageDir);
  const prompt = "use 3 agents to make a one python code for a 3d snake game with py game";
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

  assert.equal(turn.status, "needs_approval");
  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.equal(session?.mode, "real_provider");
  assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
  assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "intent_contract"));
  assert.equal(session?.tasks.length, 3);
  assert.equal(session?.patchProposals.length, 0);
  assert.equal(session?.commandRequests.length, 0);
  assert.equal(session?.nextAction?.kind, "confirm_plan");

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("think first stays provider-gated without local plan confirmation fallback", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-think-first-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-think-first-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const prompt = "add a settings page in react";
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "auto_mode",
      thinkFirst: true,
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.mode, "real_provider");
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "intent_contract"));
    assert.equal(session?.tasks.length, 1);
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.nextAction?.kind, "confirm_plan");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

class SwarmHandoffBuildProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = autoTestSchemaName(schema);
    const request = extractAutoTestOriginalRequest(input);
    if (schemaName === "initial-reasoning-decision") {
      return {
        understanding: {
          originalRequest: request,
          cleanedRequest: request,
          language: "english",
          intentKind: "workspace_action",
          route: "orchestrated_run",
          needsWorkspace: true,
          goal: "Use provider-backed swarm preflight and then create a runnable Three.js game through gated writes.",
          ambiguities: [],
          requiredEvidence: ["workspace context", "swarm staffing artifacts"],
          risk: "medium",
          confidence: "high",
          rationale: "The user explicitly requested multi-agent orchestration for a browser game implementation."
        },
        step: {
          id: "handoff_initial_step",
          kind: "final",
          rationale: "Route to orchestrated mode for swarm staffing before the write handoff.",
          toolRequests: [],
          missingFacts: [],
          successCriteria: ["Create a reviewable local patch after swarm preflight."]
        }
      } as T;
    }
    if (schemaName === "conversation-intent-decision") {
      return {
        kind: "workspace_action",
        language: "english",
        needsWorkspace: true,
        confidence: "high",
        rationale: "Implementation request with explicit multi-agent orchestration.",
        workspaceMessage: request
      } as T;
    }
    if (schemaName === "intent-contract") {
      return readyIntentContract("handoff_test", request, [
        "Provider-backed swarm records staffing and read-only worker artifacts.",
        "Write-capable implementation continues through the gated local patch path."
      ]) as T;
    }
    if (schemaName === "intent_review_result") {
      return { status: "aligned", rationale: "The worker output matches the Crossy Road implementation request.", findings: [] } as T;
    }
    if (schemaName === "run-plan") {
      return {
        summary: "Create a Vite Three.js Crossy Road scaffold.",
        reasoningSummary: "Use local gated patch generation after the provider-backed read-only swarm preflight.",
        mode: "create_project",
        tasks: [
          {
            id: "create_scaffold",
            title: "Create scaffold",
            objective: "Create a Vite + Three.js browser game scaffold.",
            roleTitle: "Project Scaffolder",
            targetFiles: ["README.md", "package.json", "index.html", "src/main.js"],
            expectedArtifact: "Reviewable diff",
            verification: "npm run build"
          },
          {
            id: "gameplay_loop",
            title: "Build gameplay",
            objective: "Add lane movement, traffic collision, scoring, and restart state.",
            roleTitle: "Gameplay Implementer",
            targetFiles: ["src/main.js"],
            expectedArtifact: "Reviewable diff",
            verification: "npm run build"
          }
        ],
        acceptanceCriteria: ["Patch proposal includes runnable scripts.", "Game entrypoint is created under src/main.js."],
        risks: ["The patch still requires approval before files are written."],
        suggestedCommands: [{ command: "npm run build", reason: "Verify the generated Vite app after apply." }]
      } as T;
    }
    if (schemaName === "run-patch-intent") {
      return {
        title: "Crossy Road Scaffold",
        summary: "Creates a reviewable Vite + Three.js Crossy Road style scaffold.",
        intents: [
          {
            path: "package.json",
            operation: "create_file",
            replacementText: `${JSON.stringify({
              scripts: { dev: "vite --host 127.0.0.1", build: "vite build" },
              dependencies: { "@vitejs/plugin-basic-ssl": "^2.0.0", three: "^0.178.0", vite: "^6.0.0" },
              devDependencies: {}
            }, null, 2)}\n`,
            reason: "Adds runnable Vite and Three.js project scripts.",
            risk: "low"
          },
          {
            path: "index.html",
            operation: "create_file",
            replacementText: "<!doctype html>\n<html><head><meta charset=\"UTF-8\"><title>Crossy Road</title></head><body><canvas id=\"game\"></canvas><script type=\"module\" src=\"/src/main.js\"></script></body></html>\n",
            reason: "Creates the browser entrypoint.",
            risk: "low"
          },
          {
            path: "src/main.js",
            operation: "create_file",
            replacementText: "import * as THREE from 'three';\n\nconst scene = new THREE.Scene();\nconst camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 100);\nconst renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('#game'), antialias: true });\nrenderer.setSize(innerWidth, innerHeight);\nscene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.8));\nconst player = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), new THREE.MeshStandardMaterial({ color: 0x2fd17c }));\nscene.add(player);\nconst cars = Array.from({ length: 8 }, (_, i) => {\n  const car = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 0.8), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xff7a1a : 0x2487ff }));\n  car.position.set((i % 4) * 3 - 5, 0, -i - 3);\n  scene.add(car);\n  return car;\n});\nlet score = 0;\naddEventListener('keydown', (event) => {\n  if (event.key === 'ArrowUp') { player.position.z -= 1; score += 1; }\n  if (event.key === 'ArrowDown') player.position.z += 1;\n  if (event.key === 'ArrowLeft') player.position.x -= 1;\n  if (event.key === 'ArrowRight') player.position.x += 1;\n});\nfunction animate() {\n  requestAnimationFrame(animate);\n  cars.forEach((car, i) => {\n    car.position.x += i % 2 ? 0.035 : -0.035;\n    if (Math.abs(car.position.x) > 7) car.position.x *= -1;\n    if (car.position.distanceTo(player.position) < 0.8) { player.position.set(0, 0, 0); score = 0; }\n  });\n  camera.position.set(player.position.x, 7, player.position.z + 8);\n  camera.lookAt(player.position);\n  renderer.render(scene, camera);\n}\nanimate();\nconsole.log('score', score);\n",
            reason: "Adds the Three.js render loop, controls, traffic, scoring, and collision reset.",
            risk: "low"
          },
          {
            path: "README.md",
            operation: "create_file",
            replacementText: "# Crossy Road Three.js\n\nRun `npm install`, then `npm run dev`.\n\nUse arrow keys to hop across traffic lanes. The scaffold includes scoring, collisions, camera follow, and restart-on-hit behavior.\n",
            reason: "Documents how to install and run the generated app.",
            risk: "low"
          }
        ],
        suggestedCommands: [{ command: "npm run build", reason: "Verify the generated Vite app after apply." }]
      } as T;
    }
    if (schemaName === "run-verification") {
      return {
        summary: "Verification pending approved apply.",
        checks: [{ name: "Build", status: "pending", detail: "Run npm run build after applying the patch." }]
      } as T;
    }
    if (schemaName === "answer-verification") {
      return {
        verdict: "pass",
        rationale: "The fixture only verifies provider-authored structured flow.",
        supportedClaims: [],
        unsupportedClaims: [],
        missingFacts: [],
        evidenceRefs: []
      } as T;
    }
    if (schemaName === "semantic_conflict_resolution") return { decisions: [] } as T;
    return withTestIntentAlignment(validSwarmOutput(schemaName), input) as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify(withTestIntentAlignment(validSwarmOutput("swarm_scout_output"), input));
  }
}

class CloudPolicyRunPlanFailureProvider extends ScriptedProvider {
  readonly structuredRetryPolicy = { maxKernelRepairAttempts: 0 };
  runPlanCalls = 0;
  runPlanRequest?: LlmRequest;

  override async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    if (autoTestSchemaName(schema) === "run-plan") {
      this.runPlanCalls += 1;
      this.runPlanRequest = input;
      throw new Error("real_provider.invalid_json: forced run-plan failure");
    }
    return super.generateStructured<T>(input, schema);
  }
}

class SingleFileCrossyProvider extends SwarmHandoffBuildProvider {
  override async generateText(input: LlmRequest): Promise<string> {
    if (!input.systemPrompt.includes("sole write-author")) return super.generateText(input);
    this.calls.push(input);
    return [
      "BEGIN HIVO ARTIFACT: index.html",
      "<!doctype html>",
      "<html><head><meta charset=\"utf-8\"><style>html,body,canvas{margin:0;width:100%;height:100%}</style></head>",
      "<body><canvas id=\"game\"></canvas>",
      "<script src=\"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js\"></script>",
      "<script>const canvas=document.getElementById('game');canvas.dataset.smoke=String(Boolean(window.THREE));</script>",
      "</body></html>",
      "END HIVO ARTIFACT"
    ].join("\n");
  }
}

class ProviderSimpleRouteNewFileProvider implements LlmProvider {
  private readonly delegate = new ScriptedProvider();
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = autoTestSchemaName(schema);
    if (schemaName === "initial-reasoning-decision") {
      const request = extractAutoTestOriginalRequest(input);
      return {
        understanding: simpleFileTurnUnderstanding(request),
        step: {
          id: "provider_simple_file_step",
          kind: "final",
          rationale: "Provider selected the bounded simple route for this single-file request.",
          toolRequests: [],
          missingFacts: [],
          successCriteria: ["Continue through simple-mode patch proposal gates."]
        }
      } as T;
    }
    if (schemaName === "turn-understanding") {
      return simpleFileTurnUnderstanding(extractAutoTestOriginalRequest(input)) as T;
    }
    if (schemaName === "conversation-intent-decision") {
      const request = extractAutoTestOriginalRequest(input);
      return {
        kind: "run_request",
        language: "english",
        needsWorkspace: true,
        confidence: "high",
        rationale: "Provider selected a bounded simple route for a single-file request.",
        workspaceMessage: request
      } as T;
    }
    return this.delegate.generateStructured<T>(input, schema);
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return this.delegate.generateText(input);
  }
}

function simpleFileTurnUnderstanding(request: string) {
  return {
    originalRequest: request,
    cleanedRequest: request,
    language: "english",
    intentKind: "run_request",
    route: "simple_run",
    needsWorkspace: true,
    goal: "Create one reviewable single-file artifact through simple-mode gates.",
    ambiguities: [],
    requiredEvidence: ["workspace context"],
    risk: "medium",
    confidence: "high",
    rationale: "Provider selected a bounded simple route for a single-file request."
  };
}

class FakeSwarmProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "swarm_specialist_output";
    const common = commonAutoOrchestrationProviderOutput<T>(input, schemaName);
    if (common) return common;
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
    return withTestIntentAlignment(validSwarmOutput(schemaName), input) as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify(withTestIntentAlignment(validSwarmOutput("swarm_scout_output"), input));
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
    const common = commonAutoOrchestrationProviderOutput<T>(input, schemaName);
    if (common) return common;
    if (schemaName === "swarm_scout_output") return withTestIntentAlignment(validReclusterDecisionOutput(), input) as T;
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
    return JSON.stringify(withTestIntentAlignment(validReclusterDecisionOutput(), input));
  }
}

class ArtifactInventoryProvider implements LlmProvider {
  calls: LlmRequest[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.calls.push(input);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "swarm_specialist_output";
    const common = commonAutoOrchestrationProviderOutput<T>(input, schemaName);
    if (common) return common;
    return withTestIntentAlignment(validArtifactInventoryOutput(schemaName), input) as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.calls.push(input);
    return JSON.stringify(withTestIntentAlignment(validArtifactInventoryOutput("swarm_scout_output"), input));
  }
}

function commonAutoOrchestrationProviderOutput<T>(input: LlmRequest, schemaName: string): T | undefined {
  const request = extractAutoTestOriginalRequest(input);
  const language = /[\u0600-\u06ff]/.test(request) ? "arabic" : "english";
  if (schemaName === "initial-reasoning-decision") {
    return {
      understanding: {
        originalRequest: request,
        cleanedRequest: request,
        language,
        intentKind: "workspace_action",
        route: "swarm_readonly",
        needsWorkspace: true,
        goal: "Answer from provider-backed read-only swarm evidence.",
        ambiguities: [],
        requiredEvidence: ["workspace context", "provider-backed worker outputs"],
        risk: "high",
        confidence: "high",
        rationale: "The fixture routes multi-agent/project understanding prompts to provider-backed read-only swarm."
      },
      step: {
        id: "auto_orchestration_initial_step",
        kind: "final",
        rationale: "Continue through provider-backed read-only swarm.",
        toolRequests: [],
        missingFacts: [],
        successCriteria: ["Use worker artifacts instead of local synthesis."]
      }
    } as T;
  }
  if (schemaName === "intent-contract") {
    return readyIntentContract("auto_orchestration_test", request, [
      "Provider-backed read-only swarm records enough evidence to synthesize the answer."
    ]) as T;
  }
  if (schemaName === "intent_review_result") {
    return { status: "aligned", rationale: "Fixture output aligns with the canonical request.", findings: [] } as T;
  }
  if (schemaName === "answer-verification") {
    return {
      verdict: "pass",
      rationale: "Fixture accepted the provider-authored answer.",
      supportedClaims: [],
      unsupportedClaims: [],
      missingFacts: [],
      evidenceRefs: []
    } as T;
  }
  if (schemaName === "semantic_conflict_resolution") return { decisions: [] } as T;
  return undefined;
}

function withTestIntentAlignment(output: Record<string, unknown>, input?: LlmRequest): Record<string, unknown> {
  const context = typeof input?.context === "object" && input.context !== null
    ? input.context as Record<string, unknown>
    : undefined;
  const frame = typeof context?.intent_frame === "object" && context.intent_frame !== null
    ? context.intent_frame as Record<string, unknown>
    : undefined;
  const taskSlice = typeof frame?.current_task_slice === "object" && frame.current_task_slice !== null
    ? frame.current_task_slice as Record<string, unknown>
    : undefined;
  const contract = typeof frame?.intent_contract === "object" && frame.intent_contract !== null
    ? frame.intent_contract as Record<string, unknown>
    : undefined;
  const alignment: Record<string, unknown> = {
    schema_version: 1,
    original_request_hash: typeof frame?.original_request_hash === "string" ? frame.original_request_hash : "test_original_request_hash",
    task_understanding: "This fixture output is aligned with the test request.",
    original_goal_contribution: "Provides read-only evidence for the orchestrated test flow.",
    possible_intent_conflicts: [],
    assumptions_used: [],
    evidence_refs: []
  };
  if (typeof frame?.intent_contract_ref === "string") alignment.intent_contract_ref = frame.intent_contract_ref;
  if (typeof contract?.revision === "number") alignment.intent_contract_revision = contract.revision;
  if (typeof taskSlice?.task_slice_id === "string") alignment.task_slice_id = taskSlice.task_slice_id;
  return {
    ...output,
    intent_alignment: alignment
  };
}

function autoTestSchemaName(schema: unknown) {
  if (typeof schema === "object" && schema && "name" in schema) {
    return String((schema as { name: string }).name);
  }
  return "";
}

function extractAutoTestOriginalRequest(input: LlmRequest) {
  const context = typeof input.context === "object" && input.context !== null
    ? input.context as Record<string, unknown>
    : undefined;
  const original = context?.original_user_request;
  if (typeof original === "string" && original.trim()) return original.trim();
  const quotedMatch = input.userPrompt.match(/BEGIN QUOTED SOURCE REQUEST\s*([\s\S]*?)\s*END QUOTED SOURCE REQUEST/i);
  if (quotedMatch?.[1]?.trim()) return quotedMatch[1].trim();
  const reasoningMatch = input.userPrompt.match(/Understand this user turn and choose its first reasoning step:\s*([\s\S]*?)\n\nReturn \{ understanding, step \}\./i);
  if (reasoningMatch?.[1]?.trim()) return reasoningMatch[1].trim();
  const userRequestMatch = input.userPrompt.match(/User request:\s*([\s\S]*?)(?:\n(?:Unified intent understanding|Workspace snapshot|Project intake|Plan|Context pack):|$)/i);
  if (userRequestMatch?.[1]?.trim()) return userRequestMatch[1].trim();
  return input.userPrompt.trim();
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
