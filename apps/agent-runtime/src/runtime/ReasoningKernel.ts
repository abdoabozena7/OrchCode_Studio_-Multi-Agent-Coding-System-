import type {
  ProviderAuthoredResult,
  InitialReasoningDecision,
  ReasoningBudget,
  ReasoningDirective,
  ReasoningEvidenceRef,
  ReasoningProgress,
  ReasoningStage,
  ReasoningStageBudget,
  ReasoningStep,
  ReasoningToolResult,
  ReasoningTurnTrace,
  ReasoningVerificationResult,
  StructuredRepairError,
  TurnUnderstanding
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import {
  providerAuthoredResultSchema,
  answerVerificationSchema,
  evidenceCurationSchema,
  initialReasoningDecisionSchema,
  reasoningStepSchema,
  turnUnderstandingSchema,
} from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { EvidenceStore } from "./EvidenceStore.js";
import { ReasoningToolDispatcher, type ReasoningToolDispatcherOptions } from "./ReasoningToolDispatcher.js";

export function invokeReasoningProviderStructured<T>(provider: LlmProvider, request: LlmRequest, schema: unknown) {
  return provider.generateStructured<T>(request, schema);
}

export function invokeReasoningProviderText(provider: LlmProvider, request: LlmRequest) {
  return provider.generateText(request);
}

export function invokeReasoningProviderEmbedding(provider: LlmProvider, request: Parameters<NonNullable<LlmProvider["embed"]>>[0]) {
  if (!provider.embed) throw new Error("reasoning_kernel.embedding_unavailable");
  return provider.embed(request);
}

export const REASONING_BUDGETS: Record<ReasoningBudget["profile"], ReasoningBudget> = {
  conversation: { profile: "conversation", maxProviderCalls: 4, maxToolRounds: 0, maxRepairAttempts: 3, maxElapsedMs: 60_000 },
  project: { profile: "project", maxProviderCalls: 12, maxToolRounds: 4, maxRepairAttempts: 3, maxElapsedMs: 90_000 },
  deep_project: { profile: "deep_project", maxProviderCalls: 24, maxToolRounds: 8, maxRepairAttempts: 4, maxElapsedMs: 180_000 },
  action: { profile: "action", maxProviderCalls: 24, maxToolRounds: 8, maxRepairAttempts: 4, maxElapsedMs: 180_000 }
};

const REASONING_STAGE_BUDGETS: Record<ReasoningStage, Omit<ReasoningStageBudget, "stage">> = {
  route: { maxElapsedMs: 20_000, maxOutputTokens: 768, reserveMs: 3_000 },
  audit: { maxElapsedMs: 20_000, maxOutputTokens: 768, reserveMs: 3_000 },
  investigate: { maxElapsedMs: 60_000, maxOutputTokens: 1_024, reserveMs: 5_000 },
  reason: { maxElapsedMs: 35_000, maxOutputTokens: 1_024, reserveMs: 5_000 },
  curate: { maxElapsedMs: 25_000, maxOutputTokens: 1_024, reserveMs: 5_000 },
  compose: { maxElapsedMs: 35_000, maxOutputTokens: 2_048, reserveMs: 5_000 },
  verify: { maxElapsedMs: 35_000, maxOutputTokens: 1_024, reserveMs: 5_000 },
  repair: { maxElapsedMs: 30_000, maxOutputTokens: 1_024, reserveMs: 5_000 }
};

export const REASONING_MAX_PROVIDER_CALLS = REASONING_BUDGETS.deep_project.maxProviderCalls;
export const REASONING_MAX_REPAIR_ATTEMPTS = REASONING_BUDGETS.deep_project.maxRepairAttempts;
export const REASONING_MAX_ELAPSED_MS = REASONING_BUDGETS.deep_project.maxElapsedMs;

const REASONING_EVIDENCE_CONTEXT_MAX_CHARS = 8_000;
const REASONING_TOOL_RESULT_CONTEXT_MAX_CHARS = 4_000;
const REASONING_CURATION_INVENTORY_MAX_CHARS = 4_000;
const REASONING_REPAIR_EVIDENCE_CONTEXT_MAX_CHARS = 6_000;
const REASONING_REPAIR_TOOL_RESULT_CONTEXT_MAX_CHARS = 2_500;
const REASONING_COMPOSE_EVIDENCE_CONTEXT_MAX_CHARS = 8_000;
const REASONING_COMPOSE_TOOL_RESULT_CONTEXT_MAX_CHARS = 2_500;
const REASONING_COMPOSE_REPAIR_EVIDENCE_CONTEXT_MAX_CHARS = 6_000;
const REASONING_COMPOSE_REPAIR_TOOL_RESULT_CONTEXT_MAX_CHARS = 2_500;
const REASONING_VERIFY_EVIDENCE_CONTEXT_MAX_CHARS = 6_000;
const REASONING_DETERMINISTIC_CURATION_MIN_SELECTED_EVIDENCE = 8;
const REASONING_DIRECT_COMPOSE_MIN_INFORMATION_GAIN = 8;
const REASONING_DIRECT_COMPOSE_LOW_TIME_MS = 70_000;
export const REASONING_CONVERSATION_CONTEXT_MAX_MESSAGES = 8;
export const REASONING_CONVERSATION_CONTEXT_MAX_CHARS = 12_000;

export type ReasoningKernelState = {
  id: string;
  startedAt: number;
  providerCalls: number;
  reasoningAttempts: number;
  repairAttempts: number;
  validationRepairAttempts: number;
  toolRounds: number;
  budget: ReasoningBudget;
  steps: ReasoningStep[];
  toolResults: ReasoningToolResult[];
  verificationResults: ReasoningVerificationResult[];
  contextOmissions: ReasoningTurnTrace["contextOmissions"];
  progress: ReasoningProgress[];
  repairErrors: StructuredRepairError[];
  indexReadiness?: ReasoningTurnTrace["indexReadiness"];
  curatedEvidenceIds: string[];
  curatedEvidenceCount: number;
  curationProviderDisabled: boolean;
};

export class ReasoningKernelFailure extends Error {
  readonly trace: ReasoningTurnTrace;

  constructor(message: string, trace: ReasoningTurnTrace, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReasoningKernelFailure";
    this.trace = trace;
  }
}

export type ReasoningReadonlyDelegation = (
  request: import("@hivo/protocol").ReasoningToolRequest,
  budget: { remainingProviderCalls: number; remainingMs: number }
) => Promise<{ result: ReasoningToolResult; providerCallsUsed: number }>;

export type ReasoningConversationContext = {
  source: "same_session_messages";
  sessionId: string;
  currentMessage: string;
  maxMessages: number;
  maxChars: number;
  omittedMessageCount: number;
  truncatedMessageCount: number;
  totalOriginalChars: number;
  totalIncludedChars: number;
  createdAt: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    createdAt?: string;
    originalChars: number;
    truncated: boolean;
  }>;
};

function providerConversationContext(context: ReasoningConversationContext | undefined) {
  return context?.messages.length ? context : undefined;
}

export function createReasoningKernelState(budget: ReasoningBudget = REASONING_BUDGETS.conversation): ReasoningKernelState {
  return {
    id: `reasoning_turn_${randomUUID()}`,
    startedAt: Date.now(),
    providerCalls: 0,
    reasoningAttempts: 0,
    repairAttempts: 0,
    validationRepairAttempts: 0,
    toolRounds: 0,
    budget,
    steps: [],
    toolResults: [],
    verificationResults: [],
    contextOmissions: [],
    progress: [],
    repairErrors: [],
    curatedEvidenceIds: [],
    curatedEvidenceCount: 0,
    curationProviderDisabled: false
  };
}

