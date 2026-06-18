import { buildAgenticEvidenceGraph } from "./AgenticEvidenceGraph.js";
import { classifyAgenticTaskIntent } from "./AgenticIntentClassifier.js";
import { buildAgenticMentalModel } from "./AgenticMentalModelBuilder.js";
import {
  defaultAgenticTaskKernelConfig,
  mergeAgenticTaskKernelConfig,
  type AgenticFallbackReason,
  type AgenticOutputDraft,
  type AgenticReadBudget,
  type AgenticReasoningTrace,
  type AgenticTaskKernelConfig,
  type AgenticTaskRequest,
  type AgenticTaskResult
} from "./AgenticTaskModels.js";
import { buildAgenticReadPlan } from "./AgenticReadPlanner.js";
import { synthesizeAgenticOutput } from "./AgenticOutputSynthesizer.js";
import { readWorkspaceForAgenticPlan } from "./AgenticWorkspaceReader.js";
import { validateAgenticOutput } from "./AgenticClaimValidator.js";
import { invokeReasoningProviderText } from "./ReasoningKernel.js";

export async function runAgenticTaskKernel(request: AgenticTaskRequest): Promise<AgenticTaskResult> {
  const config = mergeAgenticTaskKernelConfig(request.config ?? envAgenticTaskConfig());
  const disabled = !config.agenticTaskKernelEnabled || config.agenticTaskKernelMode === "off";
  const intent = classifyAgenticTaskIntent(request.prompt, request.modeHint);
  const budget = budgetFromConfig(config);
  const initialFiles = request.tools.workspace
    .listFiles(20_000)
    .filter((file) => !file.isDir && !file.isSecretCandidate)
    .map((file) => file.path.replaceAll("\\", "/"));
  const readPlan = buildAgenticReadPlan({ intent, allFiles: initialFiles, budget });
  if (disabled) {
    const emptyDraft: AgenticOutputDraft = {
      format: "markdown",
      text: disabledMessage(intent.language),
      claims: [],
      fallbackReason: "kernel_disabled"
    };
    const finalOutput = validateAgenticOutput({
      draft: emptyDraft,
      intent,
      evidenceGraph: emptyEvidenceGraph(),
      fileExists: request.tools.workspace.fileExists.bind(request.tools.workspace),
      claimValidationRequired: config.agenticTaskClaimValidationRequired
    });
    return {
      request,
      intent,
      readPlan,
      openedFiles: [],
      fileSummaries: [],
      evidenceGraph: emptyEvidenceGraph(),
      mentalModel: {
        relevantComponents: [],
        responsibilities: [],
        relationships: [],
        dataOrControlFlow: [],
        importantFiles: [],
        risks: [],
        unknowns: ["Agentic task kernel is disabled by config."],
        testOrSupportEvidence: [],
        productionEvidence: [],
        rejectedOrDowngradedEvidence: [],
        confidence: "low"
      },
      draft: emptyDraft,
      finalOutput,
      trace: buildTrace({
        intent,
        readPlan,
        openedFiles: [],
        evidenceGraph: emptyEvidenceGraph(),
        relationships: [],
        fallbackReason: "kernel_disabled",
        finalStatus: finalOutput.validationStatus,
        claims: finalOutput.claims,
        providerCalls: [{ kind: "draft", status: "skipped", reason: "kernel_disabled" }]
      })
    };
  }
  const workspaceRead = readWorkspaceForAgenticPlan({
    tools: request.tools,
    prompt: request.prompt,
    plan: readPlan
  });
  const evidenceGraph = buildAgenticEvidenceGraph({
    prompt: request.prompt,
    intent,
    openedFiles: workspaceRead.openedFiles,
    relationships: workspaceRead.relationships,
    fileExists: request.tools.workspace.fileExists.bind(request.tools.workspace),
    maxEvidenceItems: budget.maxEvidenceItems
  });
  const mentalModel = buildAgenticMentalModel({
    fileSummaries: workspaceRead.fileSummaries,
    evidenceGraph
  });
  const providerDraft = config.agenticTaskAllowNaturalDraft
    ? await requestProviderDraft(request, config, intent.mode)
    : { text: undefined, fallbackReason: "none" as AgenticFallbackReason, providerCalls: [{ kind: "draft" as const, status: "skipped" as const, reason: "natural_draft_disabled" }] };
  const draft = synthesizeAgenticOutput({
    prompt: request.prompt,
    intent,
    evidenceGraph,
    mentalModel,
    providerDraft: providerDraft.text,
    providerFallbackReason: providerDraft.fallbackReason
  });
  const finalOutput = validateAgenticOutput({
    draft,
    intent,
    evidenceGraph,
    fileExists: request.tools.workspace.fileExists.bind(request.tools.workspace),
    claimValidationRequired: config.agenticTaskClaimValidationRequired
  });
  const fallbackReason = providerDraft.fallbackReason === "none" && !providerDraft.text
    ? evidenceGraph.accepted.length ? "none" : "insufficient_evidence"
    : providerDraft.fallbackReason;
  return {
    request,
    intent,
    readPlan,
    openedFiles: workspaceRead.openedFiles,
    fileSummaries: workspaceRead.fileSummaries,
    evidenceGraph,
    mentalModel,
    draft,
    finalOutput,
    trace: buildTrace({
      intent,
      readPlan,
      openedFiles: workspaceRead.openedFiles,
      evidenceGraph,
      relationships: workspaceRead.relationships,
      fallbackReason,
      finalStatus: finalOutput.validationStatus,
      claims: finalOutput.claims,
      providerCalls: providerDraft.providerCalls
    })
  };
}

