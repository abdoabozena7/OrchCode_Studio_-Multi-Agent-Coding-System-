import type { IntegrationResult as FactoryIntegrationResult } from "./IntegrationModels.js";
import type { MultiPlanFactoryResult } from "./MultiPlanModels.js";
import type { ParsedAgentOutput, Run, RunStatus, Task } from "./OrchestrationModels.js";
import { aggregateValidationStatus, normalizeValidationStatus, type OverallValidationStatus } from "./ValidationSemantics.js";

export function summarizeValidationStatus(outputs: ParsedAgentOutput[]): OverallValidationStatus {
  const requiredOutputs = outputs.filter((output) => output.files_changed.length > 0);
  const records = requiredOutputs.flatMap((output) => output.validation_results);
  if (!requiredOutputs.length) return "not_required";
  if (!records.length) return "not_run";
  return aggregateValidationStatus(records.map((record) => ({
    command: record.command,
    status: record.status === "not_required" || record.status === "partial" ? "not_run" : record.status,
    required: record.required ?? true,
    reason: record.summary,
    log_ref: record.log_ref
  }))).status;
}

export function finalRunStatus(tasks: Task[], outputs: ParsedAgentOutput[], integration?: FactoryIntegrationResult): RunStatus {
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  const validation = summarizeValidationStatus(outputs);
  if (validation === "failed") return "failed";
  if (validation === "blocked" || validation === "skipped" || validation === "partial" || validation === "not_run") return "blocked";
  if (integration?.status === "failed") return "failed";
  if (integration && integration.status !== "passed" && integration.status !== "not_required") return "blocked";
  return "succeeded";
}

export function integrationLimitations(integration: FactoryIntegrationResult): string[] {
  if (integration.status === "passed" || integration.status === "not_required") return [];
  return [
    `Integration did not pass; status is ${integration.status}.`,
    integration.blocked_reason ?? "Integration requires safe apply and fully passed post-integration validation before success."
  ];
}

export function validationTruthLimitations(run: Run, outputs: ParsedAgentOutput[]): string[] {
  const status = summarizeValidationStatus(outputs);
  const normalized = normalizeValidationStatus(status);
  if (normalized === "passed") return [];
  if (normalized === "not_required") {
    return [run.status === "succeeded"
      ? "Validation not required because this was a plan-only/read-only run."
      : "Validation not required because no mechanical changes required validation."];
  }
  const records = outputs.flatMap((output) => output.validation_results);
  const incomplete = records
    .filter((record) => record.status !== "passed")
    .map((record) => `${record.command}: ${record.status} (${record.summary})`)
    .slice(0, 6);
  return [
    `Validation was not fully passed; overall validation status is ${normalized}.`,
    ...incomplete,
    "Remaining risk: do not treat this run as fully mechanically verified until required validation passes."
  ];
}

export function multiPlanLimitations(result: MultiPlanFactoryResult): string[] {
  if (!result.used) return [`Multi-plan factory was skipped: ${result.trigger.reason}`];
  return [
    `Multi-plan factory used ${result.generation_mode} generation and wrote merged plan ${result.merged_plan?.artifact_ref ?? "unknown"}.`,
    "Merged plan is read-only advisory context; it did not create patches, modify source files, or authorize new executor behavior."
  ];
}

export function executorProviderTruthLimitation(outputs: ParsedAgentOutput[]): string {
  if (outputs.some((output) => output.limitations.some((entry) => /Provider-backed read-only/i.test(entry)))) {
    return "Read-only Scout/Planner/Reporter roles used configured provider calls; write-capable ExecutorAgent remains separately gated through SeniorCodingAgent and review/validation authority.";
  }
  return outputs.some((output) => output.limitations.some((entry) => /provider-backed planner/i.test(entry)))
    ? "ExecutorAgent used a provider-backed SeniorCodingAgent planner; write output remains gated by review, validation, and patch authority."
    : "ExecutorAgent cannot run because a providerFactory was not wired into the orchestrator.";
}
