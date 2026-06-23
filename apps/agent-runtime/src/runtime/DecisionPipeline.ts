import type {
  AnswerVerificationReport,
  DecisionOutcome,
  DecisionPipelineState,
  ProviderAuthoredResult,
  QueryUnderstanding,
  ReasoningTurnTrace
} from "@hivo/protocol";
import type { ProjectUnderstandingAnswer } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { answerVerificationSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import {
  conversationUnderstandingFromTurnUnderstanding,
  type ConversationUnderstanding
} from "./ConversationUnderstanding.js";
import { invokeReasoningProviderStructured, understandAndDirectTurn, type ReasoningConversationContext, type ReasoningKernelState } from "./ReasoningKernel.js";

type AnswerVerificationModel = {
  verdict: "pass" | "fail" | "needs_more_evidence";
  rationale: string;
  supportedClaims: string[];
  unsupportedClaims: string[];
  missingFacts: string[];
  evidenceRefs: string[];
};

export async function beginDecisionPipeline(input: {
  message: string;
  provider: LlmProvider;
  routerProvider?: LlmProvider;
  conversationContext?: ReasoningConversationContext;
}): Promise<{ understanding: ConversationUnderstanding; state: DecisionPipelineState; reasoningState: ReasoningKernelState }> {
  const now = new Date().toISOString();
  const reasoning = await understandAndDirectTurn({
    provider: input.provider,
    routerProvider: input.routerProvider,
    message: input.message,
    conversationContext: input.conversationContext
  });
  const understanding = conversationUnderstandingFromTurnUnderstanding(reasoning.understanding);
  const query = createQueryUnderstanding(understanding);
  return {
    understanding,
    reasoningState: reasoning.state,
    state: {
      id: `decision_pipeline_${randomUUID()}`,
      version: 1,
      query,
      stages: [
        {
          stage: "route",
          status: "completed",
          source: "provider",
          detail: query.rationale,
          updatedAt: now
        },
        {
          stage: "reason",
          status: "completed",
          source: "provider",
          detail: `${reasoning.initialStep.kind}: ${reasoning.initialStep.rationale}`,
          updatedAt: now
        },
        ...(["retrieve", "curate", "compose", "verify", "decide"] as const).map((stage) => ({
          stage,
          status: "pending" as const,
          source: stage === "retrieve" ? "deterministic" as const : "hybrid" as const,
          detail: "Pending.",
          updatedAt: now
        }))
      ],
      callBudget: {
        maxProviderCalls: 12,
        maxRepairAttempts: 3,
        maxEscalationHops: 1
      },
      turnUnderstanding: reasoning.understanding,
      reasoningDirective: reasoning.directive,
      reasoningInitialStep: reasoning.initialStep,
      reasoningAttempts: reasoning.state.reasoningAttempts,
      repairAttempts: reasoning.state.repairAttempts,
      providerRequestRefs: [],
      finalResponseSource: "none",
      createdAt: now,
      updatedAt: now
    }
  };
}

export async function finalizeAnswerDecisionPipeline(input: {
  state: DecisionPipelineState;
  provider: LlmProvider;
  answerMarkdown: string;
  evidenceRefs: string[];
  validationErrors: string[];
  finalAnswerSource: "provider";
  confidence: "high" | "medium" | "low";
}): Promise<DecisionPipelineState> {
  const hardErrors = unique(input.validationErrors.filter(isHardValidationError));
  const repairableErrors = unique(input.validationErrors.filter((error) => !isHardValidationError(error)));
  let verificationModel: AnswerVerificationModel | undefined;
  let verifierSource: AnswerVerificationReport["verifierSource"] = "deterministic_only";

  if (!hardErrors.length) {
    try {
      const generated = await invokeReasoningProviderStructured<AnswerVerificationModel>(input.provider, {
        purpose: "verify",
        systemPrompt: [
          "You verify a project answer against an allow-list of evidence references.",
          "Return strict JSON only. Never approve an unknown reference.",
          "Do not add facts or rewrite the answer."
        ].join("\n"),
        userPrompt: [
          "Question:",
          input.state.query.cleanedRequest,
          "",
          "Answer:",
          input.answerMarkdown,
          "",
          "Allowed evidence refs:",
          ...input.evidenceRefs.map((ref) => `- ${ref}`),
          "",
          "Return { verdict, rationale, supportedClaims, unsupportedClaims, missingFacts, evidenceRefs }."
        ].join("\n")
      }, answerVerificationSchema);
      const validation = validateStructuredOutput(generated, answerVerificationSchema);
      if (!validation.valid) throw new Error(`answer_verifier_invalid: ${validation.errors.join("; ")}`);
      const allowed = new Set(input.evidenceRefs.map(normalizeRef));
      const unknown = generated.evidenceRefs.filter((ref) => !allowed.has(normalizeRef(ref)));
      if (unknown.length) hardErrors.push(...unknown.map((ref) => `Verifier cited unknown evidence ref: ${ref}`));
      verificationModel = generated;
      verifierSource = "provider_and_deterministic";
    } catch (error) {
      throw new Error(`answer_verifier_provider_failed: ${formatError(error)}`);
    }
  }

  const verification: AnswerVerificationReport = {
    status: hardErrors.length
      ? "rejected"
      : verificationModel?.verdict === "fail"
        ? "rejected"
        : verificationModel?.verdict === "needs_more_evidence"
          ? "unavailable"
          : "verified",
    providerVerdict: verificationModel?.verdict,
    supportedClaims: verificationModel?.supportedClaims ?? [],
    unsupportedClaims: verificationModel?.unsupportedClaims ?? [],
    missingFacts: verificationModel?.missingFacts ?? [],
    hardErrors: unique(hardErrors),
    repairableErrors,
    evidenceRefs: unique(input.evidenceRefs),
    verifierSource,
    createdAt: new Date().toISOString()
  };
  const outcome = decideAnswerOutcome({
    verification,
    confidence: input.confidence,
    hasEvidence: input.evidenceRefs.length > 0
  });
  const now = new Date().toISOString();
  return {
    ...input.state,
    stages: input.state.stages.map((record) => {
      if (record.stage === "retrieve") return { ...record, status: "completed", source: "deterministic", detail: `${input.evidenceRefs.length} final evidence ref(s).`, updatedAt: now };
      if (record.stage === "curate") return { ...record, status: input.evidenceRefs.length > 45 ? "completed" : "skipped", source: "hybrid", detail: input.evidenceRefs.length > 45 ? "Evidence was bounded before composition." : "Evidence set did not require an extra curation pass.", updatedAt: now };
      if (record.stage === "compose") return { ...record, status: "completed", source: input.finalAnswerSource === "provider" ? "provider" : "hybrid", detail: `Final source: ${input.finalAnswerSource}.`, updatedAt: now };
      if (record.stage === "verify") return { ...record, status: verification.status === "rejected" ? "blocked" : "completed", source: verifierSource === "provider_and_deterministic" ? "hybrid" : "deterministic", detail: `${verification.status}; ${verification.hardErrors.length} hard error(s), ${verification.repairableErrors.length} repairable error(s).`, updatedAt: now };
      if (record.stage === "decide") return { ...record, status: "completed", source: "deterministic", detail: `${outcome.action}: ${outcome.reason}`, updatedAt: now };
      return record;
    }),
    verification,
    outcome,
    updatedAt: now
  };
}

export function finalizeDirectConversationDecisionPipeline(
  state: DecisionPipelineState,
  result?: ProviderAuthoredResult
): DecisionPipelineState {
  const now = new Date().toISOString();
  const outcome: DecisionOutcome = {
    action: result?.decision ?? "ANSWER",
    reason: result?.rationale ?? "The provider classified and answered the direct conversation without workspace retrieval.",
    confidence: state.query.confidence,
    createdAt: now
  };
  return {
    ...state,
    stages: state.stages.map((record) => {
      if (record.stage === "route") return record;
      if (record.stage === "decide") return { ...record, status: "completed", source: "deterministic", detail: `ANSWER: ${outcome.reason}`, updatedAt: now };
      if (record.stage === "compose") return { ...record, status: "completed", source: "provider", detail: "Final response authored by provider.", updatedAt: now };
      return { ...record, status: "skipped", source: "deterministic", detail: "Direct conversation does not require workspace tools.", updatedAt: now };
    }),
    outcome,
    finalResponseSource: "provider",
    updatedAt: now
  };
}

export function finalizeAdaptiveReasoningDecisionPipeline(
  state: DecisionPipelineState,
  result: ProviderAuthoredResult,
  trace: ReasoningTurnTrace
): DecisionPipelineState {
  const now = new Date().toISOString();
  const usedTools = trace.toolResults.length > 0;
  const approvalRequired = trace.toolResults.some((tool) => tool.status === "approval_required");
  const failedTools = trace.toolResults.filter((tool) => tool.status === "failed" || tool.status === "blocked").length;
  const outcome: DecisionOutcome = {
    action: result.decision,
    reason: result.rationale,
    confidence: result.unknowns.length ? "medium" : "high",
    escalationTarget: approvalRequired ? "approval_gate" : result.decision === "ESCALATE" ? "provider_readonly_swarm" : undefined,
    createdAt: now
  };
  return {
    ...state,
    version: 2,
    stages: state.stages.map((record) => {
      if (record.stage === "retrieve") return { ...record, status: usedTools ? "completed" : "skipped", source: "deterministic", detail: `${trace.toolResults.length} provider-requested tool result(s).`, updatedAt: now };
      if (record.stage === "curate") return { ...record, status: trace.evidenceRefs.length ? "completed" : "skipped", source: "hybrid", detail: `${trace.evidenceRefs.length} evidence record(s).`, updatedAt: now };
      if (record.stage === "compose") return { ...record, status: "completed", source: "provider", detail: "Final result authored by provider.", updatedAt: now };
      if (record.stage === "verify") return { ...record, status: failedTools ? "blocked" : "completed", source: "hybrid", detail: `${failedTools} failed or blocked tool result(s).`, updatedAt: now };
      if (record.stage === "decide") return { ...record, status: "completed", source: "provider", detail: `${outcome.action}: ${outcome.reason}`, updatedAt: now };
      return record;
    }),
    outcome,
    reasoningTrace: trace,
    reasoningAttempts: trace.reasoningAttempts,
    repairAttempts: trace.repairAttempts,
    finalResponseSource: "provider",
    updatedAt: now
  };
}

export function applyProjectUnderstandingDecisionPipeline(
  state: DecisionPipelineState,
  understanding: ProjectUnderstandingAnswer
): DecisionPipelineState {
  if (understanding.mode !== "on") return state;
  const now = new Date().toISOString();
  const outcome: DecisionOutcome = {
    action: understanding.decision,
    reason: understanding.decisionReason,
    confidence: understanding.claimLedger.allMaterialClaimsSupported ? "high" : understanding.evidenceRefs.length ? "medium" : "low",
    escalationTarget: understanding.decision === "ESCALATE" ? "provider_readonly_swarm" : undefined,
    createdAt: now
  };
  return {
    ...state,
    stages: state.stages.map((record) => record.stage === "decide"
      ? { ...record, status: "completed", source: "hybrid", detail: `${outcome.action}: ${outcome.reason}`, updatedAt: now }
      : record),
    outcome,
    updatedAt: now
  };
}

function createQueryUnderstanding(understanding: ConversationUnderstanding): QueryUnderstanding {
  const route = understanding.routeDecision.route;
  const cleanedRequest = understanding.workspaceMessage || understanding.originalMessage;
  return {
    originalRequest: understanding.originalMessage,
    cleanedRequest,
    intentKind: understanding.intentDecision.kind,
    route,
    archetype: inferArchetype(cleanedRequest, route),
    requiredFacets: understanding.workspaceIntent?.requiredFacets ?? [],
    missingFacts: [],
    risk: route === "recursive_factory" ? "high" : understanding.intentDecision.kind === "workspace_action" ? "medium" : "low",
    confidence: understanding.intentDecision.confidence,
    rationale: understanding.intentDecision.rationale,
    source: "provider"
  };
}

function inferArchetype(message: string, route: QueryUnderstanding["route"]) {
  void message;
  if (route === "inspect_explain") return "project_question";
  if (route === "swarm_readonly") return "complex_readonly_question";
  if (route === "recursive_factory") return "large_workspace_action";
  if (route === "simple_run") return "bounded_workspace_action";
  return "direct_conversation";
}

function decideAnswerOutcome(input: {
  verification: AnswerVerificationReport;
  confidence: "high" | "medium" | "low";
  hasEvidence: boolean;
}): DecisionOutcome {
  const createdAt = new Date().toISOString();
  if (input.verification.hardErrors.length) {
    return { action: "REFUSE", reason: "Deterministic evidence safety checks rejected the answer.", confidence: "high", createdAt };
  }
  if (!input.hasEvidence) {
    return { action: "FOLLOW_UP", reason: "The answer needs more workspace evidence.", confidence: "low", createdAt };
  }
  return { action: "ANSWER", reason: "The final answer passed deterministic evidence guards.", confidence: input.confidence, createdAt };
}

function isHardValidationError(error: string) {
  return /unknown (?:hivo-file |evidence )?ref|unsafe path|path traversal|does not exist|non-production artifact|generated\/runtime|invalid structured|citation.*not allowed/i.test(error);
}

function normalizeRef(ref: string) {
  return ref.replaceAll("\\", "/").trim().toLowerCase();
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
