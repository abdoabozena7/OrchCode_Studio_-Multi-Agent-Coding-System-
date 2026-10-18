import type {
  AgentRuntimeSession,
  CreateRuntimeSessionRequest,
  CreateRuntimeSessionResponse,
  AgentScopedMessageResponse,
  FactoryApprovalDecisionRequest,
  RecursiveBranchExecutionStartRequest,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RuntimeTurnResponse
} from "@hivo/protocol";
import type { RuntimeConfig } from "../config.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { inferActiveProviderSource } from "../llm/ProviderTelemetry.js";
import { resolveModelCertification } from "../evals/ReasoningCertificationRegistry.js";
import { SessionManager } from "./SessionManager.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { beginDecisionPipeline } from "./DecisionPipeline.js";
import type { SwarmMode } from "../orchestration/OrchestrationConfig.js";
import { RecursiveBranchPatchProposalService } from "./RecursiveBranchPatchProposalService.js";
import { RecursiveBranchPatchStatusService } from "./RecursiveBranchPatchStatusService.js";
import {
  evaluateRecursiveBranchValidation,
  RecursiveBranchValidationService
} from "./RecursiveBranchValidationService.js";
import { RecursiveRepairStateService } from "./RecursiveRepairStateService.js";
import { RuntimeDirectTurnService } from "./RuntimeDirectTurnService.js";
import { RuntimeApprovalBoundaryService } from "./RuntimeApprovalBoundaryService.js";
import { RuntimeRecursiveFactoryPlanningService } from "./RuntimeRecursiveFactoryPlanningService.js";
import { RuntimeScopedAgentMessageService } from "./RuntimeScopedAgentMessageService.js";
import { RuntimeRunToGreenService } from "./RuntimeRunToGreenService.js";
import { RuntimeProviderContextService } from "./RuntimeProviderContextService.js";
import { RuntimeTurnFailureService } from "./RuntimeTurnFailureService.js";
import { RuntimeIntentContractService } from "./RuntimeIntentContractService.js";
import { RuntimeRunEngineService } from "./RuntimeRunEngineService.js";
import { RuntimeProviderBackedSwarmService } from "./RuntimeProviderBackedSwarmService.js";
import { RuntimeRecursiveSwarmService } from "./RuntimeRecursiveSwarmService.js";
import { RuntimeSessionOutcomeService } from "./RuntimeSessionOutcomeService.js";
import { RuntimeRecursiveBranchExecutionService } from "./RuntimeRecursiveBranchExecutionService.js";
import { RuntimePendingActionService } from "./RuntimePendingActionService.js";
import { RuntimeRecursiveBranchProgressService } from "./RuntimeRecursiveBranchProgressService.js";
import { RuntimeConversationContextService } from "./RuntimeConversationContextService.js";
import { RuntimeAdaptiveDirectTurnService } from "./RuntimeAdaptiveDirectTurnService.js";
import { RuntimePlanningTurnService } from "./RuntimePlanningTurnService.js";
import {
  detectResponseLanguage,
  isArabicRuntimeLanguage,
  summarizeRuntimeOutput,
  waitingForProviderSummary
} from "./RuntimeTextUtils.js";
import {
  assertProviderGate,
  ProviderConfigurationError
} from "./RuntimeProviderGate.js";
export { ProviderConfigurationError } from "./RuntimeProviderGate.js";
import { createRealProvider } from "./RuntimeProviderFactory.js";
export { autoSuggestEmbeddingModel } from "./RuntimeProviderFactory.js";
import { RecursiveFanInReportService } from "./RecursiveFanInReportService.js";
import { RecursiveRepairPatchProposalService } from "./RecursiveRepairPatchProposalService.js";
import { RecursiveRepairPlanningService } from "./RecursiveRepairPlanningService.js";
import { buildNestedRollup, nestedBranchValidationStatus } from "./RecursiveNestedRollup.js";
import {
  RecursiveBranchSchedulerService,
  requiredNestedSubtasksTerminal
} from "./RecursiveBranchSchedulerService.js";
import {
  buildRecursiveBranchResults,
  buildRecursiveBranchValidationRecords,
  buildRecursiveFinalReport,
  buildRecursiveIntegrationSummary
} from "./RecursiveFanInReportBuilders.js";
export { buildRecursiveIntegrationHierarchy } from "./RecursiveFanInReportBuilders.js";

type AgentRuntimeOptions = {
  providerFactory?: (session: AgentRuntimeSession) => LlmProvider;
  swarmMode?: SwarmMode;
};

