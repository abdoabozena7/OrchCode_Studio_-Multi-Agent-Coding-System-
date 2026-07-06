import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";

const sourceRoot = path.resolve(import.meta.dirname, "..", "..", "src");

test("production provider calls are confined to ReasoningKernel and provider adapters", async () => {
  const files = await sourceFiles(sourceRoot);
  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    if (relative.startsWith("tests/") || relative.startsWith("llm/") || relative === "runtime/ReasoningKernel.ts") continue;
    const content = await readFile(file, "utf8");
    if (/\.generateStructured\s*(?:<[^>]+>)?\s*\(|\.generateText\s*\(/.test(content)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("runtime mock providers and legacy semantic answer engines cannot re-enter AgentRuntime", async () => {
  const files = await sourceFiles(sourceRoot);
  const production = files.filter((file) => !path.relative(sourceRoot, file).replaceAll("\\", "/").startsWith("tests/"));
  const violations: string[] = [];
  for (const file of production) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    const content = await readFile(file, "utf8");
    if (/MockLlmProvider|defaultMockWorker/.test(content)) violations.push(relative);
  }
  const agentRuntime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  assert.doesNotMatch(agentRuntime, /UniversalProjectQuestionEngine|ProjectQuestionGrounding|createDeterministicGroundedFallbackAnswer/);
  assert.deepEqual(violations, []);
});

test("project explain does not expose local assistant answer fallback builders", async () => {
  const files = await sourceFiles(path.join(sourceRoot, "runtime"));
  const violations: string[] = [];
  const forbidden = /createEvidenceBasedAnswerFallback|createDeterministic(?:NotFound|GroundedFallback)Answer|create(?:PageInventory|ThresholdInventory|ForecastingScope|ArabicDatasetRealtime)Fallback|collectGroundingEvidenceForSynthesis/;
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    const content = await readFile(file, "utf8");
    if (forbidden.test(content)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("patch intent failures do not expose local fallback warning contracts", async () => {
  const files = [
    path.join(sourceRoot, "runtime", "RunEngine.ts"),
    path.resolve(sourceRoot, "..", "..", "..", "packages", "protocol", "src", "patch.ts")
  ];
  const violations: string[] = [];
  const forbidden = /fallbackWarning|fallbackKind|Patch unavailable|Provider patch intent failed validation/;
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (forbidden.test(content)) violations.push(path.relative(path.resolve(sourceRoot, "..", "..", ".."), file).replaceAll("\\", "/"));
  }
  assert.deepEqual(violations, []);
});

test("runtime smoke scripts do not advertise mock/demo or deterministic fallback flows", async () => {
  const packageJsonPath = path.resolve(sourceRoot, "..", "package.json");
  const scriptFiles = await sourceFiles(path.resolve(sourceRoot, "..", "scripts"));
  const violations: string[] = [];
  const forbidden = /demo_mock|fallbackUsed|fallbackReason|python-pygame-fallback|pygame-fallback|deterministic implementation fallback|Provider patch output was invalid; using deterministic implementation fallback|provider timeout must force recorded fallback/;
  for (const file of [packageJsonPath, ...scriptFiles]) {
    const content = await readFile(file, "utf8");
    if (forbidden.test(content)) violations.push(path.relative(path.resolve(sourceRoot, ".."), file).replaceAll("\\", "/"));
  }
  assert.deepEqual(violations, []);
});

test("legacy src/scheduler tree cannot re-enter beside canonical orchestration", async () => {
  const legacySchedulerRoot = path.join(sourceRoot, "scheduler");
  const legacySchedulerFiles = await sourceFiles(legacySchedulerRoot).catch(() => []);
  const files = await sourceFiles(sourceRoot);
  const violations: string[] = legacySchedulerFiles.map((file) => path.relative(sourceRoot, file).replaceAll("\\", "/"));
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    if (relative.startsWith("tests/")) continue;
    const content = await readFile(file, "utf8");
    if (/\.\.?\/scheduler|src\/scheduler/.test(content)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("legacy task graph execution loop stays behind the core canonical adapter boundary", async () => {
  const index = await readFile(path.join(sourceRoot, "orchestration", "index.ts"), "utf8");
  assert.doesNotMatch(index, /from "\.\/TaskGraphExecutionLoopService\.js"|from "\.\/TaskGraphManager\.js"/);

  const productionFiles = (await sourceFiles(sourceRoot))
    .filter((file) => !path.relative(sourceRoot, file).replaceAll("\\", "/").startsWith("tests/"));
  const violations: string[] = [];
  for (const file of productionFiles) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    if (relative === "orchestration/CoreTaskGraphExecutionService.ts" || relative === "orchestration/TaskGraphExecutionLoopService.ts") continue;
    const content = await readFile(file, "utf8");
    if (/TaskGraphExecutionLoopService/.test(content)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("agentic project explain adapter does not expose local markdown as an answer", async () => {
  const adapter = await readFile(path.join(sourceRoot, "runtime", "AgenticTaskAdapters.ts"), "utf8");
  assert.doesNotMatch(adapter, /answerMarkdown/);
  assert.doesNotMatch(adapter, /result\.finalOutput\.markdown/);
});

test("agentic task kernel output synthesizer only passes through provider draft text", async () => {
  const synthesizer = await readFile(path.join(sourceRoot, "runtime", "AgenticOutputSynthesizer.ts"), "utf8");
  assert.match(synthesizer, /providerDraft/);
  assert.doesNotMatch(synthesizer, /synthesize(?:Arabic|English)|summarySentence|designAssessmentEnglish|debuggingEnglish|planningEnglish|validationOrRepairEnglish/);
});

test("provider-backed swarm does not synthesize local semantic answers in AgentRuntime", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeProviderBackedSwarmService.ts"), "utf8");
  assert.match(service, /finalReport: string/);
  assert.doesNotMatch(runtime, /synthesize(?:GeneralSwarmAnswer|InventoryClassificationAnswer|ArabicTechnicalExplanation)/);
  assert.doesNotMatch(runtime, /isInventoryClassificationPrompt|buildArtifactInventoryRows|Artifact Inventory|This is synthesized from the worker evidence/);
});

test("AgentRuntime delegates local RunEngine execution through RuntimeRunEngineService", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeRunEngineService.ts"), "utf8");
  assert.match(runtime, /RuntimeRunEngineService/);
  assert.doesNotMatch(runtime, /new RunEngine\(/);
  assert.match(service, /new RunEngine\(/);
});

test("AgentRuntime delegates provider-backed swarm execution through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeProviderBackedSwarmService.ts"), "utf8");
  assert.match(runtime, /RuntimeProviderBackedSwarmService/);
  assert.doesNotMatch(runtime, /runProviderBackedSwarmTurn|SwarmAutopilotRuntime|formatProviderBackedSwarmAnswer/);
  assert.match(service, /SwarmAutopilotRuntime/);
  assert.match(service, /RuntimeRunEngineService/);
});

test("AgentRuntime delegates recursive swarm execution through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeRecursiveSwarmService.ts"), "utf8");
  assert.match(runtime, /RuntimeRecursiveSwarmService/);
  assert.doesNotMatch(runtime, /runRecursiveSwarmTurn|RecursiveSwarmOrchestrator|buildMemoryEvidencePack|collectIntentsFromTree|bridgeEditIntents/);
  assert.match(service, /RecursiveSwarmOrchestrator/);
  assert.match(service, /collectIntentsFromTree/);
  assert.match(service, /bridgeEditIntents/);
});

test("AgentRuntime delegates session outcome synchronization through a lifecycle service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeSessionOutcomeService.ts"), "utf8");
  assert.match(runtime, /RuntimeSessionOutcomeService/);
  assert.doesNotMatch(runtime, /syncSessionOutcome|buildRuntimeVerification|buildReviewGateSummary|setRunPhaseState/);
  assert.match(service, /class RuntimeSessionOutcomeService/);
  assert.match(service, /buildRuntimeVerification/);
  assert.match(service, /buildReviewGateSummary/);
  assert.match(service, /setRunPhaseState/);
});

test("AgentRuntime delegates recursive branch execution start through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeRecursiveBranchExecutionService.ts"), "utf8");
  assert.match(runtime, /RuntimeRecursiveBranchExecutionService/);
  assert.doesNotMatch(runtime, /advanceRecursiveBranchScheduler|setBranchExecutions|blockRecursiveBranchExecution|reviewRecursiveGraphSemanticConflicts|createBranchExecutionRecord|normalizeBranchTargetPlans|SemanticConflictResolver|runRecursiveBranchesThroughCanonicalGraph/);
  assert.match(service, /runRecursiveBranchesThroughCanonicalGraph/);
  assert.match(service, /SemanticConflictResolver/);
  assert.match(service, /createBranchExecutionRecord/);
});

