import assert from "node:assert/strict";
import test from "node:test";
import {
  executorProviderTruthLimitation,
  finalRunStatus,
  integrationLimitations,
  multiPlanLimitations,
  ORCHESTRATION_SCHEMA_VERSION,
  summarizeValidationStatus,
  validationTruthLimitations,
  type FactoryIntegrationResult,
  type MultiPlanFactoryResult,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../orchestration/index.js";

test("CoreFinalReportPolicy summarizes validation only for changed outputs", () => {
  assert.equal(summarizeValidationStatus([fakeOutput({ files_changed: [] })]), "not_required");
  assert.equal(summarizeValidationStatus([fakeOutput({ files_changed: ["src/a.ts"], validation_results: [] })]), "not_run");
  assert.equal(summarizeValidationStatus([fakeOutput({
    files_changed: ["src/a.ts"],
    validation_results: [{ command: "npm test", status: "failed", summary: "Tests failed." }]
  })]), "failed");
});

test("CoreFinalReportPolicy computes final run status from task, validation, and integration gates", () => {
  const runId = "run_policy";

  assert.equal(finalRunStatus([fakeTask(runId, { status: "failed" })], [], passedIntegration(runId)), "failed");
  assert.equal(finalRunStatus([fakeTask(runId, { status: "blocked" })], [], passedIntegration(runId)), "blocked");
  assert.equal(finalRunStatus([fakeTask(runId)], [
    fakeOutput({ files_changed: ["src/a.ts"], validation_results: [] })
  ], passedIntegration(runId)), "blocked");
  assert.equal(finalRunStatus([fakeTask(runId)], [
    fakeOutput({
      files_changed: ["src/a.ts"],
      validation_results: [{ command: "npm test", status: "passed", summary: "Passed." }]
    })
  ], { ...passedIntegration(runId), status: "failed" }), "failed");
  assert.equal(finalRunStatus([fakeTask(runId)], [
    fakeOutput({
      files_changed: ["src/a.ts"],
      validation_results: [{ command: "npm test", status: "passed", summary: "Passed." }]
    })
  ], { ...passedIntegration(runId), status: "partial" }), "blocked");
  assert.equal(finalRunStatus([fakeTask(runId)], [
    fakeOutput({
      files_changed: ["src/a.ts"],
      validation_results: [{ command: "npm test", status: "passed", summary: "Passed." }]
    })
  ], passedIntegration(runId)), "succeeded");
});

test("CoreFinalReportPolicy reports integration and validation truth limitations", () => {
  const run = fakeRun({ status: "blocked" });
  const integration = {
    ...passedIntegration(run.id),
    status: "blocked",
    blocked_reason: "Awaiting approval."
  } satisfies FactoryIntegrationResult;

  assert.deepEqual(integrationLimitations(passedIntegration(run.id)), []);
  assert.deepEqual(integrationLimitations(integration), [
    "Integration did not pass; status is blocked.",
    "Awaiting approval."
  ]);

  assert.deepEqual(validationTruthLimitations(run, []), [
    "Validation not required because no mechanical changes required validation."
  ]);
  assert.deepEqual(validationTruthLimitations(fakeRun({ status: "succeeded" }), []), [
    "Validation not required because this was a plan-only/read-only run."
  ]);
  assert.deepEqual(validationTruthLimitations(run, [fakeOutput({
    files_changed: ["src/a.ts"],
    validation_results: [{ command: "npm test", status: "failed", summary: "Tests failed." }]
  })]), [
    "Validation was not fully passed; overall validation status is failed.",
    "npm test: failed (Tests failed.)",
    "Remaining risk: do not treat this run as fully mechanically verified until required validation passes."
  ]);
});

test("CoreFinalReportPolicy reports multi-plan and provider-truth limitations", () => {
  assert.deepEqual(multiPlanLimitations(fakeMultiPlan({ used: false })), [
    "Multi-plan factory was skipped: small task"
  ]);
  assert.deepEqual(multiPlanLimitations(fakeMultiPlan({ used: true })), [
    "Multi-plan factory used deterministic generation and wrote merged plan merged-plan.json.",
    "Merged plan is read-only advisory context; it did not create patches, modify source files, or authorize new executor behavior."
  ]);

  assert.match(executorProviderTruthLimitation([fakeOutput({
    limitations: ["Provider-backed read-only PlannerAgent completed."]
  })]), /Read-only Scout\/Planner\/Reporter roles used configured provider calls/);
  assert.match(executorProviderTruthLimitation([fakeOutput({
    limitations: ["ExecutorAgent used provider-backed planner output."]
  })]), /ExecutorAgent used a provider-backed SeniorCodingAgent planner/);
  assert.equal(
    executorProviderTruthLimitation([]),
    "ExecutorAgent cannot run because a providerFactory was not wired into the orchestrator."
  );
});

function fakeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_policy",
    user_request: "Refactor orchestration",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: ["task_policy"],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: "D:/workspace",
      memory_dir: ".agent_memory",
      max_context_files: 2,
      max_context_chars: 1200,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    },
    artifacts_path: "D:/workspace/.agent_memory/runs/run_policy",
    ...overrides
  };
}

function fakeTask(runId: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task_policy",
    run_id: runId,
    title: "Policy",
    objective: "Evaluate final report policy",
    role_required: "ScoutAgent",
    status: "succeeded",
    dependencies: [],
    relevant_files: ["src/a.ts"],
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
    summary: "Done.",
    status: "succeeded",
    files_changed: [],
    validation_results: [],
    artifacts: [],
    limitations: [],
    next_recommendations: [],
    ...overrides
  };
}

function passedIntegration(runId: string): FactoryIntegrationResult {
  return {
    integration_result_id: "integration_policy",
    run_id: runId,
    status: "passed",
    applied_candidates: [],
    rejected_candidates: [],
    blocked_candidates: [],
    conflicts: [],
    validation_status: "passed",
    validation_refs: [],
    rollback_refs: [],
    changed_files: [],
    created_at: new Date().toISOString(),
    apply_mode: "dry_run",
    rollback_available: false,
    metadata_json: {}
  };
}

function fakeMultiPlan(overrides: Partial<MultiPlanFactoryResult>): MultiPlanFactoryResult {
  return {
    used: false,
    trigger: {
      use_multi_plan: false,
      reason: "small task",
      inferred_complexity: "small",
      inferred_risk: "low",
      confidence: 0.8
    },
    generation_mode: "deterministic",
    variants: [],
    evaluations: [],
    merged_plan: {
      merged_plan_id: "merged_policy",
      run_id: "run_policy",
      generation_mode: "deterministic",
      selected_plan_ids: [],
      rejected_plan_ids: [],
      summary: "Merged policy plan.",
      chosen_strategy: "Keep the refactor small.",
      merged_tasks: [],
      dependencies: [],
      risks: [],
      assumptions: [],
      validation_strategy: {
        required_commands: [],
        optional_commands: [],
        smoke_checks: [],
        manual_checks: [],
        success_criteria: [],
        validation_risk: "low"
      },
      recommended_limits: {},
      merge_rationale: [],
      merge_decisions: [],
      unresolved_questions: [],
      confidence: 0.8,
      artifact_ref: "merged-plan.json",
      created_at: new Date().toISOString()
    },
    ...overrides
  };
}
