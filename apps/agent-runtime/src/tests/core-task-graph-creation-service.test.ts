import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import {
  CoreRunLifecycleService,
  CoreTaskGraphCreationService,
  FactoryTraceWriter,
  OrchestrationArtifactStore,
  loadOrchestrationConfig
} from "../orchestration/index.js";

test("CoreTaskGraphCreationService creates the deterministic core task graph", async () => {
  const fixture = await createFixture("core-task-graph");
  try {
    const run = await fixture.lifecycle.createRun({
      userRequest: "Refactor auth layer then update docs for operators",
      workspacePath: fixture.workspace,
      memoryDir: ".agent_memory",
      config: loadOrchestrationConfig({}),
      maxContextFiles: 4,
      maxContextChars: 4000,
      maxTaskAttempts: 2
    });

    const manager = await fixture.taskGraphs.create({
      run,
      repoIndex: fixture.repoIndex,
      commandInventory: fixture.commandInventory,
      maxTaskAttempts: 2
    });
    const tasks = manager.listTasks();

    assert.equal(tasks.length, 5);
    assert.deepEqual(tasks.map((task) => task.role_required), [
      "ScoutAgent",
      "PlannerAgent",
      "ExecutorAgent",
      "ExecutorAgent",
      "ReporterAgent"
    ]);
    assert.equal(tasks[0].dependencies.length, 0);
    assert.deepEqual(tasks[1].dependencies, [tasks[0].id]);
    assert.deepEqual(tasks[2].dependencies, [tasks[1].id]);
    assert.deepEqual(tasks[3].dependencies, [tasks[1].id]);
    assert.deepEqual(tasks[4].dependencies, [tasks[2].id, tasks[3].id]);
    assert.deepEqual(tasks[0].validation_commands, ["npm run test", "npm run typecheck"]);
    assert.equal(tasks[2].max_attempts, 2);
    assert.equal(tasks[2].relevant_files.includes("src/auth.ts"), true);
    assert.equal(tasks[2].allowed_files_to_edit.includes("src/auth.ts"), true);

    const persisted = await fixture.store.loadTasks(run.id);
    assert.equal(persisted.length, tasks.length);
    const events = await fixture.store.listRunEvents(run.id);
    assert.equal(events.filter((event) => isRecord(event) && event.type === "task.created").length, tasks.length);
    assert.equal(events.some((event) => isRecord(event) && event.type === "agent.output_parsed"), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const workspace = await fixtureWorkspace(prefix);
  const store = new OrchestrationArtifactStore(workspace);
  const traceWriter = new FactoryTraceWriter({
    workspacePath: workspace,
    sourceComponent: "CoreTaskGraphCreationServiceTest"
  });
  const lifecycle = new CoreRunLifecycleService(store, traceWriter, "CoreTaskGraphCreationServiceTest");
  const taskGraphs = new CoreTaskGraphCreationService(workspace, store, ".agent_memory");
  return {
    workspace,
    store,
    lifecycle,
    taskGraphs,
    repoIndex: fakeRepoIndex(workspace),
    commandInventory: fakeCommandInventory()
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export * from './auth.js';\n", "utf8");
  await writeFile(path.join(root, "docs", "operators.md"), "# Operators\n", "utf8");
  return root;
}

function fakeRepoIndex(workspace: string): RepoIndex {
  const generatedAt = new Date("2026-06-29T00:00:00.000Z").toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    workspaceRoot: workspace,
    projectName: "core-task-graph-test",
    totals: {
      indexedFiles: 3,
      sourceFiles: 2,
      testFiles: 0,
      configFiles: 0,
      docFiles: 1,
      skippedFiles: 0,
      indexedBytes: 128
    },
    languages: { TypeScript: 2, Markdown: 1 },
    extensions: { ".ts": 2, ".md": 1 },
    topLevelDirectories: [{ path: "src", files: 2 }, { path: "docs", files: 1 }],
    ignoredDirectories: [],
    skippedFiles: [],
    sourceFiles: ["src/auth.ts", "src/index.ts"],
    testFiles: [],
    configFiles: [],
    docFiles: ["docs/operators.md"],
    importantFiles: ["src/auth.ts", "docs/operators.md"],
    entrypoints: ["src/index.ts"],
    packageFiles: [],
    dependencyFiles: [],
    buildFiles: []
  };
}

function fakeCommandInventory(): CommandInventory {
  const generatedAt = new Date("2026-06-29T00:00:00.000Z").toISOString();
  return {
    schemaVersion: 1,
    generatedAt,
    packageManagers: ["npm"],
    commands: [
      {
        id: "cmd_test",
        kind: "test",
        command: "npm run test",
        cwd: ".",
        sourceFile: "package.json",
        source: "package_json",
        packageManager: "npm",
        scriptName: "test",
        confidence: "high"
      },
      {
        id: "cmd_typecheck",
        kind: "typecheck",
        command: "npm run typecheck",
        cwd: ".",
        sourceFile: "package.json",
        source: "package_json",
        packageManager: "npm",
        scriptName: "typecheck",
        confidence: "high"
      }
    ],
    byKind: {
      test: ["npm run test"],
      lint: [],
      typecheck: ["npm run typecheck"],
      build: [],
      format: [],
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
