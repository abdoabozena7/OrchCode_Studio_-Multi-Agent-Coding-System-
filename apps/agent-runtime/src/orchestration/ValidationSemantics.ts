export const OVERALL_VALIDATION_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "blocked",
  "partial",
  "not_required",
  "not_run"
] as const;

export const VALIDATION_COMMAND_STATUSES = [
  "passed",
  "failed",
  "blocked",
  "skipped",
  "timed_out",
  "not_run"
] as const;

export type OverallValidationStatus = typeof OVERALL_VALIDATION_STATUSES[number];
export type ValidationCommandStatus = typeof VALIDATION_COMMAND_STATUSES[number];
export type ValidationRunImpact = "allow_success" | "allow_plan_only_success" | "fail" | "block" | "prevent_full_success";

export type ValidationRequirement = {
  command: string;
  required?: boolean;
  reason?: string;
};

export type ValidationCommandObservation = {
  command: string;
  status: ValidationCommandStatus;
  required?: boolean;
  reason?: string;
  log_ref?: string;
};

export type ValidationAggregationOptions = {
  mode?: "normal" | "plan_only" | "read_only" | "documentation_only";
  notRequiredReason?: string;
  skippedAllowed?: boolean;
  timedOutImpact?: "failed" | "blocked";
};

export type ValidationAggregationResult = {
  status: OverallValidationStatus;
  fully_passed: boolean;
  blocking_completion: boolean;
  run_impact: ValidationRunImpact;
  reason: string;
  required_command_count: number;
  optional_command_count: number;
  passed_count: number;
  failed_count: number;
  blocked_count: number;
  skipped_count: number;
  timed_out_count: number;
  not_run_count: number;
  commands: Array<ValidationCommandObservation & { required: boolean }>;
  missing_required_commands: string[];
  warnings: string[];
};

export function aggregateValidationStatus(
  commands: ValidationCommandObservation[],
  requirements: ValidationRequirement[] = [],
  options: ValidationAggregationOptions = {}
): ValidationAggregationResult {
  const requirementMap = new Map(requirements.map((requirement) => [requirement.command, requirement]));
  const normalizedCommands = commands.map((command) => ({
    ...command,
    status: normalizeValidationCommandStatus(command.status),
    required: command.required ?? requirementMap.get(command.command)?.required ?? true
  }));
  const observed = new Set(normalizedCommands.map((command) => command.command));
  for (const requirement of requirements) {
    if (requirement.required === false || observed.has(requirement.command)) continue;
    normalizedCommands.push({
      command: requirement.command,
      status: "not_run",
      required: true,
      reason: requirement.reason ?? "Required validation command was not run."
    });
  }

  const requiredCommands = normalizedCommands.filter((command) => command.required);
  const optionalCommands = normalizedCommands.filter((command) => !command.required);
  const passedCount = normalizedCommands.filter((command) => command.status === "passed").length;
  const failedCount = normalizedCommands.filter((command) => command.status === "failed").length;
  const blockedCount = normalizedCommands.filter((command) => command.status === "blocked").length;
  const skippedCount = normalizedCommands.filter((command) => command.status === "skipped").length;
  const timedOutCount = normalizedCommands.filter((command) => command.status === "timed_out").length;
  const notRunCount = normalizedCommands.filter((command) => command.status === "not_run").length;

  const requiredPassed = requiredCommands.filter((command) => command.status === "passed").length;
  const requiredFailed = requiredCommands.filter((command) => command.status === "failed").length;
  const requiredBlocked = requiredCommands.filter((command) => command.status === "blocked").length;
  const requiredSkipped = requiredCommands.filter((command) => command.status === "skipped").length;
  const requiredTimedOut = requiredCommands.filter((command) => command.status === "timed_out").length;
  const requiredNotRun = requiredCommands.filter((command) => command.status === "not_run").length;
  const requiredNonPassing = requiredBlocked + requiredSkipped + requiredTimedOut + requiredNotRun;

  let status: OverallValidationStatus;
  if (!requiredCommands.length && isNotRequiredMode(options)) {
    status = "not_required";
  } else if (!requiredCommands.length && normalizedCommands.length === 0) {
    status = "not_run";
  } else if (requiredFailed || (requiredTimedOut && (options.timedOutImpact ?? "failed") === "failed")) {
    status = "failed";
  } else if (requiredPassed > 0 && requiredNonPassing > 0) {
    status = "partial";
  } else if (requiredBlocked || (requiredTimedOut && options.timedOutImpact === "blocked")) {
    status = "blocked";
  } else if (requiredSkipped) {
    status = options.skippedAllowed ? "skipped" : "partial";
  } else if (requiredNotRun || (requiredCommands.length > 0 && requiredPassed === 0)) {
    status = "not_run";
  } else if (requiredCommands.length > 0 && requiredPassed === requiredCommands.length) {
    status = "passed";
  } else {
    status = "not_run";
  }

  const result: ValidationAggregationResult = {
    status,
    fully_passed: status === "passed",
    blocking_completion: isValidationBlockingCompletion(status),
    run_impact: validationStatusToRunImpact(status),
    reason: explainValidationStatus({
      status,
      required_command_count: requiredCommands.length,
      optional_command_count: optionalCommands.length,
      passed_count: passedCount,
      failed_count: failedCount,
      blocked_count: blockedCount,
      skipped_count: skippedCount,
      timed_out_count: timedOutCount,
      not_run_count: notRunCount,
      not_required_reason: options.notRequiredReason
    }),
    required_command_count: requiredCommands.length,
    optional_command_count: optionalCommands.length,
    passed_count: passedCount,
    failed_count: failedCount,
    blocked_count: blockedCount,
    skipped_count: skippedCount,
    timed_out_count: timedOutCount,
    not_run_count: notRunCount,
    commands: normalizedCommands,
    missing_required_commands: requiredCommands.filter((command) => command.status === "not_run").map((command) => command.command),
    warnings: optionalCommands
      .filter((command) => command.status !== "passed")
      .map((command) => `Optional validation command ${command.command} ended with ${command.status}.`)
  };
  return result;
}

