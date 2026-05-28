import { existsSync } from "node:fs";
import path from "node:path";
import type { CommandInventory } from "../memory/types.js";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import {
  createValidationCommandPreflight,
  createValidationEnvironmentReadiness,
  createValidationPreflightFinding,
  createValidationPreflightResult,
  type ValidationCandidate,
  type ValidationCommandPreflight,
  type ValidationEnvironmentReadiness,
  type ValidationPreflightFinding,
  type ValidationPreflightResult
} from "./ValidationCandidateModels.js";

export type ValidationPlanDraft = {
  required_commands: string[];
  optional_commands: string[];
  command_metadata: Record<string, {
    purpose: string;
    expected_output: string;
    fallback_behavior: string;
  }>;
  not_required_reason?: string;
  strict_validation_semantics_ref: string;
};

export type ValidationPreflightCheckerInput = {
  workspacePath: string;
  config: OrchestrationSafetyConfig;
  commandInventory?: CommandInventory;
  validationPlan: ValidationPlanDraft;
  candidate: ValidationCandidate;
};

export function runValidationPreflightCheck(input: ValidationPreflightCheckerInput): ValidationPreflightResult {
  const findings: ValidationPreflightFinding[] = [];
  const commandPreflights = [
    ...input.validationPlan.required_commands.map((command) => commandPreflight(input, command, true, findings)),
    ...input.validationPlan.optional_commands.map((command) => commandPreflight(input, command, false, findings))
  ];
  const environment = environmentReadiness(input, findings);
  const requiredBlocked = commandPreflights.some((entry) => entry.required && (
    ["blocked", "not_allowed", "missing", "requires_environment", "requires_human_approval"].includes(entry.safety_status)
    || (entry.safety_status === "unknown" && input.config.block_unknown_required_commands)
  ));
  const incomplete = findings.some((finding) => finding.severity === "blocking" && [
    "missing_validation_plan",
    "missing_command_purpose",
    "missing_expected_output",
    "missing_fallback",
    "strict_semantics_missing",
    "validation_claimed"
  ].includes(finding.finding_type));
  const status = environment.status === "blocked" || requiredBlocked
    ? "blocked"
    : incomplete
      ? "incomplete"
      : "passed";
  return createValidationPreflightResult({
    validation_candidate_id: input.candidate.validation_candidate_id,
    status,
    command_preflights: commandPreflights,
    environment_readiness: environment,
    findings,
    metadata_json: {
      required_command_count: input.validationPlan.required_commands.length,
      optional_command_count: input.validationPlan.optional_commands.length,
      strict_validation_semantics_ref: input.validationPlan.strict_validation_semantics_ref,
      validation_not_run: true
    }
  });
}

function commandPreflight(
  input: ValidationPreflightCheckerInput,
  command: string,
  required: boolean,
  findings: ValidationPreflightFinding[]
): ValidationCommandPreflight {
  const inventoryMatch = Boolean(input.commandInventory?.commands.some((entry) => entry.command === command));
  const risk = classifyCommandRisk(command, input.workspacePath);
  const allowlisted = commandAllowed(command, input.config.safe_commands_allowlist);
  const metadata = input.validationPlan.command_metadata[command];
  if (!metadata?.purpose) findings.push(finding(input.candidate.validation_candidate_id, "missing_command_purpose", "blocking", `Validation command is missing purpose: ${command}.`, command));
  if (!metadata?.expected_output) findings.push(finding(input.candidate.validation_candidate_id, "missing_expected_output", "blocking", `Validation command is missing expected output: ${command}.`, command));
  if (!metadata?.fallback_behavior) findings.push(finding(input.candidate.validation_candidate_id, "missing_fallback", "blocking", `Validation command is missing fallback behavior: ${command}.`, command));
  let safetyStatus: ValidationCommandPreflight["safety_status"] = "safe";
  let blockedReason: string | undefined;
  if (!command.trim()) {
    safetyStatus = "missing";
    blockedReason = "Command is empty.";
  } else if (risk === "dangerous") {
    safetyStatus = "blocked";
    blockedReason = "Command risk is dangerous.";
  } else if (risk !== "safe") {
    safetyStatus = "unknown";
    blockedReason = `Command risk is ${risk}.`;
  } else if (!allowlisted) {
    safetyStatus = "not_allowed";
    blockedReason = "Command is safe-shaped but not present in safe_commands_allowlist.";
  } else if (input.config.require_command_inventory && !inventoryMatch) {
    safetyStatus = "unknown";
    blockedReason = "Command is missing from required command inventory.";
  }
  if (required && input.config.block_unknown_required_commands && safetyStatus === "unknown") {
    findings.push(finding(input.candidate.validation_candidate_id, "command_unknown", "blocking", blockedReason ?? `Required command is unknown: ${command}.`, command));
  }
  if (required && ["blocked", "not_allowed", "missing", "requires_environment", "requires_human_approval"].includes(safetyStatus)) {
    findings.push(finding(input.candidate.validation_candidate_id, "command_blocked", "blocking", blockedReason ?? `Required command is blocked: ${command}.`, command));
  }
  if (!required && safetyStatus !== "safe") {
    findings.push(finding(input.candidate.validation_candidate_id, safetyStatus === "unknown" ? "command_unknown" : "command_blocked", "warning", blockedReason ?? `Optional command is not safe: ${command}.`, command));
  }
  return createValidationCommandPreflight({
    validation_candidate_id: input.candidate.validation_candidate_id,
    command,
    required,
    purpose: metadata?.purpose ?? "",
    expected_output: metadata?.expected_output ?? "",
    fallback_behavior: metadata?.fallback_behavior ?? "",
    safety_status: safetyStatus,
    risk,
    allowlisted,
    inventory_present: Boolean(input.commandInventory),
    inventory_match: inventoryMatch,
    future_semantics_status: safetyStatus === "safe" ? "not_run" : "blocked",
    blocked_reason: blockedReason,
    metadata_json: {
      validation_not_run: true,
      command_inventory_generated_at: input.commandInventory?.generatedAt
    }
  });
}

