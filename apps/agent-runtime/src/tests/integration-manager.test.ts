import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreOrchestrator,
  DurableLockManager,
  FactoryMetadataStore,
  IntegrationManager,
  OrchestrationArtifactStore,
  ORCHESTRATION_SCHEMA_VERSION,
  createIntegrationCandidate,
  createIntegrationPlan,
  createIntegrationResult,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../orchestration/index.js";

test("integration models create metadata refs without storing patch bodies", () => {
  const candidate = createIntegrationCandidate({
    candidate_id: "candidate_a",
    run_id: "run_models",
    task_id: "task_a",
    patch_ref: "/tmp/patch.json",
    review_ref: "/tmp/review.json",
    validation_ref: "/tmp/validation.json",
    changed_files: ["src/index.ts"],
    module_locks: ["module:orchestration"],
    semantic_locks: ["semantic:factory-metadata"],
    dependencies: [],
    status: "pending",
    metadata_json: { patch_sha256: "abc123" }
  });
  const rollback = {
    rollback_plan_id: "rollback_a",
    run_id: "run_models",
    status: "manual_limited" as const,
    candidate_ids: [candidate.candidate_id],
    changed_files: candidate.changed_files,
    rollback_refs: [],
    instructions: ["Use VCS or patch authority to restore files."],
    created_at: "2026-01-01T00:00:00.000Z",
    metadata_json: { automatic_rollback: false }
  };
  const plan = createIntegrationPlan({
    integration_plan_id: "plan_a",
    run_id: "run_models",
    candidates: [candidate],
    dependency_order: [candidate.candidate_id],
    conflict_checks: [],
    required_locks: ["src/index.ts"],
    validation_plan: {
      status: "planned",
      commands: ["npm test"],
      impacted_files: ["src/index.ts"],
      validation_refs: ["/tmp/validation.json"],
      metadata_json: {}
    },
    rollback_plan: rollback,
    batches: [],
    artifact_ref: "/tmp/plan.json"
  });
  const result = createIntegrationResult({
    integration_result_id: "result_a",
    run_id: "run_models",
    status: "blocked",
    applied_candidates: [],
    rejected_candidates: [],
    blocked_candidates: [candidate.candidate_id],
    conflicts: [],
    validation_status: "not_run",
    validation_refs: [],
    rollback_refs: [],
    changed_files: ["src/index.ts"],
    apply_mode: "prepare_only",
    rollback_available: false,
    metadata_json: { patch_ref: "/tmp/patch.json" }
  });
  assert.equal(candidate.risk_level, "low");
  assert.equal(plan.dependency_order[0], "candidate_a");
  assert.doesNotMatch(JSON.stringify(result), /diff --git/);
});

