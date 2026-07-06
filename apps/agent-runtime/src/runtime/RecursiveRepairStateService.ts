import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRollup,
  RecursiveValidationAttempt,
  ValidationTruthStatus
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { buildRecursiveValidationCommandRequest } from "./RecursiveValidation.js";
import { SessionManager } from "./SessionManager.js";

export type RecursiveRepairStateServices = {
  buildNestedRollup: (
    branch: RecursiveBranchExecutionRecord,
    patches: PatchProposal[]
  ) => RecursiveNestedSubtaskRollup;
  summarizeOutput: (output?: string) => string | undefined;
};

export type RecursiveRepairStateUpdate = {
  updated: boolean;
  queuedCommandRequestId?: string;
  revalidated?: boolean;
};

export class RecursiveRepairStateService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RecursiveRepairStateServices
  ) {}

  async updateFromPatch(
    sessionId: string,
    patchId: string,
    status: PatchProposal["status"]
  ): Promise<RecursiveRepairStateUpdate> {
    const session = this.requireSession(sessionId);
    const repair = session.recursiveFactory?.repair;
    if (!repair?.repairPatchId || repair.repairPatchId !== patchId) return { updated: false };
    if (status !== "applied") {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const draftRepair = draft.recursiveFactory?.repair;
        if (!draftRepair || draftRepair.repairPatchId !== patchId) return;
        draftRepair.repairPatchStatus = status;
        draftRepair.status = "awaiting_rust_apply";
        draftRepair.summary = "Recursive repair patch has not been applied successfully through Rust.";
        draftRepair.updatedAt = new Date().toISOString();
        if (draft.recursiveFactory?.finalReport?.repair) draft.recursiveFactory.finalReport.repair = draftRepair;
      });
      return { updated: true };
    }
    return this.queueRepairRevalidation(sessionId, patchId);
  }

  async updateFromCommandResult(
    sessionId: string,
    record: CommandExecutionRecord
  ): Promise<RecursiveRepairStateUpdate> {
    const session = this.requireSession(sessionId);
    const repair = session.recursiveFactory?.repair;
    if (!repair?.revalidationRequestId || repair.revalidationRequestId !== record.requestId) return { updated: false };
    const attempt = this.buildValidationAttemptFromExecution(record, "repair_revalidation", 2);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const draftRepair = draft.recursiveFactory?.repair;
      if (!draftRepair || draftRepair.revalidationRequestId !== record.requestId) return;
      draftRepair.status = "revalidated";
      draftRepair.validationAttempts = upsertValidationAttempt(draftRepair.validationAttempts, attempt);
      draftRepair.finalOutcome = attempt.truthStatus;
      draftRepair.summary = `Repair revalidation completed with ${attempt.truthStatus}.`;
      draftRepair.updatedAt = new Date().toISOString();
      for (const branch of draft.recursiveFactory?.branchExecutions ?? []) {
        const relatedToBranch = draftRepair.diagnosis.branchIds.includes(branch.branchId)
          || (branch.proposedPatchId ? draftRepair.diagnosis.patchIds.includes(branch.proposedPatchId) : false)
          || (branch.nestedSubtasks ?? []).some((subtask) => subtask.proposedPatchId && draftRepair.diagnosis.patchIds.includes(subtask.proposedPatchId));
        if (!relatedToBranch) continue;
        branch.validationStatus = attempt.truthStatus;
        branch.status = attempt.truthStatus === "verified_passed" ? "completed" : attempt.truthStatus === "verified_failed" ? "failed" : "validation_pending";
        branch.blockedReason = attempt.truthStatus === "verified_passed" ? undefined : branch.blockedReason;
        for (const subtask of branch.nestedSubtasks ?? []) {
          if (!subtask.proposedPatchId || !draftRepair.diagnosis.patchIds.includes(subtask.proposedPatchId)) continue;
          subtask.validationStatus = attempt.truthStatus;
          subtask.status = attempt.truthStatus === "verified_passed" ? "completed" : attempt.truthStatus === "verified_failed" ? "failed" : "validation_pending";
        }
        branch.nestedRollup = this.services.buildNestedRollup(branch, draft.patchProposals);
        branch.updatedAt = new Date().toISOString();
      }
      if (draft.recursiveFactory?.finalReport?.repair) draft.recursiveFactory.finalReport.repair = draftRepair;
    });
    return { updated: true, revalidated: true };
  }

  private async queueRepairRevalidation(sessionId: string, patchId: string): Promise<RecursiveRepairStateUpdate> {
    const session = this.requireSession(sessionId);
    const repair = session.recursiveFactory?.repair;
    const strategy = session.recursiveFactory?.finalReport?.validationDiscovery?.chosenStrategy;
    if (!repair || repair.repairPatchId !== patchId || !strategy || strategy.kind !== "command" || !strategy.command) return { updated: false };
    const alreadyQueued = Boolean(repair.revalidationRequestId && session.commandRequests.some((request) => request.id === repair.revalidationRequestId));
    if (!alreadyQueued) {
      const request = buildRecursiveValidationCommandRequest({
        sessionId,
        workspacePath: session.workspacePath,
        strategy
      });
      if (request) {
        request.reason = `Recursive repair revalidation. Rerun the same validation command after Rust applied repair patch ${patchId}. ${strategy.reason}`;
        await this.sessionManager.addCommandRequest(sessionId, request);
        await this.sessionManager.addToolIntent(sessionId, {
          id: `intent_${randomUUID()}`,
          sessionId,
          type: "validation.requested",
          title: request.command,
          summary: request.reason,
          payload: {
            recursiveRepairId: repair.id,
            repairPatchId: patchId,
            commandRequestId: request.id,
            strategy,
            executionAuthority: "rust"
          },
          status: request.status === "blocked" ? "blocked" : "proposed",
          createdAt: new Date().toISOString()
        });
        await this.sessionManager.updateSession(sessionId, (draft) => {
          const draftRepair = draft.recursiveFactory?.repair;
          if (!draftRepair || draftRepair.repairPatchId !== patchId) return;
          draftRepair.repairPatchStatus = "applied";
          draftRepair.status = "revalidation_requested";
          draftRepair.revalidationRequestId = request.id;
          draftRepair.summary = `Repair patch ${patchId} was applied through Rust; same validation command is queued for Rust revalidation.`;
          draftRepair.updatedAt = new Date().toISOString();
          if (draft.recursiveFactory?.finalReport?.repair) draft.recursiveFactory.finalReport.repair = draftRepair;
        });
        return { updated: true, queuedCommandRequestId: request.id };
      }
    }
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const draftRepair = draft.recursiveFactory?.repair;
      if (!draftRepair || draftRepair.repairPatchId !== patchId) return;
      draftRepair.repairPatchStatus = "applied";
      draftRepair.status = "applied";
      draftRepair.summary = "Repair patch was applied through Rust, but no safe revalidation request could be created.";
      draftRepair.updatedAt = new Date().toISOString();
      if (draft.recursiveFactory?.finalReport?.repair) draft.recursiveFactory.finalReport.repair = draftRepair;
    });
    return { updated: true };
  }

  private buildValidationAttemptFromExecution(
    execution: CommandExecutionRecord,
    role: RecursiveValidationAttempt["role"],
    attemptNumber: number
  ): RecursiveValidationAttempt {
    return {
      attemptNumber,
      role,
      command: execution.command,
      cwd: execution.cwd,
      truthStatus: commandExecutionTruthStatus(execution),
      status: execution.status,
      exitCode: execution.exitCode,
      stdoutSummary: this.services.summarizeOutput(execution.stdout),
      stderrSummary: this.services.summarizeOutput(execution.stderr),
      requestId: execution.requestId,
      executionId: execution.id,
      policyResult: execution.provenance?.policyDecision,
      summary: execution.message ?? `Rust TerminalService reported ${execution.status}.`,
      createdAt: execution.createdAt
    };
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export function commandExecutionTruthStatus(execution: CommandExecutionRecord): ValidationTruthStatus {
  const passed = (execution.status === "executed" || execution.status === "completed") && (execution.exitCode === undefined || execution.exitCode === 0);
  const failed = execution.status === "failed"
    || ((execution.status === "executed" || execution.status === "completed") && typeof execution.exitCode === "number" && execution.exitCode !== 0);
  if (failed) return "verified_failed";
  if (execution.status === "blocked") return "not_run_blocked_by_policy";
  if (execution.status === "approval_required") return "not_run_needs_approval";
  if (execution.status === "orphaned" || execution.status === "terminated" || execution.status === "unknown") return "not_run_runtime_error";
  return passed ? "verified_passed" : "unverified";
}

export function upsertValidationAttempt(
  attempts: RecursiveValidationAttempt[],
  attempt: RecursiveValidationAttempt
) {
  const next = attempts.filter((candidate) => candidate.attemptNumber !== attempt.attemptNumber);
  next.push(attempt);
  return next.sort((left, right) => left.attemptNumber - right.attemptNumber);
}