export class AgentRuntime {
  private readonly recursiveBranchPatchProposalService: RecursiveBranchPatchProposalService;
  private readonly recursiveBranchPatchStatusService: RecursiveBranchPatchStatusService;
  private readonly recursiveBranchValidationService: RecursiveBranchValidationService;
  private readonly recursiveRepairStateService: RecursiveRepairStateService;
  private readonly recursiveFanInReportService: RecursiveFanInReportService;
  private readonly recursiveRepairPatchProposalService: RecursiveRepairPatchProposalService;
  private readonly recursiveRepairPlanningService: RecursiveRepairPlanningService;
  private readonly recursiveBranchSchedulerService: RecursiveBranchSchedulerService;
  private readonly directTurnService: RuntimeDirectTurnService;
  private readonly approvalBoundaryService: RuntimeApprovalBoundaryService;
  private readonly recursiveFactoryPlanningService: RuntimeRecursiveFactoryPlanningService;
  private readonly scopedAgentMessageService: RuntimeScopedAgentMessageService;
  private readonly runToGreenService: RuntimeRunToGreenService;
  private readonly providerContextService: RuntimeProviderContextService;
  private readonly turnFailureService: RuntimeTurnFailureService;
  private readonly intentContractService: RuntimeIntentContractService;
  private readonly runEngineService: RuntimeRunEngineService;
  private readonly providerBackedSwarmService: RuntimeProviderBackedSwarmService;
  private readonly recursiveSwarmService: RuntimeRecursiveSwarmService;
  private readonly sessionOutcomeService: RuntimeSessionOutcomeService;
  private readonly recursiveBranchExecutionService: RuntimeRecursiveBranchExecutionService;
  private readonly pendingActionService: RuntimePendingActionService;
  private readonly recursiveBranchProgressService: RuntimeRecursiveBranchProgressService;
  private readonly conversationContextService = new RuntimeConversationContextService();
  private readonly adaptiveDirectTurnService: RuntimeAdaptiveDirectTurnService;
  private readonly planningTurnService: RuntimePlanningTurnService;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly sessionManager: SessionManager,
    private readonly options: AgentRuntimeOptions = {}
  ) {
    this.turnFailureService = new RuntimeTurnFailureService(this.sessionManager);
    this.intentContractService = new RuntimeIntentContractService(this.sessionManager);
    this.runEngineService = new RuntimeRunEngineService(this.sessionManager);
    this.providerBackedSwarmService = new RuntimeProviderBackedSwarmService(this.sessionManager, this.runEngineService);
    this.providerContextService = new RuntimeProviderContextService({
      providerRequestTimeoutMs: this.config.providerRequestTimeoutMs,
      getProvider: (session) => this.getProvider(session),
      createProvider: createRealProvider,
      useSessionProviderForSpecializedModels: Boolean(this.options.providerFactory)
    });
    this.directTurnService = new RuntimeDirectTurnService(this.sessionManager);
    this.adaptiveDirectTurnService = new RuntimeAdaptiveDirectTurnService(this.sessionManager, this.directTurnService);
    this.recursiveSwarmService = new RuntimeRecursiveSwarmService(this.sessionManager, this.directTurnService);
    this.sessionOutcomeService = new RuntimeSessionOutcomeService(this.sessionManager);
    this.pendingActionService = new RuntimePendingActionService(this.sessionManager);
    this.approvalBoundaryService = new RuntimeApprovalBoundaryService(this.sessionManager);
    this.recursiveFactoryPlanningService = new RuntimeRecursiveFactoryPlanningService(this.sessionManager);
    this.scopedAgentMessageService = new RuntimeScopedAgentMessageService(
      this.sessionManager,
      (session) => this.getProvider(session)
    );
    this.runToGreenService = new RuntimeRunToGreenService(
      this.sessionManager,
      (session) => this.getProvider(session)
    );
    this.recursiveBranchValidationService = new RecursiveBranchValidationService(this.sessionManager);
    this.recursiveRepairStateService = new RecursiveRepairStateService(this.sessionManager, {
      buildNestedRollup,
      summarizeOutput: summarizeRuntimeOutput
    });
    this.recursiveRepairPatchProposalService = new RecursiveRepairPatchProposalService(this.sessionManager, {
      getProvider: (session) => this.getProvider(session)
    });
    this.recursiveRepairPlanningService = new RecursiveRepairPlanningService(this.sessionManager, {
      proposeRepairPatch: (sessionId, finalReport, repair) => this.recursiveRepairPatchProposalService.propose(sessionId, finalReport, repair),
      summarizeOutput: summarizeRuntimeOutput
    });
    this.recursiveFanInReportService = new RecursiveFanInReportService(this.sessionManager, {
      buildBranchResults: buildRecursiveBranchResults,
      buildBranchValidationRecords: buildRecursiveBranchValidationRecords,
      buildIntegrationSummary: buildRecursiveIntegrationSummary,
      buildFinalReport: buildRecursiveFinalReport,
      prepareRepairLoop: (sessionId, finalReport) => this.recursiveRepairPlanningService.prepare(sessionId, finalReport)
    });
    this.recursiveBranchPatchProposalService = new RecursiveBranchPatchProposalService(this.sessionManager, buildNestedRollup);
    this.recursiveBranchSchedulerService = new RecursiveBranchSchedulerService(this.sessionManager, {
      proposeScheduledBranchPatch: (sessionId, branchId) => this.recursiveBranchPatchProposalService.proposeScheduledBranchPatch(sessionId, branchId),
      proposeNestedSubtaskPatch: (sessionId, branchId, subtaskId) => this.recursiveBranchPatchProposalService.proposeNestedSubtaskPatch(sessionId, branchId, subtaskId)
    });
    this.recursiveBranchExecutionService = new RuntimeRecursiveBranchExecutionService(
      this.sessionManager,
      this.recursiveBranchSchedulerService,
      { getProvider: (session) => this.getProvider(session) }
    );
    this.recursiveBranchPatchStatusService = new RecursiveBranchPatchStatusService(this.sessionManager, {
      buildNestedRollup,
      nestedBranchValidationStatus,
      requiredNestedSubtasksTerminal,
      evaluateBranchValidation: (session, branchId) => this.recursiveBranchValidationService.evaluateBranch(session, branchId),
      prepareBranchValidation: (sessionId, branchId) => this.recursiveBranchValidationService.prepareBranchValidation(sessionId, branchId)
    });
    this.recursiveBranchProgressService = new RuntimeRecursiveBranchProgressService(this.sessionManager, {
      repairState: this.recursiveRepairStateService,
      patchStatus: this.recursiveBranchPatchStatusService,
      fanInReport: this.recursiveFanInReportService,
      branchExecution: this.recursiveBranchExecutionService
    });
    this.planningTurnService = new RuntimePlanningTurnService(this.sessionManager, {
      intentContract: this.intentContractService,
      recursiveSwarm: this.recursiveSwarmService,
      recursiveFactoryPlanning: this.recursiveFactoryPlanningService,
      providerBackedSwarm: this.providerBackedSwarmService,
      runEngine: this.runEngineService
    });
  }

  async createSession(
    input: CreateRuntimeSessionRequest & { mode?: "real_provider" }
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
    const pendingAction = await this.pendingActionService.handle(session, message);
    if (pendingAction.handled) {
      return { sessionId, status: this.requireSession(sessionId).status };
    }
    const promptForExecution = pendingAction.resumePrompt ?? message;
    const conversationContext = this.conversationContextService.buildSameSession(session, promptForExecution);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = undefined;
    });
    const reportProviderProgress = true;
    if (reportProviderProgress) {
      const isArabicProgress = isArabicRuntimeLanguage(session.responseLanguage);
      await this.directTurnService.addProviderProgressEvent(sessionId, {
        stage: "planning",
        status: "running",
        title: isArabicProgress ? "فهم الطلب عند المزوّد" : "Understanding request with provider",
        summary: waitingForProviderSummary(session, session.responseLanguage)
      });
    }
    const modelCertification = resolveModelCertification(session.workspacePath, session.providerConfig);
    const providerContext = this.providerContextService.create(session, modelCertification);
    const { provider, routerProvider, telemetry: providerTelemetry } = providerContext;
    try {
      let conversationUnderstanding: ConversationUnderstanding | undefined;
      const decisionPipeline = await beginDecisionPipeline({
        message: promptForExecution,
        provider,
        routerProvider,
        conversationContext
      });
      conversationUnderstanding = decisionPipeline.understanding;
      await this.directTurnService.recordInitialDecisionPipeline(sessionId, decisionPipeline.state);
      if (reportProviderProgress) {
        const isArabicProgress = isArabicRuntimeLanguage(session.responseLanguage);
        await this.directTurnService.addProviderProgressEvent(sessionId, {
          stage: "planning",
          status: "completed",
          title: isArabicProgress ? "تحديد المسار" : "Routing complete",
          summary: decisionPipeline.state.reasoningDirective?.rationale
            ?? conversationUnderstanding?.intentDecision.rationale
            ?? "The provider classified the request and selected the next reasoning path."
        });
      }
      const directTurn = await this.adaptiveDirectTurnService.handle({
        sessionId,
        session,
        prompt: promptForExecution,
        decisionPipeline,
        providerContext,
        modelCertification,
        conversationContext
      });
      if (directTurn) {
        return directTurn;
      }
      return await this.planningTurnService.run({
        sessionId,
        session,
        prompt: promptForExecution,
        conversationUnderstanding,
        decisionPipelineId: decisionPipeline.state.id,
        providerContext,
        swarmMode: this.options.swarmMode ?? (process.env.HIVO_SWARM_MODE as SwarmMode | undefined)
      });
    } catch (error) {
      return this.turnFailureService.record({
        sessionId,
        baseSession: session,
        error,
        providerTelemetry
      });
    }
  }

  getSession(sessionId: string): AgentRuntimeSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  async decideProductSpec(sessionId: string, request: FactoryApprovalDecisionRequest) {
    return this.recursiveFactoryPlanningService.decideProductSpec(sessionId, request);
  }

  async decideTechnicalPlan(sessionId: string, request: FactoryApprovalDecisionRequest) {
    return this.recursiveFactoryPlanningService.decideTechnicalPlan(sessionId, request);
  }

  async startRecursiveBranchExecution(sessionId: string, request: RecursiveBranchExecutionStartRequest) {
    return this.recursiveBranchExecutionService.start(sessionId, request);
  }

  async approvePatch(sessionId: string, patchId: string) {
    const result = await this.approvalBoundaryService.approvePatch(sessionId, patchId);
    await this.recursiveBranchProgressService.projectPatchStatus(sessionId, patchId);
    return result;
  }

  async pauseRecursiveSwarm(sessionId: string): Promise<AgentRuntimeSession> {
    return this.recursiveSwarmService.pause(sessionId);
  }

  async resumeRecursiveSwarm(sessionId: string, message = "continue"): Promise<RuntimeTurnResponse> {
    return this.runTurn(sessionId, message);
  }

  async rejectPatch(sessionId: string, patchId: string) {
    const result = await this.approvalBoundaryService.rejectPatch(sessionId, patchId);
    await this.recursiveBranchProgressService.projectPatchStatus(sessionId, patchId);
    return result;
  }

  async reportPatchApplyResult(sessionId: string, patchId: string, result: ReportPatchApplyResultRequest) {
    const recorded = await this.approvalBoundaryService.recordPatchApplyResult(sessionId, patchId, result);
    if (!recorded.terminal) {
      await this.sessionOutcomeService.sync(sessionId);
      await this.recursiveBranchProgressService.projectPatchStatus(sessionId, patchId);
      return this.requireSession(sessionId);
    }
    const afterPatch = this.requireSession(sessionId);
    if (result.status === "applied") {
      await this.runToGreenService.queuePendingRerun(afterPatch, patchId, "Approved repair patch applied; rerun the selected command.");
    } else {
      await this.runToGreenService.recordPatchApplyFailure(sessionId, patchId);
    }
    await this.sessionOutcomeService.sync(sessionId);
    await this.recursiveBranchProgressService.updateRepairFromPatch(sessionId, patchId, recorded.patchStatus);
    await this.recursiveBranchProgressService.projectPatchStatus(sessionId, patchId);
    return this.requireSession(sessionId);
  }

  async reportCommandResult(sessionId: string, requestId: string, result: ReportCommandResultRequest) {
    const { record } = await this.approvalBoundaryService.recordCommandResult(sessionId, requestId, result);
    await this.runToGreenService.advanceFromCommandResult(sessionId, record);
    await this.sessionOutcomeService.sync(sessionId);
    await this.recursiveBranchProgressService.updateRepairFromCommandResult(sessionId, record);
    await this.recursiveBranchProgressService.projectPendingValidationPatches(sessionId);
    return this.requireSession(sessionId);
  }

  private getProvider(session: AgentRuntimeSession) {
    if (this.options.providerFactory) {
      return this.options.providerFactory(session);
    }
    return createRealProvider(session.providerConfig, this.config.providerRequestTimeoutMs);
  }

  async sendAgentScopedMessage(sessionId: string, agentId: string, message: string): Promise<AgentScopedMessageResponse> {
    return this.scopedAgentMessageService.send(sessionId, agentId, message);
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }
}
