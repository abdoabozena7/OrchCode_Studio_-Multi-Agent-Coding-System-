import type {
  PreviewRecommendation,
  QualityGateResult,
  ReviewResult,
  TaskGraph,
  WorkerOutput
} from "@hivo/protocol";
import type { CanonicalOrchestrationStatus } from "../orchestration/CanonicalOrchestrationGraph.js";
import { SessionManager } from "./SessionManager.js";

export type OrchestratedApprovalBoundaryInput = {
  sessionId: string;
  taskGraph: TaskGraph;
  workerOutputs: WorkerOutput[];
  securityReview: ReviewResult;
  reviewerSummary: ReviewResult;
  qualityGates: QualityGateResult[];
  gatesPassed: boolean;
  lockedFiles: Record<string, string>;
  canonicalGraphStatus: CanonicalOrchestrationStatus;
  previewRecommendation?: PreviewRecommendation;
};

export class OrchestratedApprovalBoundaryService {
  constructor(private readonly sessionManager: SessionManager) {}

  async record(input: OrchestratedApprovalBoundaryInput) {
    await this.sessionManager.updateSession(input.sessionId, (draft) => {
      draft.status = input.gatesPassed ? "needs_approval" : "failed";
      draft.lifecycleStage = input.gatesPassed ? "APPROVAL" : "BLOCKED";
      draft.tasks = input.taskGraph.nodes.map((node) => ({
        id: node.id,
        sessionId: input.sessionId,
        title: node.title,
        status: node.status === "completed" ? "done" : node.status === "running" ? "in_progress" : node.status === "failed" ? "blocked" : "todo",
        agentRole: node.assignedAgent,
        createdAt: new Date().toISOString()
      }));
      draft.orchestration!.taskGraph = input.taskGraph;
      draft.orchestration!.workerOutputs = input.workerOutputs;
      draft.orchestration!.securityReviews.push(input.securityReview);
      draft.orchestration!.reviewerSummaries.push(input.reviewerSummary);
      draft.orchestration!.qualityGateResults.push(...input.qualityGates);
      if (!input.gatesPassed) {
        draft.orchestration!.retryCount += 1;
      }
      draft.orchestration!.lockedFiles = input.lockedFiles;
      draft.previewRecommendation = input.previewRecommendation;
      draft.reasoningSummaries.push(
        `Canonical orchestration graph finished with status ${input.canonicalGraphStatus}.`,
        input.gatesPassed
          ? "Orchestrated run completed and stopped for Rust-mediated patch approval."
          : "Quality gates blocked the generated output before any files were applied."
      );
    });
  }
}
