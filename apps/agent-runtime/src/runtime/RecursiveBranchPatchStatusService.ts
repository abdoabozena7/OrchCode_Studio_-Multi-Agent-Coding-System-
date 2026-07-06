import type {
  AgentRuntimeSession,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRollup,
  ValidationTruthStatus
} from "@hivo/protocol";
import { SessionManager } from "./SessionManager.js";

export type RecursiveBranchValidationProjection = {
  truthStatus: ValidationTruthStatus;
  summary: string;
};

export type RecursiveBranchPatchStatusServices = {
  buildNestedRollup: (
    branch: RecursiveBranchExecutionRecord,
    patches: PatchProposal[]
  ) => RecursiveNestedSubtaskRollup;
  nestedBranchValidationStatus: (branch: RecursiveBranchExecutionRecord) => ValidationTruthStatus;
  requiredNestedSubtasksTerminal: (branch: RecursiveBranchExecutionRecord) => boolean;
  evaluateBranchValidation: (
    session: AgentRuntimeSession,
    branchId: string
  ) => RecursiveBranchValidationProjection;
  prepareBranchValidation: (
    sessionId: string,
    branchId: string
  ) => Promise<RecursiveBranchValidationProjection>;
};

export type RecursiveBranchPatchStatusProjection = {
  projected: boolean;
  branchId?: string;
  eventType?: RecursiveBranchExecutionEventType;
};

type RecursiveBranchExecutionEvent = Extract<
  Parameters<SessionManager["publishFactoryEvent"]>[0],
  { branchExecution: RecursiveBranchExecutionRecord }
>;

type RecursiveBranchExecutionEventType = RecursiveBranchExecutionEvent["type"];

