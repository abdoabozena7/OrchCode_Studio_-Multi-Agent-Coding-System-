import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

test("run this project uses launch inference instead of patch proposals for static module workspaces", async () => {
  process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `orchcode-run-static-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run-static-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "index.html"),
    '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n',
    "utf8"
  );
  await writeFile(path.join(workspace, "styles.css"), "body { margin: 0; }\n", "utf8");
  await writeFile(path.join(workspace, "main.js"), 'import * as THREE from "https://unpkg.com/three/build/three.module.js";\n', "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    accessProfile: "full_access",
    userPrompt: "run this project"
  });
  const turn = await runtime.runTurn(created.sessionId, "run this project");
  const session = runtime.getSession(created.sessionId);

  assert.equal(turn.status, "needs_approval");
  assert.equal(session?.patchProposals.length, 0);
  assert.equal(session?.commandRequests[0]?.command.includes("python -m http.server"), true);
  assert.equal(session?.commandExecutions.length, 0);
  assert.equal(session?.previewRecommendation?.type, "url");
  assert.equal(session?.nextAction?.kind, "approve_commands");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS;
});

test("run this project prefers package manager dev scripts in package.json workspaces", async () => {
  process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `orchcode-run-package-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run-package-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { dev: "vite --port 4409" } }, null, 2),
    "utf8"
  );
  await writeFile(path.join(workspace, "README.md"), "vite test fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    accessProfile: "full_access",
    userPrompt: "run this project"
  });
  await runtime.runTurn(created.sessionId, "run this project");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.patchProposals.length, 0);
  assert.equal(session?.commandRequests[0]?.command, "npm run dev");
  assert.equal(session?.previewRecommendation?.target, "http://127.0.0.1:4409");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS;
});

test("explain this project stays in simple mode and emits ordered progress without patch proposals", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-explain-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello project\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), '{"scripts":{"test":"echo ok"}}\n', "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "explain this project"
  });
  await runtime.runTurn(created.sessionId, "explain this project");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.patchProposals.length, 0);
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Intake"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Workspace snapshot"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Plan"));
  assert.ok(session?.verificationResult);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("modify requests still go through patch proposal flow with ordered reasoning", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-modify-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-modify-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "change me\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "add a settings page"
  });
  await runtime.runTurn(created.sessionId, "add a settings page");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.patchProposals.length, 1);
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Draft changes"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Approval"));

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});
