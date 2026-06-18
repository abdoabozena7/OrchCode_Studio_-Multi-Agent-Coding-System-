import {
  decideIntentBeforeRetrieval,
  normalizeProviderIntentDecision,
  prepareWorkspacePromptForUnderstanding,
  type IntentDecision,
  type ProviderIntentDecisionModel,
  type WorkspacePromptPreparation
} from "./IntentDecisionEngine.js";
import { routeConversation, type ConversationRouteDecision } from "./ConversationRouter.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { TurnUnderstanding } from "@hivo/protocol";
import { conversationIntentDecisionSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { inferWorkspaceIntent, type WorkspaceActionMode, type WorkspaceIntentUnderstanding } from "./WorkspaceReasoningPipeline.js";
import { invokeReasoningProviderStructured } from "./ReasoningKernel.js";

export type ConversationUnderstanding = {
  originalMessage: string;
  preparedPrompt: WorkspacePromptPreparation;
  workspaceMessage: string;
  intentDecision: IntentDecision;
  routeDecision: ConversationRouteDecision;
  workspaceIntent?: WorkspaceIntentUnderstanding;
  turnUnderstanding?: TurnUnderstanding;
};

export function conversationUnderstandingFromTurnUnderstanding(value: TurnUnderstanding): ConversationUnderstanding {
  const workspaceMessage = value.needsWorkspace ? value.cleanedRequest : "";
  return {
    originalMessage: value.originalRequest,
    preparedPrompt: {
      originalMessage: value.originalRequest,
      workspaceMessage: workspaceMessage || value.originalRequest,
      droppedPreamble: value.cleanedRequest !== value.originalRequest ? value.originalRequest : ""
    },
    workspaceMessage,
    intentDecision: {
      kind: value.intentKind,
      language: value.language,
      needsWorkspace: value.needsWorkspace,
      confidence: value.confidence,
      rationale: value.rationale
    },
    routeDecision: {
      route: value.route,
      confidence: value.confidence,
      language: value.language,
      normalizedPrompt: value.originalRequest,
      workspacePrompt: workspaceMessage || value.originalRequest,
      rationale: value.rationale
    },
    turnUnderstanding: value
  };
}

export function createConversationUnderstanding(message: string): ConversationUnderstanding {
  const routeDecision = routeConversation(message);
  const preparedPrompt = prepareWorkspacePromptForUnderstanding(message);
  const workspaceMessage = preparedPrompt.workspaceMessage || message;
  const intentDecision = decideIntentBeforeRetrieval(message);
  return {
    originalMessage: message,
    preparedPrompt,
    workspaceMessage,
    intentDecision,
    routeDecision,
    workspaceIntent: intentDecision.kind === "direct_conversation"
      ? undefined
      : alignWorkspaceIntentWithDecision(inferWorkspaceIntent(workspaceMessage), intentDecision)
  };
}

export async function createProviderConversationUnderstanding(provider: LlmProvider, message: string): Promise<ConversationUnderstanding> {
  const generated = await invokeReasoningProviderStructured<ProviderIntentDecisionModel>(provider, {
    purpose: "route",
    systemPrompt: [
      "You are the first intent gate for a local coding assistant.",
      "Classify the user's message before any workspace files are read.",
      "Return strict JSON only.",
      "Do not use hidden chain-of-thought. The rationale must be one short user-visible reason.",
      "Choose kind:",
      "- direct_conversation: social talk, thanks, acknowledgement, or a message that does not ask for code, files, project explanation, or running.",
      "- workspace_question: asks to explain, inspect, compare, trace, or judge project/code behavior.",
      "- workspace_action: asks to change, create, fix, implement, edit, or refactor project/code.",
      "- run_request: asks to run, start, launch, open, preview, test, or build the project.",
      "Set needsWorkspace false only for direct_conversation; otherwise true.",
      "Set workspaceMessage to the cleaned actionable request. Remove greetings and social preambles, but keep real task words.",
      "For direct_conversation, workspaceMessage should be an empty string."
    ].join("\n"),
    userPrompt: [
      "Classify this single user message before retrieval:",
      message,
      "",
      "Return JSON with exactly:",
      "{",
      "  \"kind\": \"direct_conversation|workspace_question|workspace_action|run_request\",",
      "  \"language\": \"arabic|english\",",
      "  \"needsWorkspace\": boolean,",
      "  \"confidence\": \"high|medium|low\",",
      "  \"rationale\": \"short visible reason\",",
      "  \"workspaceMessage\": \"cleaned actionable request or empty string\"",
      "}"
    ].join("\n")
  }, conversationIntentDecisionSchema);
  const validation = validateStructuredOutput(generated, conversationIntentDecisionSchema);
  if (!validation.valid) {
    throw new Error(`provider_intent_decision_invalid: ${validation.errors.join("; ")}`);
  }
  const normalized = normalizeProviderIntentDecision(generated, message);
  return {
    originalMessage: message,
    preparedPrompt: normalized.preparedPrompt,
    workspaceMessage: normalized.workspaceMessage,
    intentDecision: normalized.decision,
    routeDecision: alignRouteWithProviderDecision(routeConversation(normalized.workspaceMessage || message), normalized.decision),
    workspaceIntent: normalized.decision.kind === "direct_conversation"
      ? undefined
      : alignWorkspaceIntentWithDecision(inferWorkspaceIntent(normalized.workspaceMessage), normalized.decision)
  };
}

function alignRouteWithProviderDecision(route: ConversationRouteDecision, decision: IntentDecision): ConversationRouteDecision {
  if (decision.kind === "direct_conversation") return { ...route, route: "chat", confidence: decision.confidence, rationale: decision.rationale };
  if (decision.kind === "workspace_question") {
    return route.route === "swarm_readonly"
      ? { ...route, confidence: decision.confidence, rationale: decision.rationale }
      : { ...route, route: "inspect_explain", confidence: decision.confidence, rationale: decision.rationale };
  }
  if (decision.kind === "workspace_action") {
    return route.route === "recursive_factory"
      ? { ...route, confidence: decision.confidence, rationale: decision.rationale }
      : { ...route, route: "simple_run", confidence: decision.confidence, rationale: decision.rationale };
  }
  return { ...route, route: "simple_run", confidence: decision.confidence, rationale: decision.rationale };
}

function alignWorkspaceIntentWithDecision(intent: WorkspaceIntentUnderstanding, decision: IntentDecision): WorkspaceIntentUnderstanding {
  const actionMode = actionModeForDecision(decision);
  return actionMode ? { ...intent, actionMode } : intent;
}

function actionModeForDecision(decision: IntentDecision): WorkspaceActionMode | undefined {
  if (decision.kind === "workspace_question") return "answer_only";
  if (decision.kind === "workspace_action") return "edit";
  if (decision.kind === "run_request") return "run";
  return undefined;
}