export async function understandAndDirectTurn(input: {
  provider: LlmProvider;
  routerProvider?: LlmProvider;
  verifierProvider?: LlmProvider;
  message: string;
  conversationContext?: ReasoningConversationContext;
  state?: ReasoningKernelState;
}) {
  const state = input.state ?? createReasoningKernelState();
  const conversationContext = providerConversationContext(input.conversationContext);
  const initial = await generateWithProviderRepair<InitialReasoningDecision>({
    provider: input.routerProvider ?? input.provider,
    state,
    schema: initialReasoningDecisionSchema,
    request: {
      purpose: "route",
      reasoningStage: "route",
      systemPrompt: [
        "You are the semantic authority and first-step planner for a coding-system user turn.",
        "Understand the complete request, then choose the first adaptive reasoning step.",
        "Use tool_batch only when workspace evidence or an approval request is needed.",
        "For ordinary conversation, use final with a complete provider-authored result.",
        "If you do not know, use refuse or ask_user. Do not invent facts.",
        "Do not use hidden chain-of-thought. Return only concise decision rationale.",
        "Unknown and general questions are direct_conversation unless the user asks about the current workspace.",
        "Questions about this system, this repository, this project, current implementation behavior, files, code, or cross-file investigation are workspace questions even when they do not name a path.",
        "Deep read-only investigations spanning multiple files, modules, or relationships must use route=swarm_readonly and risk=high so the adaptive loop receives the deep-project budget.",
        "For conceptual, paraphrased, architecture, or cross-file workspace questions, prefer investigate_project; it returns ranked text/vector candidates, relationships, and source excerpts as facts in one round.",
        "Do not treat a greeting as the whole request when meaningful words follow it.",
        "Return strict JSON only."
      ].join("\n"),
      userPrompt: [
        "Understand this user turn and choose its first reasoning step:",
        input.message,
        "",
        "Return { understanding, step }.",
        "understanding must contain { originalRequest, cleanedRequest, language, intentKind, route, needsWorkspace, goal, ambiguities, requiredEvidence, risk, confidence, rationale }.",
        "step must contain { id, kind, rationale, toolRequests, result?, missingFacts, successCriteria, expectedInformationGain?, targetUnknowns?, stopCondition? }.",
        "Allowed understanding values:",
        "- language: arabic | english",
        "- intentKind: direct_conversation | workspace_question | workspace_action | run_request",
        "- route: chat | inspect_explain | simple_run | orchestrated_run | recursive_factory | swarm_readonly",
        "- risk: low | medium | high",
        "- confidence: high | medium | low",
        "- direct_conversation requires needsWorkspace=false; every other intentKind requires needsWorkspace=true",
        "Allowed step.kind values: tool_batch | final | ask_user | refuse | escalate.",
        "toolRequests, missingFacts, successCriteria, ambiguities, and requiredEvidence must always be JSON arrays.",
        "A tool_batch must contain at least one tool request. Each tool request needs id, kind, and reason.",
        "Allowed tool kinds: list_files | repository_search | read_file | inspect_manifest | investigate_project | semantic_search | follow_relationships | read_semantic_sources | run_command | propose_patch | analyze_project | delegate_readonly.",
        "repository_search, investigate_project, semantic_search, and delegate_readonly require query. read_file requires path or paths. follow_relationships and read_semantic_sources require relatedNodeIds. run_command requires command. propose_patch requires patch.",
        'Valid repository search example: { "id": "search_1", "kind": "repository_search", "reason": "Locate relevant implementation.", "query": "specific search terms" }.',
        'Valid semantic search example: { "id": "semantic_1", "kind": "semantic_search", "reason": "Find paraphrased concepts.", "query": "concept description" }.',
        'Valid file read example: { "id": "read_1", "kind": "read_file", "reason": "Inspect source.", "path": "relative/path.ts" }.',
        "Never request follow_relationships or read_semantic_sources until a prior tool result has supplied concrete relatedNodeIds.",
        "A final step may include result={ decision, answerMarkdown, claims, evidenceRefs, unknowns, rationale }; if omitted, a separate provider-authored compose step will produce it.",
        "Allowed result decisions: ANSWER | FOLLOW_UP | REFUSE | ESCALATE. claims, evidenceRefs, and unknowns must be arrays.",
        "Exact JSON shape (replace placeholder strings with the correct values):",
        "{",
        '  "understanding": {',
        '    "originalRequest": "string", "cleanedRequest": "string", "language": "<arabic|english>",',
        '    "intentKind": "<choose allowed intentKind>", "route": "<choose allowed route>", "needsWorkspace": "<boolean>",',
        '    "goal": "string", "ambiguities": [], "requiredEvidence": [],',
        '    "risk": "<low|medium|high>", "confidence": "<high|medium|low>", "rationale": "string"',
        "  },",
        '  "step": {',
        '    "id": "step_id", "kind": "<choose allowed step kind>", "rationale": "string", "toolRequests": [],',
        '    "missingFacts": [], "successCriteria": [],',
        '    "result": { "decision": "<ANSWER|FOLLOW_UP|REFUSE|ESCALATE>", "answerMarkdown": "string", "claims": [], "evidenceRefs": [], "unknowns": [], "rationale": "string" }',
        "  }",
        "}",
        "Do not copy placeholder values wrapped in angle brackets; replace every placeholder with one allowed value."
      ].join("\n"),
      context: conversationContext ? { conversationContext } : undefined
    }
  });
  const understanding = initial.understanding;
  state.reasoningAttempts += 1;
  state.budget = reasoningBudgetForUnderstanding(understanding);
  return { understanding, directive: stepToDirective(initial.step), initialStep: initial.step, state };
}

export async function runAdaptiveReasoningTurn(input: {
  provider: LlmProvider;
  routerProvider?: LlmProvider;
  verifierProvider?: LlmProvider;
  message: string;
  sessionId: string;
  tools?: ToolRegistry;
  dispatcher?: ReasoningToolDispatcher;
  evidenceStore?: EvidenceStore;
  onCommandRequest?: ReasoningToolDispatcherOptions["onCommandRequest"];
  onPatchProposal?: ReasoningToolDispatcherOptions["onPatchProposal"];
  embeddingModel?: string;
  delegateReadonly?: ReasoningReadonlyDelegation;
  conversationContext?: ReasoningConversationContext;
}): Promise<{
  understanding: TurnUnderstanding;
  result: ProviderAuthoredResult;
  trace: ReasoningTurnTrace;
}> {
  const reasoning = await understandAndDirectTurn({
    provider: input.provider,
    routerProvider: input.routerProvider,
    message: input.message,
    conversationContext: input.conversationContext
  });
  return continueAdaptiveReasoningTurn({ ...input, ...reasoning });
}

