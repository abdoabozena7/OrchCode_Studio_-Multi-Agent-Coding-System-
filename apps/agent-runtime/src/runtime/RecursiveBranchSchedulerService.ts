import type {
  AgentRuntimeSession,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRecord
} from "@hivo/protocol";
import type { SessionManager } from "./SessionManager.js";
import { buildNestedRollup, nestedBranchValidationStatus } from "./RecursiveNestedRollup.js";

export type RecursiveBranchSchedulerServices = {
  proposeScheduledBranchPatch: (sessionId: string, branchId: string) => Promise<void>;
  proposeNestedSubtaskPatch: (sessionId: string, branchId: string, subtaskId: string) => Promise<void>;
};

export type RecursiveBranchSchedulerAdvance = {
  phase?: NonNullable<AgentRuntimeSession["recursiveFactory"]>["phase"];
  branchToPropose?: string;
  nestedToPropose?: { branchId: string; subtaskId: string };
};

export class RecursiveBranchSchedulerService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RecursiveBranchSchedulerServices
  ) {}

  async advance(sessionId: string): Promise<RecursiveBranchSchedulerAdvance> {
    const advance: RecursiveBranchSchedulerAdvance = {};
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const factory = draft.recursiveFactory;
      const records = factory?.branchExecutions;
      if (!factory || !records?.length) return;
      const now = new Date().toISOString();
      for (const branch of records) {
        if (!branch.nestedSubtasks?.length) continue;
        const subtaskId = advanceNestedSubtasks(branch, now);
        if (subtaskId && !advance.nestedToPropose) advance.nestedToPropose = { branchId: branch.branchId, subtaskId };
      }
      for (const branch of records) {
        if (!isSchedulableBranchStatus(branch.status) || branch.proposedPatchId) continue;
        branch.updatedAt = now;
        const dependencyFailure = branch.executionContext.dependencies
          .map((dependencyId) => records.find((candidate) => candidate.branchId === dependencyId))
          .find((dependency) => dependency && isFailedDependencyBranch(dependency));
        if (dependencyFailure) {
          branch.status = "blocked_failed_dependency";
          branch.active = false;
          branch.schedulerDecision.blockedReason = "failed_dependency";
          branch.blockedReason = `Dependency ${dependencyFailure.branchId} failed or blocked, so this branch cannot execute.`;
          continue;
        }
        const waitingDependencies = branch.executionContext.dependencies.filter((dependencyId) => {
          const dependency = records.find((candidate) => candidate.branchId === dependencyId);
          return !dependency || !isDependencySatisfiedBranch(dependency);
        });
        if (waitingDependencies.length) {
          branch.status = "waiting_on_dependency";
          branch.active = false;
          branch.schedulerDecision.blockedReason = "dependency_waiting";
          branch.schedulerDecision.sequencingReason = `Waiting for dependencies: ${waitingDependencies.join(", ")}`;
          continue;
        }
        const blockingConflict = (factory.branchScopeConflicts ?? factory.recursiveGraph?.conflicts ?? [])
          .find((conflict) => conflict.severity === "blocking" && conflict.branchIds.includes(branch.branchId));
        if (blockingConflict) {
          branch.status = "blocked_conflict";
          branch.active = false;
          branch.schedulerDecision.blockedReason = blockingConflict.code;
          branch.conflictReason = `${blockingConflict.code}: ${blockingConflict.reason}`;
          branch.blockedReason = branch.conflictReason;
          continue;
        }
        if (!branch.executionContext.fileScopes.length && !branch.executionContext.semanticScopes.length) {
          branch.status = "blocked_conflict";
          branch.active = false;
          branch.schedulerDecision.blockedReason = "missing_file_scope";
          branch.blockedReason = "missing_file_scope: Branch has neither file scopes nor semantic scopes.";
          continue;
        }
        if (!branch.schedulerDecision.writeBranch) {
          branch.status = "completed";
          branch.active = false;
          branch.completedAt = now;
          branch.validationStatus = branch.validationStatus === "verified_passed" ? "verified_passed" : "unverified";
          branch.blockedReason = "Read-only branch completed planning work without filesystem writes; validation remains unverified until evidence is recorded.";
          continue;
        }
        branch.status = "ready";
        branch.active = false;
        branch.schedulerDecision.blockedReason = undefined;
        branch.schedulerDecision.sequencingReason = "Ready for the conservative single-writer scheduler.";
      }
      const activeWrite = records.some((branch) => isActiveWriteBranch(branch));
      const activeNestedWrite = records.some((branch) => branch.nestedSubtasks?.some((subtask) => isActiveNestedWriteSubtask(subtask)));
      if (!activeWrite && !activeNestedWrite && !advance.nestedToPropose) {
        const next = records.find((branch) => branch.status === "ready" && branch.schedulerDecision.writeBranch && !branch.proposedPatchId);
        if (next) {
          next.status = "running";
          next.active = true;
          next.startedAt ??= now;
          next.updatedAt = now;
          next.schedulerDecision.sequencingReason = "Selected by the conservative scheduler; max active write branches is 1.";
          if (shouldCreateNestedSubtasks(next)) {
            next.nestedDepth = 1;
            next.nestedEligible = true;
            next.nestedSubtasks = buildNestedSubtasks(next, now);
            next.nestedRollup = buildNestedRollup(next, []);
            next.blockedReason = "Parent branch is waiting for required nested subtasks.";
            const subtaskId = advanceNestedSubtasks(next, now);
            if (subtaskId) {
              advance.nestedToPropose = { branchId: next.branchId, subtaskId };
            }
          } else {
            advance.branchToPropose = next.branchId;
          }
        }
      }
      factory.activeBranchId = advance.branchToPropose;
      factory.executionStarted = true;
      factory.phase = records.some((branch) => branch.status === "blocked_conflict" || branch.status === "blocked_failed_dependency")
        && !records.some((branch) => isActiveWriteBranch(branch) || branch.status === "ready")
          ? "branch_execution_blocked"
          : "branch_execution_running";
      advance.phase = factory.phase;
      factory.updatedAt = now;
      for (const branch of factory.branchOrchestrators ?? []) {
        const execution = records.find((candidate) => candidate.branchId === branch.branchId);
        if (!execution) continue;
        branch.status = execution.status;
        branch.updatedAt = execution.updatedAt;
      }
      draft.status = factory.phase === "branch_execution_blocked" ? "blocked" : "needs_approval";
      draft.lifecycleStage = factory.phase === "branch_execution_blocked" ? "BLOCKED" : "APPROVAL";
    });
    if (advance.nestedToPropose) {
      await this.services.proposeNestedSubtaskPatch(sessionId, advance.nestedToPropose.branchId, advance.nestedToPropose.subtaskId);
    } else if (advance.branchToPropose) {
      await this.services.proposeScheduledBranchPatch(sessionId, advance.branchToPropose);
    }
    return advance;
  }
}

