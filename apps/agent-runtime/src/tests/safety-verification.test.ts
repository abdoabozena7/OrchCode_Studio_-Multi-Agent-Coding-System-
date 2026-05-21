import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  OrchestrationFileLockManager,
  PatchFingerprintTracker,
  TaskGraphManager,
  ValidationRunner,
  captureFileSnapshots,
  consolidateReviewResults,
  createRepairTask,
  repairStructuredOutput,
  restoreFileSnapshots,
  runReviewLoop,
  selectSchedulableTasks,
  validatePatchProposalScope,
  validateStructuredOutput,
  type CodePatchProposal,
  type ReviewResult,
  type Task
} from "../orchestration/index.js";

test("Phase 3 structured output validation and repair are explicit", () => {
  const invalidScout = validateStructuredOutput("ScoutResult", { relevant_files: ["src/index.ts"] });
  assert.equal(invalidScout.valid, false);
  assert.ok(invalidScout.errors.some((error) => error.includes("confidence")));

  const repair = repairStructuredOutput<CodePatchProposal>("CodePatchProposal", {
    task_id: "task_1",
    summary: "Changed one file"
  }, ["files_to_modify must be an array"]);
  assert.equal(repair.validation.valid, true);
  assert.ok(repair.repair_prompt.includes("Repair output to match schema CodePatchProposal"));
  assert.deepEqual(repair.repaired?.files_to_modify, []);
});

