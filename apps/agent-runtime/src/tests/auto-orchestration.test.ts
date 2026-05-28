import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

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
