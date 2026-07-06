import type {
  AgentRuntimeSession,
  RecursiveBranchResultRecord,
  RecursiveFinalReport,
  RecursiveIntegrationSummary,
  RecursiveValidationRecord
} from "@hivo/protocol";
import { SessionManager } from "./SessionManager.js";

export type RecursiveFanInReportServices = {
  buildBranchResults: (session: AgentRuntimeSession) => RecursiveBranchResultRecord[];
  buildBranchValidationRecords: (
    session: AgentRuntimeSession,
    branchResults: RecursiveBranchResultRecord[]
  ) => RecursiveValidationRecord[];
  buildIntegrationSummary: (
    session: AgentRuntimeSession,
    branchResults: RecursiveBranchResultRecord[],
    branchValidations: RecursiveValidationRecord[]
  ) => RecursiveIntegrationSummary;
  buildFinalReport: (
    session: AgentRuntimeSession,
    branchResults: RecursiveBranchResultRecord[],
    integrationSummary: RecursiveIntegrationSummary,
    branchValidations: RecursiveValidationRecord[]
  ) => RecursiveFinalReport;
  prepareRepairLoop: (
    sessionId: string,
    finalReport: RecursiveFinalReport
  ) => Promise<RecursiveFinalReport>;
};

export type RecursiveFanInReportRefresh = {
  refreshed: boolean;
  branchResultCount: number;
  finalStatus?: RecursiveFinalReport["finalStatus"];
};

export class RecursiveFanInReportService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RecursiveFanInReportServices
  ) {}

  async refresh(sessionId: string): Promise<RecursiveFanInReportRefresh> {
    const session = this.requireSession(sessionId);
    const factory = session.recursiveFactory;
    if (!factory?.branchExecutions?.length) return { refreshed: false, branchResultCount: 0 };
    const branchResults = this.services.buildBranchResults(session);
    if (!branchResults.length) return { refreshed: false, branchResultCount: 0 };
    const branchValidations = this.services.buildBranchValidationRecords(session, branchResults);
    const integrationSummary = this.services.buildIntegrationSummary(session, branchResults, branchValidations);
    const initialFinalReport = this.services.buildFinalReport(session, branchResults, integrationSummary, branchValidations);
    const finalReport = await this.services.prepareRepairLoop(sessionId, initialFinalReport);

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const draftFactory = draft.recursiveFactory;
      if (!draftFactory) return;
      draftFactory.branchResults = branchResults;
      draftFactory.integrationSummary = integrationSummary;
      draftFactory.validationHierarchy = finalReport.validationHierarchy;
      draftFactory.finalReport = finalReport;
      draftFactory.repair = finalReport.repair;
      draftFactory.updatedAt = new Date().toISOString();
      upsertRuntimeArtifact(draft, {
        id: integrationSummary.id,
        sessionId,
        type: "summary",
        title: "Recursive Branch Fan-In",
        summary: integrationSummary.validation.summary,
        payload: { integrationSummary },
        createdAt: integrationSummary.createdAt
      });
      for (const branchResult of branchResults) {
        upsertRuntimeArtifact(draft, {
          id: branchResult.id,
          sessionId,
          type: "summary",
          title: `Branch Result: ${branchResult.branchId}`,
          summary: branchResult.evidenceSummary.join(" "),
          payload: { branchResult },
          createdAt: branchResult.createdAt
        });
      }
      upsertRuntimeArtifact(draft, {
        id: finalReport.id,
        sessionId,
        type: "summary",
        title: "Final Recursive Execution Report",
        summary: `${finalReport.finalStatus}: ${finalReport.recommendedNextStep}`,
        payload: { finalReport },
        createdAt: finalReport.createdAt
      });
      if (finalReport.repair) {
        upsertRuntimeArtifact(draft, {
          id: finalReport.repair.diagnosis.id,
          sessionId,
          type: "summary",
          title: "validation_failure_diagnosis",
          summary: finalReport.repair.diagnosis.summary,
          payload: { validationFailureDiagnosis: finalReport.repair.diagnosis, repair: finalReport.repair },
          createdAt: finalReport.repair.diagnosis.createdAt
        });
      }
      applyFinalReportLifecycle(draft, finalReport);
    });

    const after = this.requireSession(sessionId);
    for (const branchResult of after.recursiveFactory?.branchResults ?? []) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.branch_result.recorded", sessionId, branchResult });
    }
    if (after.recursiveFactory?.integrationSummary) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.recursive_fan_in.updated", sessionId, integrationSummary: after.recursiveFactory.integrationSummary });
    }
    if (after.recursiveFactory?.finalReport) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.recursive_final_report.created", sessionId, finalReport: after.recursiveFactory.finalReport });
    }
    return {
      refreshed: true,
      branchResultCount: branchResults.length,
      finalStatus: finalReport.finalStatus
    };
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function applyFinalReportLifecycle(session: AgentRuntimeSession, finalReport: RecursiveFinalReport) {
  if (finalReport.finalStatus === "passed") {
    session.status = "completed";
    session.lifecycleStage = "DONE";
    session.nextAction = undefined;
  } else if (finalReport.repair?.repairPatchId && (finalReport.repair.status === "patch_proposed" || finalReport.repair.status === "awaiting_rust_apply")) {
    session.status = "needs_approval";
    session.lifecycleStage = "APPROVAL";
    session.nextAction = {
      kind: "approve_patch",
      patchId: finalReport.repair.repairPatchId,
      message: "Recursive validation failed. Review and approve the proposed repair patch before Rust apply."
    };
  } else if (finalReport.repair?.status === "revalidation_requested") {
    session.status = "needs_approval";
    session.lifecycleStage = "POST_VERIFY";
    session.nextAction = {
      kind: "approve_commands",
      message: "Recursive repair patch was applied. Run the queued revalidation command through Rust."
    };
  } else if (finalReport.finalStatus === "failed") {
    session.status = "failed";
    session.lifecycleStage = "FAILED";
    session.nextAction = undefined;
  } else {
    session.status = "needs_approval";
    session.lifecycleStage = "POST_VERIFY";
    session.nextAction = finalReport.validationHierarchy.some((entry) => entry.truthStatus === "not_run_needs_approval")
      ? { kind: "approve_commands", message: "Final recursive validation is unverified. Approve and run the pending validation commands through Rust." }
      : session.nextAction;
  }
}

function upsertRuntimeArtifact(session: AgentRuntimeSession, artifact: AgentRuntimeSession["artifacts"][number]) {
  const index = session.artifacts.findIndex((candidate) => candidate.id === artifact.id);
  if (index >= 0) {
    session.artifacts[index] = {
      ...session.artifacts[index],
      ...artifact,
      createdAt: session.artifacts[index]!.createdAt
    };
    return;
  }
  session.artifacts.push(artifact);
}
