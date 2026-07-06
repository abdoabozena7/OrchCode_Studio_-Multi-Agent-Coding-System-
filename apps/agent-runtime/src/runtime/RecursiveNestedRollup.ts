import type {
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRollup
} from "@hivo/protocol";

export function buildNestedRollup(branch: RecursiveBranchExecutionRecord, patches: PatchProposal[]): RecursiveNestedSubtaskRollup {
  const subtasks = branch.nestedSubtasks ?? [];
  const patchIds = uniqueRuntimeStrings(subtasks.flatMap((subtask) => subtask.proposedPatchId ? [subtask.proposedPatchId] : []));
  const validationState = nestedBranchValidationStatus(branch);
  return {
    parentBranchId: branch.branchId,
    completedSubtasks: subtasks.filter((subtask) => subtask.status === "completed").map((subtask) => subtask.subtaskId),
    failedSubtasks: subtasks.filter((subtask) => subtask.status === "failed").map((subtask) => subtask.subtaskId),
    blockedSubtasks: subtasks.filter((subtask) => subtask.status === "blocked" || subtask.status === "blocked_conflict").map((subtask) => subtask.subtaskId),
    appliedPatches: patchIds.filter((patchId) => patches.find((patch) => patch.id === patchId)?.status === "applied"),
    validationState,
    limitations: uniqueRuntimeStrings([
      ...subtasks.flatMap((subtask) => subtask.blockedReason ? [subtask.blockedReason] : []),
      validationState === "verified_passed" ? undefined : `Nested validation truth is ${validationState}.`
    ].filter(Boolean) as string[]),
    updatedAt: new Date().toISOString()
  };
}

export function nestedBranchValidationStatus(branch: RecursiveBranchExecutionRecord): import("@hivo/protocol").ValidationTruthStatus {
  const subtasks = branch.nestedSubtasks ?? [];
  if (!subtasks.length) return branch.validationStatus;
  if (subtasks.some((subtask) => subtask.validationStatus === "verified_failed" || subtask.status === "failed")) return "verified_failed";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_runtime_error")) return "not_run_runtime_error";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_blocked_by_policy" || subtask.status === "blocked" || subtask.status === "blocked_conflict")) return "not_run_blocked_by_policy";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_needs_approval")) return "not_run_needs_approval";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_missing_command")) return "not_run_missing_command";
  const writeSubtasks = subtasks.filter((subtask) => subtask.required && subtask.writeSubtask);
  if (writeSubtasks.length && writeSubtasks.every((subtask) => subtask.status === "completed" && subtask.validationStatus === "verified_passed")) return "verified_passed";
  if (subtasks.every((subtask) => subtask.status === "completed" && subtask.validationStatus === "verified_passed")) return "verified_passed";
  return subtasks.some((subtask) => subtask.patchApplied) ? "not_run_missing_command" : "unverified";
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
