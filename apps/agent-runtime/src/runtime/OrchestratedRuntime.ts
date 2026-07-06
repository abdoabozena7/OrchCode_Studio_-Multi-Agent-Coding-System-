import type {
  IntentContract,
  ProjectMap
} from "@hivo/protocol";
import { SessionManager } from "./SessionManager.js";
import { OrchestratedPlanningService } from "./OrchestratedPlanningService.js";
import { OrchestratedSessionRecorder } from "./OrchestratedSessionRecorder.js";
import { OrchestratedPlanningRecorder } from "./OrchestratedPlanningRecorder.js";
import { OrchestratedQueueExecutionService } from "./OrchestratedQueueExecutionService.js";
import { OrchestratedCompletionService } from "./OrchestratedCompletionService.js";

type OrchestratedRuntimePlanningService = Pick<OrchestratedPlanningService, "plan">;
type OrchestratedRuntimePlanningRecorder = Pick<OrchestratedPlanningRecorder, "start" | "record" | "stopForPlanConfirmation">;
type OrchestratedRuntimeQueueExecutionService = Pick<OrchestratedQueueExecutionService, "run">;
type OrchestratedRuntimeCompletionService = Pick<OrchestratedCompletionService, "complete">;

export type OrchestratedRuntimeDependencies = {
  planningService?: OrchestratedRuntimePlanningService;
  sessionRecorder?: OrchestratedSessionRecorder;
  planningRecorder?: OrchestratedRuntimePlanningRecorder;
  queueExecutionService?: OrchestratedRuntimeQueueExecutionService;
  completionService?: OrchestratedRuntimeCompletionService;
};

export class OrchestratedRuntime {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly dependencies: OrchestratedRuntimeDependencies = {}
  ) {}

  async run(
    sessionId: string,
    message: string,
    options: {
      projectMap?: ProjectMap;
      delegationDecision?: import("@hivo/protocol").DelegationDecision;
      intentContract?: IntentContract;
      thinkFirst?: boolean;
    } = {}
  ) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.orchestration) throw new Error("Orchestrated session not found");
    const recorder = this.dependencies.sessionRecorder ?? new OrchestratedSessionRecorder(this.sessionManager);
    const planningRecorder = this.dependencies.planningRecorder
      ?? new OrchestratedPlanningRecorder(this.sessionManager, recorder);
    const intentContract = options.intentContract ?? session.intentContract;
    if (!intentContract || intentContract.status !== "ready") {
      throw new Error("OrchestratedRuntime requires a ready IntentContract before planning.");
    }
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    const orchestrationMessage = intentContract.precise_rewrite;
    await planningRecorder.start(sessionId);

    const planningService = this.dependencies.planningService ?? new OrchestratedPlanningService();
    const planning = planningService.plan({
      sessionId,
      workspacePath: session.workspacePath,
      intentContract,
      projectMap: options.projectMap
    });
    const { projectMap, engineering } = planning;
    await planningRecorder.record({
      sessionId,
      planning,
      delegationDecision: options.delegationDecision
    });

    if (options.thinkFirst) {
      await planningRecorder.stopForPlanConfirmation({
        sessionId,
        planning,
        orchestrationMessage
      });
      return this.sessionManager.getSession(sessionId)!;
    }

    const queueExecutionService = this.dependencies.queueExecutionService
      ?? new OrchestratedQueueExecutionService(this.sessionManager, recorder);
    const queueExecution = await queueExecutionService.run({
      sessionId,
      session,
      intentContract,
      orchestrationMessage,
      projectMap,
      assignmentPlan: engineering.assignmentPlan,
      workOrders: engineering.workOrders,
      taskGraph: engineering.technicalPlan.taskGraph,
    });
    const { canonicalResult, taskExecution: queueResult, outputs, previewRecommendation, lockedFiles } = queueExecution;

    const completionService = this.dependencies.completionService
      ?? new OrchestratedCompletionService(this.sessionManager, recorder);
    await completionService.complete({
      sessionId,
      prompt: orchestrationMessage,
      session,
      taskGraph: engineering.technicalPlan.taskGraph,
      taskExecution: queueResult,
      canonicalGraphStatus: canonicalResult.graph.status,
      canonicalBlockingReasons: canonicalResult.blockingReasons,
      outputs,
      lockedFiles,
      previewRecommendation
    });
    return this.sessionManager.getSession(sessionId)!;
  }
}
