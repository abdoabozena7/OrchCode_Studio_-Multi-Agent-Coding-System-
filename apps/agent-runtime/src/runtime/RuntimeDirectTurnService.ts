import type {
  AgentRuntimeSession,
  ProviderAuthoredResult,
  ReasoningEvidenceRef,
  RuntimeProgressStage,
  RuntimeProgressStatus
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import type { IntentDecision } from "./IntentDecisionEngine.js";
import { appendProviderEvidenceLinks } from "./ProviderEvidenceLinks.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeProviderProgressInput = {
  stage: RuntimeProgressStage;
  status: RuntimeProgressStatus;
  title: string;
  summary: string;
  targetFiles?: string[];
};

export class RuntimeDirectTurnService {
  constructor(private readonly sessionManager: SessionManager) {}

  async recordInitialDecisionPipeline(
    sessionId: string,
    state: NonNullable<AgentRuntimeSession["latestDecisionPipeline"]>
  ) {
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

  async addProviderProgressEvent(sessionId: string, input: RuntimeProviderProgressInput) {
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

  async completeDirectConversationTurn(input: {
    sessionId: string;
    message: string;
    decision: IntentDecision;
    result: ProviderAuthoredResult;
    evidenceRefs?: ReasoningEvidenceRef[];
  }) {
    const session = this.requireSession(input.sessionId);
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== input.message) {
      await this.sessionManager.addMessage(input.sessionId, { role: "user", content: input.message });
    }

    const evidenceRefs = input.evidenceRefs ?? [];
    const answer = appendProviderEvidenceLinks(
      input.result.answerMarkdown,
      input.result.evidenceRefs,
      evidenceRefs,
      input.decision.language
    );
    const now = new Date().toISOString();
    const targetFiles = citedEvidenceTargetFiles(input.result.evidenceRefs, evidenceRefs);
    await this.sessionManager.updateSession(input.sessionId, (draft) => {
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
    await this.sessionManager.addProgressEvent(input.sessionId, {
      id: `progress_${randomUUID()}`,
      sessionId: input.sessionId,
      stage: "completed",
      status: "completed",
      agentName: "ReasoningKernel",
      role: "Direct Conversation",
      taskTitle: input.decision.language === "arabic" ? "رد المزوّد" : "Provider response",
      summary: input.result.rationale,
      targetFiles,
      createdAt: now
    });
    await this.sessionManager.addMessage(input.sessionId, {
      role: "assistant",
      content: answer,
      providerRequestRefs: this.requireSession(input.sessionId).providerTelemetry?.providerRequestRefs
        ?? this.requireSession(input.sessionId).latestDecisionPipeline?.providerRequestRefs
        ?? []
    });
    await this.sessionManager.setRunSummary(input.sessionId, {
      status: "completed",
      summary: answer,
      filesChanged: [],
      appliedPatchIds: [],
      proposedPatchIds: [],
      commandResults: [],
      gates: [{
        name: "Pre-retrieval intent decision",
        status: "passed",
        notes: [input.decision.rationale]
      }],
      nextAction: "Send a project question, run request, or coding task when ready.",
      createdAt: now
    });
    return { sessionId: input.sessionId, status: this.requireSession(input.sessionId).status };
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export function citedEvidenceTargetFiles(
  citedEvidenceIds: string[] | undefined,
  evidenceRefs: ReasoningEvidenceRef[]
) {
  if (!citedEvidenceIds?.length || !evidenceRefs.length) return [];
  const cited = new Set(citedEvidenceIds);
  const paths = evidenceRefs
    .filter((ref) => cited.has(ref.id) && ref.path)
    .map((ref) => ref.path!)
    .map((targetPath) => targetPath.replaceAll("\\", "/").replace(/^\.\//, ""));
  return [...new Set(paths)].slice(0, 12);
}