test("AgentRuntime delegates pending action re-entry through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimePendingActionService.ts"), "utf8");
  assert.match(runtime, /RuntimePendingActionService/);
  assert.doesNotMatch(runtime, /handlePendingAction|recordLockedClarification|RuntimePlanPendingActionService|IntentLedgerService|confirm_preview|resolve_semantic_conflict/);
  assert.match(service, /RuntimePlanPendingActionService/);
  assert.match(service, /IntentLedgerService/);
  assert.match(service, /confirm_preview/);
  assert.match(service, /resolve_semantic_conflict/);
});

test("AgentRuntime delegates recursive branch progress projection through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeRecursiveBranchProgressService.ts"), "utf8");
  assert.match(runtime, /RuntimeRecursiveBranchProgressService/);
  assert.doesNotMatch(runtime, /updateRecursiveRepairFromPatch|updateRecursiveRepairFromCommandResult|updateBranchExecutionFromPatch|updateActiveBranchValidation|refreshRecursiveFanIn/);
  assert.match(service, /RecursiveRepairStateService/);
  assert.match(service, /RecursiveBranchPatchStatusService/);
  assert.match(service, /RecursiveFanInReportService/);
});

test("AgentRuntime facade does not keep local answer or legacy plan-confirmation helpers", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  assert.doesNotMatch(runtime, /formatExplainEvidenceAnswer|shouldAnswerExplainEvidenceQuestion/);
  assert.doesNotMatch(runtime, /formatRunTurnFailureMessage|buildPlanClarification|shouldConfirmSingleFilePygamePlan/);
  assert.doesNotMatch(runtime, /createEmptyOrchestration|upsertById/);
});