export async function continueAdaptiveReasoningTurn(input: {
  provider: LlmProvider;
  routerProvider?: LlmProvider;
  verifierProvider?: LlmProvider;
  sessionId: string;
  understanding: TurnUnderstanding;
  directive: ReasoningDirective;
  initialStep?: ReasoningStep;
  state: ReasoningKernelState;
  tools?: ToolRegistry;
  dispatcher?: ReasoningToolDispatcher;
  evidenceStore?: EvidenceStore;
  onCommandRequest?: ReasoningToolDispatcherOptions["onCommandRequest"];
  onPatchProposal?: ReasoningToolDispatcherOptions["onPatchProposal"];
  embeddingModel?: string;
  delegateReadonly?: ReasoningReadonlyDelegation;
  conversationContext?: ReasoningConversationContext;
}): Promise<{
  understanding: TurnUnderstanding;
  result: ProviderAuthoredResult;
  trace: ReasoningTurnTrace;
}> {
  const evidenceStore = input.evidenceStore ?? new EvidenceStore();
  const { understanding, directive, state } = input;
  const dispatcher = input.dispatcher ?? (input.tools ? new ReasoningToolDispatcher({
    sessionId: input.sessionId,
    tools: input.tools,
    evidenceStore,
    onCommandRequest: input.onCommandRequest,
    onPatchProposal: input.onPatchProposal,
    embeddingModel: input.embeddingModel,
    delegateReadonly: input.delegateReadonly
      ? async (request) => {
          const delegated = await input.delegateReadonly!(request, {
            remainingProviderCalls: Math.max(0, state.budget.maxProviderCalls - state.providerCalls - 1),
            remainingMs: Math.max(0, state.budget.maxElapsedMs - (Date.now() - state.startedAt))
          });
          state.providerCalls += delegated.providerCallsUsed;
          assertReasoningBudgetAfterDelegation(state);
          return delegated.result;
        }
      : undefined,
    embed: input.provider.embed
      ? async (inputs, model) => {
          assertReasoningBudget(state);
          state.providerCalls += 1;
          return (await invokeReasoningProviderEmbedding(input.provider, { inputs, model })).vectors;
        }
      : undefined
  }) : undefined);
  let currentStep = input.initialStep ?? directiveToStep(directive);
  const executedToolBatches = new Set<string>();
  const duplicateToolBatches = new Map<string, number>();

  try {
    if (!understanding.needsWorkspace && understanding.confidence !== "high") {
      const auditedUnderstanding = await auditTurnUnderstanding({
        provider: input.routerProvider ?? input.verifierProvider ?? input.provider,
        understanding,
        state,
        conversationContext: input.conversationContext
      });
      if (auditedUnderstanding.needsWorkspace) {
        recordRepairError(state, "wrong_route", "audit", "Independent provider route audit reclassified the request as requiring workspace evidence.");
        state.steps.push(currentStep);
        Object.assign(understanding, auditedUnderstanding);
        // Provider disagreement about the workspace boundary is an operational
        // uncertainty signal, so preserve enough time for evidence collection.
        state.budget = REASONING_BUDGETS.deep_project;
        currentStep = await requestNextStep({
          provider: input.verifierProvider ?? input.provider,
          understanding,
          state,
          evidenceStore,
          conversationContext: input.conversationContext,
          validationErrors: ["Independent provider route audit reclassified the request as requiring workspace evidence. Choose the first safe read-tool batch."]
        });
      }
    }
    while (true) {
      state.steps.push(currentStep);
      if (currentStep.kind !== "tool_batch") {
        let result = currentStep.result;
        let resultCameFromCompose = false;
        if (!result) {
          const evidenceContext = composeEvidenceContext({
            state,
            evidenceStore
          });
          recordContextOmission(state, "compose", evidenceContext);
          result = await composeProviderAuthoredResult({
            provider: input.provider,
            understanding,
            directive: stepToDirective(currentStep),
            state,
            toolResults: state.toolResults,
            evidence: evidenceContext.selected,
            evidenceOmitted: evidenceContext.omitted,
            evidenceRefs: evidenceContext.selectedEvidenceIds,
            conversationContext: input.conversationContext,
            toolResultMaxChars: REASONING_COMPOSE_TOOL_RESULT_CONTEXT_MAX_CHARS
          });
          resultCameFromCompose = true;
        }
        let providerResultValidationErrors = validateProviderResult(result, understanding, evidenceStore.all());
        let validationErrors = [...providerResultValidationErrors];
        if (input.tools) validationErrors.push(...evidenceStore.verifyWorkspaceFiles(input.tools));
        let verifierRejected = false;
        while (resultCameFromCompose && providerResultValidationErrors.length > 0) {
          recordValidationRepairAttempt(state, validationErrors);
          const evidenceContext = composeRepairEvidenceContext({
            state,
            evidenceStore
          });
          recordContextOmission(state, "compose", evidenceContext);
          result = await composeProviderAuthoredResult({
            provider: input.provider,
            understanding,
            directive: stepToDirective(currentStep),
            state,
            toolResults: state.toolResults,
            evidence: evidenceContext.selected,
            evidenceOmitted: evidenceContext.omitted,
            evidenceRefs: evidenceContext.selectedEvidenceIds,
            validationErrors,
            conversationContext: input.conversationContext,
            toolResultMaxChars: REASONING_COMPOSE_REPAIR_TOOL_RESULT_CONTEXT_MAX_CHARS
          });
          providerResultValidationErrors = validateProviderResult(result, understanding, evidenceStore.all());
          validationErrors = [...providerResultValidationErrors];
          if (input.tools) validationErrors.push(...evidenceStore.verifyWorkspaceFiles(input.tools));
        }
        if (!validationErrors.length && result.decision === "ANSWER") {
          const verification = await verifyProviderAuthoredResult({
            provider: input.verifierProvider ?? input.provider,
            understanding,
            result,
            state,
            evidenceStore,
            conversationContext: input.conversationContext
          });
        state.verificationResults.push(verification);
        if (verification.workspaceEvidenceRequired && !understanding.needsWorkspace) {
          applyVerifierWorkspaceReclassification(understanding, state, verification);
          validationErrors.push(
            `Verifier reclassified this as a workspace question requiring ${verification.recommendedBudgetProfile ?? "project"} evidence.`
          );
        }
        if (verification.verdict !== "pass") {
            verifierRejected = true;
            applyVerifierEvidenceFollowupBudget(understanding, state, verification);
            validationErrors.push(
              ...verification.unsupportedClaims.map((claim) => `Verifier rejected unsupported claim: ${claim}`),
              ...verification.missingFacts.map((fact) => `Verifier needs more evidence: ${fact}`),
              `Verifier verdict: ${verification.verdict}. ${verification.rationale}`
            );
          }
        }
      if (!validationErrors.length) {
        return { understanding, result, trace: createTrace(understanding, state, evidenceStore.all()) };
      }
      if (verifierRejected && evidenceStore.ids().length > 0 && shouldRepairVerifierFailureWithCompose(currentStep, resultCameFromCompose)) {
        recordValidationRepairAttempt(state, validationErrors);
        const evidenceContext = composeRepairEvidenceContext({
          state,
          evidenceStore
        });
        recordContextOmission(state, "compose", evidenceContext);
        const repairStep = finalStepFromCurrentEvidence(
          currentStep,
          "The verifier rejected unsupported or insufficiently evidenced claims. Rewrite the final result from the current evidence only, remove unsupported claims, cite only supplied evidence ids, and state remaining unknowns explicitly."
        );
        const repairedResult = await composeProviderAuthoredResult({
          provider: input.provider,
          understanding,
          directive: stepToDirective(repairStep),
          state,
          toolResults: state.toolResults,
          evidence: evidenceContext.selected,
          evidenceOmitted: evidenceContext.omitted,
          evidenceRefs: evidenceContext.selectedEvidenceIds,
          validationErrors,
          conversationContext: input.conversationContext,
          toolResultMaxChars: REASONING_COMPOSE_REPAIR_TOOL_RESULT_CONTEXT_MAX_CHARS
        });
        currentStep = { ...repairStep, result: repairedResult };
        continue;
      }
      recordValidationRepairAttempt(state, validationErrors);
      currentStep = await requestNextStep({
          provider: input.provider,
          understanding,
          state,
          evidenceStore,
          conversationContext: input.conversationContext,
          validationErrors
        });
        continue;
      }

      if (!dispatcher) {
        throw new Error("reasoning_kernel.workspace_tools_required");
      }
      const batchFingerprint = toolBatchFingerprint(currentStep);
      if (executedToolBatches.has(batchFingerprint)) {
        const duplicateCount = (duplicateToolBatches.get(batchFingerprint) ?? 0) + 1;
        duplicateToolBatches.set(batchFingerprint, duplicateCount);
        if (duplicateCount > 1 && evidenceStore.ids().length > 0) {
          recordRepairError(
            state,
            "stagnation",
            "repair",
            "The provider repeated an identical tool batch after repair; composing from the current evidence instead."
          );
          currentStep = finalStepFromCurrentEvidence(
            currentStep,
            "The requested tool batch was already executed and then repeated. Compose from the current evidence, cite only supplied evidence ids, and state any remaining unknowns explicitly."
          );
          continue;
        }
        if (state.repairAttempts >= state.budget.maxRepairAttempts) {
          if (evidenceStore.ids().length > 0) {
            recordRepairError(
              state,
              "stagnation",
              "repair",
              "The provider exhausted duplicate-tool repair attempts; composing from the current evidence instead."
            );
            currentStep = finalStepFromCurrentEvidence(
              currentStep,
              "Duplicate tool repair budget is exhausted. Compose from the current evidence, cite only supplied evidence ids, and state any remaining unknowns explicitly."
            );
            continue;
          }
          throw new Error("reasoning_kernel.stagnant_tool_loop");
        }
        state.repairAttempts += 1;
        recordRepairError(state, "stagnation", "repair", "The provider repeated an identical tool batch.");
        currentStep = await requestNextStep({
          provider: input.verifierProvider ?? input.provider,
          understanding,
          state,
          evidenceStore,
          conversationContext: input.conversationContext,
          validationErrors: [
            "The requested tool batch is identical to a batch that already ran. Choose different retrieval tools, read specific discovered sources, narrow the claim, or explicitly state what remains unknown."
          ]
        });
        continue;
      }
      if (state.toolRounds >= state.budget.maxToolRounds) {
        if (evidenceStore.ids().length > 0) {
          recordRepairError(
            state,
            "stagnation",
            "repair",
            "Tool round budget reached; composing from the current evidence instead of failing the turn."
          );
          currentStep = finalStepFromCurrentEvidence(
            currentStep,
            "The tool round budget is reached. Compose from the current evidence, cite only supplied evidence ids, and state any remaining unknowns explicitly."
          );
          continue;
        }
        throw new Error("reasoning_kernel.tool_round_budget_exhausted");
      }
      executedToolBatches.add(batchFingerprint);
      state.toolRounds += 1;
      const evidenceBefore = evidenceSignatures(evidenceStore.all());
      const results = await dispatcher.executeBatch(currentStep.toolRequests);
      state.toolResults.push(...results);
      updateIndexReadiness(state, results);
      const progress = recordToolProgress(state, evidenceBefore, evidenceStore.all());
      if (shouldComposeDirectlyAfterToolBatch(currentStep, progress, state, evidenceStore)) {
        currentStep = finalStepFromCurrentEvidence(
          currentStep,
          "The provider-requested evidence batch produced enough workspace evidence. Compose from the current evidence now, cite only supplied evidence ids, and state any remaining unknowns explicitly."
        );
        continue;
      }
      const consecutiveStagnantRounds = trailingStagnantRounds(state.progress);
      if (progress.stagnant && consecutiveStagnantRounds >= 3) {
        recordRepairError(state, "stagnation", "investigate", "Three consecutive tool rounds produced no new facts.");
        throw new Error("reasoning_kernel.stagnant_tool_loop");
      }
      if (progress.stagnant && consecutiveStagnantRounds >= 2) {
        if (state.repairAttempts >= state.budget.maxRepairAttempts) throw new Error("reasoning_kernel.stagnant_tool_loop");
        state.repairAttempts += 1;
        recordRepairError(state, "stagnation", "repair", "Two consecutive tool rounds produced no new facts.");
        currentStep = await requestNextStep({
          provider: input.verifierProvider ?? input.provider,
          understanding,
          state,
          evidenceStore,
          conversationContext: input.conversationContext,
          validationErrors: [
            "Two consecutive tool rounds produced no new evidence, files, or relationships. Choose a materially different investigation, narrow the claim, or explicitly state what remains unknown."
          ]
        });
        continue;
      }
      currentStep = await requestNextStep({
        provider: input.provider,
        understanding,
        state,
        evidenceStore,
        conversationContext: input.conversationContext
      });
    }
  } catch (error) {
    if (error instanceof ReasoningKernelFailure) throw error;
    const message = formatError(error);
    throw new ReasoningKernelFailure(
      message,
      createTrace(understanding, state, evidenceStore.all(), message),
      error instanceof Error ? { cause: error } : undefined
    );
  }
}

async function auditTurnUnderstanding(input: {
  provider: LlmProvider;
  understanding: TurnUnderstanding;
  state: ReasoningKernelState;
  conversationContext?: ReasoningConversationContext;
}) {
  const audited = await generateWithProviderRepair<TurnUnderstanding>({
    provider: input.provider,
    state: input.state,
    schema: turnUnderstandingSchema,
    request: {
      purpose: "route",
      reasoningStage: "audit",
      systemPrompt: [
        "You are an independent workspace-boundary auditor for a coding-system turn.",
        "Classify the original request only. Do not answer it and do not defer to the prior classification.",
        "Set needsWorkspace=true whenever a correct answer requires inspecting the current system, repository, project, implementation, files, runtime behavior, or cross-file flow.",
        "A request may require workspace evidence even if it does not name a file or use an exact code identifier.",
        "Use direct_conversation only when the answer is genuinely independent of the current workspace.",
        "Deep cross-file or architecture investigations use route=swarm_readonly and risk=high.",
        "Return strict JSON only.",
        'Return exactly { "originalRequest": "string", "cleanedRequest": "string", "language": "arabic|english", "intentKind": "direct_conversation|workspace_question|workspace_action|run_request", "route": "chat|inspect_explain|simple_run|orchestrated_run|recursive_factory|swarm_readonly", "needsWorkspace": true|false, "goal": "string", "ambiguities": [], "requiredEvidence": [], "risk": "low|medium|high", "confidence": "high|medium|low", "rationale": "string" }.'
      ].join("\n"),
      userPrompt: input.understanding.originalRequest,
      context: {
        priorClassification: input.understanding,
        conversationContext: providerConversationContext(input.conversationContext)
      }
    }
  });
  input.state.reasoningAttempts += 1;
  return audited;
}

