import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { SandboxValidatedIntegrationCandidate } from "./SandboxIntegrationCandidateModels.js";
import {
  createIntegrationApplyApprovalBlocker,
  createIntegrationApplyApprovalWarning,
  type ApplyModeRecommendation,
  type IntegrationApplyApprovalBlocker,
  type IntegrationApplyApprovalDecision,
  type IntegrationApplyApprovalStatus,
  type IntegrationApplyApprovalWarning,
  type IntegrationApplyScope,
  type WorktreeSafetyCheck
} from "./IntegrationApplyApprovalModels.js";

export const KNOWN_DIRTY_DESKTOP_FILES = [
  "apps/desktop/src/app/App.tsx",
  "apps/desktop/src/app/styles.css"
];

export type ApplyApprovalPolicyInput = {
  approvalId: string;
  candidate: SandboxValidatedIntegrationCandidate;
  blockers: IntegrationApplyApprovalBlocker[];
  warnings: IntegrationApplyApprovalWarning[];
  worktreeSafetyCheck: WorktreeSafetyCheck;
  approvalDecision?: IntegrationApplyApprovalDecision;
  config: OrchestrationSafetyConfig;
};

export function defaultApplyScopeForCandidate(candidate: SandboxValidatedIntegrationCandidate): IntegrationApplyScope {
  return {
    scope_id: `integration_apply_scope_${candidate.integration_candidate_id}`,
    integration_candidate_id: candidate.integration_candidate_id,
    allowed_files: uniqueStrings(candidate.changed_files),
    forbidden_files: uniqueStrings(asStringArray(candidate.metadata_json.forbidden_files)),
    changed_files: uniqueStrings(candidate.changed_files),
    required_file_locks: uniqueStrings(candidate.required_file_locks),
    required_module_locks: uniqueStrings(candidate.required_module_locks),
    required_semantic_locks: uniqueStrings(candidate.required_semantic_locks),
    validation_requirements: uniqueStrings(candidate.post_integration_validation_plan.required_commands),
    rollback_requirements_ref: candidate.rollback_requirements_ref,
    post_integration_validation_plan_ref: candidate.post_integration_validation_plan_ref,
    integration_manager_required: true,
    durable_locks_required: true,
    strict_validation_required: true,
    provider_write_workers_allowed: false,
    dirty_overlap_override: false,
    metadata_json: { source: "sandbox_validated_integration_candidate" }
  };
}

export function evaluateApplyApprovalPolicy(input: ApplyApprovalPolicyInput) {
  const blockers = [...input.blockers];
  const warnings = [...input.warnings];
  const humanApprovalRequired = requiresHumanApproval(input.candidate, input.config, input.worktreeSafetyCheck);
  if (humanApprovalRequired) {
    warnings.push(createIntegrationApplyApprovalWarning({
      integration_apply_approval_id: input.approvalId,
      run_id: input.candidate.run_id,
      integration_candidate_id: input.candidate.integration_candidate_id,
      warning_type: "human_approval_required",
      severity: "warning",
      message: "Human approval is required before any future main-repository apply.",
      refs: [input.candidate.integration_candidate_id]
    }));
  }

  if (input.candidate.rollback_requirements.status === "manual_limited") {
    warnings.push(createIntegrationApplyApprovalWarning({
      integration_apply_approval_id: input.approvalId,
      run_id: input.candidate.run_id,
      integration_candidate_id: input.candidate.integration_candidate_id,
      warning_type: "manual_rollback_only",
      severity: "warning",
      message: "Rollback requirements are manual/limited, so a future apply remains human-gated.",
      refs: [input.candidate.rollback_requirements_ref ?? input.candidate.rollback_requirements.rollback_requirement_id]
    }));
  }

  warnings.push(createIntegrationApplyApprovalWarning({
    integration_apply_approval_id: input.approvalId,
    run_id: input.candidate.run_id,
    integration_candidate_id: input.candidate.integration_candidate_id,
    warning_type: "post_validation_not_run",
    severity: "info",
    message: "Post-integration validation requirements are recorded but not run by this approval gate.",
    refs: input.candidate.post_integration_validation_plan.required_commands
  }));
  warnings.push(createIntegrationApplyApprovalWarning({
    integration_apply_approval_id: input.approvalId,
    run_id: input.candidate.run_id,
    integration_candidate_id: input.candidate.integration_candidate_id,
    warning_type: "locks_not_acquired",
    severity: "info",
    message: "Required locks are recorded for future apply but not acquired by this approval gate.",
    refs: input.candidate.required_file_locks
  }));
  warnings.push(createIntegrationApplyApprovalWarning({
    integration_apply_approval_id: input.approvalId,
    run_id: input.candidate.run_id,
    integration_candidate_id: input.candidate.integration_candidate_id,
    warning_type: "main_repo_apply_not_performed",
    severity: "info",
    message: "No main repository apply occurred.",
    refs: [input.candidate.integration_candidate_id]
  }));

  const status = statusForPolicy(input.candidate, blockers, humanApprovalRequired, input.approvalDecision);
  return { status, blockers, warnings, approvalRequired: humanApprovalRequired || input.candidate.approval_required };
}

export function recommendApplyModeForStatus(status: IntegrationApplyApprovalStatus): ApplyModeRecommendation {
  if (status === "approved_for_apply_candidate") return "controlled_apply_requires_approval";
  if (status === "requires_human_approval" || status === "pending") return "prepare_only";
  if (status === "not_required") return "no_apply";
  return "blocked";
}

