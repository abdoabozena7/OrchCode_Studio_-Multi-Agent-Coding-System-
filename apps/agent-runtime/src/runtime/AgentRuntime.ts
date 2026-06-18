import type {
  AgentRuntimeSession,
  BranchOrchestratorRecord,
  CommandExecutionRecord,
  CreateRuntimeSessionRequest,
  CreateRuntimeSessionResponse,
  FactoryApprovalDecisionRequest,
  PatchProposal,
  ProviderAuthoredResult,
  RecursiveBranchExecutionRecord,
  RecursiveBranchResultRecord,
  RecursiveBranchExecutionStartRequest,
  RecursiveDiscoveredValidationCommand,
  RecursiveFinalReport,
  RecursiveFailurePatchAttribution,
  RecursiveIntegrationSummary,
  RecursiveNestedSubtaskRecord,
  RecursiveNestedSubtaskRollup,
  RecursivePatchProvenance,
  RecursiveRepairEligibility,
  RecursiveRepairRecord,
  RecursiveValidationAttempt,
  RecursiveValidationEvidence,
  RecursiveValidationFailureDiagnosis,
  RecursiveValidationFailureSignals,
  RecursiveValidationRecord,
  RecursiveValidationStrategy,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  ReasoningEvidenceRef,
  RunToGreenDiagnosis,
  RunSummary,
  RuntimeSessionStatus,
  RuntimeProgressStage,
  RuntimeProgressStatus,
  RuntimeTurnResponse
} from "@hivo/protocol";
import { accessProfileDefaults } from "@hivo/protocol";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "../config.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import {
  createProviderTelemetryRecorder,
  inferActiveProviderSource,
  TelemetryLlmProvider
} from "../llm/ProviderTelemetry.js";
import { runPatchIntentSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { readMemorySnapshotSync } from "../memory/SqliteMemoryStore.js";
import { resolveModelCertification } from "../evals/ReasoningCertificationRegistry.js";
import { SessionManager } from "./SessionManager.js";
import { appendProviderEvidenceLinks } from "./ProviderEvidenceLinks.js";
import { createSimpleDelegationDecision, parsePromptDirective, resolveExecutionMode } from "./delegation.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { resolveInsideWorkspace } from "../tools/security.js";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";
import { isExplicitOperatorSuppliedImplementationPlan, RunEngine } from "./RunEngine.js";
import { SwarmAutopilotRuntime } from "../orchestration/SwarmRuntime.js";
import { buildProjectIntake, classifyRunIntent, createProjectIntakeEvidenceRefs } from "./ProjectIntake.js";
import {
  buildProjectKnowledgeTree,
  createKnowledgeRecursivePlanning,
  createKnowledgeGuidedEditPlan,
  formatKnowledgeRoutedEditMessage,
  routeKnowledgeQuery,
  shouldRouteExistingProjectEdit
} from "./ProjectKnowledgeTree.js";
import {
  appendAgentJournalEntry,
  buildAttributedReviewGate,
  buildDiffAwareRunSummary
  ,buildReconciliationReport
} from "./AgentTelemetry.js";
import { summarizeModuleExecution, validatePatchAgainstModulePlan } from "./ModuleExecutionPlanning.js";
import { buildRepairPatchPrompt, collectRepairFileExcerpts, compileRepairPatchProposal, type RepairPatchIntentModel } from "./RepairPatchPlanning.js";
import {
  createDiagnosisFingerprint,
  diagnoseRunToGreenFailure,
  findAlternateRunToGreenCommand,
  getCurrentRunToGreenAttempt,
  markNextRunToGreenAttempt
} from "./RunToGreen.js";
import type { IntentDecision } from "./IntentDecisionEngine.js";
import { createConversationUnderstanding, type ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { executionModeForConversationRoute } from "./ConversationRouter.js";
import { beginDecisionPipeline, finalizeAdaptiveReasoningDecisionPipeline } from "./DecisionPipeline.js";
import { continueAdaptiveReasoningTurn, invokeReasoningProviderStructured, ReasoningKernelFailure } from "./ReasoningKernel.js";
import { EvidenceStore } from "./EvidenceStore.js";
import { runReadOnlyUnderstandingEscalation } from "./ProjectUnderstandingEscalation.js";
import {
  buildProductSpecification,
  buildHierarchicalRecursiveGraph,
  buildTechnicalPlan,
  formatProductSpecification,
  formatRecursiveGraph,
  formatTechnicalPlan,
  productSpecClarificationQuestions
} from "./RecursiveFactoryPlanning.js";
import {
  buildRecursiveValidationCommandRequest,
  discoverRecursiveValidationCommands,
  findRecursiveValidationEvidence,
  selectRecursiveValidationStrategy,
  truthFromRecursiveValidation
} from "./RecursiveValidation.js";

type PlanClarifyAction = {
  kind: "clarify_plan";
  message: string;
  options: Array<{
    id: string;
    label: string;
    prompt: string;
  }>;
  allowCustom?: boolean;
};

type AgentRuntimeOptions = {
  providerFactory?: (session: AgentRuntimeSession) => LlmProvider;
};

export class AgentRuntime {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly sessionManager: SessionManager,
    private readonly options: AgentRuntimeOptions = {}
  ) {}

  async createSession(
    input: CreateRuntimeSessionRequest & { mode?: "real_provider" | "demo_mock" }
  ): Promise<CreateRuntimeSessionResponse> {
    const mode = "real_provider" as const;
    if (input.mode && input.mode !== "real_provider") {
      throw new ProviderConfigurationError("provider_mock_forbidden", "Demo and mock sessions are no longer supported.");
    }
    assertProviderGate({
      mode,
      providerConfig: input.providerConfig
    });
    const session = await this.sessionManager.createSession({
      workspacePath: input.workspacePath,
      mode,
      responseLanguage: input.responseLanguage ?? detectResponseLanguage(input.userPrompt),
      debugMode: input.debugMode ?? input.debug_mode ?? false,
      trustProfile: input.trustProfile,
      providerConfig: input.providerConfig,
      activeProviderSource: input.activeProviderSource ?? inferActiveProviderSource(mode, input.providerConfig),
      sessionToken: input.sessionToken,
      sessionTokenExpiresAt: input.sessionTokenExpiresAt,
      executionMode: input.executionMode,
      accessProfile: input.accessProfile,
      thinkFirst: input.thinkFirst,
      safetySettings: input.safetySettings,
      userPrompt: input.userPrompt
    });
    return { sessionId: session.id, status: "created" };
  }

  async runTurn(sessionId: string, message: string): Promise<RuntimeTurnResponse> {
    const session = this.requireSession(sessionId);
    const pendingAction = await this.handlePendingAction(session, message);
    if (pendingAction.handled) {
      return { sessionId, status: this.requireSession(sessionId).status };
    }
    const promptForExecution = pendingAction.resumePrompt ?? message;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = undefined;
    });
    const reportProviderProgress = true;
    if (reportProviderProgress) {
      const isArabicProgress = isArabicRuntimeLanguage(session.responseLanguage);
      await this.addProviderProgressEvent(sessionId, session, {
        stage: "planning",
        status: "running",
        title: isArabicProgress ? "فهم الطلب عند المزوّد" : "Understanding request with provider",
        summary: waitingForProviderSummary(session, session.responseLanguage)
      });
    }
    const modelCertification = resolveModelCertification(session.workspacePath, session.providerConfig);
    const providerTelemetry = createProviderTelemetryRecorder({
      mode: session.mode,
      providerConfig: session.providerConfig,
      activeProviderSource: session.activeProviderSource,
      modelCertification
    });
    try {
      let provider = new TelemetryLlmProvider(this.getProvider(session), providerTelemetry);
      const routerProvider = session.providerConfig?.routerModel && !this.options.providerFactory
        ? new TelemetryLlmProvider(createRealProvider({
            ...session.providerConfig,
            selectedModel: session.providerConfig.routerModel
          }, this.config.providerRequestTimeoutMs), providerTelemetry)
        : provider;
      const verifierProvider = session.providerConfig?.verifierModel && !this.options.providerFactory
        ? new TelemetryLlmProvider(createRealProvider({
            ...session.providerConfig,
            selectedModel: session.providerConfig.verifierModel
          }, this.config.providerRequestTimeoutMs), providerTelemetry)
        : provider;
      let conversationUnderstanding: ConversationUnderstanding | undefined;
      const decisionPipeline = await beginDecisionPipeline({
        message: promptForExecution,
        provider,
        routerProvider
      });
      conversationUnderstanding = decisionPipeline.understanding;
      await this.recordInitialDecisionPipeline(sessionId, decisionPipeline.state);
      if (reportProviderProgress) {
        const isArabicProgress = isArabicRuntimeLanguage(session.responseLanguage);
        await this.addProviderProgressEvent(sessionId, session, {
          stage: "planning",
          status: "completed",
          title: isArabicProgress ? "تحديد المسار" : "Routing complete",
          summary: decisionPipeline.state.reasoningDirective?.rationale
            ?? conversationUnderstanding?.intentDecision.rationale
            ?? "The provider classified the request and selected the next reasoning path."
        });
      }
      if (
        ["direct_conversation", "workspace_question"].includes(conversationUnderstanding?.intentDecision.kind ?? "")
        || modelCertification.certifiedGates?.includes("action_reasoning")
        || ["ask_user", "cannot_answer", "refuse"].includes(decisionPipeline.state.reasoningDirective?.action ?? "")
      ) {
        // Instantiating the registry performs no reads. Workspace access still occurs only
        // when a provider-authored reasoning step explicitly requests a tool.
        const tools = new ToolRegistry(session.workspacePath);
        const adaptiveEvidenceStore = new EvidenceStore();
        if (reportProviderProgress) {
          const isArabicProgress = isArabicRuntimeLanguage(session.responseLanguage);
          await this.addProviderProgressEvent(sessionId, session, {
            stage: conversationUnderstanding?.intentDecision.kind === "workspace_question" ? "inspecting" : "working",
            status: "running",
            title: isArabicProgress ? "قراءة الأدلة وتأليف الرد" : "Reading evidence and composing answer",
            summary: isArabicProgress
              ? `بانتظار رد الموديل ${session.providerConfig?.selectedModel ?? "المحدد"} مع أدلة المشروع.`
              : `Waiting for ${session.providerConfig?.selectedModel ?? "the selected model"} to use the available evidence.`
          });
        }
        const adaptive = await continueAdaptiveReasoningTurn({
          provider,
          routerProvider,
          verifierProvider,
          sessionId,
          understanding: decisionPipeline.state.turnUnderstanding!,
          directive: decisionPipeline.state.reasoningDirective!,
          initialStep: decisionPipeline.state.reasoningInitialStep,
          state: decisionPipeline.reasoningState,
          tools,
          evidenceStore: adaptiveEvidenceStore,
          embeddingModel: session.providerConfig?.embeddingModel
            ?? process.env.HIVO_EMBEDDING_MODEL
            ?? (session.providerConfig?.providerType === "ollama" ? process.env.OLLAMA_EMBEDDING_MODEL : process.env.OPENAI_EMBEDDING_MODEL),
          delegateReadonly: async (request, budget) => {
            const delegated = await runReadOnlyUnderstandingEscalation({
              workspacePath: session.workspacePath,
              provider,
              question: request.query?.trim() || promptForExecution,
              missingFacts: [request.reason],
              budget
            });
            const evidenceRefs = delegated.reviews.map((review, index) => adaptiveEvidenceStore.add({
              sourceType: "delegated_review",
              summary: `Provider-backed read-only review ${index + 1}`,
              excerpt: review
            }));
            return {
              providerCallsUsed: delegated.providerCalls,
              result: {
                requestId: request.id,
                kind: request.kind,
                status: evidenceRefs.length ? "success" : "unavailable",
                summary: evidenceRefs.length
                  ? `Collected ${evidenceRefs.length} provider-backed read-only review(s).`
                  : "Provider-backed read-only review returned no evidence.",
                evidenceRefs,
                data: { reviews: delegated.reviews },
                createdAt: new Date().toISOString()
              }
            };
          },
          onCommandRequest: (request) => this.sessionManager.addCommandRequest(sessionId, request).then(() => undefined),
          onPatchProposal: (proposal) => this.sessionManager.addPatchProposal(sessionId, proposal).then(() => undefined)
        });
        const result = adaptive.result;
        providerTelemetry.markProviderAuthoredResponse();
        const currentPipeline = this.requireSession(sessionId).latestDecisionPipeline;
        if (currentPipeline) {
          const telemetry = providerTelemetry.snapshot();
          const finalizedPipeline = {
            ...finalizeAdaptiveReasoningDecisionPipeline(currentPipeline, result, {
              ...adaptive.trace,
              providerRequestRefs: telemetry.providerRequestRefs
            }),
            reasoningAttempts: telemetry.reasoningAttempts,
            repairAttempts: telemetry.repairAttempts,
            providerRequestRefs: telemetry.providerRequestRefs,
            finalResponseSource: telemetry.finalResponseSource
          };
          await this.sessionManager.updateSession(sessionId, (draft) => {
            draft.latestDecisionPipeline = finalizedPipeline;
            const index = draft.decisionPipelineHistory?.findIndex((entry) => entry.id === finalizedPipeline.id) ?? -1;
            if (index >= 0 && draft.decisionPipelineHistory) draft.decisionPipelineHistory[index] = finalizedPipeline;
            draft.providerTelemetry = providerTelemetry.snapshot();
            draft.evidenceReport = undefined;
          });
        }
        return this.completeDirectConversationTurn(sessionId, promptForExecution, conversationUnderstanding.intentDecision, result, adaptive.trace.evidenceRefs);
      }
      const tools = new ToolRegistry(session.workspacePath);
      const projectSummary = tools.workspace.getProjectSummary();
      const projectMap = {
        stack: Object.keys(projectSummary.languages),
        packageManagers: projectSummary.packageManagers,
        testCommands: projectSummary.testCommands,
        entryPoints: projectSummary.importantFiles.filter((file) => /main|index|app|server|lib\.rs/.test(file)).slice(0, 8),
        importantFiles: projectSummary.importantFiles
      };
      const intake = buildProjectIntake({
        workspacePath: session.workspacePath,
        message: promptForExecution,
        projectMap,
        tools,
        conversationUnderstanding
      });
      const parsedDirective = parsePromptDirective(promptForExecution);
      const routedExecutionMode = conversationUnderstanding
        ? executionModeForConversationRoute(conversationUnderstanding.routeDecision.route)
        : undefined;
      const modeResolution =
        session.executionMode === "auto_mode"
          ? parsedDirective.explicitMode || routedExecutionMode
            ? {
                mode: parsedDirective.explicitMode ?? routedExecutionMode!,
                directive: parsedDirective,
                complexity: createSimpleDelegationDecision({ prompt: promptForExecution, projectMap }).estimatedComplexity
              }
            : resolveExecutionMode(promptForExecution, projectMap)
          : {
              mode: session.executionMode,
              directive: parsedDirective,
              complexity: createSimpleDelegationDecision({ prompt: promptForExecution, projectMap }).estimatedComplexity
            };

      const requestedAgentCount = modeResolution.directive.requestedAgentCount ?? 0;
      const thinkFirst = session.thinkFirst || modeResolution.directive.thinkFirstRequested;
      let updated: AgentRuntimeSession;
      if (modeResolution.mode === "orchestrated_mode") {
        updated = await this.runProviderBackedSwarmTurn(sessionId, promptForExecution, provider, providerTelemetry, conversationUnderstanding);
      } else {
        updated = await new RunEngine(provider, this.sessionManager, { providerTelemetry }).runTurn(sessionId, promptForExecution, {
          resolvedMode: modeResolution.mode,
          projectMap,
          thinkFirst,
          conversationUnderstanding
        });
      }
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.resolvedExecutionMode = modeResolution.mode;
      });
      return { sessionId, status: updated.status };
    } catch (error) {
      providerTelemetry.markProviderError(error);
      providerTelemetry.markTerminalFailure(error);
      const providerGateFailure = isProviderGateFailure(error, session);
      const failureMessage = formatRuntimeError(error);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = providerGateFailure ? "failed_provider" : "failed";
        draft.lifecycleStage = "FAILED";
        draft.providerTelemetry = providerTelemetry.snapshot();
        if (draft.latestDecisionPipeline) {
          const reasoningTrace = error instanceof ReasoningKernelFailure
            ? {
                ...error.trace,
                providerRequestRefs: draft.providerTelemetry.providerRequestRefs
              }
            : draft.latestDecisionPipeline.reasoningTrace;
          draft.latestDecisionPipeline = {
            ...draft.latestDecisionPipeline,
            reasoningTrace,
            reasoningAttempts: draft.providerTelemetry.reasoningAttempts,
            repairAttempts: draft.providerTelemetry.repairAttempts,
            providerRequestRefs: draft.providerTelemetry.providerRequestRefs,
            finalResponseSource: "none",
            terminalFailure: failureMessage
          };
        }
        draft.reasoningSummaries.push(formatRuntimeError(error));
        draft.runSummary = {
          status: "failed",
          summary: failureMessage.slice(0, 500),
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: draft.patchProposals.map((proposal) => proposal.id),
          commandResults: draft.commandExecutions.map((command) => command.command).slice(-5),
          gates: [{
            name: "Runtime turn",
            status: "failed",
            notes: [formatRuntimeError(error)]
          }],
          nextAction: "Fix the reported runtime/provider issue, then retry the request.",
          createdAt: new Date().toISOString()
        };
      });
      return { sessionId, status: providerGateFailure ? "failed_provider" : "failed" };
    }
  }

  private async completeKnowledgeRoutedEdit(
    sessionId: string,
    message: string,
    tools: ToolRegistry,
    intake: ReturnType<typeof buildProjectIntake>
  ): Promise<AgentRuntimeSession> {
    const session = this.requireSession(sessionId);
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    const tree = await buildProjectKnowledgeTree({
      sessionId,
      workspacePath: session.workspacePath,
      tools
    });
    const route = routeKnowledgeQuery({ tree, request: message });
    const routedEdit = createKnowledgeGuidedEditPlan({ tree, route, request: message });
    const branchPlanning = createKnowledgeRecursivePlanning({
      sessionId,
      routedEdit,
      targets: routedEdit.knowledgeBranchTargets
    });
    const now = new Date().toISOString();
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = routedEdit.status === "blocked" ? "blocked" : "completed";
      draft.lifecycleStage = "PLAN";
      draft.resolvedExecutionMode = "simple_mode";
      draft.agentName = "Project Knowledge Router";
      draft.projectIntake = intake;
      draft.contextPack = intake.contextPack;
      draft.runIntent = intake.runIntent;
      draft.projectKnowledgeTree = tree;
      draft.latestKnowledgeRoute = routedEdit;
      draft.latestKnowledgeBranchTargets = routedEdit.knowledgeBranchTargets;
      draft.recursiveFactory = {
        phase: branchPlanning.graph.status === "blocked" ? "recursive_graph_blocked" : "recursive_graph_ready",
        recursiveGraph: branchPlanning.graph,
        branchOrchestrators: branchPlanning.branchOrchestrators,
        branchExecutions: branchPlanning.branchExecutions,
        branchScopeConflicts: branchPlanning.graph.conflicts,
        graphReadiness: branchPlanning.graph.readiness,
        executionStarted: false,
        updatedAt: now
      };
      draft.decisionLedger.push({
        id: `decision_${randomUUID()}`,
        sessionId,
        category: "decision",
        finding: `Project intake classified this workspace as ${intake.projectKind.replaceAll("_", " ")} before Knowledge Tree routing.`,
        decision: "Treat this workspace as existing work and route the edit through the Project Knowledge Tree before implementation.",
        rationaleSummary: intake.currentStateSummary ?? "Project intake was recorded before Knowledge Tree routing.",
        evidenceRefs: createProjectIntakeEvidenceRefs(intake),
        linkedFiles: intake.importantFiles.slice(0, 6),
        createdByAgent: "Project Knowledge Router",
        createdByAgentId: "agent_project_knowledge_router",
        linkedAgentIds: ["agent_project_knowledge_router"],
        createdAt: now
      });
      draft.nextAction = undefined;
      draft.patchProposals = draft.patchProposals;
      draft.commandRequests = draft.commandRequests;
      draft.commandExecutions = draft.commandExecutions;
      draft.taskState.phase = "completed";
      draft.taskState.finalStatus = draft.status;
      draft.runSummary = {
        status: routedEdit.status === "blocked" ? "blocked" : "completed",
        summary: routedEdit.plan.executionState,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [{
          name: "Project Knowledge Tree routing",
          status: routedEdit.status === "blocked" ? "blocked" : "passed",
          notes: [
            `Primary node: ${routedEdit.route.primaryNode}`,
            `Confidence: ${Math.round(routedEdit.route.confidence * 100)}%`,
            `Knowledge branch targets: ${routedEdit.knowledgeBranchTargets.length}`,
            routedEdit.plan.executionState
          ]
        }],
        nextAction: "Use the Knowledge-Guided Edit Plan as input to the recursive execution system in a later execution step.",
        createdAt: now
      };
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_project_intake_${randomUUID()}`,
      sessionId,
      type: "project_intake",
      title: "Project Intake",
      summary: intake.currentStateSummary ?? "Project intake was recorded before Knowledge Tree routing.",
      payload: { intake },
      createdAt: now
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_context_pack_${randomUUID()}`,
      sessionId,
      type: "context_pack",
      title: "Context Pack",
      summary: intake.contextPack?.projectSummary ?? intake.currentStateSummary ?? "Context pack recorded before Knowledge Tree routing.",
      payload: { contextPack: intake.contextPack },
      createdAt: now
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_knowledge_tree_${randomUUID()}`,
      sessionId,
      type: "project_knowledge_tree",
      title: "Project Knowledge Tree",
      summary: `Mapped ${tree.nodes.length} knowledge node(s) and ${tree.fileOwnership.length} file owner(s).`,
      payload: { tree },
      createdAt: now
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_knowledge_route_${randomUUID()}`,
      sessionId,
      type: "knowledge_edit_route",
      title: "Knowledge-Guided Edit Plan",
      summary: routedEdit.plan.executionState,
      payload: { routedEdit },
      createdAt: now
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_knowledge_branch_targets_${randomUUID()}`,
      sessionId,
      type: "knowledge_branch_targets",
      title: "Knowledge Branch Targets",
      summary: `Planned ${routedEdit.knowledgeBranchTargets.length} knowledge branch target(s). Execution has not started.`,
      payload: { targets: routedEdit.knowledgeBranchTargets, graph: branchPlanning.graph },
      createdAt: now
    });
    this.sessionManager.publishKnowledgeEvent({ type: "runtime.knowledge_tree.created", sessionId, tree });
    for (const node of tree.nodes.filter((candidate) => candidate.parent === tree.rootNodeId || candidate.nodeId === tree.rootNodeId)) {
      this.sessionManager.publishKnowledgeEvent({ type: "runtime.knowledge_node.created", sessionId, node });
    }
    this.sessionManager.publishKnowledgeEvent({
      type: routedEdit.status === "blocked" ? "runtime.edit_route.blocked" : "runtime.edit_route.ready",
      sessionId,
      routedEdit
    });
    this.sessionManager.publishKnowledgeEvent({
      type: "runtime.knowledge_branch_targets.created",
      sessionId,
      targets: routedEdit.knowledgeBranchTargets
    });
    this.sessionManager.publishFactoryEvent({ type: "runtime.recursive_graph.proposed", sessionId, graph: branchPlanning.graph });
    for (const branch of branchPlanning.branchOrchestrators) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.branch_orchestrator.planned", sessionId, branch });
    }
    for (const branchExecution of branchPlanning.branchExecutions) {
      this.sessionManager.publishKnowledgeEvent({ type: "runtime.knowledge_branch_execution.planned", sessionId, branchExecution });
    }
    this.sessionManager.publishFactoryEvent({
      type: branchPlanning.graph.status === "blocked" ? "runtime.recursive_graph.blocked" : "runtime.recursive_graph.ready",
      sessionId,
      graph: branchPlanning.graph
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: formatKnowledgeRoutedEditMessage({ tree, routedEdit })
    });
    return this.requireSession(sessionId);
  }

  private async recordInitialDecisionPipeline(sessionId: string, state: NonNullable<AgentRuntimeSession["latestDecisionPipeline"]>) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.latestDecisionPipeline = state;
      draft.decisionPipelineHistory ??= [];
      draft.decisionPipelineHistory.push(state);
      draft.reasoningSummaries.push(
        `Decision pipeline route: ${state.query.route} (${state.query.source}, ${state.query.confidence}); archetype=${state.query.archetype}.`
      );
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_decision_pipeline_${randomUUID()}`,
      sessionId,
      type: "decision_pipeline",
      title: "Decision Pipeline",
      summary: `${state.query.source} routed the request to ${state.query.route} as ${state.query.archetype}.`,
      payload: { decisionPipeline: state },
      createdAt: new Date().toISOString()
    });
  }

  private async addProviderProgressEvent(
    sessionId: string,
    session: AgentRuntimeSession,
    input: {
      stage: RuntimeProgressStage;
      status: RuntimeProgressStatus;
      title: string;
      summary: string;
      targetFiles?: string[];
    }
  ) {
    await this.sessionManager.addProgressEvent(sessionId, {
      id: `progress_${randomUUID()}`,
      sessionId,
      stage: input.stage,
      status: input.status,
      agentName: "ReasoningKernel",
      role: "Provider",
      taskTitle: input.title,
      summary: input.summary,
      targetFiles: input.targetFiles ?? [],
      createdAt: new Date().toISOString()
    });
  }

  private async completeDirectConversationTurn(
    sessionId: string,
    message: string,
    decision: IntentDecision,
    result: ProviderAuthoredResult,
    evidenceRefs: ReasoningEvidenceRef[] = []
  ): Promise<RuntimeTurnResponse> {
    const session = this.requireSession(sessionId);
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    const answer = appendProviderEvidenceLinks(result.answerMarkdown, result.evidenceRefs, evidenceRefs, decision.language);
    const now = new Date().toISOString();
    const targetFiles = citedEvidenceTargetFiles(result.evidenceRefs, evidenceRefs);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const pendingPatch = draft.patchProposals.find((proposal) => proposal.status === "proposed");
      const pendingCommand = draft.commandRequests.some((request) => request.status === "requested" || request.status === "approved");
      draft.status = pendingPatch || pendingCommand ? "needs_approval" : "completed";
      draft.lifecycleStage = pendingPatch || pendingCommand ? "APPROVAL" : "DONE";
      draft.resolvedExecutionMode = draft.executionMode === "auto_mode" ? "simple_mode" : draft.executionMode;
      draft.agentName = "Local Run";
      draft.nextAction = pendingPatch
        ? { kind: "approve_patch", message: "Review the provider-authored patch proposal before Rust applies it.", patchId: pendingPatch.id }
        : pendingCommand
          ? { kind: "approve_commands", message: "Review and run the provider-requested command through Rust authority." }
          : undefined;
      draft.runPhases = [];
    });
    await this.sessionManager.addProgressEvent(sessionId, {
      id: `progress_${randomUUID()}`,
      sessionId,
      stage: "completed",
      status: "completed",
      agentName: "ReasoningKernel",
      role: "Direct Conversation",
      taskTitle: decision.language === "arabic" ? "رد المزوّد" : "Provider response",
      summary: result.rationale,
      targetFiles,
      createdAt: now
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: answer,
      providerRequestRefs: this.requireSession(sessionId).providerTelemetry?.providerRequestRefs
        ?? this.requireSession(sessionId).latestDecisionPipeline?.providerRequestRefs
        ?? []
    });
    await this.sessionManager.setRunSummary(sessionId, {
      status: "completed",
      summary: answer,
      filesChanged: [],
      appliedPatchIds: [],
      proposedPatchIds: [],
      commandResults: [],
      gates: [{
        name: "Pre-retrieval intent decision",
        status: "passed",
        notes: [decision.rationale]
      }],
      nextAction: "Send a project question, run request, or coding task when ready.",
      createdAt: now
    });
    return { sessionId, status: this.requireSession(sessionId).status };
  }

  getSession(sessionId: string): AgentRuntimeSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

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
      this.sessionManager.publishFactoryEvent({ type: "runtime.product_spec.approved", sessionId, productSpec: this.requireSession(sessionId).recursiveFactory!.productSpec! });
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
      this.sessionManager.publishFactoryEvent({ type: "runtime.technical_plan.approved", sessionId, technicalPlan: this.requireSession(sessionId).recursiveFactory!.technicalPlan! });
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

  async startRecursiveBranchExecution(sessionId: string, request: RecursiveBranchExecutionStartRequest) {
    if (request?.approved !== true) {
      throw new Error("Recursive branch execution requires explicit user approval.");
    }
    const current = this.requireSession(sessionId);
    const factory = current.recursiveFactory;
    if (!factory?.productSpec || factory.productSpec.status !== "approved") {
      throw new Error("Branch execution requires an approved Product Specification.");
    }
    if (!factory.technicalPlan || factory.technicalPlan.status !== "approved") {
      throw new Error("Branch execution requires an approved Technical Plan.");
    }
    if (!factory.recursiveGraph || factory.recursiveGraph.status !== "ready" || factory.graphReadiness?.status !== "ready") {
      throw new Error("Branch execution requires a ready recursive graph.");
    }
    const blockingConflict = (factory.branchScopeConflicts ?? factory.recursiveGraph.conflicts).find((conflict) => conflict.severity === "blocking");
    if (blockingConflict) {
      await this.blockRecursiveBranchExecution(sessionId, blockingConflict.reason);
      throw new Error(`Branch execution blocked: ${blockingConflict.code}: ${blockingConflict.reason}`);
    }
    if (factory.executionStarted) {
      throw new Error("Recursive branch execution has already started for this session.");
    }

    const now = new Date().toISOString();
    const branches = factory.branchOrchestrators?.length ? factory.branchOrchestrators : factory.recursiveGraph.branches;
    const branchTargets = normalizeBranchTargetPlans(current.workspacePath, request, branches);
    const initialExecutions = branches.map((branch) =>
      createBranchExecutionRecord({
        branch,
        session: current,
        branchTarget: branchTargets.get(branch.branchId),
        now,
        status: branch.dependencies.length ? "waiting_on_dependency" : "ready",
        active: false
      })
    );
    if (!initialExecutions.length) {
      await this.blockRecursiveBranchExecution(sessionId, "No branch orchestrator records were available for execution.");
      throw new Error("Branch execution blocked: missing_file_scope: No branch orchestrator records were available.");
    }
    await this.setBranchExecutions(sessionId, initialExecutions, undefined, "branch_execution_running");
    await this.advanceRecursiveBranchScheduler(sessionId);
    return this.requireSession(sessionId);
  }

  async approvePatch(sessionId: string, patchId: string) {
    const currentSession = this.requireSession(sessionId);
    const currentProposal = currentSession.patchProposals.find((patch) => patch.id === patchId);
    if (!currentProposal) throw new Error("proposal_not_found: Patch proposal not found");
    if (currentProposal.status !== "proposed") {
      throw new Error(`Patch approval requires proposed status; current status is ${currentProposal.status}.`);
    }
    const preflight = new ToolRegistry(currentSession.workspacePath).patch.validate(currentProposal);
    if (!preflight.valid) {
      throw new Error(`Patch approval blocked by preflight: ${preflight.errors.join("; ")}`);
    }
    if (currentSession.latestScopeValidation?.verdict === "blocked") {
      throw new Error("Patch approval is blocked because the proposed changes exceed the scoped module plan.");
    }
    let session = await this.sessionManager.setPatchStatus(sessionId, patchId, "approved");
    const proposal = session.patchProposals.find((patch) => patch.id === patchId);
    if (!proposal) throw new Error("proposal_not_found: Patch proposal not found");
    const applied = false;
    const message = "Patch approved. Apply is handled by the Rust patch authority.";
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const approvalId = `approval_${randomUUID()}`;
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPLY";
      const patch = draft.patchProposals.find((candidate) => candidate.id === patchId);
      if (patch) {
        patch.approvalId = approvalId;
        patch.lastStatusAt = new Date().toISOString();
      }
      draft.orchestration?.approvalDecisions.push({
        id: approvalId,
        sessionId,
        targetType: "patch",
        targetId: patchId,
        decision: "approved",
        reason: "User approved patch proposal in UI",
        createdAt: new Date().toISOString()
      });
    });
    await this.updateBranchExecutionFromPatch(sessionId, patchId);
    return {
      proposal,
      applied,
      message
    };
  }

  async rejectPatch(sessionId: string, patchId: string) {
    const session = await this.sessionManager.setPatchStatus(sessionId, patchId, "rejected");
    const proposal = session.patchProposals.find((patch) => patch.id === patchId);
    if (!proposal) throw new Error("proposal_not_found: Patch proposal not found");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const approvalId = `approval_${randomUUID()}`;
      draft.lifecycleStage = "BLOCKED";
      draft.nextAction = undefined;
      const patch = draft.patchProposals.find((candidate) => candidate.id === patchId);
      if (patch) {
        patch.approvalId = approvalId;
        patch.lastStatusAt = new Date().toISOString();
      }
      draft.orchestration?.approvalDecisions.push({
        id: approvalId,
        sessionId,
        targetType: "patch",
        targetId: patchId,
        decision: "rejected",
        reason: "User rejected patch proposal in UI",
        createdAt: new Date().toISOString()
      });
      if (draft.runToGreen?.pendingRepairPatchId === patchId) {
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "User rejected the proposed repair patch during the run-to-green loop.";
        draft.runToGreen.pendingRepairPatchId = undefined;
        draft.runToGreen.pendingRerunCommand = undefined;
        draft.runToGreen.pendingRerunReason = undefined;
        draft.runToGreen.updatedAt = new Date().toISOString();
      }
    });
    await this.updateBranchExecutionFromPatch(sessionId, patchId);
    return { proposal, applied: false, message: "Patch rejected. No files were changed." };
  }

  async reportPatchApplyResult(sessionId: string, patchId: string, result: ReportPatchApplyResultRequest) {
    const current = this.requireSession(sessionId).patchProposals.find((proposal) => proposal.id === patchId);
    if (!current) throw new Error("proposal_not_found: Patch proposal not found");
    if (result.status === "apply_started") {
      if (current.status !== "approved") {
        throw new Error(`Patch apply can only start from approved status; current status is ${current.status}.`);
      }
      await this.sessionManager.setPatchStatus(sessionId, patchId, "apply_started");
      await this.syncSessionOutcome(sessionId);
      await this.updateBranchExecutionFromPatch(sessionId, patchId);
      return this.requireSession(sessionId);
    }
    if (current.status !== "approved" && current.status !== "apply_started") {
      throw new Error(`Patch apply result requires approved or apply_started status; current status is ${current.status}.`);
    }
    const status = result.status === "applied" ? "applied" : "apply_failed";
    await this.sessionManager.setPatchStatus(sessionId, patchId, status);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "summary",
      title: result.status === "applied" ? "Patch applied" : "Patch apply failed",
      summary: result.message,
      payload: {
        patchId,
        status: result.status,
        message: result.message
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: result.status === "applied"
        ? `Applied patch ${patchId}.\n\n${result.message}`
        : `Patch ${patchId} failed to apply.\n\n${result.message}`
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (result.status === "applied") {
        draft.reconciliationReport = result.reconciliationSnapshot
          ? buildReconciliationReport(draft, patchId, result.reconciliationSnapshot)
          : {
              status: "pending",
              patchId,
              sourceDiffId: patchId,
              checkedAt: new Date().toISOString(),
              checkedBy: "runtime",
              confidence: "unknown",
              reason: "Patch apply succeeded, but post-apply reconciliation has not been reported yet.",
              retryable: true,
              matchedFiles: [],
              missingFiles: [],
              extraFiles: [],
              changedFilesWithDifferentStats: [],
              sharedOrAmbiguousFiles: draft.reviewGate?.sharedFiles ?? [],
              unknowns: ["Post-apply reconciliation snapshot was not provided."]
            };
      } else {
        draft.reconciliationReport = {
          status: "failed",
          patchId,
          sourceDiffId: patchId,
          checkedAt: new Date().toISOString(),
          checkedBy: "runtime",
          confidence: "unknown",
          reason: result.message,
          retryable: false,
          matchedFiles: [],
          missingFiles: [],
          extraFiles: [],
          changedFilesWithDifferentStats: [],
          sharedOrAmbiguousFiles: draft.reviewGate?.sharedFiles ?? [],
          unknowns: ["Patch apply failed, so reconciliation did not run."]
        };
      }
      for (const agent of draft.orchestration?.agentRuns ?? []) {
        if (!(agent.changedFiles ?? []).length) continue;
        agent.currentAction = result.status === "applied"
          ? "Rust applied the reviewable changes owned by this contract."
          : "Rust reported that applying the reviewable changes failed.";
        agent.recentActions = appendRuntimeAction(agent.recentActions, result.message);
        if (result.status === "applied") {
          agent.status = agent.status === "failed" ? "failed" : "blocked";
          appendAgentJournalEntry(agent, {
            kind: "completed",
            title: "Patch apply acknowledged",
            summary: result.message,
            filePath: agent.changedFiles?.[0],
            status: "completed"
          });
        } else {
          agent.status = "failed";
          agent.completedAt = new Date().toISOString();
          appendAgentJournalEntry(agent, {
            kind: "blocked",
            title: "Patch apply failed",
            summary: result.message,
            filePath: agent.changedFiles?.[0],
            status: "failed"
          });
        }
      }
    });
    const afterPatch = this.requireSession(sessionId);
    if (result.status === "applied") {
      await this.queuePendingRunToGreenRerun(afterPatch, patchId, "Approved repair patch applied; rerun the selected command.");
    } else {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (draft.runToGreen?.pendingRepairPatchId === patchId) {
          const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
          if (attempt) {
            attempt.stopReason = "Repair patch failed to apply.";
          }
          draft.runToGreen.status = "failed";
          draft.runToGreen.finalStatus = "not_green";
          draft.runToGreen.blockerReason = "Repair patch failed to apply through Rust authority.";
          draft.runToGreen.pendingRepairPatchId = undefined;
          draft.runToGreen.pendingRerunCommand = undefined;
          draft.runToGreen.pendingRerunReason = undefined;
          draft.runToGreen.updatedAt = new Date().toISOString();
        }
      });
    }
    await this.syncSessionOutcome(sessionId);
    await this.updateRecursiveRepairFromPatch(sessionId, patchId, status);
    await this.updateBranchExecutionFromPatch(sessionId, patchId);
    return this.requireSession(sessionId);
  }

  async reportCommandResult(sessionId: string, requestId: string, result: ReportCommandResultRequest) {
    const request = this.requireSession(sessionId).commandRequests.find((candidate) => candidate.id === requestId);
    const record: CommandExecutionRecord = {
      id: `exec_${randomUUID()}`,
      sessionId,
      requestId,
      autoRun: result.autoRun ?? false,
      command: result.command,
      cwd: result.cwd,
      risk: result.risk,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      message: result.message,
      diagnosis: result.diagnosis,
      provenance: {
        source: result.provenance?.source ?? request?.provenance?.source ?? "agent",
        trigger: result.provenance?.trigger ?? (result.autoRun ? "auto_approved" : "manual"),
        requestedBy: result.provenance?.requestedBy ?? request?.provenance?.requestedBy ?? "unknown",
        approvalId: result.provenance?.approvalId ?? request?.provenance?.approvalId,
        toolCallId: result.provenance?.toolCallId ?? request?.provenance?.toolCallId,
        reason: result.provenance?.reason ?? result.message ?? request?.reason,
        sessionId,
        requestId,
        agentId: result.provenance?.agentId,
        approvalSource: result.provenance?.approvalSource,
        policyDecision: result.provenance?.policyDecision,
        policyReason: result.provenance?.policyReason,
        executionAuthority: result.provenance?.executionAuthority ?? "rust",
        background: result.provenance?.background ?? result.backgroundJob?.status === "running",
        processId: result.provenance?.processId ?? result.backgroundJob?.processId,
        networkDetected: result.provenance?.networkDetected,
        backgroundDetected: result.provenance?.backgroundDetected ?? result.backgroundJob?.status === "running",
        detectionSource: result.provenance?.detectionSource,
        networkDetectionSource: result.provenance?.networkDetectionSource,
        backgroundDetectionSource: result.provenance?.backgroundDetectionSource,
        outputSummary: result.provenance?.outputSummary,
        backgroundTrackingLimited: result.provenance?.backgroundTrackingLimited ?? Boolean(result.backgroundJob),
        jobId: result.provenance?.jobId ?? result.backgroundJob?.jobId
      },
      backgroundJob: result.backgroundJob
        ? {
            ...result.backgroundJob,
            requestId,
            sessionId
          }
        : undefined,
      createdAt: new Date().toISOString()
    };
    await this.sessionManager.addCommandExecution(sessionId, record);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "command_result",
      title: result.command,
      summary: result.message ?? `Command ${result.status}`,
      payload: {
        requestId,
        result: record
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: formatCommandResultMessage(record)
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      for (const agent of draft.orchestration?.agentRuns ?? []) {
        if (!(agent.commandsRun ?? []).includes(result.command)) continue;
        agent.commandsRun = uniqueRuntimeStrings([...(agent.commandsRun ?? []), result.command]);
        if (looksLikeTestCommand(result.command)) {
          agent.testsRun = uniqueRuntimeStrings([...(agent.testsRun ?? []), result.command]);
        }
        agent.currentAction = result.message ?? `Command recorded as ${result.status}.`;
        agent.recentActions = appendRuntimeAction(agent.recentActions, `Command result: ${result.command} (${result.status})`);
        agent.evidenceRefs = mergeRuntimeEvidenceRefs(agent.evidenceRefs, [{
          type: "command",
          commandId: requestId,
          category: "command-result",
          reason: result.message ?? `Command finished with status ${result.status}.`,
          linkedAgentId: agent.id
        }]);
        appendAgentJournalEntry(agent, {
          kind:
            result.status === "running" || result.status === "executing"
              ? "command_requested"
              : looksLikeTestCommand(result.command)
                ? "test_run"
                : "command_completed",
          title: result.command,
          summary: result.message ?? `Command recorded as ${result.status}.`,
          command: result.command,
          status:
            result.status === "failed"
              ? "failed"
              : result.status === "blocked" || result.status === "approval_required"
                ? "blocked"
                : result.status === "running" || result.status === "executing"
                  ? "running"
                  : "completed"
        });
      }
    });
    await this.advanceRunToGreenFromCommandResult(sessionId, record);
    await this.syncSessionOutcome(sessionId);
    await this.updateRecursiveRepairFromCommandResult(sessionId, record);
    await this.updateActiveBranchValidation(sessionId);
    return this.requireSession(sessionId);
  }

  private async setBranchExecutions(
    sessionId: string,
    records: RecursiveBranchExecutionRecord[],
    activeBranchId: string | undefined,
    phase: NonNullable<AgentRuntimeSession["recursiveFactory"]>["phase"]
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (!draft.recursiveFactory) return;
      draft.recursiveFactory.branchExecutions = records;
      draft.recursiveFactory.activeBranchId = activeBranchId;
      draft.recursiveFactory.executionStarted = true;
      draft.recursiveFactory.phase = phase;
      draft.recursiveFactory.updatedAt = new Date().toISOString();
      for (const branch of draft.recursiveFactory.branchOrchestrators ?? []) {
        const execution = records.find((candidate) => candidate.branchId === branch.branchId);
        if (!execution) continue;
        branch.status = execution.status;
        branch.updatedAt = execution.updatedAt;
      }
      draft.status = phase === "branch_execution_blocked" ? "blocked" : "needs_approval";
      draft.lifecycleStage = phase === "branch_execution_blocked" ? "BLOCKED" : "APPROVAL";
    });
  }

  private async blockRecursiveBranchExecution(sessionId: string, reason: string) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveFactory ??= { phase: "branch_execution_blocked", executionStarted: false, updatedAt: new Date().toISOString() };
      draft.recursiveFactory.phase = "branch_execution_blocked";
      draft.recursiveFactory.updatedAt = new Date().toISOString();
      draft.status = "blocked";
      draft.lifecycleStage = "BLOCKED";
      draft.nextAction = undefined;
      draft.reasoningSummaries.push(`Recursive branch execution blocked: ${reason}`);
    });
  }

  private async advanceRecursiveBranchScheduler(sessionId: string) {
    let branchToPropose: string | undefined;
    let nestedToPropose: { branchId: string; subtaskId: string } | undefined;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const factory = draft.recursiveFactory;
      const records = factory?.branchExecutions;
      if (!factory || !records?.length) return;
      const now = new Date().toISOString();
      for (const branch of records) {
        if (!branch.nestedSubtasks?.length) continue;
        const subtaskId = advanceNestedSubtasks(branch, now);
        if (subtaskId && !nestedToPropose) nestedToPropose = { branchId: branch.branchId, subtaskId };
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
      if (!activeWrite && !activeNestedWrite && !nestedToPropose) {
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
              nestedToPropose = { branchId: next.branchId, subtaskId };
            }
          } else {
            branchToPropose = next.branchId;
          }
        }
      }
      factory.activeBranchId = branchToPropose;
      factory.executionStarted = true;
      factory.phase = records.some((branch) => branch.status === "blocked_conflict" || branch.status === "blocked_failed_dependency")
        && !records.some((branch) => isActiveWriteBranch(branch) || branch.status === "ready")
          ? "branch_execution_blocked"
          : "branch_execution_running";
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
    if (nestedToPropose) {
      await this.proposePatchForNestedSubtask(sessionId, nestedToPropose.branchId, nestedToPropose.subtaskId);
    } else if (branchToPropose) {
      await this.proposePatchForScheduledBranch(sessionId, branchToPropose);
    }
  }

  private async proposePatchForNestedSubtask(sessionId: string, branchId: string, subtaskId: string) {
    const current = this.requireSession(sessionId);
    const branch = current.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
    const subtask = branch?.nestedSubtasks?.find((candidate) => candidate.subtaskId === subtaskId);
    if (!branch || !subtask || subtask.proposedPatchId || !subtask.plannedPatch) return;
    const patchTarget = subtask.plannedPatch.targetFile;
    const replacementText = subtask.plannedPatch.replacementText;
    const tools = new ToolRegistry(current.workspacePath);
    const exists = tools.workspace.fileExists(patchTarget);
    const currentContent = exists ? tools.workspace.readWholeFile(patchTarget) : "";
    const patchInput: Omit<PatchProposal, "id" | "sessionId" | "createdAt"> = {
      title: `Nested subtask patch: ${subtask.objective}`,
      summary: `Nested sub-orchestrator subtask ${subtask.subtaskId} proposed a patch for ${patchTarget}. Runtime did not write files.`,
      riskLevel: "low",
      filesChanged: [{
        path: patchTarget,
        changeType: exists ? "modify" : "create",
        explanation: `Nested subtask ${subtask.subtaskId} may only propose this patch; Rust apply authority must change disk.`
      }],
      artifacts: [{ path: patchTarget, content: replacementText }],
      unifiedDiff: exists
        ? createWholeFileReplaceDiff(patchTarget, currentContent, replacementText)
        : createFileDiff(patchTarget, replacementText),
      requiresApproval: true,
      status: "proposed"
    };
    const patch = tools.patch.propose(patchInput, sessionId);
    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: {
        branchId,
        subtaskId,
        patchId: patch.id,
        filesChanged: patch.filesChanged,
        directRuntimeWrite: false,
        nestedDepth: 1
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const scheduledBranch = draft.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
      const scheduledSubtask = scheduledBranch?.nestedSubtasks?.find((candidate) => candidate.subtaskId === subtaskId);
      if (!scheduledBranch || !scheduledSubtask) return;
      const now = new Date().toISOString();
      scheduledBranch.status = "running";
      scheduledBranch.active = true;
      scheduledBranch.blockedReason = "Parent branch is waiting for required nested subtasks.";
      scheduledSubtask.status = "patch_proposed";
      scheduledSubtask.proposedPatchId = patch.id;
      scheduledSubtask.active = true;
      scheduledSubtask.updatedAt = now;
      scheduledBranch.nestedRollup = buildNestedRollup(scheduledBranch, draft.patchProposals);
      scheduledBranch.updatedAt = now;
      draft.recursiveFactory!.phase = "branch_execution_running";
      draft.recursiveFactory!.executionStarted = true;
      draft.recursiveFactory!.activeBranchId = branchId;
      draft.recursiveFactory!.updatedAt = now;
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPROVAL";
      draft.nextAction = {
        kind: "approve_patch",
        patchId: patch.id,
        message: "Nested subtask patch proposed. Review and approve it before Rust apply."
      };
      draft.reasoningSummaries.push(`Nested subtask ${subtaskId} proposed patch ${patch.id}; no runtime file write occurred.`);
    });
    const updatedBranch = this.findBranchExecution(sessionId, branchId);
    if (updatedBranch) this.sessionManager.publishFactoryEvent({ type: "runtime.branch_execution.patch_proposed", sessionId, branchExecution: updatedBranch });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: [
        `Nested subtask execution started for ${subtask.objective}.`,
        "",
        `Patch proposed: ${patch.id}`,
        "Execution has not directly written files. Rust apply authority must apply the approved patch."
      ].join("\n")
    });
  }

  private async proposePatchForScheduledBranch(sessionId: string, branchId: string) {
    const current = this.requireSession(sessionId);
    const branch = current.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
    if (!branch || branch.proposedPatchId) return;
    if (!branch.executionContext.fileScopes.length) return;
    this.sessionManager.publishFactoryEvent({ type: "runtime.branch_execution.started", sessionId, branchExecution: branch });
    const patchTarget = branch.plannedPatch?.targetFile ?? branch.executionContext.fileScopes[0]!;
    const replacementText = branch.plannedPatch?.replacementText ?? `Recursive branch execution marker for ${sessionId}/${branch.branchId}\n`;
    const tools = new ToolRegistry(current.workspacePath);
    const exists = tools.workspace.fileExists(patchTarget);
    const currentContent = exists ? tools.workspace.readWholeFile(patchTarget) : "";
    const patchInput: Omit<PatchProposal, "id" | "sessionId" | "createdAt"> = {
      title: `Branch patch: ${branch.title}`,
      summary: `Controlled branch execution proposed a patch for ${patchTarget}. Runtime did not write files.`,
      riskLevel: "low",
      filesChanged: [{
        path: patchTarget,
        changeType: exists ? "modify" : "create",
        explanation: `Branch ${branch.branchId} may only propose this patch; Rust apply authority must change disk.`
      }],
      artifacts: [{ path: patchTarget, content: replacementText }],
      unifiedDiff: exists
        ? createWholeFileReplaceDiff(patchTarget, currentContent, replacementText)
        : createFileDiff(patchTarget, replacementText),
      requiresApproval: true,
      status: "proposed"
    };
    const patch = tools.patch.propose(patchInput, sessionId);
    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: {
        branchId,
        patchId: patch.id,
        filesChanged: patch.filesChanged,
        directRuntimeWrite: false
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const scheduled = draft.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
      if (!scheduled) return;
      scheduled.status = "patch_proposed";
      scheduled.reviewStatus = "pending";
      scheduled.proposedPatchId = patch.id;
      scheduled.active = true;
      scheduled.updatedAt = new Date().toISOString();
      draft.recursiveFactory!.phase = "branch_execution_running";
      draft.recursiveFactory!.executionStarted = true;
      draft.recursiveFactory!.activeBranchId = branchId;
      draft.recursiveFactory!.updatedAt = scheduled.updatedAt;
      const planned = draft.recursiveFactory!.branchOrchestrators?.find((candidate) => candidate.branchId === branchId);
      if (planned) {
        planned.status = scheduled.status;
        planned.updatedAt = scheduled.updatedAt;
      }
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPROVAL";
      draft.nextAction = {
        kind: "approve_patch",
        patchId: patch.id,
        message: "Branch patch proposed. Review and approve it before Rust apply."
      };
      draft.reasoningSummaries.push(`Branch ${branchId} proposed patch ${patch.id}; no runtime file write occurred.`);
    });
    const proposedBranch = this.findBranchExecution(sessionId, branchId)!;
    this.sessionManager.publishFactoryEvent({ type: "runtime.branch_execution.patch_proposed", sessionId, branchExecution: proposedBranch });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: [
        `Branch execution started for ${proposedBranch.title}.`,
        "",
        `Patch proposed: ${patch.id}`,
        "Execution has not directly written files. Rust apply authority must apply the approved patch."
      ].join("\n")
    });
  }

  private findBranchExecution(sessionId: string, branchId: string) {
    return this.requireSession(sessionId).recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branchId);
  }

  private async prepareRecursiveValidation(sessionId: string, branchId: string) {
    const session = this.requireSession(sessionId);
    const evaluation = evaluateRecursiveBranchValidation(session, branchId);
    const shouldRequest =
      evaluation.strategy.kind === "command"
      && evaluation.strategy.command
      && evaluation.strategy.classification !== "blocked"
      && !hasMatchingValidationRequestOrExecution(session, evaluation.strategy);
    if (!shouldRequest) return evaluation;

    const request = buildRecursiveValidationCommandRequest({
      sessionId,
      workspacePath: session.workspacePath,
      strategy: evaluation.strategy
    });
    if (!request) return evaluation;
    await this.sessionManager.addCommandRequest(sessionId, request);
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "validation.requested",
      title: request.command,
      summary: evaluation.strategy.reason,
      payload: {
        branchId,
        commandRequestId: request.id,
        discoveredCommands: evaluation.discoveredCommands,
        selectedStrategy: evaluation.strategy
      },
      status: request.status === "blocked" ? "blocked" : "proposed",
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_recursive_validation_${request.id}`,
      sessionId,
      type: "verification",
      title: "Recursive Validation Requested",
      summary: evaluation.strategy.reason,
      payload: {
        branchId,
        commandRequestId: request.id,
        discoveredCommands: evaluation.discoveredCommands,
        selectedStrategy: evaluation.strategy
      },
      createdAt: new Date().toISOString()
    });
    return evaluateRecursiveBranchValidation(this.requireSession(sessionId), branchId);
  }

  private async prepareRecursiveRepairLoop(sessionId: string, finalReport: RecursiveFinalReport): Promise<RecursiveFinalReport> {
    const session = this.requireSession(sessionId);
    const existing = session.recursiveFactory?.repair;
    if (finalReport.finalValidationState !== "verified_failed") {
      return existing
        ? { ...finalReport, repair: { ...existing, finalOutcome: finalReport.finalValidationState, updatedAt: new Date().toISOString() } }
        : finalReport;
    }

    if (existing?.status === "repair_not_attempted" || existing?.status === "revalidation_requested" || existing?.status === "revalidated" || existing?.repairPatchId) {
      return { ...finalReport, repair: refreshRecursiveRepairRecord(session, finalReport, existing) };
    }

    const diagnosis = diagnoseRecursiveValidationFailure(session, finalReport);
    if (!diagnosis) return finalReport;
    const validationAttempt = buildRecursiveValidationAttempt(session, finalReport, "initial", 1);
    const eligibility = evaluateRecursiveRepairEligibility(session, diagnosis, existing?.attemptCount ?? 0);
    const now = new Date().toISOString();
    let repair: RecursiveRepairRecord = {
      id: `recursive_repair_${sessionId}`,
      sessionId,
      status: eligibility.status === "eligible" ? "diagnosed" : "repair_not_attempted",
      attemptCount: existing?.attemptCount ?? 0,
      maxAttempts: 1,
      diagnosis,
      eligibility,
      validationAttempts: validationAttempt ? [validationAttempt] : [],
      finalOutcome: finalReport.finalValidationState,
      summary: eligibility.status === "eligible"
        ? "Validation failed and is eligible for one scoped repair patch proposal."
        : `Repair not attempted: ${eligibility.reasons.join("; ")}`,
      createdAt: now,
      updatedAt: now
    };

    if (eligibility.status !== "eligible") return { ...finalReport, repair };
    repair = await this.proposeRecursiveRepairPatch(sessionId, finalReport, repair);
    return { ...finalReport, repair };
  }

  private async proposeRecursiveRepairPatch(sessionId: string, finalReport: RecursiveFinalReport, repair: RecursiveRepairRecord): Promise<RecursiveRepairRecord> {
    const session = this.requireSession(sessionId);
    const tools = new ToolRegistry(session.workspacePath);
    const relevantFiles = collectRepairFileExcerpts(tools, repair.eligibility.relatedFiles);
    if (!relevantFiles.length) {
      return markRecursiveRepairNotAttempted(repair, "No readable related file excerpt was available for a safe repair proposal.");
    }

    const prompt = [
      "Create one reviewable recursive validation repair patch intent as strict JSON.",
      "Do not write files. Fix only the proven failure and keep the patch inside the related files.",
      "Return JSON with: title, summary, intents[{path,operation,anchorText?,preimageText?,replacementText,reason,risk}], suggestedCommands.",
      "Allowed operations: create_file, replace_range. Prefer replace_range for existing files.",
      `Failed command: ${repair.diagnosis.command}`,
      `Validation diagnosis: ${JSON.stringify(repair.diagnosis)}`,
      `Allowed related files: ${JSON.stringify(repair.eligibility.relatedFiles)}`,
      `Relevant file excerpts: ${JSON.stringify(relevantFiles)}`,
      `Final validation reason: ${finalReport.validationDiscovery?.statusReason ?? finalReport.recommendedNextStep}`
    ].join("\n");

    const generated = await invokeReasoningProviderStructured<Partial<RepairPatchIntentModel>>(
      this.getProvider(session),
      { systemPrompt: "You produce strict JSON repair patch intents for one small recursive validation failure only.", userPrompt: prompt },
      runPatchIntentSchema
    );
    const validation = validateStructuredOutput(generated, runPatchIntentSchema);
    if (!validation.valid || !generated.intents?.length) {
      return markRecursiveRepairNotAttempted(repair, "No valid scoped repair patch intent was generated.");
    }

    let patchInput: Omit<PatchProposal, "id" | "sessionId" | "createdAt">;
    try {
      patchInput = compileRepairPatchProposal(session.workspacePath, tools, generated as RepairPatchIntentModel);
    } catch (error) {
      return markRecursiveRepairNotAttempted(repair, `Repair patch compile failed: ${formatRuntimeError(error)}`);
    }

    const allowedFiles = new Set(repair.eligibility.relatedFiles.map(normalizeWorkspaceRelativePath));
    const patchFiles = patchInput.filesChanged.map((file) => normalizeWorkspaceRelativePath(file.path));
    const outOfScope = patchFiles.filter((file) => !allowedFiles.has(file));
    const patch = tools.patch.propose(patchInput, sessionId);
    const patchValidation = tools.patch.validate(patch);
    if (!patchValidation.valid || outOfScope.length || patch.filesChanged.length > 3) {
      return markRecursiveRepairNotAttempted(repair, uniqueRuntimeStrings([
        ...patchValidation.errors,
        outOfScope.length ? `Repair patch touched files outside related scope: ${outOfScope.join(", ")}` : undefined,
        patch.filesChanged.length > 3 ? "Repair patch touched more than three files." : undefined
      ].filter(Boolean) as string[]).join("; ") || "Generated repair patch failed scope validation.");
    }

    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: {
        patchId: patch.id,
        repairId: repair.id,
        diagnosisId: repair.diagnosis.id,
        filesChanged: patch.filesChanged,
        directRuntimeWrite: false,
        unifiedDiff: patch.unifiedDiff
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "patch.proposed",
      title: patch.title,
      summary: patch.summary,
      payload: { patchId: patch.id, recursiveRepairId: repair.id, diagnosis: repair.diagnosis },
      status: "proposed",
      createdAt: new Date().toISOString()
    });

    return {
      ...repair,
      status: "patch_proposed",
      attemptCount: repair.attemptCount + 1,
      repairPatchId: patch.id,
      repairPatchStatus: patch.status,
      summary: `Proposed one scoped repair patch ${patch.id}; Rust apply is required before any fix is claimed.`,
      updatedAt: new Date().toISOString()
    };
  }

  private async updateRecursiveRepairFromPatch(sessionId: string, patchId: string, status: PatchProposal["status"]) {
    const session = this.requireSession(sessionId);
    const repair = session.recursiveFactory?.repair;
    if (!repair?.repairPatchId || repair.repairPatchId !== patchId) return;
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
      return;
    }
    await this.queueRecursiveRepairRevalidation(sessionId, patchId);
  }

  private async queueRecursiveRepairRevalidation(sessionId: string, patchId: string) {
    const session = this.requireSession(sessionId);
    const repair = session.recursiveFactory?.repair;
    const strategy = session.recursiveFactory?.finalReport?.validationDiscovery?.chosenStrategy;
    if (!repair || repair.repairPatchId !== patchId || !strategy || strategy.kind !== "command" || !strategy.command) return;
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
        return;
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
  }

  private async updateRecursiveRepairFromCommandResult(sessionId: string, record: CommandExecutionRecord) {
    const session = this.requireSession(sessionId);
    const repair = session.recursiveFactory?.repair;
    if (!repair?.revalidationRequestId || repair.revalidationRequestId !== record.requestId) return;
    const attempt = buildRecursiveValidationAttemptFromExecution(record, "repair_revalidation", 2);
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
        branch.nestedRollup = buildNestedRollup(branch, draft.patchProposals);
        branch.updatedAt = new Date().toISOString();
      }
      if (draft.recursiveFactory?.finalReport?.repair) draft.recursiveFactory.finalReport.repair = draftRepair;
    });
    await this.refreshRecursiveFanIn(sessionId);
  }

  private async updateBranchExecutionFromPatch(sessionId: string, patchId: string) {
    const session = this.requireSession(sessionId);
    const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
    if (!patch) return;
    const branch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === patchId);
    if (!branch) {
      const nestedOwner = session.recursiveFactory?.branchExecutions
        ?.map((candidate) => ({
          branch: candidate,
          subtask: candidate.nestedSubtasks?.find((nested) => nested.proposedPatchId === patchId)
        }))
        .find((candidate) => candidate.subtask);
      if (!nestedOwner?.subtask) return;
      await this.updateNestedSubtaskFromPatch(sessionId, nestedOwner.branch.branchId, nestedOwner.subtask.subtaskId, patchId);
      return;
    }
    const recursiveValidation = patch.status === "applied"
      ? await this.prepareRecursiveValidation(sessionId, branch.branchId)
      : evaluateRecursiveBranchValidation(this.requireSession(sessionId), branch.branchId);
    let eventType: Parameters<SessionManager["publishFactoryEvent"]>[0]["type"] = "runtime.branch_execution.reviewing";
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const factory = draft.recursiveFactory;
      const current = factory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === patchId);
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
    const updated = this.findBranchExecution(sessionId, branch.branchId);
    if (updated) this.sessionManager.publishFactoryEvent({ type: eventType, sessionId, branchExecution: updated });
    await this.advanceRecursiveBranchScheduler(sessionId);
    await this.refreshRecursiveFanIn(sessionId);
  }

  private async updateNestedSubtaskFromPatch(sessionId: string, branchId: string, subtaskId: string, patchId: string) {
    const session = this.requireSession(sessionId);
    const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
    if (!patch) return;
    const recursiveValidation = patch.status === "applied"
      ? await this.prepareRecursiveValidation(sessionId, branchId)
      : evaluateRecursiveBranchValidation(this.requireSession(sessionId), branchId);
    let eventType: Parameters<SessionManager["publishFactoryEvent"]>[0]["type"] = "runtime.branch_execution.reviewing";
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
        branch.validationStatus = nestedBranchValidationStatus(branch);
        branch.nestedRollup = buildNestedRollup(branch, draft.patchProposals);
        const requiredDone = requiredNestedSubtasksTerminal(branch);
        branch.status = requiredDone && branch.validationStatus === "verified_passed"
          ? "completed"
          : branch.validationStatus === "verified_failed"
            ? "failed"
            : "validation_pending";
        branch.active = false;
        branch.blockedReason = branch.status === "validation_pending"
          ? "Parent branch is waiting on nested subtask validation evidence."
          : branch.nestedRollup?.limitations.join("; ");
        eventType = branch.status === "failed" ? "runtime.branch_execution.failed" : branch.status === "completed" ? "runtime.branch_execution.completed" : "runtime.branch_execution.validation_pending";
      } else if (patch.status === "apply_failed") {
        subtask.status = "failed";
        subtask.validationStatus = "not_run_runtime_error";
        subtask.active = false;
        subtask.blockedReason = "Rust apply authority reported apply_failed for nested subtask.";
        branch.status = "failed";
        branch.validationStatus = "not_run_runtime_error";
        branch.active = false;
        branch.blockedReason = subtask.blockedReason;
        branch.nestedRollup = buildNestedRollup(branch, draft.patchProposals);
        eventType = "runtime.branch_execution.failed";
      }
      branch.nestedRollup = buildNestedRollup(branch, draft.patchProposals);
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
    const updated = this.findBranchExecution(sessionId, branchId);
    if (updated) this.sessionManager.publishFactoryEvent({ type: eventType, sessionId, branchExecution: updated });
    await this.advanceRecursiveBranchScheduler(sessionId);
    await this.refreshRecursiveFanIn(sessionId);
  }

  private async updateActiveBranchValidation(sessionId: string) {
    const session = this.requireSession(sessionId);
    const pendingPatchIds = uniqueRuntimeStrings((session.recursiveFactory?.branchExecutions ?? []).flatMap((branch) => [
      branch.patchApplied && branch.status === "validation_pending" && branch.proposedPatchId ? branch.proposedPatchId : undefined,
      ...(branch.nestedSubtasks ?? []).map((subtask) =>
        subtask.patchApplied && subtask.status === "validation_pending" && subtask.proposedPatchId ? subtask.proposedPatchId : undefined
      )
    ].filter(Boolean) as string[]));
    if (!pendingPatchIds.length) return;
    for (const patchId of pendingPatchIds) {
      await this.updateBranchExecutionFromPatch(sessionId, patchId);
    }
    await this.refreshRecursiveFanIn(sessionId);
  }

  private async refreshRecursiveFanIn(sessionId: string) {
    const session = this.requireSession(sessionId);
    const factory = session.recursiveFactory;
    if (!factory?.branchExecutions?.length) return;
    const branchResults = buildRecursiveBranchResults(session);
    if (!branchResults.length) return;
    const branchValidations = buildRecursiveBranchValidationRecords(session, branchResults);
    const integrationSummary = buildRecursiveIntegrationSummary(session, branchResults, branchValidations);
    const initialFinalReport = buildRecursiveFinalReport(session, branchResults, integrationSummary, branchValidations);
    const finalReport = await this.prepareRecursiveRepairLoop(sessionId, initialFinalReport);
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
      if (finalReport.finalStatus === "passed") {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        draft.nextAction = undefined;
      } else if (finalReport.repair?.repairPatchId && (finalReport.repair.status === "patch_proposed" || finalReport.repair.status === "awaiting_rust_apply")) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPROVAL";
        draft.nextAction = {
          kind: "approve_patch",
          patchId: finalReport.repair.repairPatchId,
          message: "Recursive validation failed. Review and approve the proposed repair patch before Rust apply."
        };
      } else if (finalReport.repair?.status === "revalidation_requested") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = {
          kind: "approve_commands",
          message: "Recursive repair patch was applied. Run the queued revalidation command through Rust."
        };
      } else if (finalReport.finalStatus === "failed") {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
      } else {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = finalReport.validationHierarchy.some((entry) => entry.truthStatus === "not_run_needs_approval")
          ? { kind: "approve_commands", message: "Final recursive validation is unverified. Approve and run the pending validation commands through Rust." }
          : draft.nextAction;
      }
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
  }

  private getProvider(session: AgentRuntimeSession) {
    if (this.options.providerFactory) {
      return this.options.providerFactory(session);
    }
    return createRealProvider(session.providerConfig, this.config.providerRequestTimeoutMs);
  }

  private async advanceRunToGreenFromCommandResult(sessionId: string, record: CommandExecutionRecord) {
    const session = this.requireSession(sessionId);
    const runToGreen = session.runToGreen;
    if (!runToGreen || runToGreen.status !== "running") {
      return;
    }

    const currentAttempt = getCurrentRunToGreenAttempt(runToGreen);
    if (!currentAttempt) {
      return;
    }

    const backgroundRunning =
      record.status === "running" ||
      record.status === "executing" ||
      record.backgroundJob?.status === "running" ||
      record.provenance?.background === true;
    const alternate = findAlternateRunToGreenCommand(runToGreen);
    const diagnosis: RunToGreenDiagnosis | undefined = backgroundRunning
      ? undefined
      : record.diagnosis
        ? {
            category: record.diagnosis.category === "not_git_repository"
              ? "not_git_repository"
              : record.diagnosis.category === "command_not_found"
                ? "command_not_found"
                : "unknown",
            confidence: record.diagnosis.category === "unknown" ? "low" : "high",
            evidence: {
              command: record.command,
              exitCode: record.exitCode,
              stdoutSummary: summarizeRuntimeOutput(record.stdout),
              stderrSummary: summarizeRuntimeOutput(record.stderr)
            },
            safeFixAvailable: false,
            requiresApproval: false,
            reason: record.diagnosis.summary
          }
      : record.status === "executed" || record.status === "completed"
        ? record.exitCode === 0
          ? undefined
          : diagnoseRunToGreenFailure({
              command: record.command,
              exitCode: record.exitCode,
              stdout: record.stdout,
              stderr: record.stderr,
              modulePlan: session.moduleExecutionPlan,
              hasAlternativeCommand: Boolean(alternate)
            })
        : diagnoseRunToGreenFailure({
            command: record.command,
            exitCode: record.exitCode,
            stdout: record.stdout,
            stderr: record.stderr,
            modulePlan: session.moduleExecutionPlan,
            hasAlternativeCommand: Boolean(alternate)
          });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const state = draft.runToGreen;
      if (!state) return;
      const attempt = state.attempts.find((entry) => entry.attemptNumber === state.currentAttempt);
      if (!attempt) return;
      attempt.completedAt = new Date().toISOString();
      attempt.exitCode = record.exitCode;
      attempt.stdoutSummary = summarizeRuntimeOutput(record.stdout);
      attempt.stderrSummary = summarizeRuntimeOutput(record.stderr);
      attempt.diagnosis = diagnosis;
      if (backgroundRunning) {
        attempt.status = "failed";
        attempt.stopReason = "Background or non-terminal command state does not count as green.";
        state.status = "blocked";
        state.finalStatus = "blocked";
        state.blockerReason = "The selected command started a background or non-terminal process, so the run-to-green loop stopped without claiming success.";
      } else if ((record.status === "executed" || record.status === "completed") && record.exitCode === 0) {
        attempt.status = "passed";
        state.status = "passed";
        state.finalStatus = "green";
        state.blockerReason = undefined;
      } else {
        attempt.status = "failed";
        state.finalStatus = "not_green";
      }
      state.updatedAt = new Date().toISOString();
    });

    const updated = this.requireSession(sessionId);
    const updatedRun = updated.runToGreen;
    const updatedAttempt = updatedRun ? getCurrentRunToGreenAttempt(updatedRun) : undefined;
    if (!updatedRun || !updatedAttempt || updatedRun.status !== "running") {
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if ((record.status === "executed" || record.status === "completed") && record.exitCode === 0) {
      await this.recordRunToGreenDecision(sessionId, undefined, record.command, "Selected command passed; the bounded repair loop stopped successfully.");
      return;
    }

    const previousFailedAttempt = updatedRun.attempts
      .filter((entry) => entry.attemptNumber < updatedRun.currentAttempt && entry.status === "failed")
      .at(-1);
    const repeatedFailure =
      createDiagnosisFingerprint(previousFailedAttempt?.diagnosis) !== "" &&
      createDiagnosisFingerprint(previousFailedAttempt?.diagnosis) === createDiagnosisFingerprint(diagnosis);
    if (repeatedFailure) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "The same diagnosis repeated without clear progress, so the bounded repair loop stopped.";
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if (updatedRun.currentAttempt >= updatedRun.maxAttempts) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "max_attempts_reached";
        draft.runToGreen.finalStatus = "not_green";
        draft.runToGreen.blockerReason = `Run-to-green stopped after ${draft.runToGreen.maxAttempts} attempt(s).`;
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if ((diagnosis?.category === "script_missing" || diagnosis?.category === "command_not_found") && alternate) {
      await this.queueRunToGreenCommandRequest(sessionId, alternate, diagnosis.reason);
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if (!diagnosis || diagnosis.confidence === "low" || diagnosis.category === "unknown" || !diagnosis.safeFixAvailable) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = diagnosis?.category === "unknown" ? "blocked" : "not_green";
        draft.runToGreen.blockerReason = diagnosis?.reason ?? "Run-to-green could not continue safely.";
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    await this.proposeRunToGreenRepair(sessionId, record, diagnosis);
    await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
  }

  private async proposeRunToGreenRepair(sessionId: string, record: CommandExecutionRecord, diagnosis: NonNullable<ReturnType<typeof diagnoseRunToGreenFailure>>) {
    const session = this.requireSession(sessionId);
    const modulePlan = session.moduleExecutionPlan;
    if (!modulePlan) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "No scoped module plan was available for a safe repair patch.";
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      return;
    }

    const tools = new ToolRegistry(session.workspacePath);
    const provider = this.getProvider(session);
    const relevantFiles = collectRepairFileExcerpts(tools, uniqueRuntimeStrings([
      diagnosis.evidence.filePath ?? "",
      ...modulePlan.relevantFiles
    ]));
    const repairObjectiveSource = session.runToGreen?.objective ?? session.userPrompt;
    const repairUnderstanding = createConversationUnderstanding(repairObjectiveSource);
    const repairObjective = repairUnderstanding.intentDecision.kind === "direct_conversation"
      ? repairObjectiveSource
      : repairUnderstanding.workspaceMessage || repairObjectiveSource;
    const prompt = buildRepairPatchPrompt({
      objective: repairObjective,
      command: record.command,
      diagnosis,
      modulePlan,
      relevantFiles
    });
    const generated = await invokeReasoningProviderStructured<Partial<RepairPatchIntentModel>>(
      provider,
      { systemPrompt: "You produce strict JSON repair patch intents for small scoped fixes only. Any title field you return must be at most four words.", userPrompt: prompt },
      runPatchIntentSchema
    );
    const validation = validateStructuredOutput(generated, runPatchIntentSchema);
    if (!validation.valid || !generated.intents?.length) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "No safe scoped repair patch could be generated confidently.";
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      return;
    }

    const patchInput = compileRepairPatchProposal(session.workspacePath, tools, generated as RepairPatchIntentModel);
    const patch = tools.patch.propose(patchInput, sessionId);
    const patchValidation = tools.patch.validate(patch);
    const scopeValidation = validatePatchAgainstModulePlan(modulePlan, patch, tools.workspace);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const state = draft.runToGreen;
      if (!state) return;
      const attempt = state.attempts.find((entry) => entry.attemptNumber === state.currentAttempt);
      if (attempt) {
        attempt.proposedFixSummary = patch.summary;
        attempt.changedFiles = patch.filesChanged.map((file) => file.path);
        attempt.scopeVerdict = scopeValidation.verdict;
      }
      draft.latestScopeValidation = scopeValidation;
      if (!patchValidation.valid || scopeValidation.verdict === "blocked") {
        state.status = "blocked";
        state.finalStatus = "blocked";
        state.blockerReason = !patchValidation.valid
          ? `Repair patch validation failed: ${patchValidation.errors.join("; ")}`
          : scopeValidation.reasons[0] ?? "Repair patch exceeded the scoped module boundary.";
        state.updatedAt = new Date().toISOString();
        return;
      }
      state.pendingRepairPatchId = patch.id;
      state.pendingRerunCommand = record.command;
      state.pendingRerunReason = `Retry ${record.command} after applying the scoped repair patch.`;
      state.updatedAt = new Date().toISOString();
      draft.reviewGate = draft.reviewGate
        ? {
            ...draft.reviewGate,
            scopeValidation,
            recommendation: scopeValidation.verdict === "needs_review" ? "caution" : draft.reviewGate.recommendation
          }
        : draft.reviewGate;
    });

    const after = this.requireSession(sessionId);
    if (after.runToGreen?.status === "blocked") {
      return;
    }

    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: { patchId: patch.id, unifiedDiff: patch.unifiedDiff, filesChanged: patch.filesChanged },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "patch.proposed",
      title: patch.title,
      summary: patch.summary,
      payload: { patchId: patch.id, diagnosis },
      status: "proposed",
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "scope.validation.requested",
      title: "Run-to-green scope validation",
      summary: `Validated ${patch.filesChanged.length} repair file(s) against the module plan.`,
      payload: { patchId: patch.id, verdict: scopeValidation.verdict, reasons: scopeValidation.reasons },
      status: scopeValidation.verdict === "blocked" ? "blocked" : "executed",
      createdAt: new Date().toISOString()
    });
  }

  private async queuePendingRunToGreenRerun(session: AgentRuntimeSession, patchId: string, reason: string) {
    if (!session.runToGreen || session.runToGreen.pendingRepairPatchId !== patchId || !session.runToGreen.pendingRerunCommand) {
      return;
    }
    const selected = session.runToGreen.selectedCommands.find((command) => command.command === session.runToGreen?.pendingRerunCommand);
    if (!selected) {
      await this.sessionManager.updateSession(session.id, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "Repair patch applied, but the rerun command could not be recovered safely.";
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      return;
    }
    await this.queueRunToGreenCommandRequest(session.id, selected, session.runToGreen.pendingRerunReason ?? reason);
  }

  private async queueRunToGreenCommandRequest(sessionId: string, command: { command: string; cwd: string; reason: string }, reason: string) {
    const session = this.requireSession(sessionId);
    const now = new Date().toISOString();
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (!draft.runToGreen) return;
      markNextRunToGreenAttempt(draft.runToGreen, {
        command: command.command,
        cwd: command.cwd,
        source: "project_intake_command",
        reason
      }, reason, now);
    });
    const request = buildRuntimeCommandRequest(sessionId, command.command, command.cwd, reason);
    await this.sessionManager.addCommandRequest(sessionId, request);
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "command.requested",
      title: request.command,
      summary: reason,
      payload: { commandRequestId: request.id, risk: request.risk, runToGreen: true },
      status: request.status === "blocked" ? "blocked" : "proposed",
      createdAt: now
    });
    if (request.status === "blocked") {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = `Selected rerun command was blocked by policy: ${request.command}`;
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
    }
  }

  private async recordRunToGreenDecision(sessionId: string, diagnosis: NonNullable<ReturnType<typeof diagnoseRunToGreenFailure>> | undefined, command: string, successNote?: string) {
    const session = this.requireSession(sessionId);
    if (!session.runToGreen) return;
    const finding = successNote
      ? "Run-to-green attempt passed."
      : diagnosis
        ? `Run-to-green diagnosed ${diagnosis.category}.`
        : "Run-to-green updated attempt state.";
    const decision = successNote
      ? successNote
      : diagnosis?.safeFixAvailable
        ? "Attempt a narrow scoped repair or grounded rerun."
        : "Stop the bounded repair loop and ask for manual inspection.";
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.decisionLedger.push({
        id: `decision_${randomUUID()}`,
        sessionId,
        category: successNote ? "verification_note" : diagnosis?.safeFixAvailable ? "decision" : "risk",
        finding,
        decision,
        rationaleSummary: diagnosis?.reason ?? successNote ?? `Recorded command result for ${command}.`,
        evidenceRefs: [{
          type: "command",
          commandId: draft.commandRequests.at(-1)?.id ?? `unknown_${command}`
        }],
        linkedFiles: diagnosis?.evidence.filePath ? [diagnosis.evidence.filePath] : [],
        uncertainty: diagnosis?.confidence === "low" || diagnosis?.confidence === "unknown" ? diagnosis.reason : undefined,
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"],
        createdAt: new Date().toISOString()
      });
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }

  private async handlePendingAction(session: AgentRuntimeSession, message: string): Promise<{ handled: boolean; resumePrompt?: string }> {
    if (!session.nextAction) return { handled: false };
    const normalized = message.trim().toLowerCase();
    const maybeClarify = session.nextAction as typeof session.nextAction | PlanClarifyAction;
    if (session.nextAction.kind === "clarify_request") {
      const resumePrompt = `${session.nextAction.originalRequest}\n\nClarification: ${message.trim()}`;
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.userPrompt = resumePrompt;
        draft.nextAction = undefined;
      });
      return { handled: false, resumePrompt };
    }
    if (session.nextAction.kind === "clarify_product_spec") {
      const resumePrompt = `${session.userPrompt}\n\nProduct clarification: ${message.trim()}`;
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.userPrompt = resumePrompt;
        draft.nextAction = undefined;
      });
      return { handled: false, resumePrompt };
    }
    if (maybeClarify.kind === "clarify_plan") {
      const selected =
        maybeClarify.options.find((option) => option.id === normalized || option.label.toLowerCase() === normalized)
        ?? maybeClarify.options.find((option) => option.prompt.toLowerCase() === normalized);
      const clarification = (selected?.prompt ?? message).trim();
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined as AgentRuntimeSession["nextAction"];
        draft.thinkFirst = true;
        draft.userPrompt = `${draft.userPrompt}\n\nPlan mode clarification: ${clarification}`;
      });
      return { handled: false, resumePrompt: `${session.userPrompt}\n\nPlan mode clarification: ${clarification}` };
    }
    if (session.nextAction.kind === "confirm_plan") {
      if (/\b(proceed|continue|implement|go ahead|start)\b/.test(normalized)) {
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = undefined;
          draft.thinkFirst = false;
        });
        return { handled: false, resumePrompt: session.userPrompt };
      }
      await this.sessionManager.addMessage(session.id, {
        role: "system",
        content: "Okay. Review the plan and tell me when to proceed with implementation."
      });
      return { handled: true };
    }

    if (session.nextAction.kind === "confirm_preview") {
      if (/\b(run|open|yes|launch)\b/.test(normalized)) {
        const preview = session.nextAction.preview;
        let executionMessage = "Preview command approval is ready.";
        if (preview.command) {
          await this.sessionManager.addCommandRequest(session.id, {
            id: `cmd_${randomUUID()}`,
            sessionId: session.id,
            command: preview.command,
            cwd: session.workspacePath,
            risk: "safe",
            reason: "User requested preview launch; Rust terminal authority must execute it.",
            provenance: {
              source: "user",
              trigger: "manual",
              requestedBy: "user",
              reason: "Preview launch confirmation from the user."
            },
            status: "requested",
            createdAt: new Date().toISOString()
          });
        }
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = {
            kind: "preview_ready",
            message: executionMessage,
            preview
          };
        });
        await this.sessionManager.addMessage(session.id, {
          role: "system",
          content: `Preview is ready. Use the open button to launch ${preview.description.toLowerCase()}.`
        });
        return { handled: true };
      }

      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined;
      });
      await this.sessionManager.addMessage(session.id, {
        role: "system",
        content: "Okay. I left the result in review mode without running the preview."
      });
      return { handled: true };
    }

    return { handled: false };
  }

  private async startRecursiveFactory(sessionId: string, prompt: string, projectMap: import("@hivo/protocol").ProjectMap) {
    const questions = productSpecClarificationQuestions(prompt);
    if (questions.length) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.resolvedExecutionMode = "recursive_factory";
        draft.recursiveFactory = { phase: "clarification", executionStarted: false, updatedAt: new Date().toISOString() };
        draft.status = "needs_approval";
        draft.lifecycleStage = "PLAN";
        draft.nextAction = { kind: "clarify_product_spec", message: "I need focused clarification before drafting the Product Specification.", questions };
      });
      await this.sessionManager.addMessage(sessionId, { role: "system", content: ["Before I draft the Product Specification:", ...questions.map((question) => `- ${question}`)].join("\n") });
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

  private async addFactoryArtifact(sessionId: string, type: "product_spec" | "technical_plan" | "recursive_graph" | "branch_orchestrator", title: string, value: object) {
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

  private async runProviderBackedSwarmTurn(
    sessionId: string,
    message: string,
    provider: LlmProvider,
    providerTelemetry: ReturnType<typeof createProviderTelemetryRecorder>,
    conversationUnderstanding?: ConversationUnderstanding
  ) {
    const session = this.sessionManager.getSession(sessionId)!;
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "EXECUTION_DRAFT";
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.agentName = "Provider-Backed Swarm";
      draft.responseLanguage = conversationUnderstanding?.intentDecision.language === "arabic" ? "ar" : detectResponseLanguage(message);
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.reasoningSummaries.push("Real-provider orchestration is using provider-backed read-only swarm workers; deterministic mock workers are not accepted as the assistant answer.");
    });

    const swarmGoal = conversationUnderstanding?.workspaceMessage || message;
    const responseLanguage = conversationUnderstanding?.intentDecision.language === "arabic" ? "ar" : (session.responseLanguage ?? detectResponseLanguage(swarmGoal));
    const swarm = new SwarmAutopilotRuntime({
      workspacePath: session.workspacePath,
      mode: "deep",
      workerMode: "provider_read_only",
      providerFactory: () => provider,
      providerName: session.providerConfig?.providerName,
      modelName: session.providerConfig?.selectedModel,
      responseLanguage
    });
    const result = await swarm.run(swarmGoal);
    const workResults = await loadSwarmWorkResults(result.workItems);
    const terminalStatus = mapSwarmRunStatus(result.run.status, providerTelemetry.snapshot().lastError);
    const completedAt = new Date().toISOString();
    const summary = formatProviderBackedSwarmAnswer({
      prompt: swarmGoal,
      finalReport: result.finalReport,
      responseLanguage,
      debugMode: session.debugMode === true,
      providerCallCount: providerTelemetry.snapshot().providerRequestCount,
      workerCount: result.staffingPlan.recommended_total_logical_agents,
      workResults,
      status: terminalStatus,
      providerFailures: providerTelemetry.snapshot().providerFailureCount,
      providerTimeouts: providerTelemetry.snapshot().providerTimeoutCount,
      invalidStructuredOutputs: result.metrics.invalid_structured_outputs,
      retries: result.metrics.retries
    });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = terminalStatus;
      draft.lifecycleStage = terminalStatus === "completed" ? "DONE" : terminalStatus === "blocked" ? "BLOCKED" : "FAILED";
      draft.nextAction = undefined;
      draft.providerTelemetry = providerTelemetry.snapshot();
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.delegationDecision = {
        resolvedMode: "orchestrated_mode",
        selectedAgentCount: result.staffingPlan.recommended_total_logical_agents,
        selectedAgentRoles: Object.entries(result.staffingPlan.role_counts)
          .filter(([, count]) => count > 0)
          .map(([role, count]) => `${role} x${count}`),
        agentRoleReasons: result.staffingPlan.reasoning.map((reason, index) => ({
          agentName: `staffing_reason_${index + 1}`,
          reason
        })),
        estimatedComplexity: result.staffingPlan.task_complexity === "tiny" || result.staffingPlan.task_complexity === "small" ? "low" : result.staffingPlan.task_complexity === "medium" ? "medium" : "high",
        rationale: "Provider-backed swarm selected read-only agents automatically from repository scope, risk, and task complexity."
      };
      draft.tasks = result.workItems.map((item) => ({
        id: item.id,
        sessionId,
        title: `${item.required_role} ${item.type}`,
        status: mapSwarmWorkStatus(item.status),
        agentRole: item.required_role,
        createdAt: item.created_at
      }));
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.orchestration.selectedWorkerAgents = Object.entries(result.staffingPlan.role_counts)
        .filter(([, count]) => count > 0)
        .map(([role, count]) => `${role} x${count}`);
      draft.orchestration.agentRuns = result.agentInstances.map((agent) => ({
        id: agent.id,
        sessionId,
        agentName: agent.role,
        displayName: agent.role,
        role: agent.role,
        roleTitle: agent.role,
        lifecycleStage: terminalStatus === "completed" ? "DONE" : terminalStatus === "blocked" ? "BLOCKED" : "FAILED",
        artifactJson: {
          swarmRunId: result.run.id,
          currentWorkItemId: agent.current_work_item_id,
          workerMode: "provider_read_only"
        },
        objective: `Provider-backed read-only ${agent.role} work for ${swarmGoal}`,
        currentTask: agent.current_work_item_id,
        status: mapSwarmAgentStatus(agent.status),
        lastEvent: `Completed ${agent.completed_work_item_count} work item(s); failures ${agent.failure_count}.`,
        startedAt: agent.created_at,
        completedAt
      }));
      draft.orchestration.workerOutputs = workResults.map((workResult) => ({
        id: `worker_output_${workResult.work_item_id}`,
        sessionId,
        taskId: workResult.work_item_id,
        agentName: result.workItems.find((item) => item.id === workResult.work_item_id)?.required_role ?? "SwarmWorker",
        summary: workResult.summary,
        details: [...workResult.findings, ...workResult.unknowns.map((unknown) => `Unknown: ${unknown}`)],
        patchProposalIds: [],
        commandRequestIds: [],
        risks: workResult.risks,
        status: workResult.status === "succeeded" ? "completed" : workResult.status,
        createdAt: completedAt
      }));
      draft.runSummary = {
        status: terminalStatus === "completed" ? "completed" : terminalStatus === "blocked" ? "pending" : "failed",
        summary: `Provider-backed swarm ${result.run.status}; ${result.staffingPlan.recommended_total_logical_agents} logical agent(s), ${providerTelemetry.snapshot().providerRequestCount} provider request(s).`,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [{
          name: "Provider-backed read-only swarm",
          status: terminalStatus === "completed" ? "passed" : terminalStatus === "blocked" ? "blocked" : "failed",
          notes: [
            `workerMode=provider_read_only`,
            `providerRequests=${providerTelemetry.snapshot().providerRequestCount}`,
            `providerFailures=${providerTelemetry.snapshot().providerFailureCount}`,
            `providerTimeouts=${providerTelemetry.snapshot().providerTimeoutCount}`,
            `invalidStructuredOutputs=${result.metrics.invalid_structured_outputs}`,
            `retries=${result.metrics.retries}`,
            `finalResponseSource=${providerTelemetry.snapshot().finalResponseSource}`
          ]
        }],
        nextAction: terminalStatus === "completed" ? "Provider-backed session update completed." : "Inspect provider and swarm worker artifacts before retrying.",
        createdAt: completedAt
      };
      draft.responseLanguage = responseLanguage;
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: summary
    });
    return this.sessionManager.getSession(sessionId)!;
  }

  private async syncSessionOutcome(sessionId: string) {
    const before = this.requireSession(sessionId);
    const verification = buildRuntimeVerification(before);
    const reviewGate = buildReviewGateSummary(before, verification);
    await this.sessionManager.setVerificationResult(sessionId, verification);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.reviewGate = reviewGate;
      if (draft.moduleExecutionPlan) {
        draft.moduleExecutionPlan.updatedAt = new Date().toISOString();
      }
      const hasApplyFailure = draft.patchProposals.some((proposal) => proposal.status === "apply_failed");
      const hasPendingPatchReview = draft.patchProposals.some((proposal) => proposal.status === "proposed");
      const hasPendingPatchApply = draft.patchProposals.some((proposal) => proposal.status === "approved");
      const hasAppliedPatch = draft.patchProposals.some((proposal) => proposal.status === "applied");
      const hasPendingCommands = draft.commandRequests.some(
        (request) => request.status === "requested" || request.status === "approved" || request.status === "executing" || request.status === "running"
      );
      const hasFailedCommands = draft.commandRequests.some(
        (request) => request.status === "failed" || request.status === "blocked" || request.status === "rejected" || request.status === "denied" || request.status === "orphaned" || request.status === "terminated"
      );
      const reconciliationStatus = draft.reconciliationReport?.status;
      const scopeVerdict = draft.latestScopeValidation?.verdict;
      const runToGreenStatus = draft.runToGreen?.status;
      const runToGreenActive = runToGreenStatus === "running";

      if (runToGreenStatus === "passed") {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        draft.nextAction = draft.previewRecommendation
          ? {
              kind: "preview_ready",
              message: "Run-to-green command passed. The preview can be opened now.",
              preview: draft.previewRecommendation
            }
          : undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "completed", "Run-to-green completed successfully.");
        setRunPhaseState(draft, "final_report", "completed", "Final run-to-green report is ready.");
        return;
      }

      const noRunnableCommandOnly =
        runToGreenStatus === "blocked"
        && (draft.runToGreen?.currentAttempt ?? 0) === 0
        && !draft.commandExecutions.length
        && !draft.patchProposals.length;

      if (noRunnableCommandOnly) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(
          draft,
          "review_final_diff",
          "completed",
          draft.previewRecommendation
            ? "Preview is available even though no grounded run command was found."
            : "No grounded run command was found for this workspace."
        );
        setRunPhaseState(
          draft,
          "final_report",
          "completed",
          draft.previewRecommendation
            ? "The run finished with a preview recommendation."
            : "The run finished without a runnable command."
        );
        return;
      }

      if (runToGreenStatus === "blocked" || runToGreenStatus === "failed" || runToGreenStatus === "max_attempts_reached" || runToGreenStatus === "cancelled") {
        draft.status = runToGreenStatus === "blocked" ? "blocked" : "failed";
        draft.lifecycleStage = runToGreenStatus === "blocked" ? "BLOCKED" : "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = runToGreenStatus === "blocked" ? "blocked" : "failed";
        }
        setRunPhaseState(draft, "run_verification", runToGreenStatus === "blocked" ? "blocked" : "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", runToGreenStatus === "blocked" ? "blocked" : "completed", draft.runToGreen?.blockerReason ?? "Run-to-green stopped.");
        setRunPhaseState(draft, "final_report", runToGreenStatus === "blocked" ? "blocked" : "completed", draft.runToGreen?.blockerReason ?? "Run-to-green stopped without success.");
        return;
      }

      if (scopeVerdict === "blocked") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "BLOCKED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "blocked";
        }
        setRunPhaseState(draft, "review_final_diff", "blocked", "Module scope validation blocked the proposed change set.", 0);
        setRunPhaseState(draft, "final_report", "blocked", "Run is blocked until the patch returns inside the scoped module boundary.");
        return;
      }

      if (hasApplyFailure || (!runToGreenActive && hasFailedCommands) || verification.status === "failed") {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "final_report", "completed", "Run failed after verification or authority errors.");
        return;
      }

      if (hasPendingPatchReview) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPROVAL";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = draft.latestScopeValidation?.verdict === "needs_review" ? "blocked" : "running";
        }
        setRunPhaseState(draft, "review_final_diff", "active", "Patch review is waiting for operator approval.");
        return;
      }

      if (hasPendingPatchApply) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPLY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        setRunPhaseState(draft, "integrate_changes", "completed", "Patch proposal is approved and waiting for Rust apply.");
        setRunPhaseState(draft, "review_final_diff", "active", "Approved changes are waiting for Rust apply.");
        return;
      }

      if (hasAppliedPatch && hasPendingCommands) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        draft.nextAction = {
          kind: "approve_commands",
          message: "Patch applied. Run the requested verification commands through Rust."
        };
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Verification commands are still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Verification commands are waiting for operator execution.");
        return;
      }

      if (hasAppliedPatch && (reconciliationStatus === "pending" || reconciliationStatus === "not_run")) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Reconciliation is still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Post-apply reconciliation is still pending.");
        return;
      }

      if (hasAppliedPatch && (reconciliationStatus === "diverged" || reconciliationStatus === "failed")) {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "blocked", "Post-apply reconciliation diverged from the proposed patch.");
        setRunPhaseState(draft, "final_report", "completed", "Manual inspection is required because post-apply reconciliation diverged.");
        return;
      }

      if (hasAppliedPatch && reconciliationStatus === "unavailable") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "blocked";
        }
        setRunPhaseState(draft, "run_verification", "blocked", "Patch applied, but reconciliation data is unavailable.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Manual inspection is required because reconciliation data is unavailable.");
        return;
      }

      if (hasAppliedPatch) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        draft.nextAction = draft.previewRecommendation
          ? {
              kind: "preview_ready",
              message: "Verification is complete. The preview can be opened now.",
              preview: draft.previewRecommendation
            }
          : undefined;
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "completed", "Review gate is satisfied.");
        setRunPhaseState(draft, "final_report", "completed", "Final report is ready.");
      }
    });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const agent = draft.orchestration?.agentRuns.find((candidate) => candidate.id === "agent_local_codex");
      if (!agent) return;
      agent.status =
        draft.status === "completed"
          ? "completed"
          : draft.status === "failed" || draft.status === "failed_provider"
            ? "failed"
            : draft.status === "blocked"
              ? "blocked"
              : draft.status === "needs_approval"
                ? "running"
              : agent.status;
      agent.lifecycleStage = draft.lifecycleStage;
      agent.currentAction = draft.runSummary?.summary ?? draft.runToGreen?.blockerReason ?? agent.currentAction;
      agent.lastEvent = `sync:${draft.status}`;
      if ((agent.status === "completed" || agent.status === "failed" || agent.status === "blocked") && !agent.completedAt) {
        agent.completedAt = new Date().toISOString();
      }
    });

    const after = this.requireSession(sessionId);
    const moduleSummary = summarizeModuleExecution(after, verification);
    if (moduleSummary) {
      const previous = after.moduleExecutionSummaries?.find((entry) => entry.id === moduleSummary.id);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const existingIndex = draft.moduleExecutionSummaries?.findIndex((entry) => entry.id === moduleSummary.id) ?? -1;
        draft.moduleExecutionSummaries ??= [];
        if (existingIndex >= 0) {
          draft.moduleExecutionSummaries[existingIndex] = moduleSummary;
        } else {
          draft.moduleExecutionSummaries.push(moduleSummary);
        }
      });
      if (!previous || previous.status !== moduleSummary.status || previous.updatedAt !== moduleSummary.updatedAt) {
        await this.sessionManager.addArtifact(sessionId, {
          id: `artifact_${randomUUID()}`,
          sessionId,
          type: "module_execution_summary",
          title: moduleSummary.title,
          summary: moduleSummary.summary,
          payload: { moduleSummary },
          createdAt: new Date().toISOString()
        });
      }
    }
    const summary = buildRuntimeRunSummary(after, verification);
    await this.sessionManager.setRunSummary(sessionId, summary);
  }

}

function buildPlanClarification(
  message: string,
  intake: ReturnType<typeof buildProjectIntake>,
  conversationUnderstanding?: ConversationUnderstanding
): PlanClarifyAction | null {
  const normalized = message.trim().toLowerCase();
  const genericPlanPrompt =
    normalized.length < 100 &&
    !/\b(auth|api|ui|frontend|backend|database|tests?|deploy|runtime|module|component|page|screen|schema)\b/.test(normalized) &&
    (/\b(plan|think|analyze|review|understand|explain)\b/.test(normalized) || /(خط|خطة|حلل|اشرح|راجع|افهم)/.test(normalized));
  const unknownIntent = classifyRunIntent(message, conversationUnderstanding) === "unknown";
  const manyAreas = (intake.moduleSummary?.length ?? 0) >= 4 || intake.importantFiles.length >= 8;
  if (!genericPlanPrompt && !(unknownIntent && manyAreas)) return null;

  return {
    kind: "clarify_plan",
    message:
      containsArabic(message)
        ? "قبل ما أطلع الخطة، عايز أحدد نوعها بدقة أكثر. اختار الاتجاه الأقرب، أو اكتب اختيارك بنفسك."
        : "Before I build the plan, I want to narrow the shape of it a bit. Pick the closest direction, or write your own.",
    options: containsArabic(message)
      ? [
          {
            id: "implementation",
            label: "خطة تنفيذ آمنة",
            prompt: "اعمل plan mode يركز على safe implementation plan step by step based on the current codebase."
          },
          {
            id: "architecture",
            label: "خطة فهم المعمارية",
            prompt: "اعمل plan mode يركز على architecture understanding, important modules, and data flow based on the current codebase."
          },
          {
            id: "run_setup",
            label: "خطة تشغيل وإعداد",
            prompt: "اعمل plan mode يركز على setup, environment, and how to run the current project safely."
          }
        ]
      : [
          {
            id: "implementation",
            label: "Safe implementation plan",
            prompt: "Use plan mode and focus on a safe implementation plan step by step based on the current codebase."
          },
          {
            id: "architecture",
            label: "Architecture understanding plan",
            prompt: "Use plan mode and focus on architecture understanding, important modules, and data flow based on the current codebase."
          },
          {
            id: "run_setup",
            label: "Run and setup plan",
            prompt: "Use plan mode and focus on setup, environment, and how to run the current project safely."
          }
        ],
    allowCustom: true
  };
}

function containsArabic(value: string) {
  return /[\u0600-\u06FF]/.test(value);
}

function setRunPhaseState(
  session: AgentRuntimeSession,
  phaseId: import("@hivo/protocol").RunPhase["id"],
  status: import("@hivo/protocol").RunPhase["status"],
  summary: string,
  evidenceCount?: number
) {
  const now = new Date().toISOString();
  session.runPhases = (session.runPhases ?? []).map((phase) =>
    phase.id === phaseId
      ? {
          ...phase,
          status,
          summary,
          evidenceCount,
          startedAt: phase.startedAt ?? now,
          completedAt: status === "completed" || status === "failed" || status === "blocked" ? now : undefined
        }
      : phase
  );
}

export class ProviderConfigurationError extends Error {
  constructor(
    public readonly code:
      | "provider_missing"
      | "provider_api_key_missing"
      | "provider_validation_failed"
      | "provider_mock_forbidden",
    message: string
  ) {
    super(message);
  }
}

function assertProviderGate(input: {
  mode: AgentRuntimeSession["mode"];
  providerConfig?: AgentRuntimeSession["providerConfig"];
}) {
  if (input.mode !== "real_provider") {
    throw new ProviderConfigurationError("provider_mock_forbidden", "Demo and mock sessions are no longer supported.");
  }
  validateRealProviderConfig(input.providerConfig);
}

function validateRealProviderConfig(config: AgentRuntimeSession["providerConfig"]): asserts config is NonNullable<AgentRuntimeSession["providerConfig"]> {
  if (!config) {
    throw new ProviderConfigurationError("provider_missing", "real_provider requires a provider configuration.");
  }
  if (!config.isValid || !config.baseUrl?.trim() || !config.selectedModel?.trim()) {
    throw new ProviderConfigurationError("provider_validation_failed", "real_provider requires a valid provider configuration.");
  }
  if (config.providerType === "openai_compatible") {
    const apiKeyEnv = config.apiKeyEnv?.trim() || "OPENAI_API_KEY";
    if (!process.env[apiKeyEnv]?.trim()) {
      throw new ProviderConfigurationError("provider_api_key_missing", `API key environment variable ${apiKeyEnv} is not configured.`);
    }
  }
}

function createRealProvider(config: AgentRuntimeSession["providerConfig"], timeoutMs: number) {
  validateRealProviderConfig(config);
  const embeddingModel = config.embeddingModel
    ?? process.env.HIVO_EMBEDDING_MODEL
    ?? (config.providerType === "ollama" ? process.env.OLLAMA_EMBEDDING_MODEL : process.env.OPENAI_EMBEDDING_MODEL);
  if (config.providerType === "ollama") {
    return new OllamaProvider(config.baseUrl, config.selectedModel, timeoutMs, embeddingModel);
  }
  if (config.providerType === "openai_compatible") {
    const apiKeyEnv = config.apiKeyEnv?.trim() || "OPENAI_API_KEY";
    return new OpenAIProvider(process.env[apiKeyEnv], config.baseUrl, config.selectedModel, timeoutMs, embeddingModel);
  }
  throw new ProviderConfigurationError("provider_validation_failed", `Unsupported provider type: ${config.providerType}`);
}

function formatCommandResultMessage(record: CommandExecutionRecord) {
  const statusLine = typeof record.exitCode === "number"
    ? `${record.status} (exit ${record.exitCode})`
    : record.status;
  const output = [record.message, record.stdout, record.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return [
    `Command finished: \`${record.command}\``,
    "",
    `Status: ${statusLine}`,
    output ? `\n${truncateCommandOutput(output)}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateCommandOutput(output: string, max = 1800) {
  return output.length > max ? `${output.slice(0, max)}\n...output truncated...` : output;
}

function buildRuntimeVerification(session: AgentRuntimeSession) {
  const patchProposalCount = session.patchProposals.length;
  const appliedPatchCount = session.patchProposals.filter((proposal) => proposal.status === "applied").length;
  const applyFailed = session.patchProposals.some((proposal) => proposal.status === "apply_failed");
  const pendingPatchApply = session.patchProposals.some((proposal) => proposal.status === "approved");
  const patchApplyStarted = session.patchProposals.some((proposal) => proposal.status === "apply_started");
  const pendingPatchReview = session.patchProposals.some((proposal) => proposal.status === "proposed");
  const reconciliation = session.reconciliationReport;
  const commandStatuses = session.commandRequests.map((request) => ({
    command: request.command,
    status: request.status
  }));
  const commandFailed = commandStatuses.some((command) => command.status === "failed" || command.status === "blocked" || command.status === "denied" || command.status === "orphaned" || command.status === "terminated");
  const commandPending = commandStatuses.some(
    (command) => command.status === "requested" || command.status === "approved" || command.status === "executing" || command.status === "running"
  );
  const commandExecuted = commandStatuses.filter((command) => command.status === "executed");
  const successfulExecutions = session.commandExecutions.filter((execution) =>
    (execution.status === "executed" || execution.status === "completed") && (execution.exitCode === undefined || execution.exitCode === 0)
  );
  const failedExecutions = session.commandExecutions.filter((execution) =>
    execution.status === "failed"
    || ((execution.status === "executed" || execution.status === "completed") && typeof execution.exitCode === "number" && execution.exitCode !== 0)
  );
  const blockedExecutions = session.commandExecutions.filter((execution) => execution.status === "blocked");
  const approvalRequiredExecutions = session.commandExecutions.filter((execution) => execution.status === "approval_required");
  const runtimeErrorExecutions = session.commandExecutions.filter((execution) =>
    execution.status === "orphaned" || execution.status === "terminated" || execution.status === "unknown"
  );
  const backgroundRunning = (session.backgroundJobs ?? []).some((job) => job.status === "running");
  const validationTruthStatus =
    failedExecutions.length
      ? "verified_failed"
      : blockedExecutions.length || session.commandRequests.some((request) => request.status === "blocked" || request.status === "denied")
        ? "not_run_blocked_by_policy"
        : approvalRequiredExecutions.length
          ? "not_run_needs_approval"
          : runtimeErrorExecutions.length
            ? "not_run_runtime_error"
            : commandPending || backgroundRunning || pendingPatchReview || pendingPatchApply || patchApplyStarted
              ? "unverified"
            : successfulExecutions.length
              ? "verified_passed"
              : session.commandRequests.length
                ? "unverified"
                : "not_run_missing_command";
  const runToGreen = session.runToGreen;
  const runToGreenActive = runToGreen?.status === "running";
  const runToGreenBlockedBeforeExecution =
    runToGreen?.status === "blocked"
    && session.commandRequests.length === 0
    && session.commandExecutions.length === 0
    && patchProposalCount === 0;
  const runToGreenTerminalFailure =
    (runToGreen?.status === "blocked" && !runToGreenBlockedBeforeExecution) ||
    runToGreen?.status === "failed" ||
    runToGreen?.status === "max_attempts_reached" ||
    runToGreen?.status === "cancelled";

  return {
    id: `verification_${randomUUID()}`,
    sessionId: session.id,
    truthStatus: validationTruthStatus,
    status:
      validationTruthStatus === "verified_passed"
        ? "passed"
        : validationTruthStatus === "verified_failed"
          ? "failed"
      : runToGreenBlockedBeforeExecution
        ? "unavailable"
        : runToGreenTerminalFailure || applyFailed || (!runToGreenActive && commandFailed) || reconciliation?.status === "diverged" || reconciliation?.status === "failed"
        ? "failed"
        : runToGreen?.status === "running" || pendingPatchReview || pendingPatchApply || patchApplyStarted || commandPending || backgroundRunning || reconciliation?.status === "pending"
          ? "pending"
        : reconciliation?.status === "unavailable"
            ? "unavailable"
          : runToGreen?.status === "blocked"
            ? "unavailable"
            : runToGreen && !commandPending && !commandExecuted.length && !patchProposalCount
              ? "skipped"
          : "unavailable",
    summary:
      runToGreenBlockedBeforeExecution
        ? (runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution.")
        : runToGreenTerminalFailure
        ? runToGreen?.blockerReason ?? "Run-to-green stopped without reaching a passing command result."
        : applyFailed
        ? "Patch apply failed."
        : !runToGreenActive && commandFailed
          ? "At least one requested command failed."
          : reconciliation?.status === "diverged"
            ? "Post-apply reconciliation diverged from the proposed patch."
            : reconciliation?.status === "failed"
              ? "Post-apply reconciliation failed."
          : pendingPatchReview
            ? "Patch review is still pending."
            : pendingPatchApply
              ? "Patch was approved and is waiting for Rust apply."
              : reconciliation?.status === "pending"
                ? "Patch applied. Reconciliation is still pending."
          : reconciliation?.status === "unavailable"
                  ? "Patch applied, but reconciliation data is unavailable."
          : runToGreen?.status === "running"
            ? "Run-to-green is still waiting on a terminal command or repair result."
          : backgroundRunning
            ? "A background command is still running with limited tracking."
          : commandPending
                ? "Patch applied. Verification commands are still pending."
                : "Patch and command verification are complete.",
    checks: [
      {
        id: "run_to_green",
        label: "Run-to-green",
        name: "Run-to-green",
        status:
          runToGreen?.status === "passed"
            ? "passed"
            : runToGreenBlockedBeforeExecution
              ? "unavailable"
            : runToGreenTerminalFailure
              ? "failed"
              : runToGreen?.status === "running"
                ? "running"
                : runToGreen
                  ? "pending"
                  : "skipped",
        detail:
          runToGreen?.status === "passed"
            ? `Selected command passed on attempt ${runToGreen.currentAttempt}.`
            : runToGreenBlockedBeforeExecution
              ? (runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution.")
            : runToGreenTerminalFailure
              ? (runToGreen?.blockerReason ?? "Run-to-green stopped without reaching green.")
              : runToGreen?.status === "running"
                ? `Attempt ${runToGreen.currentAttempt}/${runToGreen.maxAttempts} is still in progress.`
                : "Run-to-green was not active for this session.",
        command: runToGreen?.attempts.at(-1)?.command,
        summary: runToGreen?.blockerReason
      },
      {
        id: "patch_proposal",
        label: "Patch proposal",
        name: "Patch proposal",
        status: patchProposalCount ? "passed" : runToGreen ? "skipped" : "pending",
        detail: patchProposalCount
          ? `${patchProposalCount} patch proposal(s) recorded.`
          : runToGreen
            ? "No patch proposal was needed before command selection."
            : "No patch proposal recorded.",
        startedAt: session.createdAt,
        completedAt: patchProposalCount ? session.updatedAt : undefined,
        summary: patchProposalCount ? "Patch proposal captured." : runToGreen ? "Patch proposal was not required." : "Patch proposal is missing."
      },
      {
        id: "rust_apply",
        label: "Rust apply",
        name: "Rust apply",
        status: applyFailed ? "failed" : appliedPatchCount ? "passed" : pendingPatchApply || pendingPatchReview ? "pending" : runToGreen ? "skipped" : "passed",
        detail: applyFailed
          ? "Rust reported a patch apply failure."
          : appliedPatchCount
            ? `${appliedPatchCount} patch(es) applied through Rust.`
            : pendingPatchApply
              ? "Waiting for Rust to apply the approved patch."
              : pendingPatchReview
                ? "Patch is waiting for approval before Rust apply."
                : runToGreen
                  ? "Rust patch apply was not started because no repair patch was proposed."
                  : "No patch apply was required.",
        linkedPatchId: session.patchProposals.at(-1)?.id,
        startedAt: session.patchProposals.at(-1)?.createdAt,
        completedAt: appliedPatchCount || applyFailed ? session.updatedAt : undefined
      },
      {
        id: "reconciliation",
        label: "Reconciliation",
        name: "Reconciliation",
        status:
          reconciliation?.status === "matched"
            ? "passed"
            : reconciliation?.status === "diverged" || reconciliation?.status === "failed"
              ? "failed"
              : reconciliation?.status === "pending"
                ? "running"
                : reconciliation?.status === "unavailable"
                  ? "unavailable"
                  : appliedPatchCount
                    ? "not_run"
                    : "skipped",
        detail: reconciliation?.reason ?? (appliedPatchCount ? "Patch applied, but reconciliation has not been recorded yet." : "Reconciliation is skipped until a patch is applied."),
        linkedPatchId: reconciliation?.patchId ?? session.patchProposals.at(-1)?.id,
        startedAt: reconciliation?.checkedAt,
        completedAt: reconciliation && reconciliation.status !== "pending" ? reconciliation.checkedAt : undefined,
        summary: reconciliation?.reason
      },
      {
        id: "command_execution",
        label: "Rust command execution",
        name: "Rust command execution",
        status: runToGreenBlockedBeforeExecution ? "not_run" : !runToGreenActive && commandFailed ? "failed" : commandPending || backgroundRunning || runToGreenActive ? "pending" : commandExecuted.length ? "passed" : runToGreen ? "skipped" : "passed",
        detail: runToGreenBlockedBeforeExecution
          ? "No grounded command was selected, so Rust command execution was not started."
          : !runToGreenActive && commandFailed
          ? "At least one verification command failed or was blocked."
          : backgroundRunning
            ? "A background verification command is still running with limited tracking."
          : runToGreenActive
            ? "Run-to-green is still diagnosing, repairing, or waiting for a rerun."
          : commandPending
            ? "Waiting for verification commands to run."
            : commandExecuted.length
              ? `Executed ${commandExecuted.length} verification command(s).`
              : runToGreen
                ? "No command was executed for this run-to-green attempt."
                : "No verification command was required.",
        command: commandExecuted[0]?.command,
        startedAt: commandPending || commandExecuted.length ? session.updatedAt : undefined,
        completedAt: commandExecuted.length || commandFailed ? session.updatedAt : undefined,
        exitCode: session.commandExecutions.at(-1)?.exitCode,
        summary: commandExecuted.length ? "Verification commands completed." : runToGreenBlockedBeforeExecution ? "Rust command execution did not start." : "Verification commands are pending or not required."
      }
    ],
    createdAt: new Date().toISOString()
  } satisfies AgentRuntimeSession["verificationResult"];
}

function shouldConfirmSingleFilePygamePlan(message: string, requestedAgentCount: number) {
  if (requestedAgentCount < 3) return false;
  const normalized = message.toLowerCase();
  return /\bpython\b/.test(normalized)
    && /\bpy\s*game\b|\bpygame\b/.test(normalized)
    && /\bone python code\b|\bsingle file\b|\bone file\b/.test(normalized);
}

async function loadSwarmWorkResults(workItems: Array<{ result_ref?: string }>) {
  const results: Array<{
    work_item_id: string;
    status: "succeeded" | "failed" | "blocked";
    summary: string;
    relevant_files: string[];
    findings: string[];
    risks: string[];
    unknowns: string[];
  }> = [];
  for (const item of workItems) {
    if (!item.result_ref) continue;
    try {
      const parsed = JSON.parse(await readFile(item.result_ref, "utf8"));
      if (typeof parsed?.work_item_id !== "string") continue;
      results.push({
        work_item_id: parsed.work_item_id,
        status: parsed.status === "succeeded" || parsed.status === "failed" || parsed.status === "blocked" ? parsed.status : "failed",
        summary: typeof parsed.summary === "string" ? parsed.summary : "Worker completed without a textual summary.",
        relevant_files: Array.isArray(parsed.relevant_files) ? parsed.relevant_files.filter((entry: unknown): entry is string => typeof entry === "string") : [],
        findings: Array.isArray(parsed.findings) ? parsed.findings.filter((entry: unknown): entry is string => typeof entry === "string") : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.filter((entry: unknown): entry is string => typeof entry === "string") : [],
        unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.filter((entry: unknown): entry is string => typeof entry === "string") : []
      });
    } catch {}
  }
  return results;
}

function mapSwarmRunStatus(status: string, providerError?: string): RuntimeSessionStatus {
  if (status === "succeeded") return "completed";
  if (providerError) return "failed_provider";
  if (status === "blocked") return "blocked";
  return "failed";
}

function mapSwarmWorkStatus(status: string): "todo" | "in_progress" | "done" | "blocked" {
  if (status === "succeeded") return "done";
  if (status === "running" || status === "leased" || status === "ready") return "in_progress";
  if (status === "queued") return "todo";
  return "blocked";
}

function mapSwarmAgentStatus(status: string): "idle" | "running" | "completed" | "blocked" | "failed" {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "running" || status === "leased") return "running";
  return "idle";
}

function formatProviderBackedSwarmAnswer(input: {
  prompt: string;
  finalReport: string;
  responseLanguage: "ar" | "en";
  debugMode: boolean;
  providerCallCount: number;
  workerCount: number;
  workResults: Array<{ summary: string; relevant_files: string[]; findings: string[]; risks: string[]; unknowns: string[] }>;
  status: RuntimeSessionStatus;
  providerFailures: number;
  providerTimeouts: number;
  invalidStructuredOutputs: number;
  retries: number;
}) {
  const body = isInventoryClassificationPrompt(input.prompt)
    ? synthesizeInventoryClassificationAnswer(input)
    : synthesizeGeneralSwarmAnswer(input);
  if (!input.debugMode) return body;
  return [
    formatDebugSwarmHeading(input.status),
    "",
    body,
    "",
    formatCompactRuntimeTruth(input)
  ].join("\n");
}

function synthesizeGeneralSwarmAnswer(input: {
  prompt: string;
  responseLanguage?: "ar" | "en";
  status?: RuntimeSessionStatus;
  workResults: Array<{ summary: string; relevant_files: string[]; findings: string[]; risks: string[]; unknowns: string[] }>;
}) {
  const arabic = input.responseLanguage === "ar" || isArabicText(input.prompt);
  const findings = dedupeEvidenceText(input.workResults.flatMap((result) => result.findings.length ? result.findings : [result.summary]))
    .filter(isUserFacingEvidenceText)
    .slice(0, 8);
  const evidenceFiles = dedupeStrings(input.workResults.flatMap((result) => result.relevant_files)).slice(0, 8);
  const caveats = dedupeEvidenceText(input.workResults.flatMap((result) => [...result.unknowns, ...result.risks]))
    .filter(isUserFacingEvidenceText)
    .slice(0, 4);

  if (arabic) {
    const explanatory = synthesizeArabicTechnicalExplanation(input.prompt, findings, evidenceFiles, caveats, input.status);
    if (explanatory) return explanatory;
    return [
      unicodeArabic("Answer"),
      input.status === "blocked"
        ? "- الإجابة دي مبنية على الأدلة المفيدة المتاحة، لكن درجة الثقة محدودة لأن جزء من الأدلة لم يكن كافيًا لإغلاق السؤال بالكامل."
        : "- دي خلاصة مفسرة من أدلة العمال، مش تفريغ خام للنتائج الداخلية.",
      "",
      unicodeArabic("How it works"),
      findings.length
        ? findings.map((finding) => `- ${arabicizeTechnicalFinding(finding)}`).join("\n")
        : "- لم أجد أدلة كافية أقدر أبني عليها إجابة موثوقة من ملفات المشروع.",
      "",
      unicodeArabic("Evidence"),
      evidenceFiles.length ? evidenceFiles.map((file) => `- \`${file}\``).join("\n") : "- \u0644\u0645 \u062a\u0633\u062c\u0644 \u0645\u0631\u0627\u062c\u0639 \u0645\u0644\u0641\u0627\u062a \u0645\u062d\u062f\u062f\u0629.",
      "",
      unicodeArabic("Limits"),
      caveats.length ? caveats.map((caveat) => `- ${caveat}`).join("\n") : "- \u0644\u0645 \u064a\u0633\u062c\u0644 \u0627\u0644\u0639\u0645\u0627\u0644 \u0627\u0644\u0645\u0642\u0628\u0648\u0644\u0648\u0646 \u062a\u062d\u0641\u0638\u0627\u062a \u0625\u0636\u0627\u0641\u064a\u0629."
    ].join("\n");
  }

  return [
    "**Answer**",
    input.status === "blocked"
      ? "This is a qualified answer from the useful evidence available; some evidence was insufficient to close the run fully."
      : "This is synthesized from the worker evidence.",
    "",
    "**Explanation**",
    findings.length ? findings.map((finding) => `- ${finding}`).join("\n") : "- I did not find enough evidence to produce a trusted answer from the project files.",
    "",
    "**Evidence**",
    evidenceFiles.length ? evidenceFiles.map((file) => `- \`${file}\``).join("\n") : "- No specific file refs were recorded.",
    "",
    "**Limits**",
    caveats.length ? caveats.map((caveat) => `- ${caveat}`).join("\n") : "- No extra caveats were reported by the accepted workers."
  ].join("\n");
}

