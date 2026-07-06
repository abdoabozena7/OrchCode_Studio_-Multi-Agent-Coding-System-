import type {
  AgentRuntimeSession,
  ApprovalRecord,
  FactoryApprovalDecisionRequest,
  ProjectMap
} from "@hivo/protocol";
import { accessProfileDefaults } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import {
  buildHierarchicalRecursiveGraph,
  buildProductSpecification,
  buildTechnicalPlan,
  formatProductSpecification,
  formatRecursiveGraph,
  formatTechnicalPlan,
  productSpecClarificationQuestions
} from "./RecursiveFactoryPlanning.js";
import { SessionManager } from "./SessionManager.js";

export type FactoryArtifactType = "product_spec" | "technical_plan" | "recursive_graph" | "branch_orchestrator";

export class RuntimeRecursiveFactoryPlanningService {
  constructor(private readonly sessionManager: SessionManager) {}

  async decideProductSpec(sessionId: string, request: FactoryApprovalDecisionRequest) {
    const current = this.requireSession(sessionId);
    const spec = current.recursiveFactory?.productSpec;
    if (!spec) throw new Error("Product Specification not found");
    const now = new Date().toISOString();
    if (request.decision === "approved") {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const productSpec = draft.recursiveFactory!.productSpec!;
        productSpec.status = "approved";
        productSpec.updatedAt = now;
        draft.orchestration ??= createEmptyOrchestration(draft);
        draft.orchestration.approvalDecisions.push(factoryApproval(sessionId, "product_spec", productSpec.id, request));
      });
      this.sessionManager.publishFactoryEvent({
        type: "runtime.product_spec.approved",
        sessionId,
        productSpec: this.requireSession(sessionId).recursiveFactory!.productSpec!
      });
      return this.proposeTechnicalPlan(sessionId);
    }

    const revised = buildProductSpecification({
      sessionId,
      prompt: spec.userGoal,
      revision: spec.revision + 1,
      feedback: request.feedback ?? request.decision
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.orchestration.approvalDecisions.push(factoryApproval(sessionId, "product_spec", spec.id, request));
      draft.recursiveFactory = { phase: "product_spec_approval", productSpec: revised, executionStarted: false, updatedAt: now };
      draft.status = "needs_approval";
      draft.lifecycleStage = "PLAN";
      draft.nextAction = { kind: "approve_product_spec", artifactId: revised.id, message: "Review the revised Product Specification." };
    });
    await this.addFactoryArtifact(sessionId, "product_spec", `Product Specification revision ${revised.revision}`, revised);
    this.sessionManager.publishFactoryEvent({ type: "runtime.product_spec.proposed", sessionId, productSpec: revised });
    await this.sessionManager.addMessage(sessionId, { role: "system", content: formatProductSpecification(revised) });
    return this.requireSession(sessionId);
  }

  async decideTechnicalPlan(sessionId: string, request: FactoryApprovalDecisionRequest) {
    const current = this.requireSession(sessionId);
    const plan = current.recursiveFactory?.technicalPlan;
    if (!plan?.id) throw new Error("Technical Plan not found");
    const now = new Date().toISOString();
    if (request.decision === "approved") {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const technicalPlan = draft.recursiveFactory!.technicalPlan!;
        technicalPlan.status = "approved";
        technicalPlan.updatedAt = now;
        draft.recursiveFactory!.phase = "approved_to_execute";
        draft.recursiveFactory!.executionStarted = false;
        draft.recursiveFactory!.updatedAt = now;
        draft.orchestration ??= createEmptyOrchestration(draft);
        draft.orchestration.approvalDecisions.push(factoryApproval(sessionId, "technical_plan", plan.id!, request));
        draft.reasoningSummaries.push("Both Recursive Factory approval gates passed. R2 graph planning will run without execution.");
      });
      this.sessionManager.publishFactoryEvent({
        type: "runtime.technical_plan.approved",
        sessionId,
        technicalPlan: this.requireSession(sessionId).recursiveFactory!.technicalPlan!
      });
      return this.proposeRecursiveGraph(sessionId);
    }

    const projectMap = current.orchestration?.projectMap ?? emptyProjectMap();
    const revised = buildTechnicalPlan({
      sessionId,
      productSpec: current.recursiveFactory!.productSpec!,
      projectMap,
      revision: (plan.revision ?? 1) + 1,
      feedback: request.feedback ?? request.decision
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.orchestration.approvalDecisions.push(factoryApproval(sessionId, "technical_plan", plan.id!, request));
      draft.recursiveFactory!.technicalPlan = revised;
      draft.recursiveFactory!.phase = "technical_plan_approval";
      draft.recursiveFactory!.updatedAt = now;
      draft.status = "needs_approval";
      draft.lifecycleStage = "PLAN";
      draft.nextAction = { kind: "approve_technical_plan", artifactId: revised.id!, message: "Review the revised Technical Plan." };
    });
    await this.addFactoryArtifact(sessionId, "technical_plan", `Technical Plan revision ${revised.revision}`, revised);
    this.sessionManager.publishFactoryEvent({ type: "runtime.technical_plan.proposed", sessionId, technicalPlan: revised });
    await this.sessionManager.addMessage(sessionId, { role: "system", content: formatTechnicalPlan(revised) });
    return this.requireSession(sessionId);
  }

  async startRecursiveFactory(sessionId: string, prompt: string, projectMap: ProjectMap) {
    const questions = productSpecClarificationQuestions(prompt);
    if (questions.length) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.resolvedExecutionMode = "recursive_factory";
        draft.recursiveFactory = { phase: "clarification", executionStarted: false, updatedAt: new Date().toISOString() };
        draft.status = "needs_approval";
        draft.lifecycleStage = "PLAN";
        draft.nextAction = { kind: "clarify_product_spec", message: "I need focused clarification before drafting the Product Specification.", questions };
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: ["Before I draft the Product Specification:", ...questions.map((question) => `- ${question}`)].join("\n")
      });
      return this.requireSession(sessionId);
    }

    const spec = buildProductSpecification({ sessionId, prompt });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.resolvedExecutionMode = "recursive_factory";
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.orchestration.projectMap = projectMap;
      draft.recursiveFactory = { phase: "product_spec_approval", productSpec: spec, executionStarted: false, updatedAt: new Date().toISOString() };
      draft.status = "needs_approval";
      draft.lifecycleStage = "PLAN";
      draft.nextAction = { kind: "approve_product_spec", artifactId: spec.id, message: "Review and approve the Product Specification before technical planning." };
    });
    await this.addFactoryArtifact(sessionId, "product_spec", "Product Specification", spec);
    this.sessionManager.publishFactoryEvent({ type: "runtime.product_spec.proposed", sessionId, productSpec: spec });
    await this.sessionManager.addMessage(sessionId, { role: "system", content: formatProductSpecification(spec) });
    return this.requireSession(sessionId);
  }

  private async proposeTechnicalPlan(sessionId: string) {
    const current = this.requireSession(sessionId);
    const plan = buildTechnicalPlan({
      sessionId,
      productSpec: current.recursiveFactory!.productSpec!,
      projectMap: current.orchestration?.projectMap ?? emptyProjectMap()
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveFactory!.technicalPlan = plan;
      draft.recursiveFactory!.phase = "technical_plan_approval";
      draft.recursiveFactory!.updatedAt = new Date().toISOString();
      draft.orchestration!.technicalPlan = plan;
      draft.status = "needs_approval";
      draft.lifecycleStage = "PLAN";
      draft.nextAction = { kind: "approve_technical_plan", artifactId: plan.id!, message: "Review and approve the Technical Plan before execution." };
    });
    await this.addFactoryArtifact(sessionId, "technical_plan", "Technical Plan", plan);
    this.sessionManager.publishFactoryEvent({ type: "runtime.technical_plan.proposed", sessionId, technicalPlan: plan });
    await this.sessionManager.addMessage(sessionId, { role: "system", content: formatTechnicalPlan(plan) });
    return this.requireSession(sessionId);
  }

  private async proposeRecursiveGraph(sessionId: string) {
    const current = this.requireSession(sessionId);
    const productSpec = current.recursiveFactory?.productSpec;
    const technicalPlan = current.recursiveFactory?.technicalPlan;
    if (!productSpec || !technicalPlan || technicalPlan.status !== "approved") {
      throw new Error("Recursive graph requires an approved Product Specification and Technical Plan.");
    }
    const graph = buildHierarchicalRecursiveGraph({ sessionId, productSpec, technicalPlan });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveFactory!.recursiveGraph = graph;
      draft.recursiveFactory!.branchOrchestrators = graph.branches;
      draft.recursiveFactory!.branchScopeConflicts = graph.conflicts;
      draft.recursiveFactory!.graphReadiness = graph.readiness;
      draft.recursiveFactory!.phase = graph.status === "blocked" ? "recursive_graph_blocked" : "recursive_graph_ready";
      draft.recursiveFactory!.executionStarted = false;
      draft.recursiveFactory!.updatedAt = new Date().toISOString();
      draft.status = graph.status === "blocked" ? "blocked" : "completed";
      draft.lifecycleStage = graph.status === "blocked" ? "BLOCKED" : "DONE";
      draft.nextAction = undefined;
      draft.reasoningSummaries.push(`Recursive graph ${graph.status}. Execution intentionally did not start.`);
    });
    await this.addFactoryArtifact(sessionId, "recursive_graph", "Hierarchical Recursive Graph", graph);
    this.sessionManager.publishFactoryEvent({ type: "runtime.recursive_graph.proposed", sessionId, graph });
    for (const branch of graph.branches) {
      await this.addFactoryArtifact(sessionId, "branch_orchestrator", branch.title, branch);
      this.sessionManager.publishFactoryEvent({ type: "runtime.branch_orchestrator.planned", sessionId, branch });
    }
    for (const conflict of graph.conflicts) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.branch_scope.conflict_detected", sessionId, conflict });
    }
    this.sessionManager.publishFactoryEvent({
      type: graph.status === "blocked" ? "runtime.recursive_graph.blocked" : "runtime.recursive_graph.ready",
      sessionId,
      graph
    });
    await this.sessionManager.addMessage(sessionId, { role: "system", content: formatRecursiveGraph(graph) });
    return this.requireSession(sessionId);
  }

  private async addFactoryArtifact(sessionId: string, type: FactoryArtifactType, title: string, value: object) {
    await this.sessionManager.addArtifact(sessionId, {
      id: "id" in value ? String(value.id) : `artifact_${randomUUID()}`,
      sessionId,
      type,
      title,
      summary: type === "product_spec" ? "Product Specification awaiting approval." : "Technical Plan awaiting approval.",
      payload: structuredClone(value) as Record<string, unknown>,
      createdAt: new Date().toISOString()
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function createEmptyOrchestration(session?: AgentRuntimeSession): NonNullable<AgentRuntimeSession["orchestration"]> {
  return {
    agentRuns: [],
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: session?.orchestration?.safetySettings ?? accessProfileDefaults(session?.accessProfile ?? "default_permissions"),
    lockedFiles: {},
    selectedWorkerAgents: [],
    mandatoryGateAgents: [],
    workOrders: [],
    qualityGateResults: [],
    retryCount: 0
  };
}

function factoryApproval(
  sessionId: string,
  targetType: "product_spec" | "technical_plan",
  targetId: string,
  request: FactoryApprovalDecisionRequest
): ApprovalRecord {
  return {
    id: `approval_${randomUUID()}`,
    sessionId,
    targetType,
    targetId,
    decision: request.decision,
    reason: request.feedback ?? `User ${request.decision.replace("_", " ")}.`,
    createdAt: new Date().toISOString()
  };
}

function emptyProjectMap(): ProjectMap {
  return {
    stack: [],
    packageManagers: [],
    testCommands: [],
    entryPoints: [],
    importantFiles: []
  };
}