test("integration manager records not_required when no patch or change artifacts exist", async () => {
  const workspace = await fixtureWorkspace("integration-not-required");
  try {
    const run = fakeRun(workspace, "run_noop");
    const manager = new IntegrationManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace), config: config() });
    const result = await manager.integrate({ run, tasks: [fakeTask(run.id, "task_read", "ScoutAgent")], parsedOutputs: [], mode: "read_only" });
    assert.equal(result.status, "not_required");
    assert.equal(result.validation_status, "not_required");
    assert.ok(result.artifact_ref && existsSync(result.artifact_ref));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const rows = metadata.all<{ status: string; metadata_json: string }>(
        "SELECT status, metadata_json FROM factory_integration_results WHERE run_id = ?",
        run.id
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "not_required");
      assert.doesNotMatch(rows[0].metadata_json, /diff --git/);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("integration discovery accepts reviewed and fully validated patch candidates", async () => {
  const workspace = await fixtureWorkspace("integration-discovery");
  try {
    const run = fakeRun(workspace, "run_discovery");
    const task = fakeTask(run.id, "task_write", "ExecutorAgent", ["src/index.ts"]);
    const { output } = await acceptedOutput(workspace, run, task);
    const manager = new IntegrationManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace), config: config() });
    const candidates = await manager.discoverCandidates(run, [task], [output]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "pending");
    assert.equal(candidates[0].review_decision, "accept");
    assert.equal(candidates[0].validation_status, "passed");
    assert.deepEqual(candidates[0].changed_files, ["src/index.ts"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("integration discovery rejects missing review and incomplete validation", async () => {
  const workspace = await fixtureWorkspace("integration-rejections");
  try {
    const run = fakeRun(workspace, "run_reject");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const taskMissingReview = fakeTask(run.id, "task_missing_review", "ExecutorAgent", ["src/a.ts"]);
    const patchRef = await artifactStore.savePatchArtifact(run.id, `${taskMissingReview.id}_patch`, { task_id: taskMissingReview.id, status: "accepted" });
    const validationRef = await artifactStore.saveValidationArtifact(run.id, `${taskMissingReview.id}_validation`, { task_id: taskMissingReview.id, status: "passed" });
    const taskPartial = fakeTask(run.id, "task_partial", "ExecutorAgent", ["src/b.ts"]);
    const partial = await acceptedOutput(workspace, run, taskPartial, "partial");
    const manager = new IntegrationManager({ workspacePath: workspace, artifactStore, config: config() });
    const candidates = await manager.discoverCandidates(run, [taskMissingReview, taskPartial], [
      fakeOutput(taskMissingReview, [patchRef, validationRef]),
      partial.output
    ]);
    assert.equal(candidates.length, 2);
    assert.equal(candidates.every((candidate) => candidate.status === "blocked"), true);
    assert.match(candidates.flatMap((candidate) => candidate.rejection_reasons ?? []).join("\n"), /Missing accepted review/);
    assert.match(candidates.flatMap((candidate) => candidate.rejection_reasons ?? []).join("\n"), /partial/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("integration ordering and conflict detection are deterministic and conservative", async () => {
  const workspace = await fixtureWorkspace("integration-conflicts");
  try {
    const run = fakeRun(workspace, "run_conflicts");
    const manager = new IntegrationManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace), config: config() });
    const parent = createIntegrationCandidate({
      candidate_id: "candidate_parent",
      run_id: run.id,
      task_id: "task_parent",
      changed_files: ["packages/protocol/src/index.ts"],
      module_locks: ["module:protocol"],
      semantic_locks: ["semantic:public-api"],
      dependencies: [],
      status: "pending",
      metadata_json: {}
    });
    const child = createIntegrationCandidate({
      candidate_id: "candidate_child",
      run_id: run.id,
      task_id: "task_child",
      changed_files: ["packages/protocol/src/index.ts"],
      module_locks: ["module:protocol"],
      semantic_locks: ["semantic:public-api"],
      dependencies: ["task_parent"],
      status: "pending",
      metadata_json: {}
    });
    const tasks = [
      fakeTask(run.id, "task_child", "ExecutorAgent", ["packages/protocol/src/index.ts"], ["task_parent"]),
      fakeTask(run.id, "task_parent", "ExecutorAgent", ["packages/protocol/src/index.ts"])
    ];
    const ordered = manager.orderCandidates(tasks, [child, parent]);
    assert.deepEqual(ordered.map((candidate) => candidate.candidate_id), ["candidate_parent", "candidate_child"]);
    const conflicts = manager.detectConflicts(run.id, ordered);
    assert.ok(conflicts.some((conflict) => conflict.conflict_type === "same_file"));
    assert.ok(conflicts.some((conflict) => conflict.conflict_type === "module_lock"));
    assert.ok(conflicts.some((conflict) => conflict.conflict_type === "semantic_lock"));
    assert.ok(conflicts.some((conflict) => conflict.conflict_type === "public_api_risk"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("integration locks block conflicting apply and release after safe adapter success", async () => {
  const blockedWorkspace = await fixtureWorkspace("integration-lock-blocked");
  try {
    const run = fakeRun(blockedWorkspace, "run_lock_blocked");
    const task = fakeTask(run.id, "task_write", "ExecutorAgent", ["src/index.ts"]);
    const { output } = await acceptedOutput(blockedWorkspace, run, task);
    const externalLocks = new DurableLockManager({ workspacePath: blockedWorkspace, ttlMs: 60_000, ownerComponent: "test" });
    await externalLocks.acquireFileLock(run.id, "external_task", "src/index.ts", "write");
    const manager = new IntegrationManager({ workspacePath: blockedWorkspace, artifactStore: new OrchestrationArtifactStore(blockedWorkspace), config: config(), applyMode: "safe_adapter", adapter: { apply: async () => ({ status: "applied", validation_status: "passed" }) } });
    const result = await manager.integrate({ run, tasks: [task], parsedOutputs: [output] });
    assert.equal(result.status, "blocked");
    assert.match(result.blocked_reason ?? "", /locks/i);
  } finally {
    await rm(blockedWorkspace, { recursive: true, force: true });
  }

  const successWorkspace = await fixtureWorkspace("integration-lock-release");
  try {
    const run = fakeRun(successWorkspace, "run_lock_release");
    const task = fakeTask(run.id, "task_write", "ExecutorAgent", ["src/index.ts"]);
    const { output } = await acceptedOutput(successWorkspace, run, task);
    const manager = new IntegrationManager({ workspacePath: successWorkspace, artifactStore: new OrchestrationArtifactStore(successWorkspace), config: config(), applyMode: "safe_adapter", adapter: { apply: async () => ({ status: "applied", changed_files: ["src/index.ts"], validation_status: "passed" }) } });
    const result = await manager.integrate({ run, tasks: [task], parsedOutputs: [output] });
    assert.equal(result.status, "passed");
    const metadata = await FactoryMetadataStore.open({ workspacePath: successWorkspace, readOnly: true });
    try {
      const active = metadata.listActiveDurableLocks().filter((lock) => lock.run_id === run.id);
      assert.equal(active.length, 0);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(successWorkspace, { recursive: true, force: true });
  }
});

test("prepare-only mode and adapter failures do not claim successful integration", async () => {
  const workspace = await fixtureWorkspace("integration-prepare");
  try {
    const run = fakeRun(workspace, "run_prepare");
    const task = fakeTask(run.id, "task_write", "ExecutorAgent", ["src/index.ts"]);
    const { output } = await acceptedOutput(workspace, run, task);
    const prepareOnly = new IntegrationManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace), config: config() });
    const prepared = await prepareOnly.integrate({ run, tasks: [task], parsedOutputs: [output] });
    assert.equal(prepared.status, "blocked");
    assert.match(prepared.blocked_reason ?? "", /No safe patch application adapter/);
    assert.equal(prepared.rollback_available, false);
    assert.ok(prepared.rollback_refs.every((ref) => existsSync(ref)));

    const failedAdapter = new IntegrationManager({
      workspacePath: workspace,
      artifactStore: new OrchestrationArtifactStore(workspace),
      config: config(),
      applyMode: "safe_adapter",
      adapter: { apply: async () => ({ status: "failed", message: "adapter refused patch" }) }
    });
    const failed = await failedAdapter.integrate({ run: fakeRun(workspace, "run_apply_failed"), tasks: [fakeTask("run_apply_failed", "task_write", "ExecutorAgent", ["src/index.ts"])], parsedOutputs: [output] });
    assert.equal(failed.status, "blocked");
    assert.match(failed.blocked_reason ?? "", /adapter refused/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("post-integration validation maps failed and partial statuses truthfully", async () => {
  const workspace = await fixtureWorkspace("integration-validation");
  try {
    for (const [status, expected] of [["failed", "failed"], ["partial", "partial"], ["not_run", "blocked"]] as const) {
      const run = fakeRun(workspace, `run_${status}`);
      const task = fakeTask(run.id, `task_${status}`, "ExecutorAgent", [`src/${status}.ts`]);
      const { output } = await acceptedOutput(workspace, run, task);
      const manager = new IntegrationManager({
        workspacePath: workspace,
        artifactStore: new OrchestrationArtifactStore(workspace),
        config: config(),
        applyMode: "safe_adapter",
        adapter: { apply: async () => ({ status: "applied", validation_status: status }) }
      });
      const result = await manager.integrate({ run, tasks: [task], parsedOutputs: [output] });
      assert.equal(result.status, expected);
      assert.notEqual(result.status, "passed");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("integration manager emits trace events and persists plan candidate conflict result tables", async () => {
  const workspace = await fixtureWorkspace("integration-metadata-trace");
  try {
    const run = fakeRun(workspace, "run_metadata");
    const task = fakeTask(run.id, "task_write", "ExecutorAgent", ["src/index.ts"]);
    const { output } = await acceptedOutput(workspace, run, task);
    const manager = new IntegrationManager({ workspacePath: workspace, artifactStore: new OrchestrationArtifactStore(workspace), config: config(), applyMode: "safe_adapter", adapter: { apply: async () => ({ status: "applied", validation_status: "passed" }) } });
    const result = await manager.integrate({ run, tasks: [task], parsedOutputs: [output] });
    assert.equal(result.status, "passed");

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.all("SELECT candidate_id FROM factory_integration_candidates WHERE run_id = ?", run.id).length, 1);
      assert.equal(metadata.all("SELECT integration_plan_id FROM factory_integration_plans WHERE run_id = ?", run.id).length, 1);
      assert.equal(metadata.all("SELECT integration_result_id FROM factory_integration_results WHERE run_id = ?", run.id).length, 1);
      const eventTypes = new Set(metadata.all<{ event_type: string }>("SELECT event_type FROM factory_trace_events WHERE run_id = ?", run.id).map((row) => row.event_type));
      assert.ok(eventTypes.has("integration_started"));
      assert.ok(eventTypes.has("integration_candidate_discovered"));
      assert.ok(eventTypes.has("integration_plan_created"));
      assert.ok(eventTypes.has("integration_locks_requested"));
      assert.ok(eventTypes.has("integration_locks_acquired"));
      assert.ok(eventTypes.has("integration_validation_completed"));
      assert.ok(eventTypes.has("integration_passed"));
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only runs record not_required integration summary", async () => {
  const workspace = await fixtureWorkspace("integration-plan-only");
  try {
    const result = await new CoreOrchestrator({ workspacePath: workspace }).planOnly("Explain src/index.ts without changing files.");
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.report.integration_status, "not_required");
    assert.equal(result.report.candidates_found, 0);
    assert.ok(result.report.integration_result_ref && existsSync(result.report.integration_result_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function acceptedOutput(workspace: string, run: Run, task: Task, validationStatus: "passed" | "partial" | "blocked" = "passed") {
  const artifactStore = new OrchestrationArtifactStore(workspace);
  const patchRef = await artifactStore.savePatchArtifact(run.id, `${task.id}_patch`, {
    task_id: task.id,
    proposal: { files_to_modify: task.allowed_files_to_edit },
    safety: { accepted: true, changed_files: task.allowed_files_to_edit }
  });
  const reviewRef = await artifactStore.saveReviewArtifact(run.id, `${task.id}_review`, {
    task_id: task.id,
    decision: "accept",
    summary: "accepted"
  });
  const validationRef = await artifactStore.saveValidationArtifact(run.id, `${task.id}_validation`, {
    task_id: task.id,
    status: validationStatus,
    result: { validation_status: validationStatus, passed: validationStatus === "passed" },
    aggregate: { status: validationStatus }
  });
  return { output: fakeOutput(task, [patchRef, reviewRef, validationRef]), refs: { patchRef, reviewRef, validationRef } };
}

function fakeOutput(task: Task, artifacts: string[]): ParsedAgentOutput {
  return {
    summary: "proposed change",
    status: "succeeded",
    files_changed: task.allowed_files_to_edit,
    validation_results: [{
      command: "npm test",
      status: "passed",
      summary: "passed",
      log_ref: artifacts.find((artifact) => artifact.includes("validation"))
    }],
    artifacts,
    limitations: [],
    next_recommendations: []
  };
}

function fakeRun(workspace: string, id: string): Run {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Test integration",
    status: "integrating",
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
      provider_mode: "mock"
    }
  };
}

function fakeTask(runId: string, id: string, role: Task["role_required"], files: string[] = [], dependencies: string[] = []): Task {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: id,
    objective: id,
    role_required: role,
    status: "succeeded",
    dependencies,
    relevant_files: files,
    allowed_files_to_edit: files,
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: ["npm test"],
    max_attempts: 1,
    attempt_count: 1,
    artifacts: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function config() {
  return {
    lock_ttl_ms: 60_000,
    validation_timeout: 1_000,
    max_validation_log_size: 10_000,
    safe_commands_allowlist: ["npm test"]
  };
}