function environmentReadiness(input: ValidationPreflightCheckerInput, findings: ValidationPreflightFinding[]): ValidationEnvironmentReadiness {
  const workspaceKnown = Boolean(input.workspacePath);
  const inventoryAvailable = Boolean(input.commandInventory);
  const validationRunnerAvailable = true;
  const requiredArtifactsExist = [
    input.candidate.patch_artifact_ref,
    input.candidate.review_artifact_ref,
    input.candidate.validation_plan_ref
  ].filter((ref): ref is string => Boolean(ref)).every((ref) => existsSync(ref) || !path.isAbsolute(ref));
  const environmentFindings: ValidationPreflightFinding[] = [];
  const add = (findingEntry: ValidationPreflightFinding) => {
    findings.push(findingEntry);
    environmentFindings.push(findingEntry);
  };
  if (!workspaceKnown) add(finding(input.candidate.validation_candidate_id, "environment_missing", "blocking", "Workspace path is missing."));
  if (!inventoryAvailable) add(finding(input.candidate.validation_candidate_id, "environment_missing", input.config.require_command_inventory ? "blocking" : "warning", "Command inventory is missing."));
  if (!validationRunnerAvailable) add(finding(input.candidate.validation_candidate_id, "environment_missing", "blocking", "Validation runner is unavailable."));
  if (!requiredArtifactsExist) add(finding(input.candidate.validation_candidate_id, "artifact_missing", "blocking", "Required candidate artifacts are missing."));
  add(finding(input.candidate.validation_candidate_id, "patch_applied", "info", "Patch is expected to be unapplied before validation preflight."));
  const warningBlocks = input.config.require_environment_readiness && environmentFindings.some((entry) => entry.severity === "warning");
  const blocked = warningBlocks || environmentFindings.some((entry) => entry.severity === "blocking");
  return createValidationEnvironmentReadiness({
    validation_candidate_id: input.candidate.validation_candidate_id,
    status: blocked ? "blocked" : environmentFindings.some((entry) => entry.severity === "warning") ? "warning" : "ready",
    workspace_path_known: workspaceKnown,
    command_inventory_available: inventoryAvailable,
    validation_runner_available: validationRunnerAvailable,
    required_artifacts_exist: requiredArtifactsExist,
    patch_apply_strategy: "prepare_only",
    findings: environmentFindings,
    metadata_json: {
      no_shell_commands_run: true,
      patch_not_applied_expected: true
    }
  });
}

function finding(
  candidateId: string,
  type: ValidationPreflightFinding["finding_type"],
  severity: ValidationPreflightFinding["severity"],
  message: string,
  command?: string
) {
  return createValidationPreflightFinding({
    validation_candidate_id: candidateId,
    finding_type: type,
    severity,
    message,
    command,
    refs: command ? [command] : []
  });
}

function commandAllowed(command: string, allowlist: string[]) {
  const normalized = command.trim().toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return normalized === allowed || normalized.startsWith(`${allowed} `);
  });
}