export function requiredNestedSubtasksTerminal(branch: RecursiveBranchExecutionRecord) {
  return (branch.nestedSubtasks ?? [])
    .filter((subtask) => subtask.required)
    .every((subtask) => subtask.status === "completed" || subtask.status === "validation_pending" || subtask.status === "failed" || subtask.status === "blocked" || subtask.status === "blocked_conflict");
}

function shouldCreateNestedSubtasks(branch: RecursiveBranchExecutionRecord) {
  if (branch.nestedDepth && branch.nestedDepth >= 1) {
    branch.nestedBlockedReason = "max_nested_depth_reached";
    return false;
  }
  if (branch.nestedSubtasks?.length) return false;
  if (!branch.active || branch.status !== "running") return false;
  if (!branch.executionContext.fileScopes.length) return false;
  if (branch.conflictReason || branch.schedulerDecision.blockedReason === "unsafe_parallel_write_scope") return false;
  const scopeText = [
    branch.title,
    branch.executionContext.branchObjective,
    ...branch.executionContext.semanticScopes,
    ...branch.executionContext.fileScopes,
    branch.plannedPatch?.targetFile,
    ...(branch.plannedNestedPatches ?? []).map((patch) => patch.targetFile)
  ].filter(Boolean).join(" ");
  return Boolean(branch.plannedNestedPatches?.length)
    || /nested|subtask|sub-orchestrator|complex|large/i.test(scopeText);
}