export async function composeProviderAuthoredResult(input: {
  provider: LlmProvider;
  understanding: TurnUnderstanding;
  directive: ReasoningDirective;
  state: ReasoningKernelState;
  toolResults?: ReasoningToolResult[];
  evidence?: ReasoningEvidenceRef[];
  evidenceOmitted?: number;
  evidenceRefs?: string[];
  validationErrors?: string[];
  toolResultMaxChars?: number;
  conversationContext?: ReasoningConversationContext;
}): Promise<ProviderAuthoredResult> {
  const request: LlmRequest = {
      purpose: "compose",
      reasoningStage: "compose",
      systemPrompt: [
        "Write the final assistant result for the user.",
        "The result must be authored by you, including follow-up, refusal, escalation, or an explicit statement that you do not know.",
        "Use the user's language. Do not claim that local code answered the question.",
        "Use only supplied evidence refs for workspace claims.",
        "For workspace_question answers, be detailed by default: explain the short summary, project goal, distinctive implementation choices, important code evidence, and confidence limits when evidence is incomplete.",
        "Write naturally and helpfully; do not compress project explanations into generic bullet points.",
        "When supplied evidence contains file paths and line numbers, cite those facts with markdown hivo-file links such as [README.md:1](hivo-file:README.md:1).",
        "If you cannot reliably form a hivo-file link, still include the relevant evidence ids in evidenceRefs; the runtime will attach file links deterministically.",
        "Do not expose hidden chain-of-thought. Return strict JSON only.",
        'Return exactly { "decision": "ANSWER|FOLLOW_UP|REFUSE|ESCALATE", "answerMarkdown": "string", "claims": [], "evidenceRefs": [], "unknowns": [], "rationale": "string" }.'
      ].join("\n"),
      maxOutputTokens: 3_072,
      userPrompt: input.understanding.originalRequest,
      context: {
        understanding: input.understanding,
        directive: input.directive,
        toolResults: compactToolResults(input.toolResults ?? [], input.toolResultMaxChars),
        evidence: input.evidence ?? [],
        evidenceOmitted: input.evidenceOmitted ?? 0,
        allowedEvidenceRefs: input.evidenceRefs ?? [],
        validationErrors: input.validationErrors ?? [],
        conversationContext: providerConversationContext(input.conversationContext)
      }
    };
  try {
    return await generateWithProviderRepair<ProviderAuthoredResult>({
      provider: input.provider,
      state: input.state,
      schema: providerAuthoredResultSchema,
      request,
      maxOperationalRepairAttempts: 1
    });
  } catch (error) {
    if (input.directive.action !== "answer" || !input.evidenceRefs?.length) throw error;
    recordRepairError(input.state, "provider_failure", "compose", `Structured compose failed; requesting provider-authored text result. ${formatError(error)}`);
    const answerMarkdown = await generateProviderTextWithBudget({
      provider: input.provider,
      state: input.state,
      request: {
        purpose: "compose",
        reasoningStage: "compose",
        systemPrompt: [
          "Write only the final assistant answer text for the user.",
          "Use the user's language.",
          "Use only supplied evidence for workspace claims.",
          "For workspace_question answers, be detailed by default: include a short summary, the project goal, what makes it distinctive, important code evidence, and confidence limits when needed.",
          "Use markdown hivo-file links for file and line evidence when possible; otherwise include relevant evidence ids so deterministic file links can be attached.",
          "If evidence is insufficient, say what is unknown instead of inventing details.",
          "Do not return JSON and do not expose hidden chain-of-thought."
        ].join("\n"),
        maxOutputTokens: 2_048,
        userPrompt: input.understanding.originalRequest,
        context: {
          understanding: input.understanding,
          directive: input.directive,
          evidence: input.evidence ?? [],
          evidenceOmitted: input.evidenceOmitted ?? 0,
          allowedEvidenceRefs: input.evidenceRefs,
          validationErrors: input.validationErrors ?? [],
          conversationContext: providerConversationContext(input.conversationContext)
        }
      }
    });
    return {
      decision: "ANSWER",
      answerMarkdown: answerMarkdown.trim(),
      claims: [],
      evidenceRefs: input.evidenceRefs,
      unknowns: [],
      rationale: "Provider-authored text compose result after structured JSON compose failed."
    };
  }
}

async function requestNextStep(input: {
  provider: LlmProvider;
  understanding: TurnUnderstanding;
  state: ReasoningKernelState;
  evidenceStore: EvidenceStore;
  validationErrors?: string[];
  conversationContext?: ReasoningConversationContext;
}) {
  const isRepair = Boolean(input.validationErrors?.length);
  const evidenceContext = isRepair ? repairEvidenceContext(input) : await curatedEvidenceContext(input);
  recordContextOmission(input.state, "reason", evidenceContext);
  const step = await generateWithProviderRepair<ReasoningStep>({
    provider: input.provider,
    state: input.state,
    schema: reasoningStepSchema,
    request: {
      purpose: input.validationErrors?.length ? "repair" : "reason",
      reasoningStage: input.validationErrors?.length ? "repair" : "reason",
      systemPrompt: [
        "You control the next step of an adaptive coding-system reasoning loop.",
        "Choose tool_batch when more workspace evidence or an approval request is required.",
        "Choose final only when you can provide the provider-authored result.",
        "For workspace claims, cite only evidence ids supplied in allowedEvidenceIds.",
        "A blocked, unavailable, or approval_required tool result is evidence about the current state; decide whether to use another tool, ask the user, refuse, or escalate.",
        "Repository facts are discoverable, not user blockers. Do not ask the user to refresh an index or provide facts that safe workspace tools can discover.",
        "If semantic_search is unavailable or a search has no matches, try list_files, analyze_project, inspect_manifest, broader repository_search terms, or read_file before FOLLOW_UP.",
        "For conceptual, paraphrased, architecture, or cross-file questions, prefer investigate_project because it retrieves candidates, relationships, and bounded source excerpts in one fact-only round.",
        "Do not use list_files plus inspect_manifest as the only investigation batch for an implementation-flow question; those tools discover candidates but do not establish the flow.",
        "After list_files or inspect_manifest, continue with semantic_search, repository_search, or read_file before composing an implementation answer.",
        "Every repository_search, investigate_project, semantic_search, or delegate_readonly request must include query. Every read_file request must include path or paths. Relationship tools require relatedNodeIds.",
        "For tool_batch, state expectedInformationGain, targetUnknowns, and a stopCondition so progress can be audited.",
        "Use ask_user only for genuine user-intent ambiguity that repository tools cannot resolve.",
        "Do not expose hidden chain-of-thought. Return a concise rationale and strict JSON only.",
        'Return exactly { "id": "string", "kind": "tool_batch|final|ask_user|refuse|escalate", "rationale": "string", "toolRequests": [], "result": optional-provider-result, "missingFacts": [], "successCriteria": [], "expectedInformationGain": "optional string", "targetUnknowns": [], "stopCondition": "optional string" }.',
        "A tool_batch requires at least one tool request. A final may omit result; when it does, the kernel will ask the provider to compose the complete result next."
      ].join("\n"),
      userPrompt: [
        "Choose the next reasoning step for the original request.",
        "Return { id, kind, rationale, toolRequests, result?, missingFacts, successCriteria }. Omit result when you want the provider compose stage to author the final response."
      ].join("\n"),
      context: {
        understanding: input.understanding,
        previousSteps: compactReasoningSteps(input.state.steps),
        toolResults: compactToolResults(input.state.toolResults, isRepair ? REASONING_REPAIR_TOOL_RESULT_CONTEXT_MAX_CHARS : undefined),
        evidence: evidenceContext.selected,
        evidenceOmitted: evidenceContext.omitted,
        allowedEvidenceIds: evidenceContext.selectedEvidenceIds,
        totalEvidenceIds: input.evidenceStore.ids().length,
        validationErrors: input.validationErrors ?? [],
        progress: input.state.progress.slice(-6),
        repairErrors: input.state.repairErrors.slice(-6),
        conversationContext: providerConversationContext(input.conversationContext),
        remainingBudget: {
          providerCalls: input.state.budget.maxProviderCalls - input.state.providerCalls,
          toolRounds: input.state.budget.maxToolRounds - input.state.toolRounds,
          elapsedMs: input.state.budget.maxElapsedMs - (Date.now() - input.state.startedAt)
        }
      }
    }
  });
  input.state.reasoningAttempts += 1;
  return step;
}

