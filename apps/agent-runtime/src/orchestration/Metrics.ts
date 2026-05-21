import type { FinalRunReport, OrchestratorEvent, Run, RunMetrics, Task } from "./OrchestrationModels.js";
import { ORCHESTRATION_SCHEMA_VERSION } from "./OrchestrationModels.js";

export function computeRunMetrics(input: {
  run: Run;
  tasks: Task[];
  events: OrchestratorEvent[];
  report?: FinalRunReport;
}): RunMetrics {
  const validation = {
    passed: 0,
    failed: 0,
    blocked: 0
  };
  for (const event of input.events.filter((candidate) => candidate.type === "validation.command_completed")) {
    const status = String(event.payload?.status ?? "");
    if (status === "passed") validation.passed += 1;
    if (status === "failed") validation.failed += 1;
    if (status === "blocked") validation.blocked += 1;
  }
  const reviewFindings: Record<string, number> = {};
  for (const event of input.events.filter((candidate) => candidate.type === "review.completed")) {
    const severity = String(event.payload?.severity ?? "unknown");
    reviewFindings[severity] = (reviewFindings[severity] ?? 0) + Number(event.payload?.findings_count ?? 0);
  }
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    run_id: input.run.id,
    status: input.run.status,
    generated_at: new Date().toISOString(),
    tasks_created: input.tasks.length,
    tasks_completed: input.tasks.filter((task) => task.status === "succeeded").length,
    tasks_failed: input.tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
    repair_attempts: input.events.filter((event) => event.type === "repair.task_created").length,
    validation,
    files_changed: input.report?.files_changed.length ?? 0,
    review_findings_by_severity: reviewFindings,
    time_per_stage_ms: computeStageDurations(input.events),
    context_size_approximation: input.events
      .filter((event) => event.type === "context_pack.created")
      .reduce((sum, event) => sum + Number(event.payload?.approximate_size ?? 0), 0),
    invalid_structured_outputs: input.events.filter((event) => event.type === "agent.output_validation_failed").length,
    repeated_failure_fingerprints: input.events.filter((event) => String(event.message).includes("Repeated failed patch fingerprint")).length,
    stale_index_warnings: input.events.filter((event) => event.type === "index.stale").length,
    approval_gates_triggered: input.events.filter((event) => event.type === "approval.required").length
  };
}

function computeStageDurations(events: OrchestratorEvent[]) {
  const stages: Record<string, number> = {};
  const transitions = events
    .filter((event) => event.type === "run.status_changed")
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  for (let index = 0; index < transitions.length - 1; index += 1) {
    const current = transitions[index];
    const next = transitions[index + 1];
    const stage = String(current.payload?.next_status ?? "unknown");
    const duration = Date.parse(next.created_at) - Date.parse(current.created_at);
    if (Number.isFinite(duration) && duration >= 0) stages[stage] = (stages[stage] ?? 0) + duration;
  }
  return stages;
}
