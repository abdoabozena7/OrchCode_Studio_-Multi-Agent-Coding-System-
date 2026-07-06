import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { buildProjectIntake, classifyRunIntent } from "../runtime/ProjectIntake.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

test("empty workspace intake stays empty or unknown without fake certainty", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-intake-empty-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  try {
    const intake = buildProjectIntake({
      workspacePath: workspace,
      message: "analyze this workspace",
      projectMap: {
        stack: [],
        packageManagers: [],
        testCommands: [],
        entryPoints: [],
        importantFiles: []
      },
      tools: new ToolRegistry(workspace)
    });

    assert.ok(intake.projectKind === "empty_project" || intake.projectKind === "unknown");
    assert.ok(intake.confidence === "low" || intake.confidence === "unknown");
    assert.ok(intake.unknowns.length >= 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("zero visible files fail closed as unknown instead of fake empty project", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-intake-zero-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  try {
    const intake = buildProjectIntake({
      workspacePath: workspace,
      message: "run this project",
      projectMap: {
        stack: [],
        packageManagers: [],
        testCommands: [],
        entryPoints: [],
        importantFiles: []
      },
      tools: new ToolRegistry(workspace)
    });

    assert.equal(intake.projectKind, "unknown");
    assert.equal(intake.runIntent, "run_to_green");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("source plus config plus docs produces high-confidence existing project intake", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-intake-existing-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "voxbox", scripts: { build: "vite build", test: "vitest run" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Voxbox\n", "utf8");
  await writeFile(path.join(workspace, "src", "main.ts"), "export const boot = true;\n", "utf8");
  await writeFile(path.join(workspace, "tests", "main.test.ts"), "export {};\n", "utf8");

  try {
    const intake = buildProjectIntake({
      workspacePath: workspace,
      message: "add a tiny feature",
      projectMap: {
        stack: ["TypeScript"],
        packageManagers: ["npm"],
        testCommands: ["npm test"],
        entryPoints: ["src/main.ts"],
        importantFiles: ["package.json", "README.md"]
      },
      tools: new ToolRegistry(workspace)
    });

    assert.equal(intake.projectKind, "existing_project");
    assert.equal(intake.confidence, "high");
    assert.equal(intake.detectedProjectName, "voxbox");
    assert.ok(intake.contextPack);
    assert.ok(intake.contextPack?.relevantFiles.includes("src/main.ts"));
    assert.ok(intake.contextPack?.verificationCommands.includes("npm test"));
    assert.ok(intake.doNotTouchCandidates.includes(".git/"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("package summary only reports npm test when a test script exists", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-intake-dev-only-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "snake-game", scripts: { dev: "vite" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "src", "main.js"), "console.log('ready');\n", "utf8");

  try {
    const tools = new ToolRegistry(workspace);
    const projectMap = tools.workspace.getProjectSummary();
    const intake = buildProjectIntake({
      workspacePath: workspace,
      message: "run this project again",
      projectMap: {
        stack: ["JavaScript"],
        packageManagers: projectMap.packageManagers,
        testCommands: projectMap.testCommands,
        entryPoints: ["src/main.js"],
        importantFiles: ["package.json", "src/main.js"]
      },
      tools
    });

    assert.deepEqual(projectMap.testCommands, []);
    assert.equal(intake.testCommands.includes("npm test"), false);
    assert.equal(intake.knownCommands.includes("npm run dev"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("git changes and todo markers produce mid-progress signals and warnings", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-intake-mid-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "src", "app.ts"), "// TODO finish this module\nexport const value = 1;\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  await writeFile(path.join(workspace, "README.md"), "work in progress\n", "utf8");

  try {
    const intake = buildProjectIntake({
      workspacePath: workspace,
      message: "fix this project until it starts",
      projectMap: {
        stack: ["TypeScript"],
        packageManagers: ["npm"],
        testCommands: [],
        entryPoints: ["src/app.ts"],
        importantFiles: ["package.json", "src/app.ts"]
      },
      tools: new ToolRegistry(workspace)
    });

    assert.equal(intake.projectKind, "mid_progress_project");
    assert.ok(intake.detectedSignals.some((signal) => signal.type === "current_git_changes"));
    assert.ok(intake.detectedSignals.some((signal) => signal.type === "existing_todos"));
    assert.equal(intake.progressReconstruction?.inferred, true);
    assert.equal(intake.runIntent, "run_to_green");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run intent contract distinguishes run once and run to green", () => {
  assert.equal(classifyRunIntent("run this project"), "run_to_green");
  assert.equal(classifyRunIntent("run npm test once"), "run_once");
  assert.equal(classifyRunIntent("inspect the current architecture"), "inspect_only");
  assert.equal(classifyRunIntent("implement the auth module"), "implement_module");
});

test("runtime records provider-authored decision and intent artifacts before orchestration", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-intake-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-intake-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "voxbox", scripts: { test: "echo ok" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Voxbox\n", "utf8");
  await writeFile(path.join(workspace, "src", "main.ts"), "export const main = true;\n", "utf8");
  await writeFile(path.join(workspace, "tests", "main.test.ts"), "export {};\n", "utf8");

  try {
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
      providerFactory: () => new ScriptedProvider()
    });
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "orchestrated_mode",
      userPrompt: "add a small README note"
    });
    const turn = await runtime.runTurn(created.sessionId, "add a small README note");
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.mode, "real_provider");
    assert.equal(session?.resolvedExecutionMode, "orchestrated_mode");
    assert.equal(session?.providerTelemetry?.terminalFailure, undefined);
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "intent_contract"));
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.patchProposals[0]?.requiresApproval, true);
    assert.equal(session?.commandRequests.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});