async function verifyProviderAuthoredResult(input: {
  provider: LlmProvider;
  understanding: TurnUnderstanding;
  result: ProviderAuthoredResult;
  state: ReasoningKernelState;
  evidenceStore: EvidenceStore;
  conversationContext?: ReasoningConversationContext;
}): Promise<ReasoningVerificationResult> {
  const evidence = input.evidenceStore.context(REASONING_VERIFY_EVIDENCE_CONTEXT_MAX_CHARS, input.result.evidenceRefs);
  recordContextOmission(input.state, "verify", evidence);
  const request: LlmRequest = {
      purpose: "verify",
      reasoningStage: "verify",
      systemPrompt: [
        "You are an independent answer verifier with no access to the author's prior reasoning.",
        "When needsWorkspace=true, judge whether every material workspace claim is supported by the supplied evidence excerpts.",
        "When needsWorkspace=false, evidence is not required; judge relevance, internal consistency, and whether the answer invents workspace-specific facts.",
        "Independently classify whether the original request requires current-workspace evidence, even if the author classified it as ordinary conversation.",
        "Set workspaceEvidenceRequired=true whenever answering correctly requires inspecting this system, repository, project, current implementation, files, code, or cross-file behavior.",
        "When workspaceEvidenceRequired=true and evidence is absent or insufficient, return needs_more_evidence and recommend project or deep_project budget.",
        "Never approve a workspace claim based only on plausibility.",
        "Return compact JSON only. Do not quote or restate long evidence excerpts.",
        "Return strict JSON only and do not rewrite the answer.",
        'Return exactly { "verdict": "pass|fail|needs_more_evidence", "rationale": "string", "workspaceEvidenceRequired": true|false, "recommendedBudgetProfile": "conversation|project|deep_project|action", "supportedClaims": [], "unsupportedClaims": [], "missingFacts": [], "evidenceRefs": [] }.'
      ].join("\n"),
      maxOutputTokens: 512,
      userPrompt: "Verify the provider-authored result against the supplied evidence.",
      context: {
        request: input.understanding.originalRequest,
        needsWorkspace: input.understanding.needsWorkspace,
        result: input.result,
        evidence: evidence.selected,
        evidenceOmitted: evidence.omitted,
        allowedEvidenceIds: evidence.selectedEvidenceIds,
        conversationContext: providerConversationContext(input.conversationContext)
      }
    };
  let generated: Omit<ReasoningVerificationResult, "createdAt">;
  try {
    generated = await generateWithProviderRepair<Omit<ReasoningVerificationResult, "createdAt">>({
      provider: input.provider,
      state: input.state,
      schema: answerVerificationSchema,
      request,
      maxOperationalRepairAttempts: 0
    });
  } catch (error) {
    recordRepairError(input.state, "provider_failure", "verify", `Structured verification failed; requesting provider-authored text verdict. ${formatError(error)}`);
    generated = await verifyProviderAuthoredResultText({
      provider: input.provider,
      understanding: input.understanding,
      result: input.result,
      state: input.state,
      evidence: evidence.selected,
      evidenceOmitted: evidence.omitted,
      allowedEvidenceIds: evidence.selectedEvidenceIds,
      conversationContext: input.conversationContext
    });
  }
  const allowed = new Set(input.evidenceStore.ids());
  const unknown = generated.evidenceRefs.filter((ref) => !allowed.has(ref));
  if (unknown.length) {
    return {
      ...generated,
      verdict: "fail",
      unsupportedClaims: [...generated.unsupportedClaims, ...unknown.map((ref) => `Verifier cited unknown evidence id ${ref}`)],
      createdAt: new Date().toISOString()
    };
  }
  return { ...generated, createdAt: new Date().toISOString() };
}

async function verifyProviderAuthoredResultText(input: {
  provider: LlmProvider;
  understanding: TurnUnderstanding;
  result: ProviderAuthoredResult;
  state: ReasoningKernelState;
  evidence: ReasoningEvidenceRef[];
  evidenceOmitted: number;
  allowedEvidenceIds: string[];
  conversationContext?: ReasoningConversationContext;
}): Promise<Omit<ReasoningVerificationResult, "createdAt">> {
  const text = await generateProviderTextWithBudget({
    provider: input.provider,
    state: input.state,
    request: {
      purpose: "verify",
      reasoningStage: "verify",
      systemPrompt: [
        "You are an independent answer verifier.",
        "Return a compact text verdict, not JSON.",
        "The first non-empty line must be exactly one of: PASS, FAIL, NEEDS_MORE_EVIDENCE.",
        "Then provide one short rationale line.",
        "Never approve workspace claims unless supplied evidence supports them."
      ].join("\n"),
      maxOutputTokens: 256,
      userPrompt: "Verify the answer against the supplied evidence.",
      context: {
        request: input.understanding.originalRequest,
        needsWorkspace: input.understanding.needsWorkspace,
        result: input.result,
        evidence: input.evidence,
        evidenceOmitted: input.evidenceOmitted,
        allowedEvidenceIds: input.allowedEvidenceIds,
        conversationContext: providerConversationContext(input.conversationContext)
      }
    }
  });
  const verdict = parseTextVerificationVerdict(text);
  const citedEvidence = input.result.evidenceRefs.filter((id) => input.allowedEvidenceIds.includes(id));
  if (verdict === "pass") {
    return {
      verdict: "pass",
      rationale: text.trim().slice(0, 700) || "Provider text verifier passed the answer.",
      workspaceEvidenceRequired: input.understanding.needsWorkspace,
      recommendedBudgetProfile: input.understanding.needsWorkspace ? "project" : "conversation",
      supportedClaims: providerResultClaimTexts(input.result),
      unsupportedClaims: [],
      missingFacts: [],
      evidenceRefs: citedEvidence
    };
  }
  return {
    verdict,
    rationale: text.trim().slice(0, 700) || "Provider text verifier did not pass the answer.",
    workspaceEvidenceRequired: input.understanding.needsWorkspace,
    recommendedBudgetProfile: input.understanding.needsWorkspace ? "deep_project" : "conversation",
    supportedClaims: [],
    unsupportedClaims: verdict === "fail" ? ["Provider text verifier rejected one or more answer claims."] : [],
    missingFacts: verdict === "needs_more_evidence" ? ["Provider text verifier requested more evidence."] : [],
    evidenceRefs: citedEvidence
  };
}

function parseTextVerificationVerdict(text: string): ReasoningVerificationResult["verdict"] {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (/^PASS\b/i.test(firstLine)) return "pass";
  if (/^NEEDS_MORE_EVIDENCE\b/i.test(firstLine)) return "needs_more_evidence";
  if (/^FAIL\b/i.test(firstLine)) return "fail";
  if (/\bPASS\b/i.test(text) && !/\bFAIL|NEEDS_MORE_EVIDENCE\b/i.test(text)) return "pass";
  if (/\bNEEDS_MORE_EVIDENCE\b/i.test(text)) return "needs_more_evidence";
  return "fail";
}

function providerResultClaimTexts(result: ProviderAuthoredResult) {
  return result.claims.map((claim) => typeof claim === "string" ? claim : claim.text);
}

async function generateWithProviderRepair<T>(input: {
  provider: LlmProvider;
  state: ReasoningKernelState;
  request: LlmRequest;
  schema: unknown;
  maxOperationalRepairAttempts?: number;
}): Promise<T> {
  let request = input.request;
  let lastErrors: string[] = [];
  let lastProviderError: unknown;
  const maxRepairAttempts = input.maxOperationalRepairAttempts ?? input.state.budget.maxRepairAttempts;
  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    assertReasoningBudget(input.state);
    input.state.providerCalls += 1;
    let generated: T;
    try {
      const stage = request.reasoningStage ?? stageForPurpose(request.purpose);
      const stageBudget = reasoningStageBudget(stage);
      const remainingMs = input.state.budget.maxElapsedMs - (Date.now() - input.state.startedAt);
      const allowedMs = Math.min(stageBudget.maxElapsedMs, remainingMs - stageBudget.reserveMs);
      if (allowedMs <= 0) throw new Error(`reasoning_kernel.${stage}_stage_budget_exhausted`);
      generated = await invokeReasoningProviderStructured<T>(input.provider, {
        ...request,
        reasoningStage: stage,
        timeoutMs: allowedMs,
        maxOutputTokens: request.maxOutputTokens ?? stageBudget.maxOutputTokens
      }, input.schema);
    } catch (error) {
      lastProviderError = error;
      recordRepairError(input.state, "provider_failure", request.reasoningStage ?? stageForPurpose(request.purpose), formatError(error));
      if (isContextTooLargeError(error)) break;
      if (attempt === maxRepairAttempts) break;
      input.state.repairAttempts += 1;
      request = {
        purpose: "repair",
        reasoningStage: "repair",
        systemPrompt: [
          input.request.systemPrompt,
          "",
          "Retry the failed reasoning request.",
          "Return only the requested structured object.",
          "Use the operational error to correct the schema without changing the task.",
          "Do not use hidden chain-of-thought."
        ].join("\n"),
        userPrompt: input.request.userPrompt,
        context: {
          originalRequest: compactLlmRequestForRepair(input.request),
          priorOperationalError: formatError(error)
        }
      };
      continue;
    }
    const validation = validateStructuredOutput(generated, input.schema);
    if (validation.valid) return generated;
    lastErrors = validation.errors;
    recordRepairError(input.state, "malformed_result", request.reasoningStage ?? stageForPurpose(request.purpose), validation.errors.join("; "));
    if (attempt === maxRepairAttempts) break;
    input.state.repairAttempts += 1;
    request = {
      purpose: "repair",
      reasoningStage: "repair",
      systemPrompt: [
          input.request.systemPrompt,
          "",
          "Repair the previous malformed structured result.",
        "Return only a corrected object matching the requested schema.",
        "Do not replace it with prose and do not use hidden chain-of-thought."
      ].join("\n"),
      userPrompt: "Repair the structured result using the validation errors.",
      context: {
        originalRequest: compactLlmRequestForRepair(input.request),
        invalidResult: truncateContextValue(generated, 700),
        validationErrors: validation.errors
      }
    };
  }
  if (lastProviderError && !lastErrors.length) {
    throw new Error(`reasoning_kernel.provider_failed_after_retries: ${formatError(lastProviderError)}`);
  }
  throw new Error(`reasoning_kernel.invalid_provider_output: ${lastErrors.join("; ")}`);
}

