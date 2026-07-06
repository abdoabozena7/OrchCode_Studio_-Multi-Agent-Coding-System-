import type { AgentRuntimeSession, RuntimeTurnResponse } from "@hivo/protocol";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { ReasoningKernelFailure } from "./ReasoningKernel.js";
import { ProviderConfigurationError } from "./RuntimeProviderGate.js";
import { SessionManager } from "./SessionManager.js";

export class RuntimeTurnFailureService {
  constructor(private readonly sessionManager: SessionManager) {}

  async record(input: {
    sessionId: string;
    baseSession: AgentRuntimeSession;
    error: unknown;
    providerTelemetry: ProviderTelemetryRecorder;
  }): Promise<RuntimeTurnResponse> {
    input.providerTelemetry.markProviderError(input.error);
    input.providerTelemetry.markTerminalFailure(input.error);
    const latestSessionForFailure = this.sessionManager.getSession(input.sessionId) ?? input.baseSession;
    const providerGateFailure = isProviderGateFailure(input.error, latestSessionForFailure);
    const failureMessage = formatRuntimeError(input.error);
    await this.sessionManager.updateSession(input.sessionId, (draft) => {
      draft.status = providerGateFailure ? "failed_provider" : "failed";
      draft.lifecycleStage = "FAILED";
      draft.providerTelemetry = input.providerTelemetry.snapshot();
      if (draft.latestDecisionPipeline) {
        const reasoningTrace = input.error instanceof ReasoningKernelFailure
          ? {
              ...input.error.trace,
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
      draft.reasoningSummaries.push(failureMessage);
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
          notes: [failureMessage]
        }],
        nextAction: "Fix the reported runtime/provider issue, then retry the request.",
        createdAt: new Date().toISOString()
      };
    });
    const failureSession = this.sessionManager.getSession(input.sessionId) ?? latestSessionForFailure;
    if (failureSession.messages.at(-1)?.role === "user") {
      await this.sessionManager.addMessage(input.sessionId, {
        role: "system",
        content: formatRuntimeFailureSystemMessage(input.error, Boolean(providerGateFailure), failureSession)
      });
    }
    return { sessionId: input.sessionId, status: providerGateFailure ? "failed_provider" : "failed" };
  }
}

export function isProviderGateFailure(error: unknown, session: AgentRuntimeSession) {
  if (session.mode !== "real_provider") return undefined;
  const detail = formatRuntimeError(error);
  if (error instanceof ProviderConfigurationError) return `provider_gate_failed:${error.code}`;
  if (/provider_patch_intent_/i.test(detail)) return undefined;
  if (session.plan && /reasoning_kernel\.invalid_provider_output|schema_validation_failed|structured output validation|failed schema validation/i.test(detail)) {
    return undefined;
  }
  if (/provider_mock_forbidden|provider_missing|provider_validation|provider_api_key|real_provider requires|Unsupported provider type|reasoning_kernel\.(?:provider_failed|invalid_provider_output|turn_timeout|provider_call_budget_exhausted)|project_explain_provider/i.test(detail)) {
    return "provider_gate_failed";
  }
  return undefined;
}

export function formatRuntimeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
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

function formatRuntimeFailureSystemMessage(error: unknown, providerGateFailure: boolean, session: AgentRuntimeSession) {
  const detail = formatRuntimeError(error);
  if (!providerGateFailure && session.plan && /patch|schema_validation|structured output|invalid_provider_output/i.test(detail)) {
    return [
      "I could not produce a file change for that request.",
      "",
      `Reason: ${detail}`,
      "",
      "No files were changed. Retry with a smaller edit, name the exact target file, or switch to a stronger configured provider."
    ].join("\n");
  }
  if (providerGateFailure) return formatProviderFailureMessage(session.userPrompt, error);
  return [
    "The runtime failed before it could complete the turn.",
    "",
    `Reason: ${detail}`,
    "",
    "No successful result was claimed."
  ].join("\n");
}
