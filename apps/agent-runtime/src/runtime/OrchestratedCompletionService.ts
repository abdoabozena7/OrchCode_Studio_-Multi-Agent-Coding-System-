import type {
  AgentRuntimeSession,
  PreviewRecommendation,
  QualityGateResult,
  ReviewResult,
  RunSummary,
  TaskGraph,
  WorkerOutput
} from "@hivo/protocol";
import type {
  CanonicalOrchestrationStatus,
  CanonicalTaskExecutionResult
} from "../orchestration/CanonicalOrchestrationGraph.js";
import {
  OrchestratedApprovalBoundaryService,
  type OrchestratedApprovalBoundaryInput
} from "./OrchestratedApprovalBoundaryService.js";
import {
  OrchestratedFinalReportService,
  type OrchestratedFinalReportInput
} from "./OrchestratedFinalReportService.js";
import {
  OrchestratedReviewService,
  type OrchestratedReviewInput,
  type OrchestratedReviewOutcome
} from "./OrchestratedReviewService.js";
import { OrchestratedSessionRecorder } from "./OrchestratedSessionRecorder.js";
import { SessionManager } from "./SessionManager.js";

export type OrchestratedCompletionInput = {
  sessionId: string;
  session: AgentRuntimeSession;
  prompt: string;
  taskGraph: TaskGraph;
  taskExecution: CanonicalTaskExecutionResult;
  canonicalGraphStatus: CanonicalOrchestrationStatus;
  canonicalBlockingReasons: string[];
  outputs: WorkerOutput[];
  lockedFiles: Record<string, string>;
  previewRecommendation?: PreviewRecommendation;
};

export type OrchestratedCompletionResult = {
  reviewOutcome: OrchestratedReviewOutcome;
  runSummary: RunSummary;
  gatesPassed: boolean;
};

type ReviewDependency = Pick<OrchestratedReviewService, "review">;
type FinalReportDependency = Pick<OrchestratedFinalReportService, "build">;
type ApprovalBoundaryDependency = Pick<OrchestratedApprovalBoundaryService, "record">;

type OrchestratedCompletionDependencies = {
  reviewService?: ReviewDependency;
  finalReportService?: FinalReportDependency;
  approvalBoundaryService?: ApprovalBoundaryDependency;
};

export class OrchestratedCompletionService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly recorder = new OrchestratedSessionRecorder(sessionManager),
    private readonly dependencies: OrchestratedCompletionDependencies = {}
  ) {}

  async complete(input: OrchestratedCompletionInput): Promise<OrchestratedCompletionResult> {
    const reviewService = this.dependencies.reviewService ?? new OrchestratedReviewService();
    const finalReportService = this.dependencies.finalReportService ?? new OrchestratedFinalReportService();
    const approvalBoundaryService = this.dependencies.approvalBoundaryService ?? new OrchestratedApprovalBoundaryService(this.sessionManager);
    const targetFiles = input.session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path));

    await this.recorder.progress(input.sessionId, {
      stage: "reviewing",
      status: "running",
      agentName: "SecurityAgent",
      role: "Security",
      taskTitle: "Review generated changes and commands",
      summary: "Checking for dangerous commands, secret exposure, and unsafe patch behavior.",
      targetFiles
    });
    const reviewOutcome = await reviewService.review({
      sessionId: input.sessionId,
      prompt: input.prompt,
      patches: input.session.patchProposals,
      commands: input.session.commandRequests,
      outputs: input.outputs,
      bankruptcyErrors: input.taskExecution.bankruptcyErrors,
      canonicalBlockingReasons: input.canonicalBlockingReasons
    } satisfies OrchestratedReviewInput);

    const { securityReview, reviewerSummary, qualityGates, gatesPassed } = reviewOutcome;
    await this.recordReviewProgress(input.sessionId, targetFiles, securityReview, reviewerSummary, qualityGates, gatesPassed);
    await approvalBoundaryService.record({
      sessionId: input.sessionId,
      taskGraph: input.taskGraph,
      workerOutputs: input.outputs,
      securityReview,
      reviewerSummary,
      qualityGates,
      gatesPassed,
      lockedFiles: input.lockedFiles,
      canonicalGraphStatus: input.canonicalGraphStatus,
      previewRecommendation: input.previewRecommendation
    } satisfies OrchestratedApprovalBoundaryInput);

    const appliedTitles: string[] = [];
    if (gatesPassed) {
      await this.recorder.emit(input.sessionId, "validation.completed", "Validation gates passed; waiting for Rust-mediated approval/apply.");
      await this.recorder.emit(input.sessionId, "verification.pending", "Post-verify is pending until Rust applies approved changes.");
    } else {
      await this.recorder.progress(input.sessionId, {
        stage: "blocked",
        status: "blocked",
        agentName: "ReviewerAgent",
        role: "Reviewer",
        taskTitle: "Run blocked",
        summary: "I stopped before applying files because one or more quality gates failed.",
        targetFiles
      });
    }

    const latestSession = this.sessionManager.getSession(input.sessionId)!;
    const finalReport = finalReportService.build({
      session: latestSession,
      qualityGates,
      gatesPassed,
      appliedTitles
    } satisfies OrchestratedFinalReportInput);
    const { runSummary } = finalReport;
    await this.sessionManager.setRunSummary(input.sessionId, runSummary);
    await this.recorder.progress(input.sessionId, {
      stage: gatesPassed ? "completed" : "blocked",
      status: gatesPassed ? "completed" : "blocked",
      agentName: latestSession.agentName,
      role: "Summary",
      taskTitle: "Final summary",
      summary: runSummary.summary,
      targetFiles: runSummary.filesChanged.map((file) => file.path),
      patchStats: runSummary.filesChanged
    });
    await this.sessionManager.addMessage(input.sessionId, {
      role: "system",
      content: finalReport.message
    });

    await this.recorder.emit(input.sessionId, "security.reviewed", securityReview.summary, "SecurityAgent");
    await this.recorder.emit(input.sessionId, "agent.completed", reviewerSummary.summary, "ReviewerAgent");
    await this.recorder.emit(
      input.sessionId,
      gatesPassed ? "orchestration.completed" : "orchestration.failed",
      gatesPassed ? "Multi-agent orchestration completed." : "Quality gates blocked the generated output."
    );

    return {
      reviewOutcome,
      runSummary,
      gatesPassed
    };
  }

  private async recordReviewProgress(
    sessionId: string,
    targetFiles: string[],
    securityReview: ReviewResult,
    reviewerSummary: ReviewResult,
    qualityGates: QualityGateResult[],
    gatesPassed: boolean
  ) {
    await this.recorder.progress(sessionId, {
      stage: "reviewing",
      status: securityReview.status === "passed" ? "completed" : "blocked",
      agentName: "SecurityAgent",
      role: "Security",
      taskTitle: "Security review",
      summary: securityReview.summary,
      targetFiles
    });
    await this.recorder.progress(sessionId, {
      stage: "reviewing",
      status: "running",
      agentName: "ReviewerAgent",
      role: "Reviewer",
      taskTitle: "Review implementation quality",
      summary: "Adversarial review of worker outputs against acceptance criteria.",
      targetFiles
    });
    await this.recorder.progress(sessionId, {
      stage: "reviewing",
      status: gatesPassed ? "completed" : "blocked",
      agentName: "ReviewerAgent",
      role: "Reviewer",
      taskTitle: "Quality gates",
      summary: gatesPassed
        ? "Reviewer, security, and test gates passed."
        : `Quality gates blocked the run: ${qualityGates.flatMap((gate) => gate.blockingReasons).join("; ")}`,
      targetFiles
    });
  }
}