test("AgentRuntime delegates conversation packing and deterministic text helpers", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const conversationContext = await readFile(path.join(sourceRoot, "runtime", "RuntimeConversationContextService.ts"), "utf8");
  const textUtils = await readFile(path.join(sourceRoot, "runtime", "RuntimeTextUtils.ts"), "utf8");
  assert.match(runtime, /RuntimeConversationContextService/);
  assert.match(runtime, /RuntimeTextUtils/);
  assert.doesNotMatch(runtime, /function buildSameSessionConversationContext|function selectConversationContextMessages|function summarizeRuntimeOutput|function detectResponseLanguage/);
  assert.match(conversationContext, /REASONING_CONVERSATION_CONTEXT_MAX_CHARS/);
  assert.match(conversationContext, /buildScopedAgentContextMessages/);
  assert.match(textUtils, /summarizeRuntimeOutput/);
});

test("AgentRuntime delegates concrete provider construction to RuntimeProviderFactory", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const factory = await readFile(path.join(sourceRoot, "runtime", "RuntimeProviderFactory.ts"), "utf8");
  assert.match(runtime, /RuntimeProviderFactory/);
  assert.doesNotMatch(runtime, /OllamaProvider|OpenAIProvider|function createRealProvider|function autoSuggestEmbeddingModel/);
  assert.match(factory, /OllamaProvider/);
  assert.match(factory, /OpenAIProvider/);
  assert.match(factory, /validateRealProviderConfig/);
});

