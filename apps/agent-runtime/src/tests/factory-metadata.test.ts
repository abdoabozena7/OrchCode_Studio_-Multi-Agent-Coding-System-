import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { FactoryMetadataStore } from "../orchestration/FactoryMetadataStore.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentInvocation,
  type Run,
  type Task
} from "../orchestration/OrchestrationModels.js";

const REQUIRED_TABLES = [
  "factory_runs",
  "factory_tasks",
  "factory_task_dependencies",
  "factory_prompts",
  "factory_prompt_quality_results",
  "factory_outputs",
  "factory_reviews",
  "factory_validations",
  "factory_artifacts",
  "factory_trace_events",
  "factory_plan_variants",
  "factory_plan_evaluations",
  "factory_merged_plans",
  "factory_worker_invocations",
  "factory_planning_evidence",
  "factory_plan_evidence_links",
  "factory_prompt_writer_outputs",
  "factory_prompt_writer_adoption_decisions",
  "factory_memory_chunks",
  "factory_context_items",
  "factory_locks",
  "factory_metrics",
  "factory_campaigns"
];

test("factory metadata schema creates all orchestration tables", async () => {
  const workspace = await fixtureWorkspace();
  const metadata = await FactoryMetadataStore.open({ workspacePath: workspace });
  try {
    const tables = metadata.tableNames();
    for (const table of REQUIRED_TABLES) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
  } finally {
    metadata.close();
  }
});

test("factory metadata records runs tasks dependencies and artifact refs without changing artifact paths", async () => {
  const workspace = await fixtureWorkspace();
  const store = new OrchestrationArtifactStore(workspace);
  const run = fakeRun(workspace);
  const scout = fakeTask(run.id, "task_scout_metadata", []);
  const executor = fakeTask(run.id, "task_executor_metadata", [scout.id]);

  const runRef = await store.saveRun(run);
  const tasksRef = await store.saveTasks(run.id, [scout, executor]);
  const rawRef = await store.saveRawOutput(run.id, `${executor.id}_manual_raw`, {
    task_id: executor.id,
    status: "succeeded"
  });

  const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
  try {
    const runRow = metadata.get<{ id: string; status: string; run_artifact_ref: string }>(
      "SELECT id, status, run_artifact_ref FROM factory_runs WHERE id = ?",
      run.id
    );
    assert.deepEqual(runRow, { id: run.id, status: "created", run_artifact_ref: runRef });

    const taskRows = metadata.all<{ task_id: string; status: string; artifact_ref: string }>(
      "SELECT task_id, status, artifact_ref FROM factory_tasks WHERE run_id = ? ORDER BY task_id",
      run.id
    );
    assert.deepEqual(taskRows, [
      { task_id: executor.id, status: "pending", artifact_ref: tasksRef },
      { task_id: scout.id, status: "pending", artifact_ref: tasksRef }
    ]);

    const dependencies = metadata.all<{ task_id: string; depends_on_task_id: string }>(
      "SELECT task_id, depends_on_task_id FROM factory_task_dependencies WHERE run_id = ?",
      run.id
    );
    assert.deepEqual(dependencies, [{ task_id: executor.id, depends_on_task_id: scout.id }]);

    const artifact = metadata.get<{ artifact_ref: string; relative_artifact_ref: string }>(
      "SELECT artifact_ref, relative_artifact_ref FROM factory_artifacts WHERE artifact_ref = ?",
      rawRef
    );
    assert.equal(artifact?.artifact_ref, rawRef);
    assert.equal(artifact?.relative_artifact_ref, `runs/${run.id}/raw_outputs/${executor.id}_manual_raw.json`);
    assert.equal(rawRef, path.join(workspace, ".agent_memory", "runs", run.id, "raw_outputs", `${executor.id}_manual_raw.json`));
    assert.equal(existsSync(rawRef), true);
  } finally {
    metadata.close();
  }
});

