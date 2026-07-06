import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreFinalReportArtifactSummaryService,
  ORCHESTRATION_SCHEMA_VERSION,
  type Run,
  type Task
} from "../orchestration/index.js";

test("CoreFinalReportArtifactSummaryService summarizes prompt-writer artifacts", async () => {
  const fixture = await createFixture("final-report-prompt-writer");
  try {
    const dir = path.join(fixture.run.artifacts_path, "prompt_writers");
    await mkdir(dir, { recursive: true });
    const artifacts = [
      await writeJsonArtifact(dir, "summary_prompt.json", { summary: "Prompt writer ran." }),
      await writeJsonArtifact(dir, "adoption_decision_adopted.json", { adopted: true, quality_status: "passed" }),
      await writeJsonArtifact(dir, "adoption_decision_rejected.json", { decision: "rejected", quality_status: "failed" }),
      await writeJsonArtifact(dir, "adoption_decision_shadow.json", { decision: "shadow_recorded", quality_status: "blocked" }),
      await writeJsonArtifact(dir, "schema_validation_failed.json", { schema_status: "failed" }),
      await writeJsonArtifact(dir, "parsed_output_1.json", { missing_context: ["src/a.ts", "src/b.ts", "src/a.ts"] }),
      await writeJsonArtifact(dir, "raw_output_1.json", { raw: true })
    ];

    const summary = await fixture.service.promptWriterReportSummary([fakeTask(fixture.run.id, artifacts)]);

    assert.equal(summary.prompt_writer_runs, 1);
    assert.equal(summary.adopted_count, 1);
    assert.equal(summary.rejected_count, 1);
    assert.equal(summary.shadow_count, 1);
    assert.equal(summary.fallback_count, 1);
    assert.equal(summary.failed_schema_count, 1);
    assert.equal(summary.failed_quality_count, 2);
    assert.deepEqual(summary.top_missing_context_warnings, ["src/a.ts", "src/b.ts"]);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreFinalReportArtifactSummaryService summarizes lock artifacts", async () => {
  const fixture = await createFixture("final-report-locks");
  try {
    const dir = path.join(fixture.run.artifacts_path, "locks");
    await mkdir(dir, { recursive: true });
    const artifacts = [
      await writeJsonArtifact(dir, "lock_request_1.json", {
        locks: [
          { status: "acquired", lock_type: "module" },
          { status: "rejected", lock_type: "semantic" },
          { status: "expired", lock_mode: "advisory" }
        ],
        conflicts: [
          { blocking: true },
          { blocking: false }
        ]
      }),
      await writeJsonArtifact(dir, "lock_snapshot_1.json", {
        locks: [
          { status: "stolen_or_recovered", lock_type: "semantic" }
        ]
      })
    ];

    const summary = await fixture.service.lockReportSummary(fixture.run, [fakeTask(fixture.run.id, artifacts)]);

    assert.equal(summary.locks_requested, 1);
    assert.equal(summary.locks_acquired, 1);
    assert.equal(summary.locks_rejected, 1);
    assert.equal(summary.advisory_locks, 1);
    assert.equal(summary.semantic_locks, 2);
    assert.equal(summary.module_locks, 1);
    assert.equal(summary.expired_locks_recovered, 2);
    assert.equal(summary.active_locks_at_end, 0);
    assert.equal(summary.blocking_conflicts, 1);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const run = fakeRun(workspace);
  await mkdir(run.artifacts_path, { recursive: true });
  return {
    workspace,
    run,
    service: new CoreFinalReportArtifactSummaryService(workspace)
  };
}

async function writeJsonArtifact(dir: string, name: string, value: unknown) {
  const artifact = path.join(dir, name);
  await writeFile(artifact, JSON.stringify(value), "utf8");
  return artifact;
}

function fakeRun(workspace: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_report_artifacts",
    user_request: "Refactor orchestration",
    status: "reporting",
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_report_artifacts"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", "run_report_artifacts")
  };
}

function fakeTask(runId: string, artifacts: string[]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_report_artifacts",
    run_id: runId,
    title: "Report artifacts",
    objective: "Summarize final report artifacts",
    role_required: "ReporterAgent",
    status: "succeeded",
    dependencies: [],
    relevant_files: [],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts,
    created_at: now,
    updated_at: now
  };
}