function synthesizeInventoryClassificationAnswer(input: {
  prompt: string;
  responseLanguage?: "ar" | "en";
  workResults: Array<{ summary: string; relevant_files: string[]; findings: string[]; risks: string[]; unknowns: string[] }>;
}) {
  const arabic = input.responseLanguage === "ar" || isArabicText(input.prompt);
  const statements = dedupeEvidenceText(input.workResults.flatMap((result) => [
    result.summary,
    ...result.findings
  ])).filter(isUserFacingEvidenceText);
  const rows = buildArtifactInventoryRows(statements, input.workResults).slice(0, 12);
  const caveats = dedupeEvidenceText(input.workResults.flatMap((result) => [...result.unknowns, ...result.risks])).slice(0, 4);
  const title = arabic ? unicodeArabic("Artifact inventory") : "**Artifact Inventory**";
  const differenceTitle = arabic ? unicodeArabic("Training artifacts vs runtime logs") : "**Training Artifacts vs Runtime Logs**";
  const limitsTitle = arabic ? unicodeArabic("Limits") : "**Limits**";
  return [
    title,
    rows.length ? formatArtifactRows(rows) : "No durable artifact paths or state-producing files were proven by accepted worker evidence.",
    "",
    differenceTitle,
    artifactDifferenceText(rows, arabic),
    "",
    limitsTitle,
    caveats.length
      ? caveats.filter(isUserFacingEvidenceText).map((caveat) => `- ${arabic ? arabicizeTechnicalFinding(caveat) : caveat}`).join("\n")
      : arabic
        ? "- لم أستنتج وجود مجلد `logs/` أو runtime logging path إلا لو كان مثبتًا في evidence."
        : "- I did not infer a `logs/` directory or runtime logging path unless an accepted worker finding named one."
  ].join("\n");
}