test("factory metadata links prompts outputs reviews and validations to a task", async () => {
  const workspace = await fixtureWorkspace();
  const store = new OrchestrationArtifactStore(workspace);
  const run = fakeRun(workspace);
  const task = fakeTask(run.id, "task_linked_metadata", []);
  const invocation = fakeInvocation(run.id, task.id);

  await store.saveRun(run);
  await store.saveTasks(run.id, [task]);
  await store.saveInvocation(invocation);
  invocation.raw_output_ref = await store.saveRawOutput(run.id, invocation.id, {
    task_id: task.id,
    status: "succeeded"
  });
  invocation.parsed_output_ref = await store.saveParsedOutput(run.id, invocation.id, {
    task_id: task.id,
    status: "succeeded",
    summary: "Structured output accepted."
  });
  invocation.status = "succeeded";
  invocation.finished_at = new Date().toISOString();
  await store.saveInvocation(invocation);
  const reviewRef = await store.saveReviewArtifact(run.id, `${task.id}_review`, {
    task_id: task.id,
    status: "succeeded",
    decision: "accept"
  });
  const validationRef = await store.saveValidationArtifact(run.id, `${task.id}_verification`, {
    task_id: task.id,
    result: {
      passed: true,
      commands_run: []
    }
  });

  const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
  try {
    const prompt = metadata.get<{ task_id: string; invocation_id: string; prompt_hash: string; prompt_chars: number }>(
      "SELECT task_id, invocation_id, prompt_hash, prompt_chars FROM factory_prompts WHERE id = ?",
      invocation.id
    );
    assert.equal(prompt?.task_id, task.id);
    assert.equal(prompt?.invocation_id, invocation.id);
    assert.equal(prompt?.prompt_hash.length, 64);
    assert.ok(prompt?.prompt_chars);

    const outputs = metadata.all<{ task_id: string; output_kind: string; artifact_ref: string }>(
      "SELECT task_id, output_kind, artifact_ref FROM factory_outputs WHERE run_id = ? AND source_id = ? ORDER BY output_kind",
      run.id,
      invocation.id
    );
    assert.deepEqual(outputs, [
      { task_id: task.id, output_kind: "parsed_output", artifact_ref: invocation.parsed_output_ref },
      { task_id: task.id, output_kind: "raw_output", artifact_ref: invocation.raw_output_ref }
    ]);

    const review = metadata.get<{ task_id: string; decision: string; artifact_ref: string }>(
      "SELECT task_id, decision, artifact_ref FROM factory_reviews WHERE run_id = ? AND task_id = ?",
      run.id,
      task.id
    );
    assert.deepEqual(review, { task_id: task.id, decision: "accept", artifact_ref: reviewRef });

    const validation = metadata.get<{ task_id: string; status: string; artifact_ref: string }>(
      "SELECT task_id, status, artifact_ref FROM factory_validations WHERE run_id = ? AND task_id = ?",
      run.id,
      task.id
    );
    assert.deepEqual(validation, { task_id: task.id, status: "passed", artifact_ref: validationRef });
  } finally {
    metadata.close();
  }
});

async function fixtureWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hivo-factory-metadata-test-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    scripts: {
      test: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function fakeRun(workspace: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_factory_metadata_test",
    user_request: "Record factory metadata",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_scout_metadata"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", "run_factory_metadata_test")
  };
}

function fakeTask(runId: string, id: string, dependencies: string[]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: `Task ${id}`,
    objective: "Exercise metadata adapter.",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies,
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: ["src/index.ts"],
    forbidden_files: [".agent_memory/"],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function fakeInvocation(runId: string, taskId: string): AgentInvocation {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "invocation_factory_metadata_test",
    run_id: runId,
    task_id: taskId,
    role: "ExecutorAgent",
    prompt: "Use the existing artifacts and return structured output.",
    context_pack_ref: path.join("context_packs", `${taskId}.json`),
    started_at: now,
    status: "running"
  };
}
