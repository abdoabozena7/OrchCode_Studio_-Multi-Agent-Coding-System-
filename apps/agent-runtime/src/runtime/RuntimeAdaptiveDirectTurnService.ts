import type { AgentRuntimeSession, ProviderTruthTelemetry, RuntimeTurnResponse } from "@hivo/protocol";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { finalizeAdaptiveReasoningDecisionPipeline } from "./DecisionPipeline.js";
import { EvidenceStore } from "./EvidenceStore.js";
import { runReadOnlyUnderstandingEscalation } from "./ProjectUnderstandingEscalation.js";
import {
  continueAdaptiveReasoningTurn,
  type ReasoningConversationContext,
  type ReasoningKernelState
} from "./ReasoningKernel.js";
import type { RuntimeDirectTurnService } from "./RuntimeDirectTurnService.js";
import type { RuntimeProviderContext } from "./RuntimeProviderContextService.js";
import { isArabicRuntimeLanguage } from "./RuntimeTextUtils.js";
import { SessionManager } from "./SessionManager.js";

type DirectDecisionPipeline = {
  understanding: ConversationUnderstanding;
  state: NonNullable<AgentRuntimeSession["latestDecisionPipeline"]>;
  reasoningState: ReasoningKernelState;
};

export type RuntimeAdaptiveDirectTurnInput = {
  sessionId: string;
  session: AgentRuntimeSession;
  prompt: string;
  decisionPipeline: DirectDecisionPipeline;
  providerContext: RuntimeProviderContext;
  modelCertification: ProviderTruthTelemetry["modelCertification"];
  conversationContext: ReasoningConversationContext;
};

export class RuntimeAdaptiveDirectTurnService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly directTurnService: RuntimeDirectTurnService
  ) {}

  async handle(input: RuntimeAdaptiveDirectTurnInput): Promise<RuntimeTurnResponse | undefined> {
    const { sessionId, session, prompt, decisionPipeline, providerContext, modelCertification, conversationContext } = input;
    const conversationUnderstanding = decisionPipeline.understanding;
    if (!shouldUseDirectProviderTurn(conversationUnderstanding, decisionPipeline, modelCertification)) {
      return undefined;
    }
    const { provider, routerProvider, verifierProvider, telemetry: providerTelemetry } = providerContext;
    const tools = new ToolRegistry(session.workspacePath);
    const adaptiveEvidenceStore = new EvidenceStore();
    const isArabicProgress = isArabicRuntimeLanguage(session.responseLanguage);
    await this.directTurnService.addProviderProgressEvent(sessionId, {
      stage: conversationUnderstanding.intentDecision.kind === "workspace_question" ? "inspecting" : "working",
      status: "running",
      title: isArabicProgress ? "قراءة الأدلة وتأليف الرد" : "Reading evidence and composing answer",
      summary: isArabicProgress
        ? `بانتظار رد الموديل ${session.providerConfig?.selectedModel ?? "المحدد"} مع أدلة المشروع.`
        : `Waiting for ${session.providerConfig?.selectedModel ?? "the selected model"} to use the available evidence.`
    });
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
          question: request.query?.trim() || prompt,
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
      onPatchProposal: (proposal) => this.sessionManager.addPatchProposal(sessionId, proposal).then(() => undefined),
      conversationContext
    });
    const result = adaptive.result;
    providerTelemetry.markProviderAuthoredResponse();
    await this.finalizeDecisionPipeline(sessionId, result, adaptive.trace, providerTelemetry);
    return this.directTurnService.completeDirectConversationTurn({
      sessionId,
      message: prompt,
      decision: conversationUnderstanding.intentDecision,
      result,
      evidenceRefs: adaptive.trace.evidenceRefs
    });
  }

  private async finalizeDecisionPipeline(
    sessionId: string,
    result: Awaited<ReturnType<typeof continueAdaptiveReasoningTurn>>["result"],
    trace: Awaited<ReturnType<typeof continueAdaptiveReasoningTurn>>["trace"],
    providerTelemetry: ProviderTelemetryRecorder
  ) {
    const currentPipeline = this.requireSession(sessionId).latestDecisionPipeline;
    if (!currentPipeline) return;
    const telemetry = providerTelemetry.snapshot();
    const finalizedPipeline = {
      ...finalizeAdaptiveReasoningDecisionPipeline(currentPipeline, result, {
        ...trace,
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

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function shouldUseDirectProviderTurn(
  conversationUnderstanding: ConversationUnderstanding,
  decisionPipeline: DirectDecisionPipeline,
  modelCertification: ProviderTruthTelemetry["modelCertification"]
) {
  return ["direct_conversation", "workspace_question"].includes(conversationUnderstanding.intentDecision.kind)
    || modelCertification.certifiedGates?.includes("action_reasoning")
    || ["ask_user", "cannot_answer", "refuse"].includes(decisionPipeline.state.reasoningDirective?.action ?? "");
}