async function generateProviderTextWithBudget(input: {
  provider: LlmProvider;
  state: ReasoningKernelState;
  request: LlmRequest;
}) {
  assertReasoningBudget(input.state);
  input.state.providerCalls += 1;
  const stage = input.request.reasoningStage ?? stageForPurpose(input.request.purpose);
  const stageBudget = reasoningStageBudget(stage);
  const remainingMs = input.state.budget.maxElapsedMs - (Date.now() - input.state.startedAt);
  const allowedMs = Math.min(stageBudget.maxElapsedMs, remainingMs - stageBudget.reserveMs);
  if (allowedMs <= 0) throw new Error(`reasoning_kernel.${stage}_stage_budget_exhausted`);
  try {
    return await invokeReasoningProviderText(input.provider, {
      ...input.request,
      reasoningStage: stage,
      timeoutMs: allowedMs,
      maxOutputTokens: input.request.maxOutputTokens ?? stageBudget.maxOutputTokens
    });
  } catch (error) {
    recordRepairError(input.state, "provider_failure", stage, formatError(error));
    throw error;
  }
}

function assertReasoningBudget(state: ReasoningKernelState) {
  if (state.providerCalls >= state.budget.maxProviderCalls) {
    throw new Error("reasoning_kernel.provider_call_budget_exhausted");
  }
  if (Date.now() - state.startedAt >= state.budget.maxElapsedMs) {
    throw new Error("reasoning_kernel.turn_timeout");
  }
}

function assertReasoningBudgetAfterDelegation(state: ReasoningKernelState) {
  if (state.providerCalls >= state.budget.maxProviderCalls) {
    throw new Error("reasoning_kernel.provider_call_budget_exhausted");
  }
  if (Date.now() - state.startedAt > state.budget.maxElapsedMs) {
    throw new Error("reasoning_kernel.turn_timeout");
  }
}

function remainingReasoningMs(state: ReasoningKernelState) {
  return state.budget.maxElapsedMs - (Date.now() - state.startedAt);
}

function reasoningBudgetForUnderstanding(understanding: TurnUnderstanding): ReasoningBudget {
  if (!understanding.needsWorkspace) return REASONING_BUDGETS.conversation;
  if (understanding.intentKind === "workspace_action" || understanding.intentKind === "run_request") return REASONING_BUDGETS.action;
  if (understanding.route === "swarm_readonly" || understanding.route === "orchestrated_run" || understanding.risk === "high") {
    return REASONING_BUDGETS.deep_project;
  }
  return REASONING_BUDGETS.project;
}

function applyVerifierWorkspaceReclassification(
  understanding: TurnUnderstanding,
  state: ReasoningKernelState,
  verification: ReasoningVerificationResult
) {
  const profile = "deep_project";
  understanding.needsWorkspace = true;
  understanding.intentKind = "workspace_question";
  understanding.route = profile === "deep_project" ? "swarm_readonly" : "inspect_explain";
  understanding.risk = profile === "deep_project" ? "high" : "medium";
  understanding.requiredEvidence = [...new Set([...understanding.requiredEvidence, ...verification.missingFacts])];
  understanding.rationale = `${understanding.rationale} Independent verifier reclassified the request as requiring workspace evidence.`;
  state.budget = REASONING_BUDGETS[profile];
}

function applyVerifierEvidenceFollowupBudget(
  understanding: TurnUnderstanding,
  state: ReasoningKernelState,
  verification: ReasoningVerificationResult
) {
  if (!verification.missingFacts.length && !verification.unsupportedClaims.length) return;
  if (state.budget.profile === "project") {
    state.budget = REASONING_BUDGETS.deep_project;
  }
  if (verification.missingFacts.length) {
    understanding.requiredEvidence = [...new Set([...understanding.requiredEvidence, ...verification.missingFacts])];
  }
}

function directiveToStep(directive: ReasoningDirective): ReasoningStep {
  const kind: ReasoningStep["kind"] = directive.toolRequests.length
    ? "tool_batch"
    : directive.action === "ask_user"
      ? "ask_user"
      : directive.action === "escalate"
        ? "escalate"
        : directive.action === "refuse" || directive.action === "cannot_answer"
          ? "refuse"
          : "final";
  return {
    id: `reasoning_step_${randomUUID()}`,
    kind,
    rationale: directive.rationale,
    toolRequests: directive.toolRequests,
    missingFacts: directive.missingFacts,
    successCriteria: directive.successCriteria
  };
}

function stepToDirective(step: ReasoningStep): ReasoningDirective {
  return {
    action: step.kind === "ask_user" ? "ask_user" : step.kind === "refuse" ? "refuse" : step.kind === "escalate" ? "escalate" : step.kind === "tool_batch" ? "investigate" : "answer",
    rationale: step.rationale,
    toolRequests: step.toolRequests,
    missingFacts: step.missingFacts,
    successCriteria: step.successCriteria
  };
}

function finalStepFromCurrentEvidence(repeatedStep: ReasoningStep, rationale: string): ReasoningStep {
  return {
    id: `${repeatedStep.id}_compose_from_current_evidence`,
    kind: "final",
    rationale,
    toolRequests: [],
    missingFacts: repeatedStep.missingFacts,
    successCriteria: repeatedStep.successCriteria,
    targetUnknowns: repeatedStep.targetUnknowns,
    stopCondition: "The already-collected evidence is enough to author an answer or explicitly report remaining unknowns."
  };
}

function shouldComposeDirectlyAfterToolBatch(
  step: ReasoningStep,
  progress: ReasoningProgress,
  state: ReasoningKernelState,
  evidenceStore: EvidenceStore
) {
  if (!evidenceStore.ids().length || progress.stagnant) return false;
  const hasInvestigationBundle = step.toolRequests.some((request) => request.kind === "investigate_project");
  const enoughInvestigationGain = hasInvestigationBundle && progress.informationGain >= REASONING_DIRECT_COMPOSE_MIN_INFORMATION_GAIN;
  const remainingMs = remainingReasoningMs(state);
  const lowTimeWithEvidence = remainingMs > reasoningStageBudget("compose").reserveMs && remainingMs <= REASONING_DIRECT_COMPOSE_LOW_TIME_MS;
  return enoughInvestigationGain || lowTimeWithEvidence;
}

function shouldRepairVerifierFailureWithCompose(step: ReasoningStep, resultCameFromCompose: boolean) {
  return resultCameFromCompose || step.id.endsWith("_compose_from_current_evidence");
}

function validateProviderResult(result: ProviderAuthoredResult, understanding: TurnUnderstanding, evidence: ReasoningEvidenceRef[]) {
  const errors: string[] = [];
  const allowed = new Set(evidence.map((entry) => entry.id));
  const resultEvidenceRefs = Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [];
  if (!Array.isArray(result.evidenceRefs)) errors.push("Provider result evidenceRefs must be an array.");
  const unknown = resultEvidenceRefs.filter((ref) => !allowed.has(ref));
  if (unknown.length) errors.push(...unknown.map((ref) => `Unknown evidence id: ${ref}`));
  if (understanding.needsWorkspace && result.decision === "ANSWER" && !resultEvidenceRefs.length) {
    errors.push("Workspace ANSWER requires at least one evidence id.");
  }
  const claims = Array.isArray(result.claims) ? result.claims : [];
  if (!Array.isArray(result.claims)) errors.push("Provider result claims must be an array.");
  for (const claim of claims) {
    if (typeof claim === "string") continue;
    if (!claim || typeof claim !== "object") {
      errors.push("Provider result claim must be a string or object.");
      continue;
    }
    const claimEvidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    if (!Array.isArray(claim.evidenceIds)) errors.push(`Claim ${claim.id ?? "unknown"} evidenceIds must be an array.`);
    const unknownClaimEvidence = claimEvidenceIds.filter((ref) => !allowed.has(ref));
    if (unknownClaimEvidence.length) errors.push(...unknownClaimEvidence.map((ref) => `Claim ${claim.id} cites unknown evidence id: ${ref}`));
    if (understanding.needsWorkspace && claim.material && !claimEvidenceIds.length) {
      errors.push(`Material workspace claim ${claim.id} has no evidence.`);
    }
  }
  return errors;
}

function createTrace(
  understanding: TurnUnderstanding,
  state: ReasoningKernelState,
  evidenceRefs: ReasoningEvidenceRef[],
  terminalFailure?: string
): ReasoningTurnTrace {
  return {
    id: state.id,
    understanding,
    steps: state.steps,
    toolResults: state.toolResults,
    evidenceRefs,
    budget: state.budget,
    providerCalls: state.providerCalls,
    reasoningAttempts: state.reasoningAttempts,
    repairAttempts: state.repairAttempts,
    toolRounds: state.toolRounds,
    verificationResults: state.verificationResults,
    contextOmissions: state.contextOmissions,
    stageBudgets: reasoningStageBudgets(),
    progress: state.progress,
    repairErrors: state.repairErrors,
    indexReadiness: state.indexReadiness,
    providerRequestRefs: [],
    terminalFailure,
    startedAt: new Date(state.startedAt).toISOString(),
    completedAt: new Date().toISOString()
  };
}

function compactToolResults(results: ReasoningToolResult[], maxChars = REASONING_TOOL_RESULT_CONTEXT_MAX_CHARS) {
  const compacted = results.map(compactToolResult);
  const selected: unknown[] = [];
  let used = 2;
  let omitted = 0;
  for (const result of compacted) {
    const size = JSON.stringify(result).length + 1;
    if (used + size <= maxChars || selected.length === 0) {
      selected.push(result);
      used += size;
    } else {
      omitted += 1;
    }
  }
  if (omitted) {
    selected.push({
      requestId: "omitted_tool_results",
      kind: "context_summary",
      status: "unavailable",
      summary: `${omitted} earlier tool result(s) omitted from provider context to stay within the context budget.`,
      evidenceRefs: [],
      data: { omittedToolResults: omitted, maxChars }
    });
  }
  return selected;
}

