import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  PatchProposal
} from "@hivo/protocol";
import type { RecursiveBranchPatchStatusService } from "./RecursiveBranchPatchStatusService.js";
import type { RecursiveFanInReportService } from "./RecursiveFanInReportService.js";
import type { RecursiveRepairStateService } from "./RecursiveRepairStateService.js";
import type { RuntimeRecursiveBranchExecutionService } from "./RuntimeRecursiveBranchExecutionService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeRecursiveBranchProgressServices = {
  repairState: RecursiveRepairStateService;
  patchStatus: RecursiveBranchPatchStatusService;
  fanInReport: RecursiveFanInReportService;
  branchExecution: RuntimeRecursiveBranchExecutionService;
};

export class RuntimeRecursiveBranchProgressService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RuntimeRecursiveBranchProgressServices
  ) {}

  async projectPatchStatus(sessionId: string, patchId: string) {
    const projection = await this.services.patchStatus.projectPatchStatus(sessionId, patchId);
    if (!projection.projected) return projection;
    await this.services.branchExecution.advance(sessionId);
    await this.refreshFanIn(sessionId);
    return projection;
  }

  async updateRepairFromPatch(sessionId: string, patchId: string, status: PatchProposal["status"]) {
    return this.services.repairState.updateFromPatch(sessionId, patchId, status);
  }

  async updateRepairFromCommandResult(sessionId: string, record: CommandExecutionRecord) {
    const update = await this.services.repairState.updateFromCommandResult(sessionId, record);
    if (update.updated) await this.refreshFanIn(sessionId);
    return update;
  }

  async projectPendingValidationPatches(sessionId: string) {
    const session = this.requireSession(sessionId);
    const pendingPatchIds = uniqueRuntimeStrings((session.recursiveFactory?.branchExecutions ?? []).flatMap((branch) => [
      branch.patchApplied && branch.status === "validation_pending" && branch.proposedPatchId ? branch.proposedPatchId : undefined,
      ...(branch.nestedSubtasks ?? []).map((subtask) =>
        subtask.patchApplied && subtask.status === "validation_pending" && subtask.proposedPatchId ? subtask.proposedPatchId : undefined
      )
    ].filter(Boolean) as string[]));
    if (!pendingPatchIds.length) return;
    for (const patchId of pendingPatchIds) {
      await this.projectPatchStatus(sessionId, patchId);
    }
    await this.refreshFanIn(sessionId);
  }

  async refreshFanIn(sessionId: string) {
    await this.services.fanInReport.refresh(sessionId);
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