export function isValidationFullyPassed(result: Pick<ValidationAggregationResult, "status"> | OverallValidationStatus) {
  return normalizeValidationStatus(typeof result === "string" ? result : result.status) === "passed";
}

export function isValidationBlockingCompletion(result: Pick<ValidationAggregationResult, "status"> | OverallValidationStatus) {
  const status = normalizeValidationStatus(typeof result === "string" ? result : result.status);
  return status === "failed" || status === "blocked" || status === "partial" || status === "skipped" || status === "not_run";
}

export function explainValidationStatus(input: Pick<
  ValidationAggregationResult,
  "status" | "required_command_count" | "optional_command_count" | "passed_count" | "failed_count" | "blocked_count" | "skipped_count" | "timed_out_count" | "not_run_count"
> & { not_required_reason?: string }) {
  const status = normalizeValidationStatus(input.status);
  if (status === "passed") return `All ${input.required_command_count} required validation check(s) ran and passed.`;
  if (status === "failed") return `${input.failed_count + input.timed_out_count} required validation check(s) failed or timed out.`;
  if (status === "blocked") return `${input.blocked_count + input.timed_out_count} required validation check(s) were blocked or unavailable.`;
  if (status === "partial") return `Validation was partial: ${input.passed_count} check(s) passed, but ${input.blocked_count + input.skipped_count + input.timed_out_count + input.not_run_count} required check(s) did not fully pass.`;
  if (status === "skipped") return `${input.skipped_count} required validation check(s) were explicitly skipped.`;
  if (status === "not_required") return input.not_required_reason ?? "Validation not required for this run mode.";
  return "Validation was expected but no required validation command was run.";
}

export function normalizeValidationStatus(status: string): OverallValidationStatus {
  if ((OVERALL_VALIDATION_STATUSES as readonly string[]).includes(status)) return status as OverallValidationStatus;
  if (status === "timed_out") return "failed";
  if (status === "not_available" || status === "unavailable") return "blocked";
  throw new Error(`Unknown validation status "${status}".`);
}

export function normalizeValidationCommandStatus(status: string): ValidationCommandStatus {
  if ((VALIDATION_COMMAND_STATUSES as readonly string[]).includes(status)) return status as ValidationCommandStatus;
  if (status === "not_available" || status === "unavailable") return "blocked";
  throw new Error(`Unknown validation command status "${status}".`);
}

export function validationStatusToRunImpact(status: OverallValidationStatus | string): ValidationRunImpact {
  const normalized = normalizeValidationStatus(status);
  if (normalized === "passed") return "allow_success";
  if (normalized === "not_required") return "allow_plan_only_success";
  if (normalized === "failed") return "fail";
  if (normalized === "blocked") return "block";
  return "prevent_full_success";
}

export function validationTraceTypeForStatus(status: OverallValidationStatus) {
  if (status === "passed") return "validation_completed";
  if (status === "failed") return "validation_failed";
  if (status === "blocked") return "validation_blocked";
  if (status === "skipped") return "validation_skipped";
  if (status === "partial") return "validation_partial";
  if (status === "not_required") return "validation_not_required";
  return "validation_not_run";
}

function isNotRequiredMode(options: ValidationAggregationOptions) {
  return options.mode === "plan_only" || options.mode === "read_only" || options.mode === "documentation_only" || Boolean(options.notRequiredReason);
}