function buildNestedSubtasks(branch: RecursiveBranchExecutionRecord, now: string): RecursiveNestedSubtaskRecord[] {
  const nestedPatches = branch.plannedNestedPatches?.length
    ? branch.plannedNestedPatches
    : branch.plannedPatch
      ? [{ ...branch.plannedPatch, objective: `Implement nested patch for ${branch.title}` }]
      : [];
  const seenTargets = new Set<string>();
  const writeSubtasks = nestedPatches.map((patch, index) => {
    const duplicate = seenTargets.has(patch.targetFile);
    seenTargets.add(patch.targetFile);
    return {
      subtaskId: `${branch.branchId}_subtask_${index + 1}`,
      sessionId: branch.sessionId,
      parentBranchId: branch.branchId,
      depth: 1 as const,
      objective: patch.objective ?? `Nested implementation slice ${index + 1} for ${branch.title}`,
      fileScopes: uniqueRuntimeStrings([patch.targetFile]),
      dependencies: index === 0 ? [] : [`${branch.branchId}_subtask_${index}`],
      expectedOutput: "Patch proposal for nested subtask work.",
      reviewerRequirement: "Review nested subtask scope and patch truth before apply.",
      validatorRequirement: branch.validationPlan.join("; ") || "Record validation truth for nested subtask.",
      status: duplicate ? "blocked_conflict" as const : index === 0 ? "ready" as const : "waiting_on_dependency" as const,
      required: true,
      writeSubtask: true,
      plannedPatch: {
        targetFile: patch.targetFile,
        replacementText: patch.replacementText
      },
      patchApplied: false,
      validationStatus: duplicate ? "not_run_blocked_by_policy" as const : "unverified" as const,
      blockedReason: duplicate ? `unsafe_parallel_write_scope: duplicate nested write target ${patch.targetFile}.` : undefined,
      active: false,
      createdAt: now,
      updatedAt: now
    };
  });
  const reviewSubtask: RecursiveNestedSubtaskRecord = {
    subtaskId: `${branch.branchId}_subtask_review`,
    sessionId: branch.sessionId,
    parentBranchId: branch.branchId,
    depth: 1,
    objective: `Review and validate nested outputs for ${branch.title}`,
    fileScopes: branch.executionContext.fileScopes,
    dependencies: writeSubtasks.map((subtask) => subtask.subtaskId),
    expectedOutput: "Nested subtask review and validation rollup.",
    reviewerRequirement: "Confirm nested patch/apply truth and scope boundaries.",
    validatorRequirement: branch.validationPlan.join("; ") || "Record validation truth for parent branch.",
    status: writeSubtasks.length ? "waiting_on_dependency" : "ready",
    required: true,
    writeSubtask: false,
    patchApplied: false,
    validationStatus: "unverified",
    active: false,
    createdAt: now,
    updatedAt: now
  };
  return [...writeSubtasks, reviewSubtask];
}

function advanceNestedSubtasks(branch: RecursiveBranchExecutionRecord, now: string) {
  const subtasks = branch.nestedSubtasks;
  if (!subtasks?.length) return undefined;
  const activeWrite = subtasks.some((subtask) => isActiveNestedWriteSubtask(subtask));
  for (const subtask of subtasks) {
    if (subtask.status !== "planned" && subtask.status !== "waiting_on_dependency" && subtask.status !== "ready") continue;
    const failedDependency = subtask.dependencies
      .map((dependencyId) => subtasks.find((candidate) => candidate.subtaskId === dependencyId))
      .find((dependency) => dependency && (dependency.status === "failed" || dependency.status === "blocked" || dependency.status === "blocked_conflict"));
    if (failedDependency) {
      subtask.status = "blocked";
      subtask.validationStatus = "not_run_blocked_by_policy";
      subtask.blockedReason = `Dependency ${failedDependency.subtaskId} failed or blocked.`;
      subtask.updatedAt = now;
      continue;
    }
    const waiting = subtask.dependencies.filter((dependencyId) => {
      const dependency = subtasks.find((candidate) => candidate.subtaskId === dependencyId);
      return !dependency || !(dependency.status === "completed" || dependency.patchApplied);
    });
    if (waiting.length) {
      subtask.status = "waiting_on_dependency";
      subtask.updatedAt = now;
      continue;
    }
    if (!subtask.writeSubtask) {
      subtask.status = "completed";
      subtask.validationStatus = subtask.validationStatus === "verified_passed" ? "verified_passed" : "unverified";
      subtask.updatedAt = now;
      continue;
    }
    if (activeWrite) continue;
    subtask.status = "running";
    subtask.active = true;
    subtask.updatedAt = now;
    return subtask.subtaskId;
  }
  branch.validationStatus = nestedBranchValidationStatus(branch);
  return undefined;
}

function isSchedulableBranchStatus(status: RecursiveBranchExecutionRecord["status"]) {
  return status === "planned" || status === "waiting_on_dependency" || status === "ready";
}

function isActiveWriteBranch(branch: RecursiveBranchExecutionRecord) {
  return branch.active
    && branch.schedulerDecision.writeBranch
    && !branch.patchApplied
    && (branch.status === "running" || branch.status === "patch_proposed" || branch.status === "reviewing" || branch.status === "validation_pending");
}

function isActiveNestedWriteSubtask(subtask: RecursiveNestedSubtaskRecord) {
  return subtask.active
    && subtask.writeSubtask
    && !subtask.patchApplied
    && (subtask.status === "running" || subtask.status === "patch_proposed" || subtask.status === "reviewing" || subtask.status === "validation_pending");
}

function isDependencySatisfiedBranch(branch: RecursiveBranchExecutionRecord) {
  return branch.status === "completed" || branch.patchApplied && branch.status !== "failed";
}

function isFailedDependencyBranch(branch: RecursiveBranchExecutionRecord) {
  return branch.status === "failed"
    || branch.status === "blocked"
    || branch.status === "blocked_conflict"
    || branch.status === "blocked_failed_dependency"
    || branch.status === "skipped";
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
