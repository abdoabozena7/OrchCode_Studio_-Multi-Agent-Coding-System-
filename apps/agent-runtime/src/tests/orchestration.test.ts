import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";
import type { CommandInventory, FileSummaryRecord, RepoIndex } from "../memory/types.js";
import { SeniorCodingAgent } from "../agents/SeniorCodingAgent.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import {
  CoreOrchestrator,
  ContextPackBuilder,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  TaskGraphManager,
  listAgentRoles,
  validateRun,
  validateTask,
  type Run,
  type Task
} from "../orchestration/index.js";

test("Phase 2 Run and Task model validation fails loudly for invalid data", () => {
  const runValidation = validateRun({
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "",
    user_request: "Inspect the project",
    status: "created",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    root_task_ids: [],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: "workspace",
      memory_dir: ".agent_memory",
      max_context_files: 4,
      max_context_chars: 4000,
      max_task_attempts: 1,
      provider_mode: "mock"
    },
    artifacts_path: "runs/run_1"
  } as Run);
  assert.equal(runValidation.valid, false);
  assert.ok(runValidation.errors.some((error) => error.includes("id is required")));

  const taskValidation = validateTask({
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_1",
    run_id: "run_1",
    title: "Bad task",
    objective: "",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies: [],
    relevant_files: [],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "ExecutorOutput",
    validation_commands: [],
    max_attempts: 0,
    attempt_count: 0,
    artifacts: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  } as Task);
  assert.equal(taskValidation.valid, false);
  assert.ok(taskValidation.errors.some((error) => error.includes("objective is required")));
  assert.ok(taskValidation.errors.some((error) => error.includes("max_attempts")));
});

test("role registry contains all required Phase 2 roles with real contracts", () => {
  const roles = listAgentRoles();
  const names = roles.map((role) => role.name).sort();
  assert.deepEqual(names, [
    "ArchitectAgent",
    "ExecutorAgent",
    "IntegratorAgent",
    "PlannerAgent",
    "ReporterAgent",
    "ReviewerAgent",
    "ScoutAgent",
    "TesterAgent"
  ].sort());
  for (const role of roles) {
    assert.ok(role.allowed_operations.length > 0);
    assert.ok(role.forbidden_operations.length > 0);
    assert.ok(role.required_output_format.length > 0);
    assert.ok(role.success_criteria.length > 0);
  }
});

test("task graph manager enforces auditable status transitions", async () => {
  const workspace = await createFixtureWorkspace("hivo-graph");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const manager = new TaskGraphManager("run_test", workspace, store);
    const task = manager.createTask({
      id: "task_one",
      run_id: "run_test",
      title: "Inspect files",
      objective: "Inspect files before edits.",
      role_required: "ScoutAgent",
      dependencies: [],
      relevant_files: ["src/index.ts"],
      allowed_files_to_edit: [],
      forbidden_files: [],
      expected_output_schema: "ScoutOutput",
      validation_commands: [],
      max_attempts: 1
    });
    await manager.recordCreatedEvents();
    await manager.markStatus(task.id, "ready");
    await assert.rejects(() => manager.markStatus(task.id, "succeeded"), /Invalid task transition/);
    await manager.markStatus(task.id, "running");
    await manager.markStatus(task.id, "succeeded");
    assert.equal(manager.requireTask(task.id).status, "succeeded");
    assert.equal(existsSync(path.join(workspace, ".agent_memory", "runs", "run_test", "events.jsonl")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("context pack builder creates bounded context from fake Phase 1 memory data", async () => {
  const workspace = await createFixtureWorkspace("hivo-context");
  try {
    await writeFakeMemory(workspace);
    const builder = new ContextPackBuilder(workspace, { maxFiles: 2, maxChars: 700 });
    const task = createTestTask("run_ctx");
    const pack = await builder.build("run_ctx", task);

    assert.equal(pack.task_id, task.id);
    assert.ok(pack.relevant_files.includes("src/index.ts"));
    assert.ok(pack.snippets.length >= 1);
    assert.ok(pack.approximate_size <= 1000);
    assert.ok(pack.validation_requirements.includes("npm run test"));
    assert.ok(pack.previous_decisions.some((decision) => decision.includes("file-backed")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("orchestrator creates a run, tasks, artifacts, executor invocation, and final report", async () => {
  const workspace = await createFixtureWorkspace("hivo-orchestrator");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      maxContextFiles: 3,
      maxContextChars: 2500
    }).runAgenticTask("Explain src/index.ts and do not change files.");

    assert.equal(result.run.status, "succeeded");
    assert.ok(result.tasks.length >= 4);
    assert.equal(result.run.root_task_ids.length, 1);
    assert.ok(result.tasks.some((task) => task.role_required === "ExecutorAgent" && task.status === "succeeded"));
    assert.equal(result.report.run_id, result.run.id);
    assert.ok(result.report.tasks_completed >= 4);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "run.json")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "tasks.json")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "reports", "final_report.json")), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "events.jsonl")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("old simple SeniorCodingAgent path still works alongside Phase 2", async () => {
  const workspace = await createFixtureWorkspace("hivo-simple-agent");
  try {
    const sessionManager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
      runtimeEventLoader: async () => []
    });
    await sessionManager.load();
    const session = await sessionManager.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      executionMode: "simple_mode",
      userPrompt: "Explain this project."
    });
    const completed = await new SeniorCodingAgent(new MockLlmProvider(), sessionManager)
      .runTurn(session.id, "Explain this project.");
    assert.equal(completed.status, "completed");
    assert.ok(completed.messages.some((message) => message.role === "assistant"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createFixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "fixture-orchestrator",
    scripts: {
      test: "node --test",
      build: "tsc -p tsconfig.json"
    }
  }, null, 2), "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "src", "index.ts"), [
    "export function greet(name: string) {",
    "  return `hello ${name}`;",
    "}"
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "src", "index.test.ts"), "import { greet } from './index.js';\n", "utf8");
  return workspace;
}

