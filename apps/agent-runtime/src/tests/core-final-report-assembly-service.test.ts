import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreFinalReportArtifactSummaryService,
  CoreFinalReportAssemblyService,
  CoreFinalReportMetadataSummaryService,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  loadOrchestrationConfig,
  type FactoryIntegrationResult,
  type IntentReviewResult,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../orchestration/index.js";

test("CoreFinalReportAssemblyService persists report fields, intent review summary, and report event", async () => {
  const workspace = await fixtureWorkspace("final-report-assembly");
  try {
    const store = new OrchestrationArtifactStore(workspace);
    const service = new CoreFinalReportAssemblyService({
      config: loadOrchestrationConfig({}),
      artifactStore: store,
      artifactSummaries: new CoreFinalReportArtifactSummaryService(workspace),
      metadataSummaries: new CoreFinalReportMetadataSummaryService(workspace),
      reviewFinalIntent: async () => fakeIntentReview()
    });
    const run = fakeRun(workspace, { status: "blocked" });
    const task = fakeTask(run.id, { status: "succeeded" });
    const output = fakeOutput({
      files_changed: ["src/profile.ts"],
      validation_results: [{ command: "npm test", status: "passed", summary: "Passed.", required: true }],
      next_recommendations: ["Ship carefully."]
    });

    const report = await service.create({
      run,
      tasks: [task],
      outputs: [output],
      extraLimitations: ["Manual approval still required."],
      integration: fakeIntegration(run.id)
    });

    assert.equal(report.run_id, run.id);
    assert.equal(report.tasks_created, 1);
    assert.deepEqual(report.files_changed, ["src/profile.ts"]);
    assert.equal(report.validation_results[0]?.command, "npm test");
    assert.equal(report.integration_status, "blocked");
    assert.equal(report.intent_review_used, true);
    assert.equal(report.intent_alignment_status, "possible_drift");
    assert.equal(report.intent_drift_count, 1);
    assert.equal(report.intent_review_ref, "intent-review.json");
    assert.equal(report.limitations.includes("Manual approval still required."), true);

    const loaded = await store.loadFinalReport(run.id);
    assert.equal(loaded.run_id, run.id);
    const events = await store.listRunEvents(run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "run.reported"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

function fakeRun(workspace: string, overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_final_report",
    user_request: "Refactor final reporting.",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_final_report"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", "run_final_report"),
    original_request_ref: "original-request.json",
    intent_ledger_ref: "intent-ledger.json",
    intent_contract_ref: "intent-contract.json",
    intent_contract_status: "ready",
    ...overrides
  };
}

function fakeTask(runId: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_final_report",
    run_id: runId,
    title: "Assemble report",
    objective: "Assemble the final run report.",
    role_required: "ReporterAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/profile.ts"],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function fakeOutput(overrides: Partial<ParsedAgentOutput> = {}): ParsedAgentOutput {
  return {
    summary: "Report assembly complete.",
    status: "succeeded",
    files_changed: [],
    validation_results: [],
    artifacts: [],
    limitations: [],
    next_recommendations: [],
    ...overrides
  };
}

function fakeIntegration(runId: string): FactoryIntegrationResult {
  return {
    integration_result_id: "integration_final_report",
    run_id: runId,
    status: "blocked",
    applied_candidates: [],
    rejected_candidates: [],
    blocked_candidates: [],
    conflicts: [],
    validation_status: "not_run",
    validation_refs: [],
    rollback_refs: [],
    changed_files: [],
    created_at: new Date().toISOString(),
    apply_mode: "dry_run",
    rollback_available: false,
    blocked_reason: "Manual approval still required.",
    metadata_json: {}
  };
}

function fakeIntentReview(): IntentReviewResult {
  return {
    schema_version: 1,
    review_id: "intent_review_final",
    run_id: "run_final_report",
    run_kind: "core",
    stage: "final",
    status: "possible_drift",
    mode: "report_only",
    reviewed_artifact_refs: [],
    rationale: "One possible drift was found.",
    findings: [{
      finding_id: "finding_final_report",
      finding_type: "possible_drift",
      severity: "warning",
      rationale: "Report mentions approval.",
      evidence_refs: [],
      recommended_action: "review_manually"
    }],
    provider_used: false,
    created_at: new Date().toISOString(),
    artifact_ref: "intent-review.json",
    metadata_json: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