export function shouldUseAgenticKernelForProjectExplain(input: {
  mode: AgenticTaskKernelConfig["agenticTaskKernelMode"];
  projectExplainUseAgenticKernel: boolean;
  prompt: string;
  taskMode: string;
  complexity: "simple" | "complex";
}) {
  if (!input.projectExplainUseAgenticKernel || input.mode === "off") return false;
  if (input.mode === "force") return true;
  if (input.complexity === "complex") return true;
  return ["architecture_explain", "data_flow", "ui_flow", "backend_flow", "design_assessment", "debugging_analysis"].includes(input.taskMode);
}

export function envAgenticTaskConfig(): Partial<AgenticTaskKernelConfig> {
  const base = defaultAgenticTaskKernelConfig();
  return {
    agenticTaskKernelEnabled: boolEnv("HIVO_AGENTIC_TASK_KERNEL_ENABLED", base.agenticTaskKernelEnabled),
    agenticTaskKernelMode: modeEnv("HIVO_AGENTIC_TASK_KERNEL_MODE", base.agenticTaskKernelMode),
    agenticTaskMaxOpenedFiles: intEnv("HIVO_AGENTIC_TASK_MAX_OPENED_FILES", base.agenticTaskMaxOpenedFiles),
    agenticTaskMaxRelationshipDepth: intEnv("HIVO_AGENTIC_TASK_MAX_RELATIONSHIP_DEPTH", base.agenticTaskMaxRelationshipDepth),
    agenticTaskMaxFileChars: intEnv("HIVO_AGENTIC_TASK_MAX_FILE_CHARS", base.agenticTaskMaxFileChars),
    agenticTaskMaxTotalReadChars: intEnv("HIVO_AGENTIC_TASK_MAX_TOTAL_READ_CHARS", base.agenticTaskMaxTotalReadChars),
    agenticTaskMaxEvidenceItems: intEnv("HIVO_AGENTIC_TASK_MAX_EVIDENCE_ITEMS", base.agenticTaskMaxEvidenceItems),
    agenticTaskProviderTimeoutMs: intEnv("HIVO_AGENTIC_TASK_PROVIDER_TIMEOUT_MS", base.agenticTaskProviderTimeoutMs),
    agenticTaskAllowNaturalDraft: boolEnv("HIVO_AGENTIC_TASK_ALLOW_NATURAL_DRAFT", base.agenticTaskAllowNaturalDraft),
    agenticTaskClaimValidationRequired: boolEnv("HIVO_AGENTIC_TASK_CLAIM_VALIDATION_REQUIRED", base.agenticTaskClaimValidationRequired),
    agenticTaskDisableGenericFallbackForComplexQuestions: boolEnv("HIVO_AGENTIC_TASK_DISABLE_GENERIC_FALLBACK_FOR_COMPLEX_QUESTIONS", base.agenticTaskDisableGenericFallbackForComplexQuestions),
    projectExplainUseAgenticKernel: boolEnv("HIVO_PROJECT_EXPLAIN_USE_AGENTIC_KERNEL", base.projectExplainUseAgenticKernel)
  };
}

function budgetFromConfig(config: AgenticTaskKernelConfig): AgenticReadBudget {
  return {
    maxOpenedFiles: config.agenticTaskMaxOpenedFiles,
    maxRelationshipDepth: config.agenticTaskMaxRelationshipDepth,
    maxCharsPerFile: config.agenticTaskMaxFileChars,
    maxTotalChars: config.agenticTaskMaxTotalReadChars,
    maxEvidenceItems: config.agenticTaskMaxEvidenceItems,
    timeoutMs: config.agenticTaskProviderTimeoutMs
  };
}

