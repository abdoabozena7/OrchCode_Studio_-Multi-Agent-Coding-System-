import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreRunLifecycleService,
  FactoryMetadataStore,
  FactoryTraceWriter,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  loadOrchestrationConfig,
  type FinalRunReport,
  type Run,
  type Task
} from "../orchestration/index.js";

test("CoreRunLifecycleService creates runs with intent ledger and created transition", async () => {
  const fixture = await createFixture("lifecycle-create-run");
  try {
    const run = await fixture.lifecycle.createRun({
      userRequest: "Create a lifecycle-owned run.",
      workspacePath: fixture.workspace,
      memoryDir: ".agent_memory",
      config: loadOrchestrationConfig({}),
      maxContextFiles: 3,
      maxContextChars: 2400,
      maxTaskAttempts: 2
    });

    assert.equal(run.status, "created");
    assert.equal(run.user_request, "Create a lifecycle-owned run.");
    assert.equal(run.memory_snapshot_ref, "pending");
    assert.equal(run.config.workspace_path, fixture.workspace);
    assert.equal(run.config.max_context_files, 3);
    assert.equal(run.config.max_context_chars, 2400);
    assert.equal(run.config.max_task_attempts, 2);
    assert.match(run.original_request_ref ?? "", /original_request/);
    assert.match(run.intent_ledger_ref ?? "", /intent_ledger\.json$/);

    const persistedRun = await fixture.store.loadRun(run.id);
    assert.equal(persistedRun.id, run.id);
    const events = await fixture.store.listRunEvents(run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "run.created"), true);

    const metadata = await FactoryMetadataStore.open({ workspacePath: fixture.workspace, readOnly: true });
    try {
      const transition = metadata.get<{ next_status: string; source_component: string }>(
        "SELECT next_status, source_component FROM factory_run_transitions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
        run.id
      );
      assert.equal(transition?.next_status, "created");
      assert.equal(transition?.source_component, "CoreRunLifecycleServiceTest");
    } finally {
      metadata.close();
    }
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreRunLifecycleService persists accepted transitions and run status events", async () => {
  const fixture = await createFixture("lifecycle-transition");
  try {
    await fixture.store.saveRun(fixture.run);

    await fixture.lifecycle.transitionRun(fixture.run, "intake", "Started intake.");

    assert.equal(fixture.run.status, "intake");
    const events = await fixture.store.listRunEvents(fixture.run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "run.status_changed"), true);

    const metadata = await FactoryMetadataStore.open({ workspacePath: fixture.workspace, readOnly: true });
    try {
      const transition = metadata.get<{ next_status: string; source_component: string }>(
        "SELECT next_status, source_component FROM factory_run_transitions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
        fixture.run.id
      );
      assert.equal(transition?.next_status, "intake");
      assert.equal(transition?.source_component, "CoreRunLifecycleServiceTest");
    } finally {
      metadata.close();
    }
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreRunLifecycleService reconciles resume-safe run metadata", async () => {
  const fixture = await createFixture("lifecycle-resume-ok");
  try {
    const run = await fixture.lifecycle.createRun({
      userRequest: "Resume a lifecycle-owned run.",
      workspacePath: fixture.workspace,
      memoryDir: ".agent_memory",
      config: loadOrchestrationConfig({}),
      maxContextFiles: 3,
      maxContextChars: 2400,
      maxTaskAttempts: 2
    });
    await fixture.lifecycle.transitionRun(run, "intake", "Started intake.");

    const reconciliation = await fixture.lifecycle.reconcileRunForResume({
      run,
      workspacePath: fixture.workspace,
      memoryDir: ".agent_memory"
    });

    assert.deepEqual(reconciliation, {
      ok: true,
      reason: "SQLite run state and factory metadata agree."
    });
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreRunLifecycleService blocks resume when artifact and metadata status diverge", async () => {
  const fixture = await createFixture("lifecycle-resume-mismatch");
  try {
    const run = await fixture.lifecycle.createRun({
      userRequest: "Resume mismatch.",
      workspacePath: fixture.workspace,
      memoryDir: ".agent_memory",
      config: loadOrchestrationConfig({}),
      maxContextFiles: 3,
      maxContextChars: 2400,
      maxTaskAttempts: 2
    });
    await fixture.lifecycle.transitionRun(run, "intake", "Started intake.");
    run.status = "planning";

    const reconciliation = await fixture.lifecycle.reconcileRunForResume({
      run,
      workspacePath: fixture.workspace,
      memoryDir: ".agent_memory"
    });

    assert.equal(reconciliation.ok, false);
    assert.equal(reconciliation.severity, "blocked");
    assert.match(reconciliation.reason, /Run status mismatch: artifact=planning, metadata=intake\./);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreRunLifecycleService records rejected transitions without mutating the run", async () => {
  const fixture = await createFixture("lifecycle-rejected");
  try {
    await fixture.store.saveRun(fixture.run);

    await assert.rejects(
      () => fixture.lifecycle.transitionRun(fixture.run, "succeeded", "Invalid shortcut."),
      /Invalid run transition/
    );

    assert.equal(fixture.run.status, "created");
    const traceEvents = await fixture.store.listRunEvents(fixture.run.id);
    assert.equal(traceEvents.some((event) => isRecord(event) && event.type === "run.status_changed"), false);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreRunLifecycleService writes checkpoints and metrics as lifecycle artifacts", async () => {
  const fixture = await createFixture("lifecycle-artifacts");
  try {
    await fixture.store.saveRun(fixture.run);
    const task = fakeTask(fixture.run.id);
    const checkpointRef = await fixture.lifecycle.writeCheckpoint(fixture.run, [task], "planned", ["Task graph ready."]);
    const metrics = await fixture.lifecycle.writeRunMetrics(fixture.run, [task], fakeReport(fixture.run));

    assert.match(checkpointRef, /planned/);
    assert.equal(metrics.run_id, fixture.run.id);
    const events = await fixture.store.listRunEvents(fixture.run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "run.checkpoint_written"), true);
    assert.equal(events.some((event) => isRecord(event) && event.type === "metrics.written"), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const workspace = await fixtureWorkspace(prefix);
  const store = new OrchestrationArtifactStore(workspace);
  const traceWriter = new FactoryTraceWriter({
    workspacePath: workspace,
    sourceComponent: "CoreRunLifecycleServiceTest"
  });
  const run = fakeRun(workspace, `run_${prefix.replace(/[^a-z0-9]/gi, "_")}`);
  const lifecycle = new CoreRunLifecycleService(store, traceWriter, "CoreRunLifecycleServiceTest");
  return { workspace, store, traceWriter, run, lifecycle };
}

async function fixtureWorkspace(prefix: string) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), { name: prefix, scripts: { test: "node -e \"process.exit(0)\"" } });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function fakeRun(workspace: string, id: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Lifecycle test",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_1"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id)
  };
}

function fakeTask(runId: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_1",
    run_id: runId,
    title: "Inspect",
    objective: "Inspect project",
    role_required: "ScoutAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function fakeReport(run: Run): FinalRunReport {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    run_id: run.id,
    status: run.status,
    user_request: run.user_request,
    tasks_created: 1,
    tasks_completed: 0,
    tasks_failed: 0,
    files_changed: [],
    validation_results: [],
    artifacts_path: run.artifacts_path,
    limitations: [],
    next_recommendations: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