export function validateIntegrationApplyApprovalScope(
  approvalId: string,
  candidate: SandboxValidatedIntegrationCandidate,
  requestedScope: IntegrationApplyScope
): IntegrationApplyApprovalBlocker[] {
  const blockers: IntegrationApplyApprovalBlocker[] = [];
  const candidateScope = defaultApplyScopeForCandidate(candidate);
  const add = (blocker_type: IntegrationApplyApprovalBlocker["blocker_type"], reason: string, refs: string[]) => {
    blockers.push(createIntegrationApplyApprovalBlocker({
      integration_apply_approval_id: approvalId,
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      blocker_type,
      severity: "blocking",
      reason,
      refs
    }));
  };
  const changed = new Set(candidateScope.changed_files);
  for (const file of requestedScope.allowed_files) {
    if (!changed.has(file)) add("approval_scope_too_broad", `Approval scope includes file outside candidate scope: ${file}.`, [file]);
  }
  for (const file of requestedScope.changed_files) {
    if (!changed.has(file)) add("approval_scope_too_broad", `Approval changed_files includes file outside candidate scope: ${file}.`, [file]);
  }
  for (const file of candidateScope.forbidden_files) {
    if (!requestedScope.forbidden_files.includes(file)) add("approval_scope_too_broad", `Approval scope removes forbidden file constraint: ${file}.`, [file]);
  }
  for (const command of candidateScope.validation_requirements) {
    if (!requestedScope.validation_requirements.includes(command)) add("approval_weakened_validation", `Approval scope removes validation requirement: ${command}.`, [command]);
  }
  for (const lock of candidateScope.required_file_locks) {
    if (!requestedScope.required_file_locks.includes(lock)) add("approval_weakened_locks", `Approval scope removes file lock requirement: ${lock}.`, [lock]);
  }
  for (const lock of candidateScope.required_module_locks) {
    if (!requestedScope.required_module_locks.includes(lock)) add("approval_weakened_locks", `Approval scope removes module lock requirement: ${lock}.`, [lock]);
  }
  for (const lock of candidateScope.required_semantic_locks) {
    if (!requestedScope.required_semantic_locks.includes(lock)) add("approval_weakened_locks", `Approval scope removes semantic lock requirement: ${lock}.`, [lock]);
  }
  if (candidateScope.rollback_requirements_ref && requestedScope.rollback_requirements_ref !== candidateScope.rollback_requirements_ref) {
    add("approval_weakened_rollback", "Approval scope changes or removes rollback requirements.", [candidateScope.rollback_requirements_ref]);
  }
  if (candidateScope.post_integration_validation_plan_ref && requestedScope.post_integration_validation_plan_ref !== candidateScope.post_integration_validation_plan_ref) {
    add("approval_weakened_validation", "Approval scope changes or removes post-integration validation plan.", [candidateScope.post_integration_validation_plan_ref]);
  }
  if (!requestedScope.integration_manager_required) add("approval_bypasses_integration_manager", "Approval scope bypasses IntegrationManager.", [candidate.integration_candidate_id]);
  if (!requestedScope.durable_locks_required) add("approval_bypasses_durable_locks", "Approval scope bypasses durable locks.", candidate.required_file_locks);
  if (!requestedScope.strict_validation_required) add("approval_bypasses_strict_validation", "Approval scope bypasses strict validation.", [candidate.sandbox_validation_id]);
  if (requestedScope.provider_write_workers_allowed) add("approval_allows_provider_write_workers", "Approval scope allows provider write workers outside policy.", [candidate.integration_candidate_id]);
  return blockers;
}

function statusForPolicy(
  candidate: SandboxValidatedIntegrationCandidate,
  blockers: IntegrationApplyApprovalBlocker[],
  humanApprovalRequired: boolean,
  decision?: IntegrationApplyApprovalDecision
): IntegrationApplyApprovalStatus {
  if (blockers.some((blocker) => blocker.blocker_type === "dirty_worktree_overlap" || blocker.blocker_type === "dirty_known_desktop_file" || blocker.blocker_type === "clean_worktree_required")) {
    return "dirty_worktree_blocked";
  }
  if (blockers.some((blocker) => blocker.blocker_type === "missing_locks")) return "missing_locks";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_rollback_plan")) return "missing_rollback_plan";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_post_validation_plan")) return "missing_post_validation_plan";
  if (blockers.some((blocker) => blocker.blocker_type.startsWith("approval_"))) return "rejected";
  if (blockers.length) return "candidate_invalid";
  if (decision?.decision === "reject") return "rejected";
  if (decision?.decision === "block") return "blocked";
  if (decision?.decision === "approve" && ["human", "test_fixture"].includes(decision.approver_type)) return "approved_for_apply_candidate";
  if (candidate.changed_files.length === 0 && !humanApprovalRequired) return "not_required";
  if (humanApprovalRequired) return "requires_human_approval";
  return "approved_for_apply_candidate";
}

function requiresHumanApproval(candidate: SandboxValidatedIntegrationCandidate, config: OrchestrationSafetyConfig, worktree: WorktreeSafetyCheck) {
  if (config.require_human_approval_for_main_repo_apply !== false) return true;
  if (candidate.changed_files.length > 0) return true;
  if (["high", "critical"].includes(candidate.risk_level)) return true;
  if (candidate.rollback_requirements.status === "manual_limited") return true;
  if (worktree.status === "dirty_overlap" || worktree.status === "dirty_known_desktop_overlap") return true;
  return candidate.changed_files.some((file) => isPolicySensitiveFile(file));
}

export function isPolicySensitiveFile(file: string) {
  const normalized = file.replace(/\\/g, "/");
  return [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    ".env",
    "schema",
    "migration",
    "security",
    "auth",
    "config",
    "api"
  ].some((fragment) => normalized.includes(fragment));
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