test("patch safety rejects scope violations and forbidden files", async () => {
  const workspace = await createFixtureWorkspace("orchcode-patch-safety");
  try {
    const task = createTask("run_scope", {
      allowed_files_to_edit: ["src/allowed.ts"],
      forbidden_files: [".env", ".agent_memory/"]
    });
    const outsideProposal = proposal("task_scope", ["src/other.ts"], "--- a/src/other.ts\n+++ b/src/other.ts\n@@\n-old\n+new");
    const outside = validatePatchProposalScope({
      workspacePath: workspace,
      task,
      proposal: outsideProposal,
      config: { max_files_per_task: 4, max_patch_bytes: 10_000 }
    });
    assert.equal(outside.accepted, false);
    assert.deepEqual(outside.scope_violations, ["src/other.ts"]);

    const forbiddenProposal = proposal("task_scope", [".env"], "--- a/.env\n+++ b/.env\n@@\n-old\n+new");
    const forbidden = validatePatchProposalScope({
      workspacePath: workspace,
      task,
      proposal: forbiddenProposal,
      config: { max_files_per_task: 4, max_patch_bytes: 10_000 }
    });
    assert.equal(forbidden.accepted, false);
    assert.deepEqual(forbidden.forbidden_violations, [".env"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file locks acquire, release, and block overlapping scopes", async () => {
  const workspace = await createFixtureWorkspace("orchcode-locks");
  try {
    const locks = new OrchestrationFileLockManager(workspace, 60_000);
    const first = locks.acquire("run_lock", "task_a", ["src/allowed.ts"]);
    assert.equal(first.acquired, true);
    const second = locks.acquire("run_lock", "task_b", ["./src/allowed.ts"]);
    assert.equal(second.acquired, false);
    assert.equal(second.conflicts[0]?.owner_task_id, "task_a");
    locks.releaseByTask("task_a");
    assert.equal(locks.acquire("run_lock", "task_b", ["src/allowed.ts"]).acquired, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scheduler separates overlapping tasks and admits disjoint tasks", async () => {
  const workspace = await createFixtureWorkspace("orchcode-scheduler");
  try {
    const locks = new OrchestrationFileLockManager(workspace, 60_000);
    const overlapping = selectSchedulableTasks(workspace, [
      { id: "task_a", role_required: "ExecutorAgent", allowed_files_to_edit: ["src/"] },
      { id: "task_b", role_required: "ExecutorAgent", allowed_files_to_edit: ["src/allowed.ts"] }
    ], locks, { maxParallelTasks: 2 });
    assert.deepEqual(overlapping.selected.map((task) => task.id), ["task_a"]);
    assert.deepEqual(overlapping.blocked.map((entry) => entry.task.id), ["task_b"]);

    const disjoint = selectSchedulableTasks(workspace, [
      { id: "task_c", role_required: "ExecutorAgent", allowed_files_to_edit: ["src/allowed.ts"] },
      { id: "task_d", role_required: "ExecutorAgent", allowed_files_to_edit: ["docs/notes.md"] }
    ], locks, { maxParallelTasks: 2 });
    assert.deepEqual(disjoint.selected.map((task) => task.id), ["task_c", "task_d"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validation failure can create a repair task and repair limits stop loops", async () => {
  const workspace = await createFixtureWorkspace("orchcode-validation-repair");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const task = createTask("run_repair", {
      validation_commands: ["node -e \"process.exit(3)\""],
      allowed_files_to_edit: ["src/allowed.ts"]
    });
    const runner = new ValidationRunner(workspace, store, {
      validation_timeout: 5_000,
      max_validation_log_size: 2_000,
      safe_commands_allowlist: ["node -e"]
    });
    const verification = await runner.runForTask({
      runId: "run_repair",
      task,
      commandInventory: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        packageManagers: [],
        commands: [{
          id: "cmd_fail",
          kind: "test",
          command: "node -e \"process.exit(3)\"",
          cwd: ".",
          sourceFile: "package.json",
          source: "package_json",
          confidence: "high"
        }],
        byKind: {
          test: ["node -e \"process.exit(3)\""],
          lint: [],
          typecheck: [],
          build: [],
          format: [],
          smoke: [],
          dev: [],
          run: [],
          unknown: []
        }
      }
    });
    assert.equal(verification.passed, false);
    assert.deepEqual(verification.failed_commands, ["node -e \"process.exit(3)\""]);

    const manager = new TaskGraphManager("run_repair", workspace, store);
    const original = manager.createTask(task);
    const repair = createRepairTask({
      manager,
      originalTask: original,
      failure: {
        reason: verification.summary,
        required_changes: ["Fix failing validation"],
        validation_logs: verification.logs_refs,
        previous_patch_fingerprint: "fp1"
      },
      config: { max_repair_rounds: 1, max_attempts_per_task: 1 }
    });
    assert.ok(repair);
    const secondRepair = createRepairTask({
      manager,
      originalTask: original,
      failure: {
        reason: "still failing",
        required_changes: ["Try again"],
        validation_logs: [],
        previous_patch_fingerprint: "fp2"
      },
      config: { max_repair_rounds: 1, max_attempts_per_task: 1 }
    });
    assert.equal(secondRepair, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("patch fingerprint tracker detects identical repeated failures", () => {
  const tracker = new PatchFingerprintTracker();
  assert.equal(tracker.recordFailedFingerprint("task_a", "fingerprint"), false);
  assert.equal(tracker.recordFailedFingerprint("task_a", "fingerprint"), true);
  assert.equal(tracker.hasFailedFingerprint("task_a", "fingerprint"), true);
});

test("review result consolidation escalates scope violations to repair", async () => {
  const workspace = await createFixtureWorkspace("orchcode-review");
  try {
    const task = createTask("run_review", {
      allowed_files_to_edit: ["src/allowed.ts"],
      forbidden_files: [".env"]
    });
    const unsafe = validatePatchProposalScope({
      workspacePath: workspace,
      task,
      proposal: proposal("task_review", ["src/other.ts"], "--- a/src/other.ts\n+++ b/src/other.ts\n@@\n-old\n+new"),
      config: { max_files_per_task: 4, max_patch_bytes: 10_000 }
    });
    const result = runReviewLoop({
      task,
      proposal: proposal("task_review", ["src/other.ts"], ""),
      safety: unsafe,
      config: { enable_multi_perspective_review: true, max_review_findings: 10 }
    });
    assert.equal(result.decision, "request_repair");
    assert.deepEqual(result.scope_violations, ["src/other.ts"]);

    const critical: ReviewResult = {
      decision: "request_changes",
      severity: "critical",
      findings: ["secret-like text"],
      required_changes: ["remove secret"],
      scope_violations: [],
      confidence: 0.9
    };
    assert.equal(consolidateReviewResults([critical]).decision, "require_human_approval");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("task events are written with typed lifecycle events", async () => {
  const workspace = await createFixtureWorkspace("orchcode-events");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const manager = new TaskGraphManager("run_events", workspace, store);
    const task = manager.createTask(createTask("run_events"));
    await manager.recordCreatedEvents();
    await manager.markStatus(task.id, "ready");
    await manager.markStatus(task.id, "running");
    await manager.markStatus(task.id, "succeeded");
    const eventsPath = path.join(workspace, ".agent_memory", "runs", "run_events", "events.jsonl");
    assert.equal(existsSync(eventsPath), true);
    const events = await readFile(eventsPath, "utf8");
    assert.match(events, /"task.started"/);
    assert.match(events, /"task.succeeded"/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("file snapshots can restore unsafe direct edits", async () => {
  const workspace = await createFixtureWorkspace("orchcode-restore");
  try {
    const filePath = path.join(workspace, "src", "allowed.ts");
    const snapshots = await captureFileSnapshots(workspace, ["src/allowed.ts"]);
    await writeFile(filePath, "export const value = 2;\n", "utf8");
    await restoreFileSnapshots(snapshots);
    assert.equal(await readFile(filePath, "utf8"), "export const value = 1;\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createFixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }, null, 2), "utf8");
  await writeFile(path.join(workspace, "src", "allowed.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(workspace, "src", "other.ts"), "export const other = 1;\n", "utf8");
  await writeFile(path.join(workspace, "docs", "notes.md"), "notes\n", "utf8");
  await writeFile(path.join(workspace, ".env"), "SECRET=nope\n", "utf8");
  return workspace;
}

function createTask(runId: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_test",
    run_id: runId,
    title: "Modify allowed file",
    objective: "Modify only the allowed file.",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/allowed.ts"],
    allowed_files_to_edit: ["src/allowed.ts"],
    forbidden_files: [".env"],
    expected_output_schema: "ExecutorOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function proposal(taskId: string, files: string[], diff: string): CodePatchProposal {
  return {
    task_id: taskId,
    summary: "Proposed patch",
    files_to_modify: files,
    patch_or_diff: diff,
    risks: [],
    validation_suggestions: ["node -e \"process.exit(0)\""],
    requires_followup: false
  };
}
