import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteMemoryStore } from "../memory/SqliteMemoryStore.js";
import type { DecisionRecord, FailedAttemptRecord, SuccessfulPatternRecord } from "../memory/types.js";
import {
  CoreMemoryUpdateService,
  createFactoryTraceEvent,
  ORCHESTRATION_SCHEMA_VERSION,
  type FactoryTraceEvent,
  type FactoryTraceEventInput,
  type FinalRunReport,
  type Run
} from "../orchestration/index.js";

test("CoreMemoryUpdateService appends decision and success pattern for succeeded runs", async () => {
  const fixture = await createFixture("core-memory-success");
  try {
    const traces: FactoryTraceEventInput[] = [];
    const service = new CoreMemoryUpdateService(fakeTraceWriter(traces));
    const run = fakeRun(fixture.workspace, { status: "succeeded" });
    const report = fakeReport(run, { files_changed: ["src/a.ts"] });

    const result = await service.appendRunHandoff({
      workspacePath: fixture.workspace,
      executionMode: "deep",
      run,
      report
    });

    assert.equal(result.decision.agent, "CoreOrchestrator");
    assert.equal(result.successfulPattern?.relatedRunIds?.[0], run.id);
    assert.equal(result.failedAttempt, undefined);
    assert.deepEqual(traces.map((trace) => trace.event_type), ["memory_append_started", "memory_append_completed"]);

    const records = await loadRecords(fixture.workspace);
    assert.equal(records.decisions.length, 1);
    assert.equal(records.successfulPatterns.length, 1);
    assert.equal(records.failedAttempts.length, 0);
    assert.deepEqual(records.decisions[0]?.relatedFiles, ["src/a.ts"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreMemoryUpdateService appends decision and failed attempt for non-succeeded runs", async () => {
  const fixture = await createFixture("core-memory-failed");
  try {
    const traces: FactoryTraceEventInput[] = [];
    const service = new CoreMemoryUpdateService(fakeTraceWriter(traces));
    const run = fakeRun(fixture.workspace, { status: "blocked" });
    const report = fakeReport(run, {
      limitations: ["Validation blocked."],
      next_recommendations: ["Run validation after approval."]
    });

    const result = await service.appendRunHandoff({
      workspacePath: fixture.workspace,
      executionMode: "fast",
      run,
      report
    });

    assert.equal(result.successfulPattern, undefined);
    assert.equal(result.failedAttempt?.relatedRunId, run.id);
    assert.equal(result.failedAttempt?.nextAvoidance, "Run validation after approval.");
    assert.equal(result.decision.rationale, "Validation blocked.");
    assert.deepEqual(traces.map((trace) => trace.metadata_json?.final_status), ["blocked", "blocked"]);

    const records = await loadRecords(fixture.workspace);
    assert.equal(records.decisions.length, 1);
    assert.equal(records.successfulPatterns.length, 0);
    assert.equal(records.failedAttempts.length, 1);
    assert.deepEqual(records.failedAttempts[0]?.evidence, [report.artifacts_path]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "a.ts"), "export const value = 1;\n", "utf8");
  return { workspace };
}

function fakeTraceWriter(traces: FactoryTraceEventInput[]) {
  return {
    async write(input: FactoryTraceEventInput): Promise<FactoryTraceEvent> {
      traces.push(input);
      return createFactoryTraceEvent({ ...input, source_component: "CoreOrchestrator" });
    }
  };
}

async function loadRecords(workspace: string) {
  const store = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
  try {
    return {
      decisions: store.records<DecisionRecord>("decision"),
      successfulPatterns: store.records<SuccessfulPatternRecord>("successful_pattern"),
      failedAttempts: store.records<FailedAttemptRecord>("failed_attempt")
    };
  } finally {
    store.close();
  }
}

function fakeRun(workspace: string, overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_memory",
    user_request: "Refactor orchestration",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: [],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", "run_memory"),
    ...overrides
  };
}

function fakeReport(run: Run, overrides: Partial<FinalRunReport> = {}): FinalRunReport {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    run_id: run.id,
    status: run.status,
    user_request: run.user_request,
    tasks_created: 0,
    tasks_completed: 0,
    tasks_failed: 0,
    files_changed: [],
    validation_results: [],
    artifacts_path: run.artifacts_path,
    limitations: [],
    next_recommendations: [],
    ...overrides
  };
}
