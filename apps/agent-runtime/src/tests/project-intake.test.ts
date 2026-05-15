import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { buildProjectIntake, classifyRunIntent } from "../runtime/ProjectIntake.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("empty workspace intake stays empty or unknown without fake certainty", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-intake-empty-${Date.now()}`);
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

test("source plus config plus docs produces high-confidence existing project intake", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-intake-existing-${Date.now()}`);
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

test("git changes and todo markers produce mid-progress signals and warnings", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-intake-mid-${Date.now()}`);
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

test("runtime records project intake, context pack, and intake decisions before patch planning", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-intake-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-intake-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "voxbox", scripts: { test: "echo ok" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Voxbox\n", "utf8");
  await writeFile(path.join(workspace, "src", "main.ts"), "export const main = true;\n", "utf8");
  await writeFile(path.join(workspace, "tests", "main.test.ts"), "export {};\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "add a small README note"
    });
    await runtime.runTurn(created.sessionId, "add a small README note");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.projectIntake?.projectKind, "existing_project");
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "project_intake"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "context_pack"));
    assert.ok((session?.decisionLedger ?? []).some((record) => /Treat this workspace as existing work/i.test(record.decision)));
    assert.equal(session?.runIntent, "implement_module");
    assert.notEqual(session?.plan?.summary.includes("Create a new local project"), true);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});