async function writeFakeMemory(workspace: string) {
  const paths = await ensureMemoryLayout(workspace);
  const repoIndex: RepoIndex = {
    schemaVersion: 1,
    generatedAt: new Date("2026-05-21T00:00:00.000Z").toISOString(),
    workspaceRoot: workspace,
    projectName: "fixture-orchestrator",
    totals: {
      indexedFiles: 3,
      sourceFiles: 2,
      testFiles: 1,
      configFiles: 1,
      docFiles: 0,
      skippedFiles: 0,
      indexedBytes: 300
    },
    languages: { TypeScript: 2, JSON: 1 },
    extensions: { ".ts": 2, ".json": 1 },
    topLevelDirectories: [{ path: "src", files: 2 }],
    ignoredDirectories: [],
    skippedFiles: [],
    sourceFiles: ["src/index.ts", "src/index.test.ts"],
    testFiles: ["src/index.test.ts"],
    configFiles: ["package.json"],
    docFiles: [],
    importantFiles: ["package.json", "src/index.ts"],
    entrypoints: ["src/index.ts"],
    packageFiles: ["package.json"],
    dependencyFiles: ["package-lock.json"],
    buildFiles: ["package.json"]
  };
  const commandInventory: CommandInventory = {
    schemaVersion: 1,
    generatedAt: repoIndex.generatedAt,
    packageManagers: ["npm"],
    commands: [{
      id: "cmd_test",
      kind: "test",
      command: "npm run test",
      cwd: ".",
      sourceFile: "package.json",
      source: "package_json",
      packageManager: "npm",
      scriptName: "test",
      confidence: "high"
    }],
    byKind: {
      test: ["npm run test"],
      lint: [],
      typecheck: [],
      build: [],
      format: [],
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
  const summary: FileSummaryRecord = {
    schemaVersion: 1,
    path: "src/index.ts",
    roleGuess: "Likely entrypoint.",
    language: "TypeScript",
    roles: ["source", "entrypoint"],
    exports: ["greet"],
    imports: [],
    symbols: [{ name: "greet", kind: "function", line: 1, exported: true }],
    relatedTests: ["src/index.test.ts"],
    purposeGuess: "exports greet"
  };
  await writeJson(paths.repoIndex, repoIndex);
  await writeJson(paths.commandInventory, commandInventory);
  await writeFile(paths.fileSummaries, `${JSON.stringify(summary)}\n`, "utf8");
  await writeFile(paths.decisions, `${JSON.stringify({
    id: "decision_test",
    createdAt: new Date("2026-05-21T00:00:00.000Z").toISOString(),
    summary: "Keep Phase 1 memory file-backed for now."
  })}\n`, "utf8");
}

function createTestTask(runId: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_context",
    run_id: runId,
    title: "Inspect entrypoint",
    objective: "Explain greet in src/index.ts",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: [],
    forbidden_files: [".env"],
    expected_output_schema: "ExecutorOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}
