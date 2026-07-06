import type { DelegationDecision } from "@hivo/protocol";
import type { OrchestratedPlanningResult } from "./OrchestratedPlanningService.js";
import { OrchestratedSessionRecorder } from "./OrchestratedSessionRecorder.js";
import { SessionManager } from "./SessionManager.js";

export type OrchestratedPlanningRecordInput = {
  sessionId: string;
  planning: OrchestratedPlanningResult;
  delegationDecision?: DelegationDecision;
};

export type OrchestratedPlanModeStopInput = {
  sessionId: string;
  planning: OrchestratedPlanningResult;
  orchestrationMessage: string;
};

export class OrchestratedPlanningRecorder {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly recorder = new OrchestratedSessionRecorder(sessionManager)
  ) {}

  async start(sessionId: string) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "PLAN";
    });
    await this.recorder.progress(sessionId, {
      stage: "planning",
      status: "running",
      agentName: "Product Orchestrator",
      role: "Product",
      taskTitle: "Understand the request",
      summary: "Turning your prompt into concrete goals and success criteria.",
      targetFiles: []
    });
    await this.recorder.emit(sessionId, "orchestration.started", "Multi-agent orchestration started.");
  }

  async record(input: OrchestratedPlanningRecordInput) {
    const { sessionId, planning } = input;
    const { projectMap, productBrief, businessBrief, engineering } = planning;

    await this.recorder.recordAgent(sessionId, "Product Orchestrator", "Product Orchestrator", "Create product brief");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.productBrief = productBrief;
      draft.orchestration!.projectMap = projectMap;
    });
    await this.recorder.progress(sessionId, {
      stage: "planning",
      status: "completed",
      agentName: "Product Orchestrator",
      role: "Product",
      taskTitle: "Product brief",
      summary: `Goal: ${productBrief.goal}`,
      targetFiles: []
    });
    await this.recorder.emit(sessionId, "product_brief.created", "Product brief created.", "Product Orchestrator");

    await this.recorder.progress(sessionId, {
      stage: "planning",
      status: "running",
      agentName: "Business Orchestrator",
      role: "Business",
      taskTitle: "Define MVP and acceptance criteria",
      summary: "Converting the goal into MVP scope, risks, and acceptance checks.",
      targetFiles: []
    });
    await this.recorder.recordAgent(sessionId, "Business Orchestrator", "Business Orchestrator", "Create business brief");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.businessBrief = businessBrief;
    });
    await this.recorder.progress(sessionId, {
      stage: "planning",
      status: "completed",
      agentName: "Business Orchestrator",
      role: "Business",
      taskTitle: "Business brief",
      summary: `Acceptance criteria prepared: ${businessBrief.acceptanceCriteria.slice(0, 3).join("; ")}`,
      targetFiles: []
    });
    await this.recorder.emit(sessionId, "business_brief.created", "Business brief created.", "Business Orchestrator");

    await this.recorder.progress(sessionId, {
      stage: "assigning",
      status: "running",
      agentName: "Engineering Orchestrator",
      role: "Engineering",
      taskTitle: "Assign the working team",
      summary: "Scanning the project shape and selecting only the workers needed for this task.",
      targetFiles: projectMap.importantFiles.slice(0, 5)
    });
    await this.recorder.recordAgent(sessionId, "Engineering Orchestrator", "Engineering Orchestrator", "Create task graph");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.agentName = "Dynamic Working Team";
      draft.delegationDecision = {
        ...(input.delegationDecision ?? engineering.delegationDecision),
        selectedAgentCount: engineering.delegationDecision.selectedAgentCount,
        selectedAgentRoles: engineering.delegationDecision.selectedAgentRoles,
        agentRoleReasons: engineering.delegationDecision.agentRoleReasons,
        rationale: engineering.delegationDecision.rationale
      };
      draft.orchestration!.technicalPlan = engineering.technicalPlan;
      draft.orchestration!.assignmentPlan = {
        ...engineering.assignmentPlan,
        trustProfile: draft.trustProfile
      };
      draft.orchestration!.taskGraph = engineering.technicalPlan.taskGraph;
      draft.orchestration!.selectedWorkerAgents = engineering.delegationDecision.selectedAgentRoles;
      draft.orchestration!.mandatoryGateAgents = ["Product Orchestrator", "Business Orchestrator", "Engineering Orchestrator", "SecurityAgent", "ReviewerAgent"];
      draft.orchestration!.workOrders = engineering.workOrders;
    });
    await this.recorder.progress(sessionId, {
      stage: "assigning",
      status: "completed",
      agentName: "Engineering Orchestrator",
      role: "Engineering",
      taskTitle: "Working team selected",
      summary: engineering.delegationDecision.rationale,
      targetFiles: engineering.workOrders.flatMap((order) => order.requiredArtifacts).slice(0, 8)
    });
    await this.recorder.emit(sessionId, "technical_plan.created", "Technical plan and task graph created.", "Engineering Orchestrator");
    for (const node of engineering.technicalPlan.taskGraph.nodes) {
      await this.recorder.emit(sessionId, "task.created", node.title, node.assignedAgent, node.id);
    }
    for (const order of engineering.workOrders) {
      await this.recorder.recordQueuedWorkOrder(sessionId, order);
    }
  }

  async stopForPlanConfirmation(input: OrchestratedPlanModeStopInput) {
    await this.sessionManager.addMessage(input.sessionId, {
      role: "system",
      content: formatOrchestratedPlanModeMessage(input.planning, input.orchestrationMessage)
    });
    await this.sessionManager.updateSession(input.sessionId, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "PLAN";
      draft.nextAction = {
        kind: "confirm_plan",
        message: "Plan is ready. Want me to proceed with implementation?"
      };
    });
  }
}

export function formatOrchestratedPlanModeMessage(
  planning: Pick<OrchestratedPlanningResult, "businessBrief" | "engineering">,
  message: string
) {
  const arabic = /[\u0600-\u06FF]/.test(message);
  return [
    arabic
      ? "اشتغلت في Plan mode فقط: رتبت الفريق والخطوات ووقفت قبل أي تعديل."
      : "I stayed in plan mode only: I organized the team and the steps, then stopped before any edits.",
    "",
    planning.engineering.technicalPlan.summary,
    "",
    arabic ? "## توزيع الشغل" : "## Work Breakdown",
    ...planning.engineering.workOrders.map((order, index) => `${index + 1}. ${order.dynamicRole}: ${order.objective}`),
    "",
    arabic ? "## معايير القبول" : "## Acceptance Criteria",
    ...planning.businessBrief.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    arabic ? "## ملاحظات الخطة" : "## Planning Notes",
    `- ${planning.engineering.delegationDecision.rationale}`,
    "",
    arabic
      ? "لو الخطة مناسبة، اختار Implement plan."
      : "If the plan looks right, choose Implement plan."
  ].join("\n");
}
