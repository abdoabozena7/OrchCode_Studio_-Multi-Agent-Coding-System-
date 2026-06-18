import { randomUUID } from "node:crypto";
import type { WorkerCapabilityGrant } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { invokeReasoningProviderEmbedding, invokeReasoningProviderStructured, invokeReasoningProviderText, runAdaptiveReasoningTurn } from "./ReasoningKernel.js";

export async function runReadOnlyUnderstandingEscalation(input: {
  workspacePath: string;
  provider: LlmProvider;
  question: string;
  missingFacts: string[];
  budget: { remainingProviderCalls: number; remainingMs: number };
}) {
  let providerCalls = 0;
  const startedAt = Date.now();
  const invoke = async <T>(operation: () => Promise<T>) => {
    if (providerCalls >= input.budget.remainingProviderCalls) throw new Error("project_understanding.escalation_provider_budget_exhausted");
    if (Date.now() - startedAt >= input.budget.remainingMs) throw new Error("project_understanding.escalation_timeout");
    providerCalls += 1;
    return operation();
  };
  const boundedRequest = (request: LlmRequest): LlmRequest => ({
    ...request,
    timeoutMs: Math.max(1, Math.min(request.timeoutMs ?? input.budget.remainingMs, input.budget.remainingMs - (Date.now() - startedAt)))
  });
  const budgetedProvider: LlmProvider = {
    generateStructured: (request, schema) => invoke(() => invokeReasoningProviderStructured(input.provider, boundedRequest(request), schema)),
    generateText: (request) => invoke(() => invokeReasoningProviderText(input.provider, boundedRequest(request))),
    ...(input.provider.embed ? { embed: (request: Parameters<NonNullable<LlmProvider["embed"]>>[0]) => invoke(() => invokeReasoningProviderEmbedding(input.provider, request)) } : {})
  };
  const sessionId = `readonly_reasoning_worker_${randomUUID()}`;
  const grant: WorkerCapabilityGrant = {
    id: `grant_${randomUUID()}`,
    workerId: sessionId,
    sessionId,
    allowedPaths: [],
    allowedTools: ["workspace.list_files", "workspace.read_file", "workspace.search_code"],
    allowedCommandRisks: [],
    canProposePatches: false,
    canRequestCommands: false,
    allowNetwork: false,
    expiresAt: new Date(Date.now() + Math.max(1, input.budget.remainingMs)).toISOString()
  };
  const result = await runAdaptiveReasoningTurn({
    provider: budgetedProvider,
    verifierProvider: budgetedProvider,
    message: [
      input.question,
      "",
      "Read-only delegated investigation. Focus on these unresolved facts:",
      ...input.missingFacts.map((fact) => `- ${fact}`),
      "Do not request commands or patches. Return evidence-backed findings or explicitly state what remains unknown."
    ].join("\n"),
    sessionId,
    tools: new ToolRegistry(input.workspacePath, grant)
  });
  return { reviews: [result.result.answerMarkdown], providerCalls };
}
