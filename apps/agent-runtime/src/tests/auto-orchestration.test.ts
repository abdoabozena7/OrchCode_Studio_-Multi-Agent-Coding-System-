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
    mode: "demo_mock",
    executionMode: "auto_mode",
    userPrompt: "explain this repo"
  });
  await runtime.runTurn(created.sessionId, "explain this repo");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.tasks.length, 1);
  assert.equal(session?.tasks[0]?.agentRole, "Implementation Worker");

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
    mode: "demo_mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs"
  });
  await runtime.runTurn(created.sessionId, "use 3 agents to make a html ,css ,js code for a 3d snake game with threejs");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
  assert.equal(session?.tasks.length, 3);
  assert.deepEqual(session?.tasks.map((task) => task.agentRole), [
    "Gameplay Implementer",
    "3D Rendering Implementer",
    "Frontend Integration Implementer"
  ]);
  assert.equal((session?.patchProposals.length ?? 0) > 0, true);
  assert.equal(session?.verificationResult?.status, "pending");
  assert.equal(session?.patchProposals[0]?.status, "proposed");
  assert.ok((session?.toolIntents.length ?? 0) >= 4);
  assert.ok((session?.artifacts.length ?? 0) >= 3);
  assert.ok(session?.runSummary);
  assert.equal((session?.runSummary?.filesChanged.length ?? 0) > 0, true);
  assert.equal(session?.runSummary?.gates.some((gate) => gate.name === "Rust apply"), true);

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
    mode: "demo_mock",
    executionMode: "auto_mode",
    accessProfile: "full_access",
    userPrompt: "use 1 agent to make a html css js 3d snake game with threejs"
  });
  await runtime.runTurn(created.sessionId, "use 1 agent to make a html css js 3d snake game with threejs");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.tasks.length, 1);
  assert.deepEqual(session?.tasks.map((task) => task.agentRole), ["Gameplay Implementer"]);
  assert.equal(session?.status, "needs_approval");

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
    mode: "demo_mock",
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