async function requestProviderDraft(
  request: AgenticTaskRequest,
  config: AgenticTaskKernelConfig,
  mode: string
): Promise<{ text?: string; fallbackReason: AgenticFallbackReason; providerCalls: AgenticReasoningTrace["providerCalls"] }> {
  if (!request.provider) return { fallbackReason: "none", providerCalls: [{ kind: "draft", status: "skipped", reason: "no_provider" }] };
  try {
    const text = await withTimeout(
      invokeReasoningProviderText(request.provider, {
        systemPrompt: [
          "You are a bounded natural-language synthesizer for a universal agentic task kernel.",
          "Use only the evidence summary in context. Do not invent citations or paths.",
          "Keep claims qualified when evidence is incomplete."
        ].join("\n"),
        userPrompt: request.prompt,
        context: { mode }
      }),
      config.agenticTaskProviderTimeoutMs
    );
    return { text, fallbackReason: "none", providerCalls: [{ kind: "draft", status: "success" }] };
  } catch (error) {
    return {
      fallbackReason: isTimeoutError(error) ? "provider_timeout" : "provider_failed",
      providerCalls: [{ kind: "draft", status: isTimeoutError(error) ? "timeout" : "failed", reason: error instanceof Error ? error.message : String(error) }]
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider_timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && /timeout/i.test(error.message);
}

function buildTrace(input: {
  intent: ReturnType<typeof classifyAgenticTaskIntent>;
  readPlan: ReturnType<typeof buildAgenticReadPlan>;
  openedFiles: AgenticTaskResult["openedFiles"];
  evidenceGraph: AgenticTaskResult["evidenceGraph"];
  relationships: AgenticTaskResult["evidenceGraph"]["relationships"];
  fallbackReason: AgenticFallbackReason;
  finalStatus: AgenticTaskResult["finalOutput"]["validationStatus"];
  claims: AgenticTaskResult["finalOutput"]["claims"];
  providerCalls: AgenticReasoningTrace["providerCalls"];
}): AgenticReasoningTrace {
  return {
    taskMode: input.intent.mode,
    detectedIntent: input.intent,
    readPlan: input.readPlan,
    openedFiles: input.openedFiles,
    fileSummaries: input.openedFiles.map((file) => ({
      path: file.path,
      kind: "unknown",
      symbols: [],
      imports: [],
      exports: [],
      routes: [],
      calls: [],
      summary: file.openedBecause.join("; ")
    })),
    relationshipsFollowed: input.relationships,
    evidenceAccepted: input.evidenceGraph.accepted.map((item) => item.id),
    evidenceDowngraded: input.evidenceGraph.downgraded.map((item) => item.id),
    evidenceRejected: input.evidenceGraph.rejected.map((item) => item.id),
    providerCalls: input.providerCalls,
    fallbackReason: input.fallbackReason,
    claimValidationSummary: countClaimStatuses(input.claims),
    finalOutputValidationStatus: input.finalStatus
  };
}

function emptyEvidenceGraph(): AgenticTaskResult["evidenceGraph"] {
  return {
    items: [],
    relationships: [],
    accepted: [],
    downgraded: [],
    rejected: [],
    byPath: {},
    summary: {
      productionEvidenceCount: 0,
      supportEvidenceCount: 0,
      rejectedEvidenceCount: 0,
      confidence: "low"
    }
  };
}

function disabledMessage(language: "arabic" | "english") {
  return language === "arabic"
    ? "\u0643\u064a\u0631\u0646\u0644 \u0627\u0644\u062a\u0641\u0643\u064a\u0631 \u0627\u0644\u0648\u0643\u064a\u0644\u064a \u0645\u062a\u0648\u0642\u0641 \u0645\u0646 \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a."
    : "The agentic task kernel is disabled by configuration.";
}

function countClaimStatuses(claims: AgenticTaskResult["finalOutput"]["claims"]) {
  const statuses = {
    supported: 0,
    partially_supported: 0,
    unsupported: 0,
    contradicted: 0,
    opinion: 0,
    unknown: 0
  };
  for (const claim of claims) statuses[claim.status] += 1;
  return statuses;
}

function boolEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function modeEnv(name: string, fallback: AgenticTaskKernelConfig["agenticTaskKernelMode"]) {
  const value = process.env[name];
  return value === "off" || value === "auto" || value === "force" ? value : fallback;
}