function compactReasoningSteps(steps: ReasoningStep[]) {
  const maxSteps = 6;
  const omitted = Math.max(0, steps.length - maxSteps);
  const selected = steps.slice(-maxSteps).map((step) => ({
    id: step.id,
    kind: step.kind,
    rationale: step.rationale,
    toolRequests: step.toolRequests.map((request) => ({
      id: request.id,
      kind: request.kind,
      query: request.query,
      path: request.path,
      paths: request.paths,
      limit: request.limit,
      reason: request.reason
    })),
    missingFacts: step.missingFacts,
    successCriteria: step.successCriteria,
    expectedInformationGain: step.expectedInformationGain,
    targetUnknowns: step.targetUnknowns,
    stopCondition: step.stopCondition,
    result: step.result
      ? {
          decision: step.result.decision,
          answerMarkdownChars: typeof step.result.answerMarkdown === "string" ? step.result.answerMarkdown.length : 0,
          evidenceRefs: Array.isArray(step.result.evidenceRefs) ? step.result.evidenceRefs : [],
          claims: Array.isArray(step.result.claims)
            ? step.result.claims.map((claim) => typeof claim === "string"
              ? claim
              : {
                  id: claim.id,
                  material: claim.material,
                  evidenceIds: Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [],
                  confidence: claim.confidence
                })
            : []
      }
      : undefined
  }));
  if (!omitted) return selected;
  return [
    {
      id: "omitted_reasoning_steps",
      kind: "context_summary",
      rationale: `${omitted} earlier reasoning step(s) omitted from provider context to keep the repair loop bounded. Recent steps are included below.`,
      toolRequests: [],
      missingFacts: [],
      successCriteria: []
    },
    ...selected
  ];
}

function compactLlmRequestForRepair(request: LlmRequest) {
  return {
    purpose: request.purpose,
    reasoningStage: request.reasoningStage,
    userPrompt: request.userPrompt,
    context: compactRepairContext(request.context)
  };
}

function compactRepairContext(context: unknown) {
  if (!isPlainRecord(context)) return truncateContextValue(context, 500);
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if ((key === "evidence" || key === "evidenceInventory") && Array.isArray(value)) {
      compacted[key] = compactEvidenceForRepair(value);
      continue;
    }
    if (key === "toolResults" && Array.isArray(value)) {
      compacted[key] = compactUnknownArrayForRepair(value, 4_000);
      continue;
    }
    if (key === "previousSteps" && Array.isArray(value)) {
      compacted[key] = compactUnknownArrayForRepair(value, 4_000);
      continue;
    }
    if (key === "repairErrors" && Array.isArray(value)) {
      compacted[key] = value.slice(-6);
      continue;
    }
    if (key === "progress" && Array.isArray(value)) {
      compacted[key] = value.slice(-6);
      continue;
    }
    compacted[key] = truncateContextValue(value, 700);
  }
  return compacted;
}

function compactEvidenceForRepair(value: unknown[]) {
  const selected: unknown[] = [];
  let used = 2;
  let omitted = 0;
  for (const entry of value) {
    const compact = compactEvidenceEntryForRepair(entry);
    const size = JSON.stringify(compact).length + 1;
    if (used + size <= 8_000 || selected.length === 0) {
      selected.push(compact);
      used += size;
    } else {
      omitted += 1;
    }
  }
  if (omitted) selected.push({ kind: "context_summary", omittedEvidence: omitted, maxChars: 8_000 });
  return selected;
}

function compactEvidenceEntryForRepair(entry: unknown) {
  if (!isPlainRecord(entry)) return truncateContextValue(entry, 400);
  return {
    id: entry.id,
    sourceType: entry.sourceType,
    path: entry.path,
    startLine: entry.startLine,
    endLine: entry.endLine,
    summary: typeof entry.summary === "string" ? entry.summary.slice(0, 240) : entry.summary,
    excerpt: typeof entry.excerpt === "string" ? entry.excerpt.slice(0, 700) : undefined
  };
}

function compactUnknownArrayForRepair(value: unknown[], maxChars: number) {
  const selected: unknown[] = [];
  let used = 2;
  let omitted = 0;
  for (const entry of value) {
    const compact = truncateContextValue(entry, 500);
    const size = JSON.stringify(compact).length + 1;
    if (used + size <= maxChars || selected.length === 0) {
      selected.push(compact);
      used += size;
    } else {
      omitted += 1;
    }
  }
  if (omitted) selected.push({ kind: "context_summary", omittedItems: omitted, maxChars });
  return selected;
}

function compactToolResult(result: ReasoningToolResult) {
  return {
    requestId: result.requestId,
    kind: result.kind,
    status: result.status,
    summary: result.summary,
    evidenceRefs: result.evidenceRefs.map((entry) => entry.id),
    error: result.error,
    approvalRef: result.approvalRef,
    data: compactToolData(result)
  };
}

function toolBatchFingerprint(step: ReasoningStep) {
  return JSON.stringify(step.toolRequests.map((request) => ({
    kind: request.kind,
    query: request.query?.trim(),
    path: request.path,
    paths: [...(request.paths ?? [])].sort(),
    command: request.command?.trim(),
    limit: request.limit,
    relatedNodeIds: [...(request.relatedNodeIds ?? [])].sort(),
    patch: request.patch
      ? {
          filesChanged: request.patch.filesChanged.map((file) => ({ path: file.path, changeType: file.changeType })),
          unifiedDiff: request.patch.unifiedDiff
        }
      : undefined
  })));
}

function compactToolData(result: ReasoningToolResult) {
  if (!result.data || typeof result.data !== "object") return result.data;
  const data = result.data as Record<string, unknown>;
  if (result.kind === "list_files" && Array.isArray(data.files)) {
    return {
      files: data.files.slice(0, 160),
      totalFiles: data.totalFiles ?? data.files.length,
      omittedFiles: Math.max(0, data.files.length - 160),
      evidenceFileLimit: data.evidenceFileLimit,
      omittedEvidenceFiles: data.omittedEvidenceFiles
    };
  }
  if (result.kind === "repository_search" && Array.isArray(data.matches)) {
    return {
      matches: truncateContextValue(data.matches.slice(0, 20), 300),
      totalMatches: data.matches.length,
      omittedMatches: Math.max(0, data.matches.length - 20)
    };
  }
  if (result.kind === "semantic_search" && Array.isArray(data.nodes)) {
    return { nodes: truncateContextValue(data.nodes.slice(0, 20), 500), retrieval: data.retrieval };
  }
  if (result.kind === "investigate_project") {
    return { bundle: compactInvestigationBundle(data.bundle), indexReadiness: data.indexReadiness };
  }
  if (result.kind === "follow_relationships" && Array.isArray(data.relationships)) {
    return { relationships: truncateContextValue(data.relationships.slice(0, 25), 500) };
  }
  if (result.kind === "read_file" && Array.isArray(data.files)) {
    return {
      files: data.files.slice(0, 4).map((file) => typeof file === "object" && file
        ? { ...(file as Record<string, unknown>), content: String((file as Record<string, unknown>).content ?? "").slice(0, 1_500) }
        : file)
    };
  }
  return truncateContextValue(data, 700);
}

function compactInvestigationBundle(bundle: unknown) {
  if (!isPlainRecord(bundle)) return truncateContextValue(bundle, 700);
  const evidenceIds = Array.isArray(bundle.evidenceIds) ? bundle.evidenceIds : [];
  const candidatePaths = Array.isArray(bundle.candidatePaths) ? bundle.candidatePaths : [];
  const relatedNodeIds = Array.isArray(bundle.relatedNodeIds) ? bundle.relatedNodeIds : [];
  const relationshipIds = Array.isArray(bundle.relationshipIds) ? bundle.relationshipIds : [];
  return {
    query: bundle.query,
    freshness: bundle.freshness,
    retrieval: bundle.retrieval,
    candidatePaths: candidatePaths.slice(0, 12),
    omittedCandidatePaths: Math.max(0, candidatePaths.length - 12),
    relatedNodeIds: relatedNodeIds.slice(0, 12),
    omittedRelatedNodeIds: Math.max(0, relatedNodeIds.length - 12),
    relationshipIds: relationshipIds.slice(0, 12),
    omittedRelationshipIds: Math.max(0, relationshipIds.length - 12),
    evidenceIds: evidenceIds.slice(0, 24),
    omittedEvidenceIds: Math.max(0, evidenceIds.length - 24)
  };
}

function recordContextOmission(
  state: ReasoningKernelState,
  stage: "reason" | "compose" | "verify",
  context: ReturnType<EvidenceStore["context"]>
) {
  if (!context.omittedEvidenceIds.length) return;
  state.contextOmissions.push({
    stage,
    omittedEvidenceIds: context.omittedEvidenceIds,
    selectedEvidenceIds: context.selectedEvidenceIds,
    maxChars: context.maxChars
  });
}

