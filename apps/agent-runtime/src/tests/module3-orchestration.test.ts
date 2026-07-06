import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProductBrief, BusinessBrief, TechnicalPlan, TaskGraph, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import { OrchestrationFileLockManager } from "../orchestration/FileLockManager.js";
import { validateBusinessBrief, validateProductBrief, validateTaskGraph, validateTechnicalPlan } from "../schemas/validators.js";
import { SecurityAgent } from "../agents/workers/SecurityAgent.js";
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

test("ProductBrief and BusinessBrief validators accept valid briefs", () => {
  const product: ProductBrief = {
    goal: "Add a settings page with theme toggle",
    userIntent: "add_feature",
    scope: ["settings page"],
    constraints: ["patch proposal only"],
    successCriteria: ["theme can be toggled"],
    clarifyingQuestions: [],
    assumptions: ["existing React app"]
  };
  const business: BusinessBrief = {
    mvpScope: ["settings page"],
    outOfScope: ["account settings"],
    userValue: "User controls theme",
    businessRisks: ["visual regression"],
    acceptanceCriteria: ["toggle works"],
    priority: "medium",
    releaseNotesDraft: "Adds theme setting."
  };
  assert.equal(validateProductBrief(product).valid, true);
  assert.equal(validateBusinessBrief(business).valid, true);
});

test("TechnicalPlan and TaskGraph validators check dependency shape", () => {
  const graph: TaskGraph = {
    sessionId: "s1",
    nodes: [
      {
        id: "a",
        title: "A",
        description: "first",
        assignedAgent: "ArchitectAgent",
        status: "pending",
        dependsOn: [],
        fileLocks: [],
        expectedOutput: "notes",
        riskLevel: "low"
      }
    ],
    edges: []
  };
  const plan: TechnicalPlan = {
    summary: "plan",
    architectureImpact: "low",
    affectedAreas: ["ui"],
    testStrategy: ["npm test"],
    riskLevel: "low",
    taskGraph: graph
  };
  assert.equal(validateTaskGraph(graph).valid, true);
  assert.equal(validateTechnicalPlan(plan).valid, true);
});

test("OrchestrationFileLockManager detects conflicts", () => {
  const locks = new OrchestrationFileLockManager("D:/workspace");
  assert.equal(locks.acquire("run-a", "task-a", ["src/App.tsx"]).acquired, true);
  const conflict = locks.acquire("run-a", "task-b", ["src/App.tsx"]);
  assert.equal(conflict.acquired, false);
  assert.equal(conflict.conflicts[0]?.owner_task_id, "task-a");
});

test("provider-backed orchestrated session reaches approval without demo mock runtime", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-module3-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-module3-storage-${Date.now()}`);
  try {
    await mkdir(path.join(workspace, "apps/desktop/src/app"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n", "utf8");
    await writeFile(path.join(workspace, "apps/desktop/src/app/App.tsx"), "export function App(){return null}\n", "utf8");

    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => new ScriptedProvider()
    });
    const prompt = "Add a settings page with theme toggle";
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "orchestrated_mode",
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.status, "needs_approval");
    assert.equal(session?.mode, "real_provider");
    assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
    assert.notEqual(session?.agentName, "Mock Agent");
    assert.equal(session?.providerTelemetry?.terminalFailure, undefined);
    assert.ok((session?.messages.length ?? 0) >= 1);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.patchProposals[0]?.requiresApproval, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("SecurityAgent blocks dangerous command requests", () => {
  const review = new SecurityAgent().review(
    "s1",
    [],
    [
      {
        id: "cmd1",
        sessionId: "s1",
        command: "rm -rf .",
        cwd: "C:/workspace",
        risk: "dangerous",
        reason: "bad",
        status: "blocked",
        createdAt: new Date().toISOString()
      }
    ]
  );
  assert.equal(review.status, "blocked");
});