export class RecursiveBranchPatchStatusService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RecursiveBranchPatchStatusServices
  ) {}

  async projectPatchStatus(sessionId: string, patchId: string): Promise<RecursiveBranchPatchStatusProjection> {
    const session = this.requireSession(sessionId);
    const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
    if (!patch) return { projected: false };

    const directBranch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === patchId);
    if (directBranch) {
      return this.projectBranchPatchStatus(sessionId, directBranch.branchId, patch);
    }

    const nestedOwner = session.recursiveFactory?.branchExecutions
      ?.map((candidate) => ({
        branch: candidate,
        subtask: candidate.nestedSubtasks?.find((nested) => nested.proposedPatchId === patchId)
      }))
      .find((candidate) => candidate.subtask);
    if (!nestedOwner?.subtask) return { projected: false };

    return this.projectNestedSubtaskPatchStatus(sessionId, nestedOwner.branch.branchId, nestedOwner.subtask.subtaskId, patch);
  }

  private async projectBranchPatchStatus(
    sessionId: string,
    branchId: string,
    patch: PatchProposal
  ): Promise<RecursiveBranchPatchStatusProjection> {
    const recursiveValidation = await this.validationForPatch(sessionId, branchId, patch);
    let eventType: RecursiveBranchExecutionEventType = "runtime.branch_execution.reviewing";

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const factory = draft.recursiveFactory;
      const current = factory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === patch.id);
      if (!factory || !current) return;
      const now = new Date().toISOString();
      current.updatedAt = now;

      if (patch.status === "approved") {
        current.status = "reviewing";
        current.reviewStatus = "approved";
        current.blockedReason = undefined;
        eventType = "runtime.branch_execution.reviewing";
      } else if (patch.status === "apply_started") {
        current.status = "validation_pending";
        current.reviewStatus = "approved";
        current.validationStatus = "unverified";
        current.blockedReason = "Rust apply is in progress; no terminal apply or validation result is available yet.";
        eventType = "runtime.branch_execution.validation_pending";
      } else if (patch.status === "rejected") {
        current.status = "blocked";
        current.reviewStatus = "needs_changes";
        current.active = false;
        current.blockedReason = "Patch was rejected during required branch review.";
        eventType = "runtime.branch_execution.blocked";
      } else if (patch.status === "applied") {
        current.patchApplied = true;
        current.reviewStatus = "approved";
        current.validationStatus = recursiveValidation.truthStatus;
        if (current.validationStatus === "verified_passed") {
          current.status = "completed";
          current.active = false;
          current.completedAt = now;
          current.blockedReason = undefined;
          factory.phase = "branch_execution_completed";
          draft.status = "completed";
          draft.lifecycleStage = "DONE";
          eventType = "runtime.branch_execution.completed";
        } else if (current.validationStatus === "verified_failed") {
          current.status = "failed";
          current.active = false;
          current.completedAt = now;
          current.blockedReason = recursiveValidation.summary;
          factory.phase = "branch_execution_blocked";
          draft.status = "failed";
          draft.lifecycleStage = "FAILED";
          eventType = "runtime.branch_execution.failed";
        } else {
          current.status = "validation_pending";
          current.active = false;
          current.blockedReason = `Validation is ${current.validationStatus}: ${recursiveValidation.summary}`;
          factory.phase = "branch_execution_running";
          draft.status = "needs_approval";
          draft.lifecycleStage = "POST_VERIFY";
          draft.nextAction = draft.commandRequests.some((request) => request.status === "requested" || request.status === "approved")
            ? { kind: "approve_commands", message: "Branch patch applied. Run or report the requested validation commands through Rust." }
            : undefined;
          eventType = "runtime.branch_execution.validation_pending";
        }
      } else if (patch.status === "apply_failed") {
        current.status = "failed";
        current.reviewStatus = "approved";
        current.validationStatus = "not_run_runtime_error";
        current.active = false;
        current.completedAt = now;
        current.blockedReason = "Rust apply authority reported apply_failed.";
        factory.phase = "branch_execution_blocked";
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        eventType = "runtime.branch_execution.failed";
      }

      factory.activeBranchId = current.active ? current.branchId : undefined;
      factory.executionStarted = true;
      factory.updatedAt = now;
      const planned = factory.branchOrchestrators?.find((candidate) => candidate.branchId === current.branchId);
      if (planned) {
        planned.status = current.status;
        planned.updatedAt = now;
      }
    });

    this.publishBranchEvent(sessionId, branchId, eventType);
    return { projected: true, branchId, eventType };
  }

  private async projectNestedSubtaskPatchStatus(
    sessionId: string,
    branchId: string,
    subtaskId: string,
    patch: PatchProposal
  ): Promise<RecursiveBranchPatchStatusProjection> {
    const recursiveValidation = await this.validationForPatch(sessionId, branchId, patch);
    let eventType: RecursiveBranchExecutionEventType = "runtime.branch_execution.reviewing";

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const branch = draft.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
      const subtask = branch?.nestedSubtasks?.find((candidate) => candidate.subtaskId === subtaskId);
      if (!branch || !subtask) return;
      const now = new Date().toISOString();
      subtask.updatedAt = now;
      branch.updatedAt = now;
      branch.active = true;

      if (patch.status === "approved") {
        subtask.status = "reviewing";
        subtask.blockedReason = undefined;
        eventType = "runtime.branch_execution.reviewing";
      } else if (patch.status === "apply_started") {
        subtask.status = "validation_pending";
        subtask.validationStatus = "unverified";
        subtask.blockedReason = "Rust apply is in progress; no terminal apply or validation result is available yet.";
        eventType = "runtime.branch_execution.validation_pending";
      } else if (patch.status === "rejected") {
        subtask.status = "blocked";
        subtask.active = false;
        subtask.blockedReason = "Nested subtask patch was rejected during required review.";
        branch.status = "blocked";
        branch.active = false;
        branch.blockedReason = "Required nested subtask patch was rejected.";
        eventType = "runtime.branch_execution.blocked";
      } else if (patch.status === "applied") {
        subtask.patchApplied = true;
        subtask.validationStatus = recursiveValidation.truthStatus;
        subtask.active = false;
        if (subtask.validationStatus === "verified_passed") {
          subtask.status = "completed";
          subtask.blockedReason = undefined;
        } else if (subtask.validationStatus === "verified_failed") {
          subtask.status = "failed";
          subtask.blockedReason = recursiveValidation.summary;
        } else {
          subtask.status = "validation_pending";
          subtask.blockedReason = `Validation is ${subtask.validationStatus}: ${recursiveValidation.summary}`;
        }
        branch.patchApplied = branch.nestedSubtasks?.some((candidate) => candidate.patchApplied) ?? branch.patchApplied;
        branch.validationStatus = this.services.nestedBranchValidationStatus(branch);
        branch.nestedRollup = this.services.buildNestedRollup(branch, draft.patchProposals);
        const requiredDone = this.services.requiredNestedSubtasksTerminal(branch);
        branch.status = requiredDone && branch.validationStatus === "verified_passed"
          ? "completed"
          : branch.validationStatus === "verified_failed"
            ? "failed"
            : "validation_pending";
        branch.active = false;
        branch.blockedReason = branch.status === "validation_pending"
          ? "Parent branch is waiting on nested subtask validation evidence."
          : branch.nestedRollup?.limitations.join("; ");
        eventType = branch.status === "failed"
          ? "runtime.branch_execution.failed"
          : branch.status === "completed"
            ? "runtime.branch_execution.completed"
            : "runtime.branch_execution.validation_pending";
      } else if (patch.status === "apply_failed") {
        subtask.status = "failed";
        subtask.validationStatus = "not_run_runtime_error";
        subtask.active = false;
        subtask.blockedReason = "Rust apply authority reported apply_failed for nested subtask.";
        branch.status = "failed";
        branch.validationStatus = "not_run_runtime_error";
        branch.active = false;
        branch.blockedReason = subtask.blockedReason;
        branch.nestedRollup = this.services.buildNestedRollup(branch, draft.patchProposals);
        eventType = "runtime.branch_execution.failed";
      }

      branch.nestedRollup = this.services.buildNestedRollup(branch, draft.patchProposals);
      draft.recursiveFactory!.activeBranchId = branch.active ? branch.branchId : undefined;
      draft.recursiveFactory!.executionStarted = true;
      draft.recursiveFactory!.updatedAt = now;
      const planned = draft.recursiveFactory!.branchOrchestrators?.find((candidate) => candidate.branchId === branch.branchId);
      if (planned) {
        planned.status = branch.status;
        planned.updatedAt = now;
      }
      draft.status = branch.status === "failed" ? "failed" : "needs_approval";
      draft.lifecycleStage = branch.status === "failed" ? "FAILED" : "POST_VERIFY";
      if (branch.status !== "failed") {
        draft.nextAction = draft.commandRequests.some((request) => request.status === "requested" || request.status === "approved")
          ? { kind: "approve_commands", message: "Nested subtask patch applied. Run or report validation commands through Rust." }
          : undefined;
      }
    });

    this.publishBranchEvent(sessionId, branchId, eventType);
    return { projected: true, branchId, eventType };
  }

  private async validationForPatch(
    sessionId: string,
    branchId: string,
    patch: PatchProposal
  ): Promise<RecursiveBranchValidationProjection> {
    if (patch.status === "applied") {
      return this.services.prepareBranchValidation(sessionId, branchId);
    }
    return this.services.evaluateBranchValidation(this.requireSession(sessionId), branchId);
  }

  private publishBranchEvent(
    sessionId: string,
    branchId: string,
    eventType: RecursiveBranchExecutionEventType
  ) {
    const updated = this.requireSession(sessionId).recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branchId);
    if (updated) this.sessionManager.publishFactoryEvent({ type: eventType, sessionId, branchExecution: updated });
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}