async function curatedEvidenceContext(input: {
  provider: LlmProvider;
  understanding: TurnUnderstanding;
  state: ReasoningKernelState;
  evidenceStore: EvidenceStore;
  conversationContext?: ReasoningConversationContext;
}) {
  let context = input.evidenceStore.context(REASONING_EVIDENCE_CONTEXT_MAX_CHARS, preferredEvidenceIds(input.state));
  const evidenceCount = input.evidenceStore.all().length;
  if (!context.omitted || input.state.curatedEvidenceCount === evidenceCount || input.state.curationProviderDisabled) return context;
  if (hasSufficientDeterministicEvidenceContext(context)) {
    input.state.curatedEvidenceCount = evidenceCount;
    return context;
  }
  if (input.state.budget.profile === "project") {
    input.state.budget = REASONING_BUDGETS.deep_project;
  }
  const inventory = compactEvidenceInventory(input.evidenceStore.all(), context.selectedEvidenceIds, REASONING_CURATION_INVENTORY_MAX_CHARS);
  let generated: {
    selectedEvidenceRefs: string[];
    missingFacts: string[];
    rationale: string;
  };
  try {
    generated = await generateWithProviderRepair<{
      selectedEvidenceRefs: string[];
      missingFacts: string[];
      rationale: string;
    }>({
      provider: input.provider,
      state: input.state,
      schema: evidenceCurationSchema,
      request: {
        purpose: "curate",
        reasoningStage: "curate",
        systemPrompt: [
          "Select the most relevant evidence records for the user's request.",
          "Use only supplied evidence ids. Do not answer the user or invent evidence.",
          "Prefer evidence that can support material claims and cross-file relationships.",
          "Return a small pack: usually 4 to 8 evidence ids.",
          "Return strict JSON only.",
          'Return exactly { "selectedEvidenceRefs": [], "missingFacts": [], "rationale": "string" }.'
        ].join("\n"),
        maxOutputTokens: 512,
        userPrompt: "Curate the evidence pack for the next reasoning step.",
        context: {
          request: input.understanding.originalRequest,
          conversationContext: providerConversationContext(input.conversationContext),
          evidenceInventory: inventory.selected,
          evidenceInventoryOmitted: inventory.omittedEvidenceIds.length,
          totalEvidenceIds: evidenceCount,
          currentSelectedEvidenceIds: context.selectedEvidenceIds,
          omittedEvidenceCount: context.omittedEvidenceIds.length,
          omittedEvidenceIds: context.omittedEvidenceIds.slice(0, 20)
        }
      },
      maxOperationalRepairAttempts: 0
    });
  } catch (error) {
    input.state.curationProviderDisabled = true;
    input.state.curatedEvidenceCount = evidenceCount;
    recordRepairError(input.state, "provider_failure", "curate", `Evidence curation failed; using deterministic evidence ordering. ${formatError(error)}`);
    return context;
  }
  input.state.reasoningAttempts += 1;
  const allowed = new Set(input.evidenceStore.ids());
  input.state.curatedEvidenceIds = [...new Set(generated.selectedEvidenceRefs.filter((id) => allowed.has(id)))];
  input.state.curatedEvidenceCount = evidenceCount;
  context = input.evidenceStore.context(REASONING_EVIDENCE_CONTEXT_MAX_CHARS, preferredEvidenceIds(input.state));
  return context;
}

function hasSufficientDeterministicEvidenceContext(context: ReturnType<EvidenceStore["context"]>) {
  return context.selectedEvidenceIds.length >= REASONING_DETERMINISTIC_CURATION_MIN_SELECTED_EVIDENCE
    && context.omittedEvidenceIds.length <= context.selectedEvidenceIds.length;
}

function composeRepairEvidenceContext(input: {
  state: ReasoningKernelState;
  evidenceStore: EvidenceStore;
}) {
  return input.evidenceStore.context(
    REASONING_COMPOSE_REPAIR_EVIDENCE_CONTEXT_MAX_CHARS,
    preferredEvidenceIds(input.state)
  );
}

function repairEvidenceContext(input: {
  state: ReasoningKernelState;
  evidenceStore: EvidenceStore;
}) {
  return input.evidenceStore.context(
    REASONING_REPAIR_EVIDENCE_CONTEXT_MAX_CHARS,
    preferredEvidenceIds(input.state)
  );
}

function composeEvidenceContext(input: {
  state: ReasoningKernelState;
  evidenceStore: EvidenceStore;
}) {
  return input.evidenceStore.context(
    REASONING_COMPOSE_EVIDENCE_CONTEXT_MAX_CHARS,
    preferredEvidenceIds(input.state)
  );
}

function preferredEvidenceIds(state: ReasoningKernelState) {
  return [
    ...new Set([
      ...readFileEvidenceIds(state.toolResults),
      ...state.curatedEvidenceIds
    ])
  ];
}

function readFileEvidenceIds(toolResults: ReasoningToolResult[]) {
  return toolResults.flatMap((result) => result.status === "success" && result.kind === "read_file"
    ? result.evidenceRefs.map((entry) => entry.id)
    : []);
}

function compactEvidenceInventory(
  evidence: ReasoningEvidenceRef[],
  preferredEvidenceIds: string[],
  maxChars: number
) {
  const preferred = new Set(preferredEvidenceIds);
  const ordered = [
    ...preferredEvidenceIds.flatMap((id) => evidence.find((entry) => entry.id === id) ? [evidence.find((entry) => entry.id === id)!] : []),
    ...evidence.filter((entry) => !preferred.has(entry.id))
  ];
  const selected: Array<Pick<ReasoningEvidenceRef, "id" | "sourceType" | "path" | "startLine" | "endLine" | "summary">> = [];
  const omittedEvidenceIds: string[] = [];
  let used = 2;
  for (const entry of ordered) {
    const compact = {
      id: entry.id,
      sourceType: entry.sourceType,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      summary: entry.summary.length > 220 ? `${entry.summary.slice(0, 220)}...` : entry.summary
    };
    const size = JSON.stringify(compact).length + 1;
    if (used + size <= maxChars || selected.length === 0) {
      selected.push(compact);
      used += size;
    } else {
      omittedEvidenceIds.push(entry.id);
    }
  }
  return { selected, omittedEvidenceIds, usedChars: used, maxChars };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isContextTooLargeError(error: unknown) {
  return /provider\.context_too_large/i.test(formatError(error));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateContextValue(value: unknown, maxStringLength: number, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}... [truncated ${value.length - maxStringLength} chars]`
      : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 4) {
    if (Array.isArray(value)) return { kind: "array", length: value.length, truncated: true };
    return { kind: "object", keys: Object.keys(value).slice(0, 20), truncated: true };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => truncateContextValue(entry, maxStringLength, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 40).map(([key, entry]) => [key, truncateContextValue(entry, maxStringLength, depth + 1)])
  );
}

function reasoningStageBudget(stage: ReasoningStage): ReasoningStageBudget {
  return { stage, ...REASONING_STAGE_BUDGETS[stage] };
}

function reasoningStageBudgets() {
  return (Object.keys(REASONING_STAGE_BUDGETS) as ReasoningStage[]).map(reasoningStageBudget);
}

function stageForPurpose(purpose: LlmRequest["purpose"]): ReasoningStage {
  if (purpose === "route") return "route";
  if (purpose === "curate") return "curate";
  if (purpose === "compose" || purpose === "decide") return "compose";
  if (purpose === "verify") return "verify";
  if (purpose === "repair") return "repair";
  if (purpose === "retrieve" || purpose === "escalate") return "investigate";
  return "reason";
}

function recordRepairError(
  state: ReasoningKernelState,
  kind: StructuredRepairError["kind"],
  stage: ReasoningStage,
  message: string
) {
  state.repairErrors.push({ kind, stage, message, createdAt: new Date().toISOString() });
}

function recordValidationRepairAttempt(state: ReasoningKernelState, errors: string[]) {
  if (state.validationRepairAttempts >= state.budget.maxRepairAttempts) {
    throw new Error("reasoning_kernel.validation_repair_budget_exhausted");
  }
  state.validationRepairAttempts += 1;
  state.repairAttempts += 1;
  recordValidationRepairErrors(state, errors);
}

function recordValidationRepairErrors(state: ReasoningKernelState, errors: string[]) {
  for (const error of errors) {
    const kind: StructuredRepairError["kind"] = /reclassif|route/i.test(error)
      ? "wrong_route"
      : /unsafe|secret|permission|approval|patch/i.test(error)
        ? "unsafe_action"
        : /unsupported|claim|evidence id|no evidence/i.test(error)
          ? "unsupported_claim"
          : "insufficient_evidence";
    recordRepairError(state, kind, "repair", error);
  }
}

function evidenceSignatures(evidence: ReasoningEvidenceRef[]) {
  return new Set(evidence.map(evidenceSignature));
}

function evidenceSignature(entry: ReasoningEvidenceRef) {
  return [
    entry.sourceType,
    entry.path ?? "",
    entry.startLine ?? "",
    entry.endLine ?? "",
    entry.contentHash ?? "",
    entry.summary,
    entry.excerpt ?? ""
  ].join("|");
}

function recordToolProgress(
  state: ReasoningKernelState,
  before: Set<string>,
  evidence: ReasoningEvidenceRef[]
): ReasoningProgress {
  const added = evidence.filter((entry) => entry.sourceType !== "investigation_bundle" && !before.has(evidenceSignature(entry)));
  const newFileCount = new Set(added.filter((entry) => ["workspace_file", "manifest"].includes(entry.sourceType)).map((entry) => entry.path).filter(Boolean)).size;
  const newRelationshipCount = added.filter((entry) => entry.sourceType === "semantic_relationship").length;
  const informationGain = added.length + newFileCount * 2 + newRelationshipCount;
  const progress: ReasoningProgress = {
    round: state.toolRounds,
    newEvidenceCount: added.length,
    newFileCount,
    newRelationshipCount,
    informationGain,
    stagnant: informationGain === 0,
    reason: informationGain === 0
      ? "The tool round produced no new evidence signatures, source files, or relationships."
      : `The tool round added ${added.length} evidence record(s), ${newFileCount} source file(s), and ${newRelationshipCount} relationship(s).`,
    createdAt: new Date().toISOString()
  };
  state.progress.push(progress);
  return progress;
}

function trailingStagnantRounds(progress: ReasoningProgress[]) {
  let count = 0;
  for (let index = progress.length - 1; index >= 0 && progress[index]?.stagnant; index -= 1) count += 1;
  return count;
}

function updateIndexReadiness(state: ReasoningKernelState, results: ReasoningToolResult[]) {
  for (const result of results) {
    if (!result.data || typeof result.data !== "object") continue;
    const readiness = (result.data as { indexReadiness?: ReasoningTurnTrace["indexReadiness"] }).indexReadiness;
    if (readiness) state.indexReadiness = readiness;
  }
}
