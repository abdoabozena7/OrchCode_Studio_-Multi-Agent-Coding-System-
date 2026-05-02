import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

test("auto mode keeps small tasks in a single agent", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-auto-simple-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-auto-simple-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "mock",
    executionMode: "auto_mode",
    userPrompt: "explain this repo"
  });
  await runtime.runTurn(created.sessionId, "explain this repo");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.delegationDecision?.selectedAgentCount, 1);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("auto mode chooses orchestrated workers dynamically and respects explicit count", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-auto-orch-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-auto-orch-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs"
  });
  await runtime.runTurn(created.sessionId, "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.equal(session?.delegationDecision?.requestedAgentCount, 3);
  assert.equal(session?.delegationDecision?.selectedAgentCount, 3);
  assert.deepEqual(session?.delegationDecision?.selectedAgentRoles, ["GameLogicAgent", "ThreeJsRenderingAgent", "FrontendIntegrationAgent"]);
  assert.deepEqual(session?.orchestration?.selectedWorkerAgents, ["GameLogicAgent", "ThreeJsRenderingAgent", "FrontendIntegrationAgent"]);
  assert.deepEqual(session?.orchestration?.mandatoryGateAgents, [
    "Product Orchestrator",
    "Business Orchestrator",
    "Engineering Orchestrator",
    "SecurityAgent",
    "ReviewerAgent"
  ]);
  assert.deepEqual(session?.patchProposals[0]?.filesChanged.map((file) => file.path), ["index.html", "styles.css", "main.js"]);
  assert.equal(session?.orchestration?.qualityGateResults.every((gate) => gate.status === "passed"), true);
  assert.equal(session?.patchProposals[0]?.status, "applied");
  assert.ok((session?.progressEvents.length ?? 0) >= 8);
  assert.equal(session?.agentWorkStatuses.length, 3);
  assert.ok(session?.runSummary);
  assert.deepEqual(session?.runSummary?.filesChanged.map((file) => file.path), ["index.html", "styles.css", "main.js"]);
  assert.equal(session?.runSummary?.gates.every((gate) => gate.status === "passed"), true);

  const mainJs = await readFile(path.join(workspace, "main.js"), "utf8");
  assert.match(mainJs, /class SnakeGame/);
  assert.match(mainJs, /three\.module\.js/);
  assert.match(mainJs, /spawnFood/);
  assert.match(mainJs, /scoreLabel/);
  assert.match(mainJs, /isWallCollision/);
  assert.match(mainJs, /isSelfCollision/);
  assert.match(mainJs, /restartGame/);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("explicit one-agent request still uses one worker plus mandatory gates", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-one-agent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-one-agent-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: "use 1 agent to make a html css js 3d snake game with threejs"
  });
  await runtime.runTurn(created.sessionId, "use 1 agent to make a html css js 3d snake game with threejs");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.delegationDecision?.selectedAgentCount, 1);
  assert.deepEqual(session?.delegationDecision?.selectedAgentRoles, ["FrontendIntegrationAgent"]);
  assert.equal(session?.orchestration?.mandatoryGateAgents.includes("ReviewerAgent"), true);
  assert.equal(session?.status, "completed");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("think first stops after planning and waits for confirmation", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-think-first-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-think-first-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n", "utf8");
  await writeFile(path.join(workspace, "src", "App.tsx"), "export function App(){return null}\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "mock",
    executionMode: "auto_mode",
    thinkFirst: true,
    userPrompt: "add a settings page in react"
  });
  await runtime.runTurn(created.sessionId, "add a settings page in react");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.status, "needs_approval");
  assert.equal(session?.nextAction?.kind, "confirm_plan");
  assert.ok(session?.plan || session?.orchestration?.technicalPlan);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});