function buildArtifactInventoryRows(
  statements: string[],
  workResults: Array<{ relevant_files: string[] }>
) {
  const rows: Array<{ category: string; file: string; artifact: string; evidence: string; notes: string }> = [];
  const fallbackFiles = dedupeStrings(workResults.flatMap((result) => result.relevant_files));
  for (const statement of statements) {
    const text = statement.trim();
    if (!text) continue;
    const files = extractFileRefs(text);
    const artifacts = extractArtifactRefs(text);
    const category = classifyArtifactStatement(text);
    if (!category) continue;
    const sourceFiles = files.length ? files : fallbackFiles.filter((file) => text.toLowerCase().includes(file.toLowerCase()));
    const file = sourceFiles[0] ?? "not specified";
    const artifact = artifacts[0] ?? inferredArtifactLabel(text, category);
    rows.push({
      category,
      file,
      artifact,
      evidence: compactEvidence(text, file),
      notes: notesForArtifactCategory(category, text)
    });
  }
  return dedupeArtifactRows(rows);
}

function classifyArtifactStatement(text: string) {
  const normalized = text.toLowerCase();
  const hasPathOrState = /\b[A-Z][A-Z0-9_]*_PATH\b|(?:^|[\s="'`])(?:data|models?|artifacts?|state|logs?)\/[\w./-]+\.(?:csv|json|jsonl|pkl|pickle|joblib|pt|onnx|sqlite|db)\b/i.test(text);
  if (!hasPathOrState) return undefined;
  if (/\b(model|trained|training|fit|fitted|forecast|sarima|arima|cluster(?:ing)?|joblib|pickle|pkl|onnx|pt|FORECAST_STATE_PATH|MODEL_PATH)\b/i.test(text)) {
    return "Model/state";
  }
  if (/\b(log|ACTION_LOG_PATH|action_log|audit|event)\b/i.test(text)) {
    return "Runtime log";
  }
  if (/\b(data|dataset|csv|json|state|history|customer|DATA_PATH)\b/i.test(text)) {
    return "Data/state";
  }
  return undefined;
}

function extractFileRefs(text: string) {
  return dedupeStrings([...text.matchAll(/\b[\w.-]+(?:\/[\w.-]+)+\.(?:py|ts|tsx|js|jsx|json|jsonl|csv|md|toml|yaml|yml)\b/g)].map((match) => match[0]));
}

function extractArtifactRefs(text: string) {
  const pathArtifacts = [...text.matchAll(/\b(?:data|models?|artifacts?|state|logs?)\/[\w./-]+\.(?:csv|json|jsonl|pkl|pickle|joblib|pt|onnx|sqlite|db)\b/gi)].map((match) => match[0]);
  const constants = [...text.matchAll(/\b[A-Z][A-Z0-9_]*_PATH\b/g)].map((match) => match[0]);
  return dedupeStrings([...pathArtifacts, ...constants]);
}

function inferredArtifactLabel(text: string, category: string) {
  const constants = extractArtifactRefs(text);
  if (constants.length) return constants[0]!;
  if (category === "Model/state") return "model or forecasting state path named in evidence";
  if (category === "Runtime log") return "runtime log path named in evidence";
  return "data or state path named in evidence";
}

function notesForArtifactCategory(category: string, text: string) {
  if (category === "Model/state") return /train|fit|fitted|forecast|sarima|arima/i.test(text) ? "Training/model state evidence." : "Model-like persisted state evidence.";
  if (category === "Runtime log") return /write|append|record|log/i.test(text) ? "Runtime write/log evidence." : "Runtime log path evidence.";
  return /read|load|dataset|input/i.test(text) ? "Input/read data evidence." : "Persisted data/state evidence.";
}

function dedupeArtifactRows(rows: Array<{ category: string; file: string; artifact: string; evidence: string; notes: string }>) {
  const seen = new Set<string>();
  const result: typeof rows = [];
  for (const row of rows) {
    const key = `${row.category}|${row.file}|${row.artifact}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function formatArtifactRows(rows: Array<{ category: string; file: string; artifact: string; evidence: string; notes: string }>) {
  return [
    "| Category | File | Produced artifact/state | Evidence | Notes |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${escapeMarkdownTable(row.category)} | ${escapeMarkdownTable(row.file)} | ${escapeMarkdownTable(row.artifact)} | ${escapeMarkdownTable(row.evidence)} | ${escapeMarkdownTable(row.notes)} |`)
  ].join("\n");
}

function artifactDifferenceText(rows: Array<{ category: string }>, arabic: boolean) {
  const hasModel = rows.some((row) => row.category === "Model/state");
  const hasRuntimeLog = rows.some((row) => row.category === "Runtime log");
  const hasData = rows.some((row) => row.category === "Data/state");
  if (arabic) {
    return [
      hasModel ? "- Training/model artifacts are persisted model or forecasting state proven by the table above." : "- No training/model artifact was proven by accepted worker evidence.",
      hasData ? "- Data/state artifacts are datasets or persisted state files proven by paths or read/write evidence." : "- No separate data/state artifact was proven by accepted worker evidence.",
      hasRuntimeLog ? "- Runtime logs are files written while the app runs, not trained model state." : "- No runtime log path was proven, so I am not claiming a `logs/` directory exists."
    ].join("\n");
  }
  return [
    hasModel ? "- Training artifacts are persisted model or forecasting state produced by training/fitting or model-state code." : "- No training/model artifact was proven by accepted worker evidence.",
    hasData ? "- Data artifacts are datasets or persisted state files proven by paths or read/write evidence." : "- No separate data/state artifact was proven by accepted worker evidence.",
    hasRuntimeLog ? "- Runtime logs are files written during application execution; they are operational records, not trained model state." : "- No runtime log path was proven, so I am not claiming a `logs/` directory exists."
  ].join("\n");
}

function synthesizeArabicTechnicalExplanation(
  prompt: string,
  findings: string[],
  evidenceFiles: string[],
  caveats: string[],
  status?: RuntimeSessionStatus
) {
  if (!isReclusterDecisionPrompt(prompt)) return undefined;
  const hasDrift = hasAnyEvidence(findings, ["drift", "distribution", "threshold"]);
  const hasFcm = hasAnyEvidence(findings, ["fcm", "membership", "cmeans", "cluster"]);
  const hasOffer = hasAnyEvidence(findings, ["offer", "action", "dispatch", "orchestrator"]);
  const confidenceLine = status === "blocked"
    ? "الإجابة دي مؤهلة: الأدلة المتاحة كافية لشرح منطق القرار، لكن بعض نتائج السرب لم تصل لدرجة قبول نهائية."
    : "الإجابة دي مركبة من أدلة السرب المقبولة، مع الحفاظ على أسماء الملفات والمصطلحات التقنية.";
  const steps = [
    "النظام يقرر `Re-cluster` بدل إرسال `offer` لما تكون إشارة تغيّر السلوك أقوى من إن العرض الحالي يظل صالح لنفس تقسيم العملاء.",
    hasDrift
      ? "`drift detection` هو البوابة الأولى: لو التوزيع أو مؤشرات السلوك خرجت عن الحالة المتوقعة، يبقى قرار الـ offer القديم مبني على cluster context محتمل يكون قديم."
      : "`drift detection` مطلوب كإشارة أولى، لكن الأدلة المتاحة لم تثبت تفاصيل threshold أو معادلة drift نفسها.",
    hasFcm
      ? "`FCM membership` يحدد درجة انتماء العميل لكل cluster. لو درجات العضوية اتغيرت أو بقت غير حاسمة، ده معناه إن تمثيل العميل داخل الـ clusters محتاج تحديث قبل اختيار offer."
      : "`FCM membership` هو الرابط المنطقي بين drift والقرار، لكن الأدلة المتاحة لم تثبت كل تفاصيل حساب membership.",
    hasOffer
      ? "`orchestrator rules` هي طبقة القرار: لو drift/membership بتقول إن التصنيف غير مستقر، يختار `Re-cluster`; ولو التصنيف مستقر وكافي، يقدر يكمل لمسار `offer`."
      : "`orchestrator rules` يفترض أنها تفصل بين إعادة التجميع وإرسال العرض، لكن الأدلة المتاحة لم تثبت كل شروط القاعدة التنفيذية."
  ];
  return [
    "**الخلاصة**",
    confidenceLine,
    "",
    "**منطق القرار خطوة بخطوة**",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "**الأدلة المستخدمة**",
    evidenceFiles.length
      ? evidenceFiles.slice(0, 6).map((file) => `- \`${file}\``).join("\n")
      : "- لم تُسجل مراجع ملفات محددة في نتائج السرب المفيدة.",
    "",
    "**حدود الإجابة**",
    caveats.length
      ? caveats.slice(0, 3).map((caveat) => `- ${arabicizeTechnicalFinding(caveat)}`).join("\n")
      : "- لا أضيف تفاصيل thresholds أو شروط runtime غير مثبتة في الأدلة."
  ].join("\n");
}

function isReclusterDecisionPrompt(prompt: string) {
  return /\bre-?cluster\b/i.test(prompt)
    && /\boffer\b/i.test(prompt)
    && /\b(drift|fcm|membership|orchestrator|rules?)\b/i.test(prompt);
}

function hasAnyEvidence(values: string[], terms: string[]) {
  const text = values.join("\n").toLowerCase();
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function arabicizeTechnicalFinding(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return text;
  if (isArabicText(text)) return text;
  return `الدليل يشير إلى: ${text}`;
}

function isUserFacingEvidenceText(value: string) {
  return !/\b(Provider-backed swarm|Internal Swarm Autopilot Report|Runtime truth|logical agents?|provider requests?|invalid structured outputs?|schema failed|worker evidence summaries?|deterministic\/mock|mock worker|fallback accepted|telemetry|debug)\b/i.test(value);
}

function formatDebugSwarmHeading(status: RuntimeSessionStatus) {
  if (status === "completed") return "Provider-backed swarm completed successfully.";
  if (status === "blocked") return "Provider-backed swarm blocked before producing an accepted answer.";
  if (status === "failed_provider") return "Provider-backed swarm failed because the model provider failed.";
  return "Provider-backed swarm failed before producing an accepted answer.";
}

function compactEvidence(text: string, file?: string) {
  let normalized = text.replace(/\s+/g, " ").trim();
  if (file && file !== "not specified") {
    normalized = normalized.replace(new RegExp(`^${escapeRegExp(file)}\\s+`, "i"), "");
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function dedupeEvidenceText(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase()
      .replace(/\b\d+\b/g, "#")
      .replace(/[.,;:]+$/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function escapeMarkdownTable(value: string) {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInventoryClassificationPrompt(prompt: string) {
  return /\b(artifact|artifacts|inventory|classify|classification|which files|models?\/data\/logs?|training artifacts?|runtime logs?|durable)\b/i.test(prompt)
    || /(?:\u0627\u0644\u0645\u0644\u0641\u0627\u062a|\u0627\u064a\u0647|\u0625\u064a\u0647).*(?:artifacts|models|data|logs)/u.test(prompt);
}

function isArabicText(value: string) {
  return /[\u0600-\u06ff]/.test(value);
}

function detectResponseLanguage(value: string): "ar" | "en" {
  return isArabicText(value) ? "ar" : "en";
}

function unicodeArabic(label: "Summary" | "Answer" | "How it works" | "Evidence" | "Limits" | "Artifact inventory" | "Training artifacts vs runtime logs") {
  switch (label) {
    case "Summary":
      return "**\u0627\u0644\u062e\u0644\u0627\u0635\u0629**";
    case "Answer":
      return "**\u0627\u0644\u0625\u062c\u0627\u0628\u0629**";
    case "How it works":
      return "**\u0627\u0644\u0634\u0631\u062d**";
    case "Evidence":
      return "**\u0627\u0644\u0623\u062f\u0644\u0629**";
    case "Limits":
      return "**\u062d\u062f\u0648\u062f \u0627\u0644\u0625\u062c\u0627\u0628\u0629**";
    case "Artifact inventory":
      return "**\u062c\u0631\u062f \u0627\u0644\u0640 artifacts**";
    case "Training artifacts vs runtime logs":
      return "**\u0627\u0644\u0641\u0631\u0642 \u0628\u064a\u0646 training artifacts \u0648 runtime logs**";
  }
}

function formatCompactRuntimeTruth(input: {
  providerCallCount: number;
  workerCount: number;
  providerFailures: number;
  providerTimeouts: number;
  invalidStructuredOutputs: number;
  retries: number;
}) {
  return [
    "**Runtime truth:**",
    `provider_read_only; logical agents ${input.workerCount}; provider requests ${input.providerCallCount}; failures ${input.providerFailures}; timeouts ${input.providerTimeouts}; retries ${input.retries}; invalid structured outputs ${input.invalidStructuredOutputs}; mock/fallback accepted as answer: no.`
  ].join("\n");
}

function shouldAnswerExplainEvidenceQuestion(message: string, session: AgentRuntimeSession) {
  if (!session.explainReport) return false;
  const normalized = message.toLowerCase();
  const english = /\b(came from|why these)\b/i.test(message)
    || (/\bwhere\b/i.test(message) && /\b(file|files|link|links|reference|references|source|sources|evidence)\b/i.test(message))
    || (/\b(source|sources|links?|references?)\b/i.test(message) && /\b(of|for)\s+(these|this|the)\b/i.test(message));
  const arabic = /(جبت|جاب|فين|منين|مصدر|مصادر|دليل|أدلة|ادلة|روابط|لينكات|ملفات|الملفات|اللينكات|الروابط)/.test(normalized)
    && /(ملف|ملفات|رابط|روابط|لينك|لينكات|مصدر|مصادر|دليل|أدلة|ادلة|جبت|منين)/.test(normalized);
  return english || arabic;
}

function formatExplainEvidenceAnswer(session: AgentRuntimeSession, message: string) {
  const report = session.explainReport!;
  const arabic = /[\u0600-\u06ff]/.test(message);
  const evidence = report.evidence
    .filter((entry) => entry.type !== "directory")
    .slice(0, 8)
    .map((entry) => {
      const line = entry.lineStart ?? 1;
      const label = `${entry.path}:${line}`;
      return `- [${label}](hivo-file:${encodeURIComponent(entry.path)}:${line}): ${entry.reason}`;
    });
  const ignored = report.contextPack.inventory.ignoredDirectories.slice(0, 6).join(", ") || "none";
  if (arabic) {
    return [
      "الملفات والروابط دي جاية من تقرير القراءة لنفس الـ workspace المفتوح في الجلسة، مش من بحث خارجي ولا من مشروع تاني.",
      "",
      `- Workspace: \`${session.workspacePath}\``,
      `- اتفحص ${report.contextPack.inventory.scannedFiles} ملف قابل للقراءة، واتجاهلت generated/vendor زي: ${ignored}.`,
      "- الروابط `hivo-file:` هي مراجع نسبية داخل نفس الـ workspace، والسطر جنب كل رابط هو السطر اللي اتاخد كدليل.",
      "",
      "أهم الأدلة المستخدمة:",
      ...(evidence.length ? evidence : ["- مفيش evidence file refs محفوظة في التقرير السابق."]),
      "",
      "لو عنوان المشروع أو الدومين كان مختلف عن الأدلة، فده معناه bug في استنتاج الدومين، مش إن الروابط دليل على مشروع تاني."
    ].join("\n");
  }
  return [
    "Those files and links came from the read-only explain report for this session's workspace, not from an external search or a different project.",
    "",
    `- Workspace: \`${session.workspacePath}\``,
    `- Scanned ${report.contextPack.inventory.scannedFiles} readable file(s); ignored generated/vendor folders such as: ${ignored}.`,
    "- `hivo-file:` links are relative references inside that workspace, with the linked line used as evidence.",
    "",
    "Main evidence refs:",
    ...(evidence.length ? evidence : ["- No file evidence refs were stored on the previous report."]),
    "",
    "If the project title/domain disagreed with those refs, that is a domain-inference bug, not proof that the files came from another workspace."
  ].join("\n");
}

function formatRunTurnFailureMessage(prompt: string, error: unknown) {
  const detail = formatRuntimeError(error);
  if (/[\u0600-\u06ff]/.test(prompt)) {
    return [
      "الـ run وقع قبل ما أقدر أكمل الرد.",
      "",
      `السبب: ${detail}`,
      "",
      "ماخمنتش إجابة من غير دليل. جرّب الطلب تاني بعد ما تصلح سبب الخطأ، أو استخدم Restart Latest لو كنت شغال في development mode."
    ].join("\n");
  }
  return [
    "The run failed before I could finish the response.",
    "",
    `Reason: ${detail}`,
    "",
    "I did not guess an answer without evidence. Fix the reported issue and retry, or use Restart Latest while developing."
  ].join("\n");
}

function formatProviderFailureMessage(_prompt: string, error: unknown) {
  const detail = formatRuntimeError(error);
  return [
    "The real model provider was required, but the provider gate failed before I could produce a trusted answer.",
    "",
    `Reason: ${detail}`,
    "",
    "I did not use MockProvider or a deterministic fallback as a successful assistant reply. Fix the provider configuration/runtime and retry."
  ].join("\n");
}

function isProviderGateFailure(error: unknown, session: AgentRuntimeSession) {
  if (session.mode !== "real_provider") return undefined;
  const detail = formatRuntimeError(error);
  if (error instanceof ProviderConfigurationError) return `provider_gate_failed:${error.code}`;
  if (/provider_mock_forbidden|provider_missing|provider_validation|provider_api_key|real_provider requires|Unsupported provider type|reasoning_kernel\.(?:provider_failed|invalid_provider_output|turn_timeout|provider_call_budget_exhausted)|project_explain_provider/i.test(detail)) {
    return "provider_gate_failed";
  }
  return undefined;
}

function formatRuntimeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
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
): import("@hivo/protocol").ApprovalRecord {
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

function emptyProjectMap(): import("@hivo/protocol").ProjectMap {
  return {
    stack: [],
    packageManagers: [],
    testCommands: [],
    entryPoints: [],
    importantFiles: []
  };
}

function buildRecursiveBranchResults(session: AgentRuntimeSession): RecursiveBranchResultRecord[] {
  const factory = session.recursiveFactory;
  if (!factory?.branchExecutions?.length) return [];
  const now = new Date().toISOString();
  return factory.branchExecutions
    .filter((branch) =>
      branch.proposedPatchId
      || branch.patchApplied
      || branch.status === "blocked"
      || branch.status === "blocked_conflict"
      || branch.status === "blocked_failed_dependency"
      || branch.status === "failed"
      || branch.status === "completed"
      || branch.status === "skipped"
    )
    .map((branch) => {
      const branchPatchIds = uniqueRuntimeStrings([
        ...(branch.proposedPatchId ? [branch.proposedPatchId] : []),
        ...(branch.nestedSubtasks ?? []).flatMap((subtask) => subtask.proposedPatchId ? [subtask.proposedPatchId] : [])
      ]);
      const patches = session.patchProposals.filter((patch) => branchPatchIds.includes(patch.id));
      const planned = factory.branchOrchestrators?.find((candidate) => candidate.branchId === branch.branchId);
      const filesChanged = uniqueRuntimeStrings(patches.flatMap((patch) => patch.filesChanged.map((file) => file.path)));
      const patchIds = patches.map((patch) => patch.id);
      const nestedRollup = branch.nestedSubtasks?.length ? buildNestedRollup(branch, session.patchProposals) : branch.nestedRollup;
      const appliedState = branchAppliedState(branch, patches);
      const risksAndLimitations = uniqueRuntimeStrings([
        ...(planned?.risks ?? []),
        branch.blockedReason,
        branch.conflictReason,
        ...(nestedRollup?.limitations ?? []),
        branch.validationStatus === "verified_passed" ? undefined : `Validation truth is ${branch.validationStatus}.`
      ].filter(Boolean) as string[]);
      return {
        id: `branch_result_${session.id}_${branch.branchId}`,
        sessionId: session.id,
        branchId: branch.branchId,
        objective: branch.executionContext.branchObjective,
        patchIds,
        appliedState,
        reviewResult: branch.reviewStatus,
        validationState: branch.validationStatus,
        filesChanged,
        nestedRollup,
        risksAndLimitations,
        evidenceSummary: [
          `Branch status: ${branch.status}.`,
          `Review: ${branch.reviewStatus}.`,
          `Patch truth: ${patches.map((patch) => `${patch.id}=${patch.status}`).join(", ") || "no patch proposed"}.`,
          `Applied state: ${appliedState}.`,
          `Validation: ${branch.validationStatus}.`,
          ...(nestedRollup ? [`Nested subtasks: completed=${nestedRollup.completedSubtasks.length}, failed=${nestedRollup.failedSubtasks.length}, blocked=${nestedRollup.blockedSubtasks.length}.`] : [])
        ],
        createdAt: branch.createdAt,
        updatedAt: now
      };
    });
}

function buildRecursiveBranchValidationRecords(session: AgentRuntimeSession, branchResults: RecursiveBranchResultRecord[]): RecursiveValidationRecord[] {
  const now = new Date().toISOString();
  return branchResults.map((result) => {
    const evaluation = evaluateRecursiveBranchValidation(session, result.branchId);
    const status = validationRecordStatus(result.validationState);
    return {
      id: `recursive_validation_branch_${session.id}_${result.branchId}`,
      sessionId: session.id,
      level: "branch_validation",
      branchId: result.branchId,
      truthStatus: result.validationState,
      status,
      summary: status === "passed"
        ? `Branch ${result.branchId} validation passed: ${evaluation.summary}`
        : status === "failed"
          ? `Branch ${result.branchId} validation failed: ${evaluation.summary}`
          : `Branch ${result.branchId} validation is ${result.validationState}; ${evaluation.summary}`,
      blockingReasons: status === "passed" ? [] : result.risksAndLimitations,
      evidenceRefs: [
        ...result.patchIds.map((patchId) => `patch:${patchId}`),
        ...result.filesChanged.map((file) => `file:${file}`),
        ...evaluation.evidence.map((entry) => entry.executionId ? `command_execution:${entry.executionId}` : entry.kind === "patch_effect" ? "patch_effect:evidence" : "validation:evidence")
      ],
      discoveredCommands: evaluation.discoveredCommands,
      selectedStrategy: evaluation.strategy,
      evidence: evaluation.evidence,
      createdAt: result.createdAt,
      updatedAt: now
    };
  });
}

function buildRecursiveIntegrationSummary(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  branchValidations: RecursiveValidationRecord[]
): RecursiveIntegrationSummary {
  const now = new Date().toISOString();
  const factory = session.recursiveFactory;
  const completedBranches = branchResults
    .filter((result) => branchValidations.find((validation) => validation.branchId === result.branchId)?.status === "passed")
    .map((result) => result.branchId);
  const failedBranches = branchResults
    .filter((result) => result.appliedState === "apply_failed" || result.validationState === "verified_failed")
    .map((result) => result.branchId);
  const blockedBranches = branchResults
    .filter((result) => {
      const branch = factory?.branchExecutions?.find((candidate) => candidate.branchId === result.branchId);
      return result.reviewResult === "blocked"
        || result.reviewResult === "needs_changes"
        || branch?.status === "blocked"
        || branch?.status === "blocked_conflict"
        || branch?.status === "blocked_failed_dependency"
        || branch?.status === "skipped";
    })
    .map((result) => result.branchId);
  const unverifiedBranches = branchResults
    .filter((result) => !completedBranches.includes(result.branchId) && !failedBranches.includes(result.branchId) && !blockedBranches.includes(result.branchId))
    .map((result) => result.branchId);
  const conflictsUnresolved = (factory?.branchScopeConflicts ?? [])
    .filter((conflict) => conflict.severity === "blocking")
    .map((conflict) => `${conflict.code}: ${conflict.reason}`);
  const conflictsResolved = (factory?.branchScopeConflicts ?? [])
    .filter((conflict) => conflict.severity !== "blocking")
    .map((conflict) => `${conflict.code}: ${conflict.reason}`);
  const status =
    failedBranches.length
      ? "failed"
      : blockedBranches.length || unverifiedBranches.length || conflictsUnresolved.length
        ? "unverified"
        : "passed";
  const truthStatus =
    status === "passed"
      ? "verified_passed"
      : status === "failed"
        ? worstRecursiveTruth(branchResults.map((result) => result.validationState), "verified_failed")
        : worstRecursiveTruth(branchResults.map((result) => result.validationState), "unverified");
  const validation: RecursiveValidationRecord = {
    id: `recursive_validation_integration_${session.id}`,
    sessionId: session.id,
    level: "integration_validation",
    truthStatus,
    status,
    summary:
      status === "passed"
        ? "All branch results are verified and no unresolved conflicts remain."
        : status === "failed"
          ? "One or more branch results failed, so integration validation cannot pass."
          : "Integration validation is unverified because at least one branch or conflict remains unresolved.",
    blockingReasons: uniqueRuntimeStrings([
      ...failedBranches.map((branchId) => `Failed branch: ${branchId}`),
      ...blockedBranches.map((branchId) => `Blocked branch: ${branchId}`),
      ...unverifiedBranches.map((branchId) => `Unverified branch: ${branchId}`),
      ...conflictsUnresolved
    ]),
    evidenceRefs: branchResults.flatMap((result) => result.patchIds.map((patchId) => `patch:${patchId}`)),
    discoveredCommands: branchValidations.flatMap((validation) => validation.discoveredCommands ?? []),
    selectedStrategy: selectIntegrationStrategy(branchValidations),
    evidence: branchValidations.flatMap((validation) => validation.evidence ?? []),
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
  return {
    id: `recursive_fan_in_${session.id}`,
    sessionId: session.id,
    completedBranches,
    blockedBranches,
    failedBranches,
    unverifiedBranches,
    conflictsResolved,
    conflictsUnresolved,
    integrationRisks: uniqueRuntimeStrings([
      ...branchResults.flatMap((result) => result.risksAndLimitations),
      ...validation.blockingReasons
    ]),
    remainingManualSteps: remainingRecursiveManualSteps(validation, branchResults),
    validation,
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
}

function buildRecursiveFinalReport(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  integrationSummary: RecursiveIntegrationSummary,
  branchValidations: RecursiveValidationRecord[]
): RecursiveFinalReport {
  const now = new Date().toISOString();
  const finalValidation = buildRecursiveFinalValidation(session, branchResults, integrationSummary, branchValidations, now);
  const validationHierarchy = [...branchValidations, integrationSummary.validation, finalValidation];
  const graph = session.recursiveFactory?.recursiveGraph;
  return {
    id: `recursive_final_report_${session.id}`,
    sessionId: session.id,
    productGoal: session.recursiveFactory?.productSpec?.userGoal ?? session.userPrompt,
    approvedTechnicalPlanSummary: session.recursiveFactory?.technicalPlan?.summary ?? "No approved Technical Plan summary recorded.",
    graphSummary: graph
      ? `${graph.rootGoal}; ${graph.branches.length} branch(es), ${graph.conflicts.length} conflict(s), graph ${graph.status}.`
      : "No recursive graph recorded.",
    branchOutcomes: branchResults,
    patchApplyTruth: branchResults.flatMap((result) =>
      result.patchIds.map((patchId) => {
        const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
        return {
          patchId,
          status: patch?.status ?? "proposed",
          filesChanged: patch?.filesChanged.map((file) => file.path) ?? result.filesChanged
        };
      })
    ),
    patchProvenance: buildRecursivePatchProvenance(session, branchResults),
    validationHierarchy,
    finalValidationState: finalValidation.truthStatus,
    finalStatus: finalValidation.status,
    validationDiscovery: {
      discoveredCommands: finalValidation.discoveredCommands ?? [],
      chosenStrategy: finalValidation.selectedStrategy ?? {
        kind: "missing",
        classification: "missing",
        scope: "none",
        reason: "No final validation strategy was recorded."
      },
      evidence: finalValidation.evidence ?? [],
      statusReason: finalValidation.summary
    },
    knownLimitations: uniqueRuntimeStrings([
      ...integrationSummary.integrationRisks,
      ...validationHierarchy.flatMap((validation) => validation.status === "passed" ? [] : validation.blockingReasons)
    ]),
    recommendedNextStep: recommendedRecursiveNextStep(finalValidation, integrationSummary),
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
}

function buildRecursiveFinalValidation(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  integrationSummary: RecursiveIntegrationSummary,
  branchValidations: RecursiveValidationRecord[],
  now: string
): RecursiveValidationRecord {
  const failedBranch = branchValidations.some((validation) => validation.status === "failed");
  const unverifiedBranch = branchValidations.some((validation) => validation.status === "unverified");
  const repairRevalidationPassed = hasVerifiedRepairRevalidationPass(session, branchResults);
  const selectedStrategy = selectIntegrationStrategy([...branchValidations, integrationSummary.validation]);
  const evidence = [...branchValidations, integrationSummary.validation].flatMap((validation) => validation.evidence ?? []);
  const discoveredCommands = [...branchValidations, integrationSummary.validation].flatMap((validation) => validation.discoveredCommands ?? []);
  const status =
    repairRevalidationPassed
      ? "passed"
      : failedBranch || integrationSummary.validation.status === "failed"
      ? "failed"
      : unverifiedBranch || integrationSummary.validation.status === "unverified" || !branchResults.length
        ? "unverified"
        : "passed";
  const truthStatus =
    status === "passed"
      ? "verified_passed"
      : status === "failed"
        ? worstRecursiveTruth([...branchResults.map((result) => result.validationState), integrationSummary.validation.truthStatus], "verified_failed")
        : worstRecursiveTruth([...branchResults.map((result) => result.validationState), integrationSummary.validation.truthStatus], "unverified");
  return {
    id: `recursive_validation_final_${session.id}`,
    sessionId: session.id,
    level: "final_validation",
    truthStatus,
    status,
    summary:
      repairRevalidationPassed
        ? "Final recursive validation passed after Rust-applied repair and successful same-command revalidation."
        : status === "passed"
          ? "Final recursive validation passed from branch and integration evidence."
        : status === "failed"
          ? "Final recursive validation failed because at least one required branch or integration result failed."
          : "Final recursive validation is unverified; no green success is claimed.",
    blockingReasons: uniqueRuntimeStrings([
      ...(status === "passed" ? [] : branchValidations.flatMap((validation) => validation.status === "passed" ? [] : validation.blockingReasons)),
      ...(status === "passed" ? [] : integrationSummary.validation.blockingReasons),
      ...(status === "passed" || branchResults.length ? [] : ["No branch result records were available."])
    ]),
    evidenceRefs: [
      ...branchResults.flatMap((result) => result.patchIds.map((patchId) => `patch:${patchId}`)),
      ...evidence.map((entry) => entry.executionId ? `command_execution:${entry.executionId}` : entry.kind === "patch_effect" ? "patch_effect:evidence" : "validation:evidence"),
      `session:${session.id}`
    ],
    discoveredCommands,
    selectedStrategy,
    evidence,
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
}

function hasVerifiedRepairRevalidationPass(session: AgentRuntimeSession, branchResults: RecursiveBranchResultRecord[]) {
  const repair = session.recursiveFactory?.repair;
  if (!repair || repair.status !== "revalidated" || repair.repairPatchStatus !== "applied" || !repair.repairPatchId) return false;
  const revalidation = repair.validationAttempts.find((attempt) =>
    attempt.role === "repair_revalidation"
    && attempt.truthStatus === "verified_passed"
    && (attempt.status === "executed" || attempt.status === "completed" || attempt.status === "verified_passed")
    && (attempt.exitCode === undefined || attempt.exitCode === 0)
    && attempt.policyResult !== "blocked"
  );
  if (!revalidation) return false;
  if (!branchResults.length) return false;
  return branchResults.every((result) => result.patchIds.every((patchId) =>
    session.patchProposals.find((patch) => patch.id === patchId)?.status === "applied"
  ));
}

type RecursiveBranchValidationEvaluation = {
  discoveredCommands: RecursiveDiscoveredValidationCommand[];
  strategy: RecursiveValidationStrategy;
  evidence: RecursiveValidationEvidence[];
  truthStatus: import("@hivo/protocol").ValidationTruthStatus;
  summary: string;
};

function evaluateRecursiveBranchValidation(session: AgentRuntimeSession, branchId: string): RecursiveBranchValidationEvaluation {
  const patches = recursiveBranchPatches(session, branchId);
  const discoveredCommands = discoverRecursiveValidationCommands({
    workspacePath: session.workspacePath,
    projectMap: session.orchestration?.projectMap
  });
  const strategy = selectRecursiveValidationStrategy({
    discoveredCommands,
    patches,
    branchId,
    exactPatchEffectAllowed: true
  });
  const evidence = findRecursiveValidationEvidence({ session, strategy, patches });
  const truthStatus = truthFromRecursiveValidation({ strategy, evidence });
  return {
    discoveredCommands,
    strategy,
    evidence,
    truthStatus,
    summary: summarizeRecursiveValidationEvaluation(strategy, evidence, discoveredCommands)
  };
}

function recursiveBranchPatches(session: AgentRuntimeSession, branchId: string) {
  const branch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
  if (!branch) return [];
  const patchIds = uniqueRuntimeStrings([
    branch.proposedPatchId,
    ...(branch.nestedSubtasks ?? []).map((subtask) => subtask.proposedPatchId)
  ].filter(Boolean) as string[]);
  return session.patchProposals.filter((patch) => patchIds.includes(patch.id));
}

function hasMatchingValidationRequestOrExecution(session: AgentRuntimeSession, strategy: RecursiveValidationStrategy) {
  if (strategy.kind !== "command" || !strategy.command) return false;
  const targetCwd = path.resolve(resolveInsideWorkspace(session.workspacePath, strategy.cwd ?? "."));
  return session.commandRequests.some((request) =>
    normalizeRuntimeCommand(request.command) === normalizeRuntimeCommand(strategy.command!)
    && path.resolve(request.cwd) === targetCwd
  ) || session.commandExecutions.some((execution) =>
    normalizeRuntimeCommand(execution.command) === normalizeRuntimeCommand(strategy.command!)
    && path.resolve(execution.cwd) === targetCwd
  );
}

function summarizeRecursiveValidationEvaluation(
  strategy: RecursiveValidationStrategy,
  evidence: RecursiveValidationEvidence[],
  discoveredCommands: RecursiveDiscoveredValidationCommand[]
) {
  const latest = evidence.at(-1);
  if (latest) {
    const outputSummary = [
      latest.policyResult ? `policy=${latest.policyResult}` : undefined,
      typeof latest.exitCode === "number" ? `exit=${latest.exitCode}` : undefined,
      latest.stdoutSummary ? `stdout=${latest.stdoutSummary}` : undefined,
      latest.stderrSummary ? `stderr=${latest.stderrSummary}` : undefined
    ].filter(Boolean).join("; ");
    return outputSummary ? `${latest.summary} (${outputSummary})` : latest.summary;
  }
  if (strategy.kind === "command") {
    return `Discovered ${discoveredCommands.length} validation command(s). Selected ${strategy.command}; status is ${strategy.classification}, so no verified pass is claimed until Rust reports a passing terminal result.`;
  }
  if (strategy.kind === "patch_effect") {
    return "Selected exact patch-effect validation, but no matching patch-effect evidence has been recorded.";
  }
  return strategy.reason;
}

function selectIntegrationStrategy(validations: RecursiveValidationRecord[]): RecursiveValidationStrategy {
  const strategies = validations.map((validation) => validation.selectedStrategy).filter(Boolean) as RecursiveValidationStrategy[];
  return strategies.find((strategy) => strategy.kind === "command" && strategy.classification === "safe_auto")
    ?? strategies.find((strategy) => strategy.kind === "command")
    ?? strategies.find((strategy) => strategy.kind === "patch_effect")
    ?? {
      kind: "missing",
      classification: "missing",
      scope: "none",
      reason: "No branch validation strategy was available for integration."
    };
}

function normalizeRuntimeCommand(command: string) {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function branchAppliedState(branch: RecursiveBranchExecutionRecord, patches: PatchProposal[]): RecursiveBranchResultRecord["appliedState"] {
  if (patches.some((patch) => patch.status === "apply_failed") || branch.status === "failed" && branch.validationStatus === "not_run_runtime_error") return "apply_failed";
  if (!patches.length || patches.every((patch) => patch.status !== "applied")) return "not_applied";
  if (patches.every((patch) => patch.status === "applied") && branch.patchApplied) return "applied";
  return "partially_applied";
}

function validationRecordStatus(truthStatus: import("@hivo/protocol").ValidationTruthStatus): RecursiveValidationRecord["status"] {
  if (truthStatus === "verified_passed") return "passed";
  if (truthStatus === "verified_failed") return "failed";
  return "unverified";
}

function worstRecursiveTruth(values: import("@hivo/protocol").ValidationTruthStatus[], fallback: import("@hivo/protocol").ValidationTruthStatus): import("@hivo/protocol").ValidationTruthStatus {
  const ordered: import("@hivo/protocol").ValidationTruthStatus[] = [
    "verified_failed",
    "not_run_runtime_error",
    "not_run_blocked_by_policy",
    "not_run_needs_approval",
    "not_run_missing_command",
    "unverified",
    "verified_passed"
  ];
  return ordered.find((candidate) => values.includes(candidate)) ?? fallback;
}

function remainingRecursiveManualSteps(validation: RecursiveValidationRecord, branchResults: RecursiveBranchResultRecord[]) {
  if (validation.status === "passed") return [];
  const steps = [
    validation.truthStatus === "not_run_needs_approval" ? "Approve and run pending validation commands through Rust." : undefined,
    validation.truthStatus === "not_run_missing_command" ? "Record or add an explicit validation command before claiming success." : undefined,
    validation.truthStatus === "verified_failed" ? "Inspect failed validation evidence and repair the affected branch." : undefined,
    ...branchResults
      .filter((result) => result.validationState !== "verified_passed")
      .map((result) => `Resolve ${result.branchId}: validation is ${result.validationState}.`)
  ].filter(Boolean) as string[];
  return uniqueRuntimeStrings(steps.length ? steps : ["Review unverified recursive validation evidence before claiming success."]);
}

function recommendedRecursiveNextStep(finalValidation: RecursiveValidationRecord, integrationSummary: RecursiveIntegrationSummary) {
  if (finalValidation.status === "passed") return "Recursive execution is verified; review the final report and close the run.";
  if (finalValidation.status === "failed") return "Inspect failed branch or integration evidence, then request a repair branch.";
  return integrationSummary.remainingManualSteps[0] ?? "Run or report validation evidence through Rust before claiming final success.";
}

function buildRecursivePatchProvenance(session: AgentRuntimeSession, branchResults: RecursiveBranchResultRecord[]): RecursivePatchProvenance[] {
  const recursivePatchIds = new Set(branchResults.flatMap((result) => result.patchIds));
  return session.patchProposals
    .filter((patch) => recursivePatchIds.has(patch.id) && patch.status === "applied")
    .map((patch) => {
      const owner = findRecursivePatchOwner(session, patch.id);
      const diffHunks = parsePatchDiffHunks(patch.unifiedDiff);
      return {
        patchId: patch.id,
        branchId: owner?.branchId,
        subtaskId: owner?.subtaskId,
        filesChanged: patch.filesChanged.map((file) => normalizeWorkspaceRelativePath(file.path)),
        diffHunks,
        touchedSymbols: extractTouchedSymbols(diffHunks),
        fileHashes: patch.filesChanged.map((file) => {
          const filePath = normalizeWorkspaceRelativePath(file.path);
          const afterContent = patch.artifacts?.find((artifact) => normalizeWorkspaceRelativePath(artifact.path) === filePath)?.content
            ?? safeReadWorkspaceFile(session.workspacePath, filePath);
          const beforeContent = reconstructRemovedContentForFile(diffHunks, filePath);
          return {
            path: filePath,
            beforeHash: beforeContent ? sha256Text(beforeContent) : undefined,
            afterHash: afterContent !== undefined ? sha256Text(afterContent) : undefined
          };
        }),
        rustApplyResultId: findPatchApplyArtifactId(session, patch.id) ?? (patch.appliedAt || patch.lastStatusAt ? `patch_apply:${patch.id}:${patch.appliedAt ?? patch.lastStatusAt}` : undefined),
        validationAttemptId: findValidationAttemptAfterPatch(session, patch)
      };
    });
}

function findRecursivePatchOwner(session: AgentRuntimeSession, patchId: string) {
  for (const branch of session.recursiveFactory?.branchExecutions ?? []) {
    if (branch.proposedPatchId === patchId) return { branchId: branch.branchId };
    const subtask = branch.nestedSubtasks?.find((candidate) => candidate.proposedPatchId === patchId);
    if (subtask) return { branchId: branch.branchId, subtaskId: subtask.subtaskId };
  }
  return undefined;
}

function findPatchApplyArtifactId(session: AgentRuntimeSession, patchId: string) {
  return session.artifacts.find((artifact) =>
    artifact.title === "Patch applied"
    && typeof artifact.payload?.patchId === "string"
    && artifact.payload.patchId === patchId
  )?.id;
}

function findValidationAttemptAfterPatch(session: AgentRuntimeSession, patch: PatchProposal) {
  const appliedAt = Date.parse(patch.appliedAt ?? patch.lastStatusAt ?? patch.createdAt);
  return session.commandExecutions.find((execution) =>
    Number.isFinite(appliedAt)
      ? Date.parse(execution.createdAt) >= appliedAt
      : true
  )?.id;
}

function parsePatchDiffHunks(diff: string): RecursivePatchProvenance["diffHunks"] {
  const hunks: RecursivePatchProvenance["diffHunks"] = [];
  let currentFile = "";
  let current: RecursivePatchProvenance["diffHunks"][number] | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch?.[1]) currentFile = normalizeWorkspaceRelativePath(fileMatch[1]);
    if (line.startsWith("@@")) {
      current = { filePath: currentFile, header: line, addedLines: [], removedLines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.addedLines.push(line.slice(1));
    if (line.startsWith("-") && !line.startsWith("---")) current.removedLines.push(line.slice(1));
  }
  return hunks;
}

function extractTouchedSymbols(hunks: RecursivePatchProvenance["diffHunks"]): RecursivePatchProvenance["touchedSymbols"] {
  const symbols: RecursivePatchProvenance["touchedSymbols"] = [];
  for (const hunk of hunks) {
    for (const line of [...hunk.addedLines, ...hunk.removedLines]) {
      const trimmed = line.trim();
      const candidates = [
        { match: trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/), kind: "function" as const },
        { match: trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/), kind: "class" as const },
        { match: trimmed.match(/^def\s+([A-Za-z_]\w*)/), kind: "function" as const },
        { match: trimmed.match(/^class\s+([A-Za-z_]\w*)/), kind: "class" as const },
        { match: trimmed.match(/^(?:pub\s+)?fn\s+([A-Za-z_]\w*)/), kind: "function" as const },
        { match: trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/), kind: "unknown" as const }
      ];
      for (const candidate of candidates) {
        const name = candidate.match?.[1];
        if (name) symbols.push({ filePath: hunk.filePath, name, kind: candidate.kind });
      }
    }
    const moduleName = moduleNameForPath(hunk.filePath);
    if (moduleName) symbols.push({ filePath: hunk.filePath, name: moduleName, kind: "module" });
  }
  return dedupeSymbols(symbols);
}

function reconstructRemovedContentForFile(hunks: RecursivePatchProvenance["diffHunks"], filePath: string) {
  const lines = hunks
    .filter((hunk) => normalizeWorkspaceRelativePath(hunk.filePath) === normalizeWorkspaceRelativePath(filePath))
    .flatMap((hunk) => hunk.removedLines);
  return lines.length ? `${lines.join("\n")}\n` : undefined;
}

function safeReadWorkspaceFile(workspacePath: string, filePath: string) {
  try {
    return readFileSync(resolveInsideWorkspace(workspacePath, filePath), "utf8");
  } catch {
    return undefined;
  }
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function diagnoseRecursiveValidationFailure(session: AgentRuntimeSession, finalReport: RecursiveFinalReport): RecursiveValidationFailureDiagnosis | undefined {
  const failedEvidence = [...(finalReport.validationDiscovery?.evidence ?? [])]
    .reverse()
    .find((entry) => entry.kind === "command" && entry.truthStatus === "verified_failed" && entry.command);
  if (!failedEvidence?.command) return undefined;
  const execution = failedEvidence.executionId
    ? session.commandExecutions.find((candidate) => candidate.id === failedEvidence.executionId)
    : session.commandExecutions.find((candidate) => normalizeRuntimeCommand(candidate.command) === normalizeRuntimeCommand(failedEvidence.command!));
  const stdout = execution?.stdout ?? failedEvidence.stdoutSummary ?? "";
  const stderr = execution?.stderr ?? failedEvidence.stderrSummary ?? "";
  const combined = `${stdout}\n${stderr}`;
  const failingTests = extractFailureLines(combined, /^(?:FAILED|ERROR)\s+(.+)$/i);
  const errors = extractFailureLines(combined, /\b(?:AssertionError|Error:|Traceback|failed|failure|panic|error)\b/i);
  const failureSignals = extractRecursiveValidationFailureSignals(session.workspacePath, failedEvidence.command, combined);
  const attribution = attributeRecursiveFailureToPatches({
    patchProvenance: finalReport.patchProvenance,
    failureSignals,
    output: combined,
    memoryFreshness: detectProjectMemoryFreshness(session.workspacePath)
  });
  const patchIds = attribution.relatedPatchIds;
  const branchIds = attribution.relatedBranchIds;
  const likelyFiles = uniqueRuntimeStrings(finalReport.patchProvenance
    .filter((provenance) => patchIds.includes(provenance.patchId))
    .flatMap((provenance) => provenance.filesChanged));
  const summary = [
    `Validation command failed: ${failedEvidence.command}`,
    typeof failedEvidence.exitCode === "number" ? `exit ${failedEvidence.exitCode}` : undefined,
    failingTests.length ? `failing tests: ${failingTests.slice(0, 3).join("; ")}` : undefined,
    `attribution=${attribution.confidence}`,
    likelyFiles.length ? `likely files: ${likelyFiles.join(", ")}` : "no related patched file could be proven"
  ].filter(Boolean).join("; ");
  return {
    id: `validation_failure_diagnosis_${session.id}`,
    sessionId: session.id,
    command: failedEvidence.command,
    cwd: failedEvidence.cwd ?? session.workspacePath,
    exitCode: failedEvidence.exitCode,
    stdoutSummary: failedEvidence.stdoutSummary ?? summarizeRuntimeOutput(stdout),
    stderrSummary: failedEvidence.stderrSummary ?? summarizeRuntimeOutput(stderr),
    failingTests,
    errors,
    likelyFiles,
    branchIds,
    patchIds,
    failureSignals,
    attribution,
    summary,
    createdAt: new Date().toISOString()
  };
}

function extractRecursiveValidationFailureSignals(workspacePath: string, command: string, output: string): RecursiveValidationFailureSignals {
  const commandType = classifyValidationCommandType(command);
  const workspaceFiles = extractWorkspaceFileRefs(workspacePath, output);
  const stackFrames = extractStackFrames(workspacePath, output);
  const failingTestFiles = uniqueRuntimeStrings(output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(?:FAILED|ERROR)\s+([^\s:]+)(?:::\S+)?/i);
    return match?.[1] ? [normalizeDiagnosedFilePath(workspacePath, match[1])].filter(Boolean) as string[] : [];
  }));
  const sourceFiles = uniqueRuntimeStrings([
    ...workspaceFiles,
    ...stackFrames.map((frame) => frame.filePath).filter(Boolean) as string[]
  ].filter((file) => !failingTestFiles.includes(file)));
  const assertionMessages = extractFailureLines(output, /\b(?:AssertionError|assert |Error:|panic|failed|failure)\b/i);
  const importModules = extractImportModules(output);
  const lineNumbers = uniqueLineNumbers(stackFrames.flatMap((frame) =>
    typeof frame.line === "number" ? [{ filePath: frame.filePath, line: frame.line }] : []
  ));
  return {
    commandType,
    failingTestFiles,
    sourceFiles,
    assertionMessages,
    importModules,
    stackFrames,
    lineNumbers
  };
}

function classifyValidationCommandType(command: string): RecursiveValidationFailureSignals["commandType"] {
  const normalized = normalizeRuntimeCommand(command);
  if (/\bpytest\b/.test(normalized)) return "pytest";
  if (/\bnpm\b|\bpnpm\b|\byarn\b|node\s+--test/.test(normalized)) return "npm";
  if (/\bcargo\b/.test(normalized)) return "cargo";
  return "other";
}

function extractStackFrames(workspacePath: string, output: string): RecursiveValidationFailureSignals["stackFrames"] {
  const frames: RecursiveValidationFailureSignals["stackFrames"] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const python = line.match(/^File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(.+)$/);
    const node = line.match(/^at\s+(.+?)\s+\((.+?):(\d+):\d+\)$/);
    const simple = line.match(/^([A-Za-z0-9_.\-\/\\]+?\.(?:ts|tsx|js|jsx|py|rs|go|java|cs)):(\d+)(?::\d+)?(?::\s*in\s*(.+))?/);
    if (python) {
      frames.push({ filePath: normalizeDiagnosedFilePath(workspacePath, python[1]!), line: Number(python[2]), functionName: python[3], raw: line });
    } else if (node) {
      frames.push({ filePath: normalizeDiagnosedFilePath(workspacePath, node[2]!), line: Number(node[3]), functionName: node[1], raw: line });
    } else if (simple) {
      frames.push({ filePath: normalizeDiagnosedFilePath(workspacePath, simple[1]!), line: Number(simple[2]), functionName: simple[3], raw: line });
    }
  }
  return frames;
}

function extractImportModules(output: string) {
  const modules = new Set<string>();
  const patterns = [
    /ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/g,
    /ImportError:\s+.*?from ['"]?([A-Za-z0-9_.-]+)['"]?/g,
    /^\s*(?:from|import)\s+([A-Za-z0-9_.-]+)/gm,
    /Cannot find module ['"]([^'"]+)['"]/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const moduleName = match[1]?.replace(/^\.+/, "").split(".").filter(Boolean).join(".");
      if (moduleName) modules.add(moduleName);
    }
  }
  return [...modules];
}

function uniqueLineNumbers(lines: Array<{ filePath?: string; line: number }>) {
  const seen = new Set<string>();
  return lines.filter((entry) => {
    const key = `${entry.filePath ?? ""}:${entry.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function moduleNameForPath(filePath: string) {
  const withoutExtension = normalizeWorkspaceRelativePath(filePath).replace(/\.[^.]+$/, "");
  const parts = withoutExtension.split("/").filter(Boolean);
  if (!parts.length) return undefined;
  const filename = parts.at(-1);
  if (!filename) return undefined;
  return filename === "__init__" && parts.length > 1 ? parts.at(-2) : filename;
}

function moduleNamesMatch(observed: string, changed: string) {
  const normalizedObserved = observed.replaceAll("/", ".").replaceAll("\\", ".").toLowerCase();
  const normalizedChanged = changed.replaceAll("/", ".").replaceAll("\\", ".").toLowerCase();
  return normalizedObserved === normalizedChanged
    || normalizedObserved.endsWith(`.${normalizedChanged}`)
    || normalizedChanged.endsWith(`.${normalizedObserved}`);
}

function dedupeSymbols(symbols: RecursivePatchProvenance["touchedSymbols"]) {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectProjectMemoryFreshness(workspacePath: string): RecursiveFailurePatchAttribution["memoryFreshness"] {
  const state = readMemorySnapshotSync<{
    stale?: boolean;
    fresh?: boolean;
    status?: string;
    freshness?: string;
    updatedAt?: string;
    lastIndexedAt?: string;
  }>(workspacePath, "index_state");
  if (!state) return "unknown";
  if (state.stale || state.status === "stale" || state.freshness === "stale") return "stale";
  if (state.fresh === true || state.status === "fresh" || state.freshness === "fresh") return "fresh";
  const timestamp = Date.parse(state.updatedAt ?? state.lastIndexedAt ?? "");
  if (Number.isFinite(timestamp) && Date.now() - timestamp < 24 * 60 * 60 * 1000) return "fresh";
  if (Number.isFinite(timestamp)) return "stale";
  return "unknown";
}

function attributeRecursiveFailureToPatches(input: {
  patchProvenance: RecursivePatchProvenance[];
  failureSignals: RecursiveValidationFailureSignals;
  output: string;
  memoryFreshness: RecursiveFailurePatchAttribution["memoryFreshness"];
}): RecursiveFailurePatchAttribution {
  const outputLower = input.output.toLowerCase();
  const tracebackFiles = new Set([
    ...input.failureSignals.sourceFiles,
    ...input.failureSignals.stackFrames.map((frame) => frame.filePath).filter(Boolean) as string[]
  ].map(normalizeWorkspaceRelativePath));
  const evidence: string[] = [];
  const relatedPatchIds = new Set<string>();
  const relatedBranchIds = new Set<string>();
  let confidence: RecursiveFailurePatchAttribution["confidence"] = "none";

  const promote = (next: RecursiveFailurePatchAttribution["confidence"]) => {
    const order: RecursiveFailurePatchAttribution["confidence"][] = ["none", "low", "medium", "high"];
    if (order.indexOf(next) > order.indexOf(confidence)) confidence = next;
  };
  const relate = (provenance: RecursivePatchProvenance, reason: string, next: RecursiveFailurePatchAttribution["confidence"]) => {
    relatedPatchIds.add(provenance.patchId);
    if (provenance.branchId) relatedBranchIds.add(provenance.branchId);
    evidence.push(reason);
    promote(next);
  };

  for (const provenance of input.patchProvenance) {
    const changedFiles = provenance.filesChanged.map(normalizeWorkspaceRelativePath);
    const directChangedFile = changedFiles.find((file) => tracebackFiles.has(file));
    if (directChangedFile) {
      relate(provenance, `Changed file ${directChangedFile} appears in traceback/stack frame.`, "high");
      continue;
    }
    const changedSymbol = provenance.touchedSymbols.find((symbol) =>
      symbol.kind !== "module"
      && symbol.name.length > 2
      && new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`).test(input.output)
    );
    if (changedSymbol) {
      const symbolFrameMatch = input.failureSignals.stackFrames.some((frame) => frame.functionName === changedSymbol.name);
      relate(
        provenance,
        `Changed ${changedSymbol.kind} ${changedSymbol.name} is referenced in validation output${symbolFrameMatch ? " stack frames" : ""}.`,
        symbolFrameMatch ? "high" : "medium"
      );
      continue;
    }
    const moduleMatch = provenance.touchedSymbols.find((symbol) =>
      symbol.kind === "module"
      && input.failureSignals.importModules.some((moduleName) => moduleNamesMatch(moduleName, symbol.name))
    );
    if (moduleMatch) {
      relate(provenance, `Failing test output imports changed module ${moduleMatch.name}.`, "medium");
      continue;
    }
    const basenameMention = changedFiles.find((file) => {
      const basename = path.basename(file, path.extname(file)).toLowerCase();
      return basename.length > 3 && outputLower.includes(basename);
    });
    if (basenameMention) {
      evidence.push(`Changed file basename ${path.basename(basenameMention)} appears in output, but no traceback/import relation was proven.`);
      promote("low");
    }
  }

  if (input.memoryFreshness === "stale" && confidence !== "none") {
    confidence = confidence === "high" || confidence === "medium" ? confidence : "low";
  }
  if (!relatedPatchIds.size || confidence === "low" || confidence === "none") {
    return {
      relatedPatchIds: [],
      relatedBranchIds: [],
      confidence: relatedPatchIds.size ? confidence : "none",
      evidence: uniqueRuntimeStrings(evidence),
      reason: evidence.length
        ? "Only weak or non-relational evidence was found; no patch relationship is claimed."
        : "Validation output did not mention changed files, changed symbols, or imports of changed modules.",
      memoryFreshness: input.memoryFreshness
    };
  }
  return {
    relatedPatchIds: [...relatedPatchIds],
    relatedBranchIds: [...relatedBranchIds],
    confidence,
    evidence: uniqueRuntimeStrings(evidence),
    reason: `Attribution confidence is ${confidence} from deterministic validation-output evidence.`,
    memoryFreshness: input.memoryFreshness
  };
}

function evaluateRecursiveRepairEligibility(session: AgentRuntimeSession, diagnosis: RecursiveValidationFailureDiagnosis, attemptCount: number): RecursiveRepairEligibility {
  const reasons: string[] = [];
  const maxAttempts = 1;
  const knownCommand = session.commandExecutions.some((execution) =>
    normalizeRuntimeCommand(execution.command) === normalizeRuntimeCommand(diagnosis.command)
  );
  if (!knownCommand) reasons.push("Failure was not produced by a known Rust-reported validation command.");
  if (attemptCount >= maxAttempts) reasons.push("Recursive repair attempt cap has already been reached.");
  const filesInsideWorkspace = diagnosis.likelyFiles.every((file) => isInsideWorkspacePath(session.workspacePath, file));
  if (diagnosis.attribution.confidence !== "high") {
    reasons.push(`Repair requires high failure-to-patch attribution by default; observed ${diagnosis.attribution.confidence}. ${diagnosis.attribution.reason}`);
  }
  if (!diagnosis.likelyFiles.length) reasons.push("No likely failing file could be tied to an applied recursive patch.");
  if (!filesInsideWorkspace) reasons.push("At least one diagnosed file is outside the workspace.");
  if (diagnosis.likelyFiles.length > 3) reasons.push("Diagnosis affects more than three files.");
  const relatedFiles = diagnosis.likelyFiles.filter((file) => isInsideWorkspacePath(session.workspacePath, file));
  if (!diagnosis.patchIds.length) reasons.push("Diagnosis did not map to an applied recursive patch.");
  const blockingConflicts = (session.recursiveFactory?.branchScopeConflicts ?? []).filter((conflict) => conflict.severity === "blocking");
  if (blockingConflicts.length) reasons.push("Blocking recursive scope conflicts remain unresolved.");
  return {
    status: reasons.length ? "repair_not_attempted" : "eligible",
    reasons: reasons.length ? uniqueRuntimeStrings(reasons) : ["Known validation failure is small, workspace-local, and tied to applied recursive patches."],
    attemptCount,
    maxAttempts,
    relatedFiles: uniqueRuntimeStrings(relatedFiles),
    relatedPatchIds: uniqueRuntimeStrings(diagnosis.patchIds)
  };
}

function refreshRecursiveRepairRecord(session: AgentRuntimeSession, finalReport: RecursiveFinalReport, repair: RecursiveRepairRecord): RecursiveRepairRecord {
  const patch = repair.repairPatchId ? session.patchProposals.find((candidate) => candidate.id === repair.repairPatchId) : undefined;
  const latestAttempt = buildRecursiveValidationAttempt(session, finalReport, repair.revalidationRequestId ? "repair_revalidation" : "initial", repair.revalidationRequestId ? 2 : 1);
  return {
    ...repair,
    repairPatchStatus: patch?.status ?? repair.repairPatchStatus,
    validationAttempts: latestAttempt ? upsertValidationAttempt(repair.validationAttempts, latestAttempt) : repair.validationAttempts,
    finalOutcome: finalReport.finalValidationState,
    updatedAt: new Date().toISOString()
  };
}

function buildRecursiveValidationAttempt(
  session: AgentRuntimeSession,
  finalReport: RecursiveFinalReport,
  role: RecursiveValidationAttempt["role"],
  attemptNumber: number
): RecursiveValidationAttempt | undefined {
  const evidence = [...(finalReport.validationDiscovery?.evidence ?? [])]
    .reverse()
    .find((entry) => entry.kind === "command" && entry.command);
  if (!evidence?.command) return undefined;
  const execution = evidence.executionId ? session.commandExecutions.find((candidate) => candidate.id === evidence.executionId) : undefined;
  return execution
    ? buildRecursiveValidationAttemptFromExecution(execution, role, attemptNumber)
    : {
        attemptNumber,
        role,
        command: evidence.command,
        cwd: evidence.cwd ?? session.workspacePath,
        truthStatus: evidence.truthStatus,
        status: evidence.truthStatus,
        exitCode: evidence.exitCode,
        stdoutSummary: evidence.stdoutSummary,
        stderrSummary: evidence.stderrSummary,
        requestId: evidence.requestId,
        executionId: evidence.executionId,
        policyResult: evidence.policyResult,
        summary: evidence.summary,
        createdAt: new Date().toISOString()
      };
}

function buildRecursiveValidationAttemptFromExecution(
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
    stdoutSummary: summarizeRuntimeOutput(execution.stdout),
    stderrSummary: summarizeRuntimeOutput(execution.stderr),
    requestId: execution.requestId,
    executionId: execution.id,
    policyResult: execution.provenance?.policyDecision,
    summary: execution.message ?? `Rust TerminalService reported ${execution.status}.`,
    createdAt: execution.createdAt
  };
}

function commandExecutionTruthStatus(execution: CommandExecutionRecord): import("@hivo/protocol").ValidationTruthStatus {
  const passed = (execution.status === "executed" || execution.status === "completed") && (execution.exitCode === undefined || execution.exitCode === 0);
  const failed = execution.status === "failed"
    || ((execution.status === "executed" || execution.status === "completed") && typeof execution.exitCode === "number" && execution.exitCode !== 0);
  if (failed) return "verified_failed";
  if (execution.status === "blocked") return "not_run_blocked_by_policy";
  if (execution.status === "approval_required") return "not_run_needs_approval";
  if (execution.status === "orphaned" || execution.status === "terminated" || execution.status === "unknown") return "not_run_runtime_error";
  return passed ? "verified_passed" : "unverified";
}

function upsertValidationAttempt(attempts: RecursiveValidationAttempt[], attempt: RecursiveValidationAttempt) {
  const next = attempts.filter((candidate) => candidate.attemptNumber !== attempt.attemptNumber);
  next.push(attempt);
  return next.sort((left, right) => left.attemptNumber - right.attemptNumber);
}

function markRecursiveRepairNotAttempted(repair: RecursiveRepairRecord, reason: string): RecursiveRepairRecord {
  return {
    ...repair,
    status: "repair_not_attempted",
    eligibility: {
      ...repair.eligibility,
      status: "repair_not_attempted",
      reasons: uniqueRuntimeStrings([...repair.eligibility.reasons, reason])
    },
    summary: `Repair not attempted: ${reason}`,
    updatedAt: new Date().toISOString()
  };
}

function extractFailureLines(output: string, pattern: RegExp) {
  return uniqueRuntimeStrings(output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line))
    .slice(0, 12));
}

function extractWorkspaceFileRefs(workspacePath: string, output: string) {
  const refs = new Set<string>();
  const patterns = [
    /(file:\/\/\/[^\s)]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|json|md|txt|toml|yaml|yml))(?::\d+)?/g,
    /([A-Za-z0-9_.\-\/\\]+?\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|json|md|txt|toml|yaml|yml))(?::\d+)?/g,
    /([A-Za-z]:[^\s:]+?\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|json|md|txt|toml|yaml|yml))(?::\d+)?/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const normalized = normalizeDiagnosedFilePath(workspacePath, raw);
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}

