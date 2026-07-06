import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DurableLockManager } from "../orchestration/DurableLockManager.js";
import type { FactoryLock, FactoryLockMode, FactoryLockScope, LockAcquisitionRequest, LockAcquisitionResult } from "../orchestration/FactoryLockModels.js";
import type { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { CoreTaskGraphExecutionService } from "../orchestration/CoreTaskGraphExecutionService.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type OrchestratorEvent,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../orchestration/OrchestrationModels.js";
import { TaskGraphManager } from "../orchestration/TaskGraphManager.js";

test("CoreTaskGraphExecutionService runs legacy tasks through the canonical graph", async () => {
  const workspace = await createFixtureWorkspace("hivo-core-task-execution");
  try {
    const store = fakeArtifactStore();
    const manager = new TaskGraphManager("run_core_execution", workspace, store.asStore);
    manager.createTask(taskInput("inspect", "ScoutAgent", "Inspect the project", []));
    const lockManager = fakeLockManager();

    const result = await new CoreTaskGraphExecutionService(store.asStore).execute({
      run: fakeRun(workspace, "run_core_execution"),
      manager,
      lockManager: lockManager.asManager,
      config: { lock_ttl_ms: 1000 },
      executeTask: async () => output("inspection complete"),
      writeCheckpoint: async () => undefined,
      createEvent
    });

    assert.equal(result.outputs.length, 1);
    assert.equal(result.tasks[0]?.status, "succeeded");
    assert.equal(result.canonical.graph.status, "awaiting_approval");
    assert.equal(result.canonical.graph.finalStatus, "needs_approval");
    assert.equal(result.canonical.taskExecution.completed, 1);
    assert.equal(result.canonical.taskExecution.failed, 0);
    assert.equal(lockManager.acquireRequests.length, 0);
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
    run_id: "run_core_execution",
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
    user_request: "Test canonical execution service",
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

function output(summary: string): ParsedAgentOutput {
  return {
    summary,
    status: "succeeded",
    files_changed: [],
    validation_results: [],
    artifacts: [],
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
  const asStore = {
    async saveTasks() {
      return "tasks.json";
    },
    async appendEvent() {
      return "events.jsonl";
    },
    async saveLockSnapshot(_runId: string, id: string) {
      return `locks/${id}.json`;
    }
  } as unknown as OrchestrationArtifactStore;
  return { asStore };
}

function fakeLockManager() {
  const acquireRequests: LockAcquisitionRequest[] = [];
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
      return {
        acquired: true,
        request,
        locks: [],
        conflicts: [],
        requested_paths: request.scopes.map((scope) => scope.scope),
        artifact_refs: []
      };
    },
    releaseByTask: async (): Promise<FactoryLock[]> => []
  } as unknown as DurableLockManager;
  return { asManager, acquireRequests };
}

async function createFixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}