test("AgentRuntime delegates adaptive direct provider turns through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimeAdaptiveDirectTurnService.ts"), "utf8");
  assert.match(runtime, /RuntimeAdaptiveDirectTurnService/);
  assert.doesNotMatch(runtime, /continueAdaptiveReasoningTurn|runReadOnlyUnderstandingEscalation|finalizeAdaptiveReasoningDecisionPipeline|new ToolRegistry|new EvidenceStore/);
  assert.match(service, /continueAdaptiveReasoningTurn/);
  assert.match(service, /runReadOnlyUnderstandingEscalation/);
  assert.match(service, /finalizeAdaptiveReasoningDecisionPipeline/);
});

test("AgentRuntime delegates planning-capable orchestration handoff through a focused service", async () => {
  const runtime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  const service = await readFile(path.join(sourceRoot, "runtime", "RuntimePlanningTurnService.ts"), "utf8");
  assert.match(runtime, /RuntimePlanningTurnService/);
  assert.doesNotMatch(runtime, /RuntimeOrchestrationPreludeService|RuntimeOrchestrationDispatchService|intentContractService\.compile|blockPlanning|startRecursiveFactory|providerBackedSwarm\.run|recursiveSwarmService\.run|runEngineService\.run/);
  assert.match(service, /RuntimeOrchestrationPreludeService/);
  assert.match(service, /RuntimeOrchestrationDispatchService/);
  assert.match(service, /intentContract\.compile/);
});

test("ReasoningKernel starts with a combined provider understanding and ReasoningStep and never silently truncates context", async () => {
  const kernel = await readFile(path.join(sourceRoot, "runtime", "ReasoningKernel.ts"), "utf8");
  const providerContract = await readFile(path.join(sourceRoot, "llm", "LlmProvider.ts"), "utf8");
  assert.match(kernel, /initialReasoningDecisionSchema/);
  assert.doesNotMatch(kernel, /reasoningDirectiveSchema/);
  assert.doesNotMatch(providerContract, /provider context truncated/);
  assert.match(providerContract, /provider\.context_too_large/);
});

test("adaptive read-only delegation and composite investigation remain inside ReasoningKernel", async () => {
  const escalation = await readFile(path.join(sourceRoot, "runtime", "ProjectUnderstandingEscalation.ts"), "utf8");
  const dispatcher = await readFile(path.join(sourceRoot, "runtime", "ReasoningToolDispatcher.ts"), "utf8");
  const kernel = await readFile(path.join(sourceRoot, "runtime", "ReasoningKernel.ts"), "utf8");
  assert.match(escalation, /runAdaptiveReasoningTurn/);
  assert.doesNotMatch(escalation, /SwarmAutopilotRuntime/);
  assert.match(dispatcher, /investigateProject/);
  assert.match(kernel, /informationGain/);
  assert.match(kernel, /REASONING_STAGE_BUDGETS/);
});

test("SessionManager rejects assistant messages without provider provenance", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "hivo-provider-provenance-"));
  try {
    const manager = new SessionManager(storage, new EventBus());
    await manager.load();
    const session = await manager.createSession({
      workspacePath: storage,
      mode: "real_provider",
      userPrompt: "hello"
    });
    await assert.rejects(
      manager.addMessage(session.id, { role: "assistant", content: "local answer" }),
      /provider_provenance_required/
    );
    await manager.addMessage(session.id, { role: "assistant", content: "provider answer", providerRequestRefs: ["provider_request_1"] });
    assert.equal(manager.getSession(session.id)?.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

async function sourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await sourceFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) results.push(fullPath);
  }
  return results;
}