function normalizeDiagnosedFilePath(workspacePath: string, filePath: string) {
  let stripped = filePath.replace(/^["'`]+|["'`,.;)]+$/g, "").replaceAll("\\", "/");
  if (/^file:\/\//i.test(stripped)) {
    try {
      stripped = fileURLToPath(stripped);
    } catch {
      return undefined;
    }
  }
  const absolute = /^[a-z]:/i.test(stripped) || stripped.startsWith("/")
    ? path.resolve(stripped)
    : path.resolve(workspacePath, stripped);
  const relative = path.relative(workspacePath, absolute).replaceAll("\\", "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return normalizeWorkspaceRelativePath(relative);
}

function isInsideWorkspacePath(workspacePath: string, filePath: string) {
  try {
    resolveInsideWorkspace(workspacePath, filePath);
    return !normalizeWorkspaceRelativePath(filePath).startsWith("..");
  } catch {
    return false;
  }
}

function normalizeWorkspaceRelativePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
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

function createBranchExecutionRecord(input: {
  branch: BranchOrchestratorRecord;
  session: AgentRuntimeSession;
  branchTarget?: RecursiveBranchTargetPlan;
  now: string;
  status: RecursiveBranchExecutionRecord["status"];
  active: boolean;
}): RecursiveBranchExecutionRecord {
  const productSpec = input.session.recursiveFactory!.productSpec!;
  const technicalPlan = input.session.recursiveFactory!.technicalPlan!;
  const fileScopes = uniqueRuntimeStrings([
    ...(input.branchTarget?.targetFile ? [input.branchTarget.targetFile] : []),
    ...input.branch.fileScopes
  ]);
  const lockScopes = uniqueRuntimeStrings([
    ...(input.branchTarget?.targetFile ? [`file:${input.branchTarget.targetFile}`] : []),
    ...input.branch.lockScopes
  ]);
  return {
    branchId: input.branch.branchId,
    sessionId: input.session.id,
    title: input.branch.title,
    status: input.status,
    active: input.active,
    executionContext: {
      branchObjective: input.branch.objective,
      approvedProductSpecSummary: productSpec.userGoal,
      approvedTechnicalPlanSummary: technicalPlan.summary,
      fileScopes,
      semanticScopes: input.branch.semanticScopes,
      lockScopes,
      dependencies: input.branch.dependencies,
      evidenceContextPack: [
        `Product Spec ${productSpec.id} revision ${productSpec.revision} approved.`,
        `Technical Plan ${technicalPlan.id ?? "unknown"} revision ${technicalPlan.revision ?? 1} approved.`,
        ...input.branch.inputContextRequirements
      ]
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: fileScopes.length > 0,
      blockedReason: input.status === "waiting_on_dependency" && input.branch.dependencies.length ? "dependency_waiting" : undefined,
      sequencingReason: input.branch.dependencies.length
        ? `Waiting for dependencies: ${input.branch.dependencies.join(", ")}`
        : "Conservative scheduler selected one ready write branch."
    },
    plannedPatch: input.branchTarget,
    plannedNestedPatches: input.branchTarget?.nestedPatches,
    nestedDepth: 0,
    nestedEligible: false,
    reviewStatus: "not_started",
    validationStatus: "unverified",
    validationPlan: input.branch.validationStrategy.length ? input.branch.validationStrategy : technicalPlan.validationCommands ?? technicalPlan.testStrategy,
    patchApplied: false,
    createdAt: input.now,
    updatedAt: input.now
  };
}

type RecursiveBranchTargetPlan = {
  targetFile: string;
  replacementText: string;
  nestedPatches?: Array<{
    targetFile: string;
    replacementText: string;
    objective?: string;
  }>;
};

function normalizeBranchTargetPlans(
  workspacePath: string,
  request: RecursiveBranchExecutionStartRequest,
  branches: BranchOrchestratorRecord[]
) {
  const targets = new Map<string, RecursiveBranchTargetPlan>();
  const explicitTargets = request.branchTargets ?? [];
  for (const target of explicitTargets) {
    const branch = target.branchId ? branches.find((candidate) => candidate.branchId === target.branchId) : undefined;
    if (!branch) continue;
    targets.set(branch.branchId, {
      targetFile: normalizeBranchTargetPath(workspacePath, target.targetFile),
      replacementText: target.replacementText,
      nestedPatches: target.nestedSubtasks?.map((nested) => ({
        targetFile: normalizeBranchTargetPath(workspacePath, nested.targetFile),
        replacementText: nested.replacementText,
        objective: nested.objective
      }))
    });
  }
  if (request.targetFile && branches[0] && !targets.has(branches[0].branchId)) {
    targets.set(branches[0].branchId, {
      targetFile: normalizeBranchTargetPath(workspacePath, request.targetFile),
      replacementText: request.replacementText ?? `Recursive branch execution marker for ${branches[0].branchId}\n`
    });
  }
  return targets;
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

function buildNestedRollup(branch: RecursiveBranchExecutionRecord, patches: PatchProposal[]): RecursiveNestedSubtaskRollup {
  const subtasks = branch.nestedSubtasks ?? [];
  const patchIds = uniqueRuntimeStrings(subtasks.flatMap((subtask) => subtask.proposedPatchId ? [subtask.proposedPatchId] : []));
  const validationState = nestedBranchValidationStatus(branch);
  return {
    parentBranchId: branch.branchId,
    completedSubtasks: subtasks.filter((subtask) => subtask.status === "completed").map((subtask) => subtask.subtaskId),
    failedSubtasks: subtasks.filter((subtask) => subtask.status === "failed").map((subtask) => subtask.subtaskId),
    blockedSubtasks: subtasks.filter((subtask) => subtask.status === "blocked" || subtask.status === "blocked_conflict").map((subtask) => subtask.subtaskId),
    appliedPatches: patchIds.filter((patchId) => patches.find((patch) => patch.id === patchId)?.status === "applied"),
    validationState,
    limitations: uniqueRuntimeStrings([
      ...subtasks.flatMap((subtask) => subtask.blockedReason ? [subtask.blockedReason] : []),
      validationState === "verified_passed" ? undefined : `Nested validation truth is ${validationState}.`
    ].filter(Boolean) as string[]),
    updatedAt: new Date().toISOString()
  };
}

function nestedBranchValidationStatus(branch: RecursiveBranchExecutionRecord): import("@hivo/protocol").ValidationTruthStatus {
  const subtasks = branch.nestedSubtasks ?? [];
  if (!subtasks.length) return branch.validationStatus;
  if (subtasks.some((subtask) => subtask.validationStatus === "verified_failed" || subtask.status === "failed")) return "verified_failed";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_runtime_error")) return "not_run_runtime_error";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_blocked_by_policy" || subtask.status === "blocked" || subtask.status === "blocked_conflict")) return "not_run_blocked_by_policy";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_needs_approval")) return "not_run_needs_approval";
  if (subtasks.some((subtask) => subtask.validationStatus === "not_run_missing_command")) return "not_run_missing_command";
  const writeSubtasks = subtasks.filter((subtask) => subtask.required && subtask.writeSubtask);
  if (writeSubtasks.length && writeSubtasks.every((subtask) => subtask.status === "completed" && subtask.validationStatus === "verified_passed")) return "verified_passed";
  if (subtasks.every((subtask) => subtask.status === "completed" && subtask.validationStatus === "verified_passed")) return "verified_passed";
  return subtasks.some((subtask) => subtask.patchApplied) ? "not_run_missing_command" : "unverified";
}

function requiredNestedSubtasksTerminal(branch: RecursiveBranchExecutionRecord) {
  return (branch.nestedSubtasks ?? [])
    .filter((subtask) => subtask.required)
    .every((subtask) => subtask.status === "completed" || subtask.status === "validation_pending" || subtask.status === "failed" || subtask.status === "blocked" || subtask.status === "blocked_conflict");
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

function normalizeBranchTargetPath(workspacePath: string, requestedPath: string) {
  const resolved = resolveInsideWorkspace(workspacePath, requestedPath);
  return path.relative(resolveInsideWorkspace(workspacePath), resolved).replaceAll("\\", "/");
}

function createFileDiff(filePath: string, content: string) {
  const newLines = toUnifiedDiffLines(content);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${newLines.length} @@`,
    ...newLines.map((line) => `+${line}`)
  ].join("\n") + "\n";
}

function createWholeFileReplaceDiff(filePath: string, currentContent: string, replacementText: string) {
  const oldLines = toUnifiedDiffLines(currentContent);
  const newLines = toUnifiedDiffLines(replacementText);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n") + "\n";
}

function toUnifiedDiffLines(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.length ? withoutFinalNewline.split("\n") : [];
}

function buildRuntimeRunSummary(session: AgentRuntimeSession, verification: NonNullable<AgentRuntimeSession["verificationResult"]>): RunSummary {
  const status = (
    session.status === "failed" || session.status === "failed_provider"
      ? "failed"
      : session.status === "blocked" || session.lifecycleStage === "BLOCKED"
        ? "blocked"
      : session.status === "completed"
        ? "completed"
        : "pending"
  ) as RunSummary["status"];
  const nextAction =
    session.runToGreen?.status === "passed"
      ? "Selected run-to-green command passed."
      : session.runToGreen?.blockerReason
        ? session.runToGreen.blockerReason
        : session.status === "needs_approval"
          ? session.nextAction?.message ?? "Review the pending runtime action."
          : session.status === "failed" || session.status === "failed_provider"
            ? "Inspect the recorded patch or command failure."
            : "Review the active run state and latest verification evidence.";
  return buildDiffAwareRunSummary(
    session,
    verification,
    status,
    nextAction
  );
}

function buildReviewGateSummary(
  session: AgentRuntimeSession,
  verification: NonNullable<AgentRuntimeSession["verificationResult"]>
): NonNullable<AgentRuntimeSession["reviewGate"]> {
  const gate = buildAttributedReviewGate(session, verification);
  const scopeValidation = session.latestScopeValidation;
  const runToGreen = session.runToGreen
    ? {
        status: session.runToGreen.status,
        currentAttempt: session.runToGreen.currentAttempt,
        maxAttempts: session.runToGreen.maxAttempts,
        lastCommand: session.runToGreen.attempts.at(-1)?.command,
        lastDiagnosis: session.runToGreen.attempts.at(-1)?.diagnosis,
        blockerReason: session.runToGreen.blockerReason,
        finalStatus: session.runToGreen.finalStatus
      }
    : undefined;
  const withRunToGreen = {
    ...gate,
    runToGreen,
    unresolvedBlockers: uniqueRuntimeStrings([
      ...gate.unresolvedBlockers,
      ...(session.runToGreen?.status === "blocked" || session.runToGreen?.status === "max_attempts_reached"
        ? [session.runToGreen.blockerReason ?? "Run-to-green stopped without reaching green."]
        : [])
    ])
  };
  if (!scopeValidation) {
    if (session.runToGreen?.status === "blocked") {
      return {
        ...withRunToGreen,
        recommendation: "do_not_apply",
        summary: session.runToGreen.blockerReason ?? "Run-to-green was blocked before command execution.",
        unresolvedBlockers: uniqueRuntimeStrings([
          ...withRunToGreen.unresolvedBlockers,
          session.runToGreen.blockerReason ?? "Run-to-green was blocked before command execution."
        ])
      };
    }
    return withRunToGreen;
  }
  return {
    ...withRunToGreen,
    scopeValidation,
    recommendation:
      scopeValidation.verdict === "blocked"
        ? "do_not_apply"
        : scopeValidation.verdict === "needs_review"
          ? "caution"
          : gate.recommendation,
    unresolvedBlockers: uniqueRuntimeStrings([
      ...withRunToGreen.unresolvedBlockers,
      ...(scopeValidation.verdict === "blocked" ? ["Module scope validation blocked apply until the patch is narrowed."] : [])
    ]),
    summary:
      scopeValidation.verdict === "blocked"
        ? "Patch review is blocked because proposed changes exceed the scoped module plan."
        : scopeValidation.verdict === "needs_review"
          ? "Patch review needs extra attention because it touches cautionary or approval-sensitive scope."
          : withRunToGreen.summary
  };
}

function appendRuntimeAction(actions: string[] | undefined, next: string) {
  return [...(actions ?? []), next].slice(-8);
}

function waitingForProviderSummary(session: AgentRuntimeSession, language: "ar" | "en" | "arabic" | "english" | string | undefined) {
  const model = session.providerConfig?.selectedModel ?? session.providerConfig?.routerModel ?? "selected model";
  if (isArabicRuntimeLanguage(language)) {
    return `بانتظار رد الموديل ${model} لتحديد نوع السؤال وخطة الأدلة.`;
  }
  return `Waiting for ${model} to classify the request and choose the evidence plan.`;
}

function isArabicRuntimeLanguage(language: "ar" | "en" | "arabic" | "english" | string | undefined) {
  return language === "ar" || language === "arabic";
}

function citedEvidenceTargetFiles(citedEvidenceIds: string[] | undefined, evidenceRefs: ReasoningEvidenceRef[]) {
  if (!citedEvidenceIds?.length || !evidenceRefs.length) return [];
  const cited = new Set(citedEvidenceIds);
  const paths = evidenceRefs
    .filter((ref) => cited.has(ref.id) && ref.path)
    .map((ref) => ref.path!)
    .map((targetPath) => targetPath.replaceAll("\\", "/").replace(/^\.\//, ""));
  return [...new Set(paths)].slice(0, 12);
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function looksLikeTestCommand(command: string) {
  return /\b(test|vitest|jest|cargo test|npm test|pnpm test|yarn test|diff --check|tsc)\b/i.test(command);
}

function mergeRuntimeEvidenceRefs(
  existing: NonNullable<NonNullable<AgentRuntimeSession["orchestration"]>["agentRuns"]>[number]["evidenceRefs"] | undefined,
  next: import("@hivo/protocol").EvidenceRef[]
) {
  const merged = [...(existing ?? [])];
  for (const ref of next) {
    const fingerprint = JSON.stringify(ref);
    if (!merged.some((candidate) => JSON.stringify(candidate) === fingerprint)) {
      merged.push(ref);
    }
  }
  return merged.slice(-12);
}

function buildRuntimeCommandRequest(sessionId: string, command: string, cwd: string, reason: string) {
  const normalized = command.toLowerCase();
  const risk = classifyCommandRisk(command, cwd);
  return {
    id: `cmd_${randomUUID()}`,
    sessionId,
    command,
    cwd,
    risk,
    reason,
    provenance: {
      source: "agent" as const,
      trigger: "manual" as const,
      requestedBy: "agent" as const,
      agentId: "agent_local_codex",
      approvalSource: risk === "dangerous" ? "denied" as const : "none" as const,
      policyDecision: risk === "dangerous" ? "deny" as const : risk === "safe" ? "allow" as const : "require_approval" as const,
      policyReason: reason,
      background: looksLikeBackgroundCommand(normalized),
      networkDetected: looksLikeNetworkCommand(normalized),
      backgroundDetected: looksLikeBackgroundCommand(normalized),
      detectionSource: "heuristic" as const,
      networkDetectionSource: "heuristic" as const,
      backgroundDetectionSource: "heuristic" as const,
      reason
    },
    status: risk === "dangerous" ? "blocked" as const : "requested" as const,
    createdAt: new Date().toISOString()
  };
}

function summarizeRuntimeOutput(text: string | undefined, limit = 240) {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}
