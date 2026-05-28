import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendFailedAttempt, compactMemory, ensureMemoryLayout, getFailedAttempts, writeJson } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { buildProjectIntelligence, explainIndexedFile } from "../memory/ProjectIntelligence.js";
import { loadOrchestrationConfig } from "../orchestration/OrchestrationConfig.js";
import { assessApprovalGate } from "../orchestration/ApprovalGates.js";
import { CampaignManager } from "../orchestration/CampaignManager.js";
import { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { ORCHESTRATION_SCHEMA_VERSION, type Run, type Task } from "../orchestration/OrchestrationModels.js";
import { computeRunMetrics } from "../orchestration/Metrics.js";

test("Phase 4 stale index detection reports changed files", async () => {
  const workspace = await fixtureWorkspace();
  await rebuildRepoIndex(workspace);
  await writeFile(path.join(workspace, "src", "add.ts"), "export const add = (a: number, b: number) => a + b + 0;\n", "utf8");

  const freshness = await assessIndexFreshness(workspace);

  assert.equal(freshness.status, "stale");
  assert.deepEqual(freshness.changedFiles, ["src/add.ts"]);
});

test("Phase 4 project intelligence explains dependencies and risky files", async () => {
  const workspace = await fixtureWorkspace();
  const snapshot = await rebuildRepoIndex(workspace);
  const intelligence = buildProjectIntelligence({
    generatedAt: snapshot.repoIndex.generatedAt,
    repoIndex: snapshot.repoIndex,
    fileManifest: snapshot.fileManifest,
    symbolIndex: snapshot.symbolIndex,
    commandInventory: snapshot.commandInventory
  });

  assert.deepEqual(intelligence.dependencyGraph["src/add.test.ts"], ["src/add.ts"]);
  assert.equal(explainIndexedFile("package.json", intelligence).risk.risk, "high");
});

test("Phase 4 modes change context and review behavior", () => {
  const fast = loadOrchestrationConfig({ execution_mode: "fast" });
  const exhaustive = loadOrchestrationConfig({ execution_mode: "exhaustive" });

  assert.equal(fast.validation_level, "basic");
  assert.equal(exhaustive.validation_level, "strict");
  assert.equal(exhaustive.enable_multi_perspective_review, true);
  assert.ok(fast.max_context_size < exhaustive.max_context_size);
});

test("Phase 4 approval gates require operator review for risky files", () => {
  const gate = assessApprovalGate({
    task: fakeTask("run_gate", ["package.json"]),
    proposal: {
      task_id: "task_gate",
      summary: "Update dependency config",
      files_to_modify: ["package.json"],
      patch_or_diff: "diff --git a/package.json b/package.json\n+  \"type\": \"module\"",
      risks: [],
      validation_suggestions: [],
      requires_followup: false
    },
    config: loadOrchestrationConfig({ execution_mode: "deep" })
  });

  assert.equal(gate.required, true);
  assert.deepEqual(gate.risky_files, ["package.json"]);
});

test("Phase 4 artifact store writes checkpoints and metrics", async () => {
  const workspace = await fixtureWorkspace();
  const store = new OrchestrationArtifactStore(workspace);
  const run = fakeRun(workspace);
  const task = fakeTask(run.id, ["src/add.ts"]);

  await store.saveRun(run);
  await store.saveTasks(run.id, [task]);
  const checkpointRef = await store.saveCheckpoint({
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "checkpoint_test",
    run_id: run.id,
    label: "test",
    created_at: new Date().toISOString(),
    run_status: run.status,
    task_graph_state: [task],
    memory_snapshot_ref: run.memory_snapshot_ref,
    config: run.config,
    notes: ["test checkpoint"]
  });
  const metricsRef = await store.saveRunMetrics(computeRunMetrics({ run, tasks: [task], events: [], report: undefined }));

  assert.match(checkpointRef, /checkpoints/);
  assert.match(metricsRef, /metrics/);
  assert.equal((await store.listCheckpoints(run.id)).length, 1);
});

test("Phase 4 campaign can plan pause resume and report", async () => {
  const workspace = await fixtureWorkspace();
  const manager = new CampaignManager(workspace);
  const campaign = await manager.create("Improve arithmetic helper safety");
  const planned = await manager.plan(campaign.id);
  const paused = await manager.pause(campaign.id);
  const resumed = await manager.resume(campaign.id);
  const report = await manager.report(campaign.id);
  const metrics = await manager.metrics(campaign.id);

  assert.equal(planned.milestones.length, 3);
  assert.equal(paused.status, "paused");
  assert.ok(["running", "blocked"].includes(resumed.status));
  assert.equal(report.campaign_id, campaign.id);
  assert.equal(metrics.milestones_total, 3);
});

test("Phase 4 memory compaction records failed attempts", async () => {
  const workspace = await fixtureWorkspace();
  const memory = await ensureMemoryLayout(workspace);
  await appendFailedAttempt(workspace, { summary: "manual failed attempt", relatedTaskId: "task_memory" });
  await writeJson(path.join(memory.runsDir, "run_failed", "reports", "final_report.json"), {
    run_id: "run_failed",
    status: "failed",
    limitations: ["validation failed"],
    validation_results: [{ status: "failed", command: "npm test" }],
    files_changed: [],
    next_recommendations: ["fix tests"]
  });

  const compacted = await compactMemory(workspace);
  const attempts = await getFailedAttempts(workspace);

  assert.equal(compacted.failedAttemptsAdded, 1);
  assert.ok(attempts.some((attempt) => attempt.relatedRunId === "run_failed"));
});

async function fixtureWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hivo-phase4-test-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) { return a + b; }\n", "utf8");
  await writeFile(path.join(root, "src", "add.test.ts"), "import { add } from './add';\nadd(1, 2);\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  return root;
}

function fakeTask(runId: string, allowed: string[]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_gate",
    run_id: runId,
    title: "Task",
    objective: "Modify allowed files",
    role_required: "ExecutorAgent",
    status: "ready",
    dependencies: [],
    relevant_files: allowed,
    allowed_files_to_edit: allowed,
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

function fakeRun(workspace: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_phase4_test",
    user_request: "test",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_gate"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "mock"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", "run_phase4_test")
  };
}
