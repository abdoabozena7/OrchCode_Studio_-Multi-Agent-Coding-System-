import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DurableLockManager } from "../orchestration/DurableLockManager.js";
import type { FactoryLock, FactoryLockMode, FactoryLockScope, LockAcquisitionRequest, LockAcquisitionResult } from "../orchestration/FactoryLockModels.js";
import type { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type OrchestratorEvent,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../orchestration/OrchestrationModels.js";
import { TaskGraphExecutionLoopService } from "../orchestration/TaskGraphExecutionLoopService.js";
import { TaskGraphManager } from "../orchestration/TaskGraphManager.js";

test("TaskGraphExecutionLoopService executes read-only tasks without durable locks", async () => {
  const workspace = await createFixtureWorkspace("hivo-loop-readonly");
  try {
    const store = fakeArtifactStore();
    const manager = new TaskGraphManager("run_loop", workspace, store.asStore);
    manager.createTask(taskInput("inspect", "ScoutAgent", "Inspect the project", []));
    const lockManager = fakeLockManager();
    let executedTaskId = "";
    let checkpointCount = 0;

    const result = await new TaskGraphExecutionLoopService(store.asStore).execute({
      run: fakeRun(workspace, "run_loop"),
      manager,
      lockManager: lockManager.asManager,
      config: { lock_ttl_ms: 1000 },
      executeTask: async (task) => {
        executedTaskId = task.id;
        return output("inspection complete");
      },
      writeCheckpoint: async () => {
        checkpointCount += 1;
      },
      createEvent
    });

    assert.equal(executedTaskId, "inspect");
    assert.equal(lockManager.acquireRequests.length, 0);
    assert.equal(checkpointCount, 1);
    assert.equal(result.outputs.length, 1);
    assert.equal(manager.requireTask("inspect").status, "succeeded");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TaskGraphExecutionLoopService acquires and releases locks for editing tasks", async () => {
  const workspace = await createFixtureWorkspace("hivo-loop-locks");
  try {
    const store = fakeArtifactStore();
    const manager = new TaskGraphManager("run_loop", workspace, store.asStore);
    manager.createTask(taskInput("edit", "ExecutorAgent", "Implement change", ["src/app.ts"]));
    const lockManager = fakeLockManager();

    await new TaskGraphExecutionLoopService(store.asStore).execute({
      run: fakeRun(workspace, "run_loop"),
      manager,
      lockManager: lockManager.asManager,
      config: { lock_ttl_ms: 2500 },
      executeTask: async () => output("change complete", ["patch.json"]),
      writeCheckpoint: async () => undefined,
      createEvent
    });

    assert.equal(lockManager.acquireRequests.length, 1);
    assert.equal(lockManager.acquireRequests[0]?.scopes.some((scope) => scope.scope === "src/app.ts" && scope.mode === "write"), true);
    assert.equal(lockManager.releaseTasks[0], "edit");
    assert.deepEqual(store.lockSnapshotIds, ["edit_acquired", "edit_released"]);
    assert.equal(store.events.some((event) => event.type === "lock.acquired"), true);
    assert.equal(store.events.some((event) => event.type === "lock.released"), true);
    assert.equal(manager.requireTask("edit").status, "succeeded");
    assert.equal(manager.requireTask("edit").artifacts.includes("patch.json"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TaskGraphExecutionLoopService blocks pending tasks when no dependency path is ready", async () => {
  const workspace = await createFixtureWorkspace("hivo-loop-blocked");
  try {
    const store = fakeArtifactStore();
    const manager = new TaskGraphManager("run_loop", workspace, store.asStore);
    manager.createTask({ ...taskInput("blocked-dependency", "ScoutAgent", "Inspect dependency", []), status: "blocked" });
    manager.createTask(taskInput("waiting", "ExecutorAgent", "Implement after dependency", ["src/app.ts"], ["blocked-dependency"]));

    const result = await new TaskGraphExecutionLoopService(store.asStore).execute({
      run: fakeRun(workspace, "run_loop"),
      manager,
      lockManager: fakeLockManager().asManager,
      config: { lock_ttl_ms: 1000 },
      executeTask: async () => {
        throw new Error("No task should execute when the graph has no ready dependency path.");
      },
      writeCheckpoint: async () => undefined,
      createEvent
    });

    assert.equal(result.outputs.length, 0);
    assert.equal(manager.requireTask("waiting").status, "blocked");
    assert.equal(manager.requireTask("waiting").result_summary, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function taskInput(
  id: string,
  role: Task["role_required"],
  objective: string,
  allowedFiles: string[],
  dependencies: string[] = []
): Parameters<TaskGraphManager["createTask"]>[0] {
  return {
    id,
    run_id: "run_loop",
    title: id,
    objective,
    role_required: role,
    dependencies,
    relevant_files: allowedFiles,
    allowed_files_to_edit: allowedFiles,
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1
  };
}

function fakeRun(workspace: string, id: string): Run {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Test execution loop",
    status: "executing",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    root_task_ids: [],
    memory_snapshot_ref: path.join(workspace, ".agent_memory", "repo_index.json"),
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id),
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 4,
      max_context_chars: 4000,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    }
  };
}

function output(summary: string, artifacts: string[] = []): ParsedAgentOutput {
  return {
    summary,
    status: "succeeded",
    files_changed: [],
    validation_results: [],
    artifacts,
    limitations: [],
    next_recommendations: []
  };
}

function createEvent(
  runId: string,
  type: OrchestratorEvent["type"],
  message: string,
  payload?: Record<string, unknown>,
  taskId?: string
): OrchestratorEvent {
  return {
    id: `event_${type}_${taskId ?? "run"}`,
    run_id: runId,
    task_id: taskId,
    type,
    message,
    created_at: new Date().toISOString(),
    payload
  };
}

function fakeArtifactStore() {
  const events: OrchestratorEvent[] = [];
  const lockSnapshotIds: string[] = [];
  const asStore = {
    async saveTasks() {
      return "tasks.json";
    },
    async appendEvent(event: OrchestratorEvent) {
      events.push(event);
      return "events.jsonl";
    },
    async saveLockSnapshot(_runId: string, id: string) {
      lockSnapshotIds.push(id);
      return `locks/${id}.json`;
    }
  } as unknown as OrchestrationArtifactStore;
  return { asStore, events, lockSnapshotIds };
}

function fakeLockManager() {
  const acquireRequests: LockAcquisitionRequest[] = [];
  const releaseTasks: string[] = [];
  const locksByTask = new Map<string, FactoryLock[]>();
  const asManager = {
    deriveModuleLocksForTask: () => [],
    deriveSemanticLocksForTask: () => [],
    normalizeLockScope: (scope: string, mode: FactoryLockMode = "write") => ({
      type: scope === "." ? "directory" : "file",
      mode,
      scope,
      normalized_scope_key: `file:${scope}`,
      confidence: "high",
      reason: "test lock scope"
    } satisfies FactoryLockScope),
    acquireLocks: async (request: LockAcquisitionRequest): Promise<LockAcquisitionResult> => {
      acquireRequests.push(request);
      const locks = request.scopes.map((scope, index) => lockForScope(request, scope, index));
      if (request.task_id) locksByTask.set(request.task_id, locks);
      return {
        acquired: true,
        request,
        locks,
        conflicts: [],
        requested_paths: request.scopes.map((scope) => scope.scope),
        artifact_refs: ["locks/acquire.json"]
      };
    },
    releaseByTask: async (taskId: string): Promise<FactoryLock[]> => {
      releaseTasks.push(taskId);
      return (locksByTask.get(taskId) ?? []).map((lock) => ({
        ...lock,
        status: "released",
        released_at: new Date().toISOString()
      }));
    }
  } as unknown as DurableLockManager;
  return { asManager, acquireRequests, releaseTasks };
}

function lockForScope(request: LockAcquisitionRequest, scope: FactoryLockScope, index: number): FactoryLock {
  return {
    schema_version: 1,
    lock_id: `lock_${index}`,
    run_id: request.run_id,
    task_id: request.task_id,
    lock_type: scope.type,
    lock_mode: scope.mode,
    lock_scope: scope.scope,
    normalized_scope_key: scope.normalized_scope_key,
    owner_component: request.owner_component,
    status: "acquired",
    reason: request.reason,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (request.ttl_ms ?? 1000)).toISOString(),
    metadata_json: request.metadata_json ?? {}
  };
}

async function createFixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}
