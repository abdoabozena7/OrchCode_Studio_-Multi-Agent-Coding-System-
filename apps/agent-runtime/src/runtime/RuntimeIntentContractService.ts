import type {
  AgentRuntimeSession,
  IntentContract,
  RuntimeSessionStatus,
  RuntimeTurnResponse
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { resolveMemoryPaths } from "../memory/ProjectMemory.js";
import { IntentLedgerService } from "../orchestration/IntentLedgerService.js";
import { UserIntentCompiler, type UserIntentCompilationResult } from "../orchestration/UserIntentCompiler.js";
import { SessionManager } from "./SessionManager.js";

export class RuntimeIntentContractService {
  constructor(private readonly sessionManager: SessionManager) {}

  async compile(input: {
    sessionId: string;
    originalRequest: string;
    provider: LlmProvider;
    parentContext: Record<string, unknown>;
  }): Promise<UserIntentCompilationResult> {
    const session = requireSession(this.sessionManager, input.sessionId);
    if (session.intentContract?.status === "ready" && session.intent_contract_status === "ready") {
      return {
        ready: true,
        contract: session.intentContract,
        blockingQuestions: [],
        validationErrors: [],
        errors: []
      };
    }
    const artifactsPath = path.join(resolveMemoryPaths(session.workspacePath).rootDir, "runtime_intents", input.sessionId);
    const ledger = new IntentLedgerService({
      workspacePath: session.workspacePath,
      sourceComponent: "AgentRuntime"
    });
    const original = await ledger.saveOriginalRequest({
      runId: input.sessionId,
      runKind: "runtime_session",
      artifactsPath,
      originalRequest: input.originalRequest,
      metadata: {
        source_component: "AgentRuntime",
        session_id: input.sessionId
      }
    });
    const compilation = await new UserIntentCompiler().compile({
      workspacePath: session.workspacePath,
      runId: input.sessionId,
      runKind: "runtime_session",
      artifactsPath,
      originalRequest: input.originalRequest,
      provider: input.provider,
      parentContext: {
        ...input.parentContext,
        session_id: input.sessionId,
        original_request_ref: original.artifact_ref,
        intent_ledger_ref: path.join(artifactsPath, "intent", "intent_ledger.json"),
        execution_mode: session.executionMode,
        trust_profile: session.trustProfile
      },
      sourceComponent: "AgentRuntime"
    });
    await this.sessionManager.updateSession(input.sessionId, (draft) => {
      draft.intentContract = compilation.contract;
      draft.intent_contract_ref = compilation.contract.artifact_ref;
      draft.intent_contract_status = compilation.contract.status;
      draft.reasoningSummaries.push(`Intent contract compiled with status ${compilation.contract.status}.`);
    });
    await this.sessionManager.addArtifact(input.sessionId, {
      id: `artifact_intent_contract_${randomUUID()}`,
      sessionId: input.sessionId,
      type: "intent_contract",
      title: "Intent Contract",
      summary: `Intent contract status: ${compilation.contract.status}.`,
      payload: { intentContract: compilation.contract },
      createdAt: new Date().toISOString()
    });
    this.sessionManager.publishIntentContractEvent({
      type: "runtime.intent_contract.compiled",
      sessionId: input.sessionId,
      intentContract: compilation.contract
    });
    return compilation;
  }

  async blockPlanning(input: {
    sessionId: string;
    originalRequest: string;
    compilation: UserIntentCompilationResult;
    providerTelemetry: ProviderTelemetryRecorder;
  }): Promise<RuntimeTurnResponse> {
    const contract = input.compilation.contract;
    const blockingQuestions = input.compilation.blockingQuestions;
    const status: RuntimeSessionStatus =
      contract.status === "provider_unavailable"
        ? "failed_provider"
        : contract.status === "needs_clarification"
          ? "needs_approval"
          : "blocked";
    const summary = contract.status === "needs_clarification"
      ? "Planning is waiting for blocking intent clarification."
      : `Planning blocked by intent contract status ${contract.status}.`;
    await this.sessionManager.addMessage(input.sessionId, {
      role: "system",
      content: formatIntentContractBlockMessage(contract, blockingQuestions, input.compilation.validationErrors)
    });
    await this.sessionManager.updateSession(input.sessionId, (draft) => {
      draft.status = status;
      draft.lifecycleStage = contract.status === "provider_unavailable"
        ? "FAILED"
        : contract.status === "needs_clarification"
          ? "PLAN"
          : "BLOCKED";
      draft.intentContract = contract;
      draft.intent_contract_ref = contract.artifact_ref;
      draft.intent_contract_status = contract.status;
      draft.providerTelemetry = input.providerTelemetry.snapshot();
      draft.nextAction = contract.status === "needs_clarification"
        ? {
            kind: "clarify_request",
            message: "Answer the blocking intent questions before planning can start.",
            originalRequest: input.originalRequest,
            missingFacts: blockingQuestions
          }
        : undefined;
      draft.taskState.phase = contract.status === "provider_unavailable" ? "failed" : "verification_pending";
      draft.taskState.finalStatus =
        status === "failed_provider" ? "failed" : status === "blocked" ? "blocked" : undefined;
      draft.runSummary = {
        status: contract.status === "needs_clarification" ? "pending" : status === "failed_provider" ? "failed" : "blocked",
        summary,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [{
          name: "Intent contract gate",
          status: contract.status === "provider_unavailable" ? "failed" : "blocked",
          notes: [
            `intent_contract_status=${contract.status}`,
            `intent_contract_ref=${contract.artifact_ref ?? "missing"}`,
            ...blockingQuestions.map((question) => `blocking_question=${question}`),
            ...input.compilation.validationErrors.map((error) => `validation_error=${error}`)
          ]
        }],
        nextAction: contract.status === "needs_clarification"
          ? "Answer the blocking intent questions; planning has not started."
          : "Restore a ready provider-authored intent contract before planning.",
        createdAt: new Date().toISOString()
      };
      draft.reasoningSummaries.push(summary);
    });
    return { sessionId: input.sessionId, status };
  }
}

export function formatIntentContractBlockMessage(contract: IntentContract, blockingQuestions: string[], validationErrors: string[]) {
  const lines = [
    "Planning is blocked until a ready provider-authored intent_contract.json exists.",
    `Intent contract status: ${contract.status}.`,
    `Intent contract ref: ${contract.artifact_ref ?? "missing"}.`
  ];
  if (blockingQuestions.length) {
    lines.push("", "Blocking questions:");
    lines.push(...blockingQuestions.map((question) => `- ${question}`));
  }
  if (validationErrors.length) {
    lines.push("", "Validation errors:");
    lines.push(...validationErrors.map((error) => `- ${error}`));
  }
  return lines.join("\n");
}

function requireSession(sessionManager: SessionManager, sessionId: string): AgentRuntimeSession {
  const session = sessionManager.getSession(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  return session;
}
