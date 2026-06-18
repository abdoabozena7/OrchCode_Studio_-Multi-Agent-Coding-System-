import type { EvidenceProvenance, EvidenceTruthReport, GroundedEvidenceItem, ProjectExplainEvidenceRef, ProjectExplainReport, ProjectExplainSection, ProjectUnderstandingAnswer, RejectedEvidenceItem } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { analyzeAlgorithmInventory } from "./AlgorithmInventoryAnalyzer.js";
import { classifyAgenticTaskIntent } from "./AgenticIntentClassifier.js";
import { envAgenticTaskConfig, runAgenticTaskKernel, shouldUseAgenticKernelForProjectExplain } from "./AgenticTaskKernel.js";
import { mergeAgenticTaskKernelConfig, type AgenticTaskIntent, type AgenticTaskKernelConfig, type AgenticTaskResult } from "./AgenticTaskModels.js";
import { analyzeCodeFlow } from "./CodeFlowAnalyzer.js";
import { analyzeFrontendStructure } from "./FrontendStructureAnalyzer.js";
import { composeAnswer } from "./InspectExplainComposer.js";
import type { InspectExplainFacts } from "./InspectExplainFacts.js";
import {
  laneScopedFilesForTopic,
  runInspectExplainReadLanes,
  validateAnswerAgainstReadLaneEvidence,
  type InspectExplainEvidenceReview,
  type InspectExplainLaneSynthesizedGraph,
  type InspectExplainReadLaneArtifact,
  type InspectExplainReadLaneFinding,
  type InspectExplainReadLaneRun
} from "./InspectExplainReadLanes.js";
import { explainProjectWithLlm } from "./LlmProjectExplainer.js";
import {
  buildEvidenceTruthReport,
  canProveImplementation,
  createEvidenceProvenance,
  evidenceItemForReport,
  filterProjectEvidencePaths,
  isProductionEvidence
} from "./EvidenceHygiene.js";
import { analyzeTrainingInference } from "./TrainingInferenceAnalyzer.js";
import { analyzeUIControls } from "./UIControlAnalyzer.js";
import { prepareWorkspacePromptForUnderstanding } from "./IntentDecisionEngine.js";
import {
  extractImplementationEvidence,
  cleanedOutputsFromFlow,
  inferRequestedFacets,
  inferTargetConcept,
  sanitizeSearchQuery,
  synthesizeConceptFlow,
  suppressedEvidenceFromRoles,
  validateAnswerLanguage,
  validateConceptCoverage,
  validateEvidenceDedupe,
  validateOutputCleanup,
  validateRoleClassification,
  type ConceptFlow,
  type CoverageValidation,
  type DedupeValidation,
  type ImplementationEvidence,
  type LanguageValidation,
  type OutputCleanupValidation,
  type RoleClassificationValidation,
  type RequestedQuestionFacet,
  type SourceRole
} from "./ProjectQuestionConceptEngine.js";
import {
  buildProjectIntelligenceGraph,
  resolveInvestigationConcept,
  resolveMechanismChain,
  validateMechanismCoverage,
  type InvestigationConceptResolution,
  type MechanismChain,
  type MechanismCoverageValidation,
  type MechanismEvidence,
  type ProjectIntelligenceGraph,
  type ProjectIntelligenceGraphSummary
} from "./ProjectIntelligenceKernel.js";
import {
  facetsForEvidenceItem,
  inferWorkspaceIntent,
  responseLooksOffIntent,
  type WorkspaceAnswerGoal,
  type WorkspaceEvidenceFacet,
  type WorkspaceEvidenceLike,
  type WorkspaceIntentUnderstanding
} from "./WorkspaceReasoningPipeline.js";
import { projectUnderstandingKernelMode, runProjectUnderstandingKernel } from "./ProjectUnderstandingKernel.js";
import { runReadOnlyUnderstandingEscalation } from "./ProjectUnderstandingEscalation.js";

export type UniversalInspectTopic =
  | "frontend"
  | "algorithms"
  | "training_inference"
  | "code_flow"
  | "ui_controls"
  | "general";

export type ProjectQuestionUnderstanding = {
  actionMode: WorkspaceIntentUnderstanding["actionMode"];
  answerGoal: WorkspaceAnswerGoal | "yes_no";
  topicPhrase: string;
  targetConcept: string;
  questionScope: "concept" | "pipeline" | "inventory" | "location" | "comparison" | "general";
  requestedFacets: RequestedQuestionFacet[];
  topicTerms: string[];
  normalizedTerms: string[];
  entities: string[];
  language: WorkspaceIntentUnderstanding["language"];
  requiredFacets: WorkspaceEvidenceFacet[];
  expectedAnswerShape: "count" | "list" | "flow" | "locate" | "compare" | "yes_no" | "summary";
  detailLevel: "brief" | "normal" | "detailed" | "deep";
  wantsCodeExamples: boolean;
  wantsComparisons: boolean;
  wantsJudgment: boolean;
};

export type ProjectQuestionSearchQuery = {
  query: string;
  source: "entity" | "topic_term" | "alias" | "facet" | "path";
  iteration: number;
};

export type ProjectQuestionSearchIteration = {
  iteration: number;
  queries: string[];
  matches: number;
  candidateFiles: string[];
};

export type ProjectQuestionEvidence = WorkspaceEvidenceLike & {
  query: string;
  querySource: ProjectQuestionSearchQuery["source"] | "structured";
  confidence: "high" | "medium" | "low";
  sourceRole: SourceRole;
  provenance?: EvidenceProvenance;
};

export type ConceptResolutionStatus =
  | "direct_found"
  | "alias_found"
  | "behavioral_found"
  | "architectural_pattern_found"
  | "not_found";

export type ConceptEvidenceBuckets = {
  directTargetEvidence: ProjectQuestionEvidence[];
  aliasTargetEvidence: ProjectQuestionEvidence[];
  behavioralTargetEvidence: ProjectQuestionEvidence[];
  architecturalPatternEvidence: ProjectQuestionEvidence[];
  generalProjectEvidence: ProjectQuestionEvidence[];
  noiseEvidence: ProjectQuestionEvidence[];
};

export type ConceptResolution = ConceptEvidenceBuckets & {
  targetConcept: string;
  resolvedName?: string;
  inferredPatternName?: string;
  labelsOrModifiers: string[];
  secondaryConcepts: string[];
  literalTerms: string[];
  aliasTerms: string[];
  behavioralTerms: string[];
  architecturalTerms: string[];
  resolutionStatus: ConceptResolutionStatus;
  confidence: "high" | "medium" | "low";
  targetEvidenceRefs: string[];
  rejectedGeneralEvidence: ProjectQuestionEvidence[];
  userVisibleNegativeEvidence: string[];
};

export type TargetEvidenceValidation = {
  valid: boolean;
  errors: string[];
};

export type MechanismEvidenceBuckets = {
  directMechanismEvidence: MechanismEvidence[];
  uiEvidence: MechanismEvidence[];
  apiLinkEvidence: MechanismEvidence[];
  backendHandlerEvidence: MechanismEvidence[];
  storageEvidence: MechanismEvidence[];
  testEndpointExpectations: MechanismEvidence[];
  targetScopedStorageEvidence: MechanismEvidence[];
  generalStorageEvidence: MechanismEvidence[];
  rejectedMechanismEvidence: MechanismEvidence[];
  downstreamConsumerEvidence: MechanismEvidence[];
  statusOnlyEvidence: MechanismEvidence[];
  contextOnlyEvidence: MechanismEvidence[];
};

export type ProjectQuestionEvidencePack = {
  question: string;
  intent: WorkspaceIntentUnderstanding;
  topic: UniversalInspectTopic;
  questionUnderstanding: ProjectQuestionUnderstanding;
  queryPlan: ProjectQuestionSearchQuery[];
  searchIterations: ProjectQuestionSearchIteration[];
  candidateFiles: string[];
  openedFiles: string[];
  positiveEvidence: ProjectQuestionEvidence[];
  negativeEvidence: string[];
  suppressedNegativeQueries: string[];
  conceptResolution: ConceptResolution;
  evidenceBuckets: ConceptEvidenceBuckets;
  targetEvidenceValidation: TargetEvidenceValidation;
  literalSearch: string[];
  aliasSearch: string[];
  behavioralSearch: string[];
  architecturalPatternSearch: string[];
  rejectedGeneralEvidence: ProjectQuestionEvidence[];
  userVisibleNegativeEvidence: string[];
  projectIntelligenceGraphSummary: ProjectIntelligenceGraphSummary;
  mechanismChain: MechanismChain;
  mechanismEvidence: MechanismEvidenceBuckets;
  mechanismCoverageValidation: MechanismCoverageValidation;
  statusOnlyEvidence: MechanismEvidence[];
  contextOnlyEvidence: MechanismEvidence[];
  testEndpointExpectations: MechanismEvidence[];
  targetScopedStorageEvidence: MechanismEvidence[];
  generalStorageEvidence: MechanismEvidence[];
  mechanismExpansionTrace: string[];
  rejectedMechanismEvidence: MechanismEvidence[];
  missingMechanismLinks: string[];
  graphExpansionTrace: string[];
  implementationEvidence: ImplementationEvidence[];
  evidenceGroups: DedupeValidation["groups"];
  canonicalActions: string[];
  artifactPreparationEvidence: ImplementationEvidence[];
  evidenceRoles: Record<SourceRole, number>;
  semanticEvidenceRoles: Record<SourceRole, number>;
  suppressedEvidence: ReturnType<typeof suppressedEvidenceFromRoles>;
  conceptFlow: ConceptFlow;
  coverageValidation: CoverageValidation;
  roleClassificationValidation: RoleClassificationValidation;
  languageValidation: LanguageValidation;
  dedupeValidation: DedupeValidation;
  outputCleanupValidation: OutputCleanupValidation;
  cleanedOutputs: string[];
  structuredFacts: InspectExplainFacts;
  confidence: "high" | "medium" | "low";
  answerShapeValidation: AnswerShapeValidation;
  validationErrors: string[];
  fallbackUsed: boolean;
  fallbackReason?: string;
  evidenceReport: EvidenceTruthReport;
  investigationConceptResolution: InvestigationConceptResolution;
  projectIntelligenceGraph: ProjectIntelligenceGraph;
  evidenceTiers: ConceptEvidenceBuckets;
  readLaneRun: InspectExplainReadLaneRun;
  readLaneArtifacts: InspectExplainReadLaneArtifact[];
  laneSynthesizedGraph: InspectExplainLaneSynthesizedGraph;
  evidenceReview: InspectExplainEvidenceReview;
  agenticTask?: AgenticProjectExplainDebug;
  projectUnderstanding?: ProjectUnderstandingAnswer;
};

export type AgenticProjectExplainDebug = {
  enabled: boolean;
  usedForFinalAnswer: boolean;
  mode: AgenticTaskResult["intent"]["mode"];
  intent: AgenticTaskResult["intent"];
  readPlan: AgenticTaskResult["readPlan"];
  openedFiles: string[];
  relationshipsFollowed: AgenticTaskResult["evidenceGraph"]["relationships"];
  evidenceAccepted: string[];
  evidenceDowngraded: string[];
  evidenceRejected: string[];
  fallbackReason: AgenticTaskResult["trace"]["fallbackReason"];
  claimValidationSummary: AgenticTaskResult["trace"]["claimValidationSummary"];
  finalOutputValidationStatus: AgenticTaskResult["finalOutput"]["validationStatus"];
};

export type AnswerShapeValidation = {
  valid: boolean;
  errors: string[];
  tooShallow: boolean;
  charCount: number;
  sectionCount: number;
  citationCount: number;
  codeFenceCount: number;
  minCharCount: number;
  minSectionCount: number;
  repairedFrom?: string[];
};

export type UniversalProjectQuestionResult = ProjectQuestionEvidencePack & {
  answerMarkdown: string;
  evidenceRefs: string[];
  usedEvidenceRefs: string[];
  unsupportedOrUnclearParts: string[];
  revisionCount: number;
  validationWarnings: string[];
  grounding: Awaited<ReturnType<typeof explainProjectWithLlm>>["grounding"];
  augmentedReport: ProjectExplainReport;
  answerStrategy: ProjectAnswerStrategy;
};

export type ProjectAnswerStrategyName =
  | "provider_final"
  | "provider_revision_final";

export type ProjectAnswerStrategy = {
  strategy: ProjectAnswerStrategyName;
  finalAnswerSource: "provider";
  providerDraftStatus: "accepted_first" | "accepted_revision";
  fallbackUsed: false;
  reason?: string;
};

const SEARCH_LIMITS = {
  maxIterations: 3,
  maxCandidateFiles: 80,
  maxOpenedFiles: 24,
  maxSnippetsPerFile: 8,
  maxReadChars: 300_000,
  maxEvidenceItems: 120
};

const TEXT_FILE_RE = /\.(c|cc|conf|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/i;
const SOURCE_FILE_RE = /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|py|rs|ts|tsx)$/i;
const IGNORED_PATH_RE = /(^|\/)(\.agent_memory|\.cache|\.git|\.hivo-agent-runtime|\.next|\.nuxt|\.orchcode-agent-runtime|\.pytest_cache|\.ruff_cache|\.svelte-kit|\.tmp-run|\.turbo|\.venv|\.vite|__pycache__|build|coverage|dist|env|node_modules|out|output|outputs|playwright-report|site-packages|target|test-results|venv)(\/|$)/i;

const COMMON_STOP_WORDS = new Set([
  "about", "after", "all", "and", "answer", "are", "code", "current", "does", "each",
  "describe", "explain", "file", "files", "find", "for", "from", "full", "have", "here", "how", "inside",
  "is", "list", "many", "me", "of", "project", "show", "system", "that", "the",
  "this", "tell", "summarize", "what", "where", "which", "with", "work", "works"
]);

const FACET_ALIASES: Record<WorkspaceEvidenceFacet, string[]> = {
  ui_structure: [
    "VIEWS", "PAGES", "ROUTES", "TABS", "CHAPTERS", "data-view", "data-page",
    "<Route", "<nav", "<section", "href=", "BrowserRouter", "createBrowserRouter"
  ],
  code_symbols: [
    "function", "class", "interface", "type", "def ", "export ", "import ",
    "router", "endpoint", "service", "controller"
  ],
  algorithms_models: [
    "algorithm", "model", "classifier", "cluster", "clustering", "forecast",
    "SVM", "SVC", "fit(", "predict(", "fit_predict", "sklearn", "statsmodels", "shap"
  ],
  numeric_logic: [
    "threshold", "cutoff", "score", "weight", "condition", "formula", ">=", "<=", "=="
  ],
  data_flow: [
    "dataset", "records", "csv", "fetch", "api/", "pipeline", "storage", "load",
    "save", "stream", "poll", "socket", "input", "output"
  ],
  tests_docs: [
    "test(", "describe(", ".test.", ".spec.", "README", "docs"
  ]
};

const TRAINING_INFERENCE_ALIASES = [
  "train", "training", "fit(", "fit_predict", "joblib.dump", "pickle.dump",
  "predict", "prediction", "inference", "joblib.load", "pickle.load", "/train", "/predict"
];

const INTERNAL_SEARCH_TERMS = new Set([
  "function", "class", "interface", "type", "def", "export", "import", "router", "endpoint", "service", "controller"
]);

const ARCHITECTURAL_PATTERN_TERMS = [
  "orchestrator", "orchestration", "outer loop", "outer_loop", "loop", "cycle",
  "agent", "scheduler", "feedback", "retry", "retrain", "decision", "planner",
  "executor", "pipeline", "state machine", "run loop", "control loop"
];

const CONCEPT_RESOLUTION_ALIASES: Record<string, string[]> = {
  dbscan: ["dbscan", "DBSCAN", "density-based", "density based", "fit_predict"],
  fcm: ["fcm", "FCM", "fuzzy c", "fuzzy c-means", "cmeans", "skfuzzy"],
  svm: ["svm", "SVM", "svc", "SVC", "linearsvc", "support vector"],
  shap: ["shap", "SHAP", "KernelExplainer", "shap_values"],
  sarima: ["sarima", "SARIMA", "sarimax", "SARIMAX", "arima", "ARIMA"],
  outerloop: ["outerloop", "outer_loop", "outer loop", "outer-loop", "control loop", "agent loop", "planning loop", "feedback loop"]
};

export async function answerUniversalProjectQuestion(input: {
  provider: LlmProvider;
  tools: ToolRegistry;
  userPrompt: string;
  explainReport: ProjectExplainReport;
  intent?: WorkspaceIntentUnderstanding;
  embeddingModel?: string;
}): Promise<UniversalProjectQuestionResult> {
  const preparedPrompt = prepareWorkspacePromptForUnderstanding(input.userPrompt);
  const understandingPrompt = preparedPrompt.workspaceMessage || input.userPrompt;
  const intent = input.intent ?? inferWorkspaceIntent(input.userPrompt);
  const topic = inferUniversalInspectTopic(understandingPrompt, intent);
  const agenticConfig = mergeAgenticTaskKernelConfig({
    ...envAgenticTaskConfig(),
    agenticTaskAllowNaturalDraft: false
  });
  const agenticIntent = classifyAgenticTaskIntent(understandingPrompt);
  const agenticKernelEnabledForQuestion = shouldUseAgenticKernelForProjectExplain({
    mode: agenticConfig.agenticTaskKernelMode,
    projectExplainUseAgenticKernel: agenticConfig.projectExplainUseAgenticKernel,
    prompt: understandingPrompt,
    taskMode: agenticIntent.mode,
    complexity: agenticIntent.complexity
  });
  const agenticKernelResult = agenticKernelEnabledForQuestion
    ? await runAgenticTaskKernel({
      adapterId: "project_explain",
      prompt: understandingPrompt,
      workspacePath: input.tools.getWorkspacePath(),
      modeHint: agenticIntent.mode,
      provider: input.provider,
      tools: input.tools,
      config: agenticConfig
    })
    : undefined;
  const understandingKernelMode = projectUnderstandingKernelMode();
  const projectUnderstanding = agenticIntent.complexity === "complex" && understandingKernelMode !== "off"
    ? await runProjectUnderstandingKernel({
      question: understandingPrompt,
      provider: input.provider,
      tools: input.tools,
      embeddingModel: input.embeddingModel,
      mode: understandingKernelMode,
      escalate: understandingKernelMode === "on"
        ? async (question, missingFacts, budget) => {
          return runReadOnlyUnderstandingEscalation({
            workspacePath: input.tools.getWorkspacePath(),
            provider: input.provider,
            question,
            missingFacts,
            budget
          });
        }
        : undefined
    })
    : undefined;
  const allFiles = input.tools.workspace
    .listFiles(10_000)
    .filter((file) => !file.isDir && !file.isSecretCandidate)
    .map((file) => file.path)
    .filter(isSearchablePath);
  const evidenceScope = filterProjectEvidencePaths(allFiles, understandingPrompt);
  const projectSourceFiles = evidenceScope.included;
  const investigationConceptResolution = resolveInvestigationConcept(understandingPrompt);
  const questionUnderstanding = applyInvestigationConceptResolution(
    createQuestionUnderstanding(understandingPrompt, intent, topic),
    investigationConceptResolution,
    understandingPrompt
  );
  const readLaneRun = runInspectExplainReadLanes({
    userPrompt: understandingPrompt,
    targetConcept: questionUnderstanding.targetConcept,
    topic,
    intent,
    filePaths: projectSourceFiles,
    readFile: (relativePath) => input.tools.workspace.readWholeFile(relativePath)
  });
  const laneScopedFiles = laneScopedFilesForTopic(readLaneRun, topic, projectSourceFiles);
  const structuredFacts = collectStructuredFacts(input.tools, laneScopedFiles, topic, questionUnderstanding.targetConcept);
  const queryPlan = createSearchPlan(questionUnderstanding, topic);
  const search = collectLocalEvidence(input.tools, projectSourceFiles, queryPlan, intent);
  const structuredEvidence = proveEvidenceItems(structuredFactsToEvidence(structuredFacts), understandingPrompt, input.tools.workspace.fileExists.bind(input.tools.workspace));
  const readLaneEvidence = proveEvidenceItems(readLaneFindingsToEvidence(readLaneRun.artifacts), understandingPrompt, input.tools.workspace.fileExists.bind(input.tools.workspace));
  const searchEvidence = proveEvidenceItems(search.positiveEvidence, understandingPrompt, input.tools.workspace.fileExists.bind(input.tools.workspace));
  const projectIntelligenceGraph = filterSelfReferentialProjectIntelligenceGraph(buildProjectIntelligenceGraph({
    targetConcept: questionUnderstanding.targetConcept,
    filePaths: laneScopedFiles,
    readFile: (relativePath) => input.tools.workspace.readWholeFile(relativePath)
  }), questionUnderstanding);
  const mechanismChain = mergeReadLaneGraphIntoMechanismChain(
    resolveMechanismChain(projectIntelligenceGraph, questionUnderstanding.targetConcept),
    readLaneRun
  );
  const mechanismEvidence = bucketMechanismEvidence(projectIntelligenceGraph.evidence);
  const allCollectedEvidence = uniqueEvidence([
    ...searchEvidence,
    ...structuredEvidence,
    ...readLaneEvidence
  ]).slice(0, SEARCH_LIMITS.maxEvidenceItems);
  const implementationEvidence = extractImplementationEvidence({
    workspace: input.tools.workspace,
    filePaths: laneScopedFiles,
    targetConcept: questionUnderstanding.targetConcept,
    requestedFacets: questionUnderstanding.requestedFacets,
    positiveEvidence: allCollectedEvidence
  });
  const conceptFlow = synthesizeConceptFlow({
    targetConcept: questionUnderstanding.targetConcept,
    requestedFacets: questionUnderstanding.requestedFacets,
    implementationEvidence
  });
  const conceptResolution = resolveConceptEvidence({
    questionUnderstanding,
    topic,
    queryPlan,
    localEvidence: allCollectedEvidence,
    structuredEvidence: [],
    mechanismEvidence: projectIntelligenceGraph.evidence,
    investigationConceptResolution,
    implementationEvidence,
    conceptFlow,
    negativeEvidence: search.negativeEvidence,
    prompt: understandingPrompt,
    fileExists: input.tools.workspace.fileExists.bind(input.tools.workspace)
  });
  const evidenceBuckets: ConceptEvidenceBuckets = {
    directTargetEvidence: conceptResolution.directTargetEvidence,
    aliasTargetEvidence: conceptResolution.aliasTargetEvidence,
    behavioralTargetEvidence: conceptResolution.behavioralTargetEvidence,
    architecturalPatternEvidence: conceptResolution.architecturalPatternEvidence,
    generalProjectEvidence: conceptResolution.generalProjectEvidence,
    noiseEvidence: conceptResolution.noiseEvidence
  };
  const positiveEvidence = evidenceForAnswer({
    allCollectedEvidence,
    conceptResolution,
    questionUnderstanding,
    topic
  });
  const dedupeValidation = validateEvidenceDedupe(implementationEvidence);
  const outputCleanupValidation = validateOutputCleanup(conceptFlow);
  const suppressedEvidence = suppressedEvidenceFromRoles(implementationEvidence);
  const artifactPreparationEvidence = implementationEvidence.filter((item) => item.semanticRole === "artifact_preparation");
  const canonicalActions = uniqueStrings(implementationEvidence.map((item) => item.canonicalAction));
  const roleClassificationValidation = isDecisionPolicyQuestion(understandingPrompt, questionUnderstanding)
    ? {
        valid: true,
        errors: [],
        implementationRefs: implementationEvidence.filter((item) => item.semanticRole === "implementation").map((item) => item.ref),
        suppressedRefs: suppressedEvidenceFromRoles(implementationEvidence).map((item) => item.ref)
      }
    : validateRoleClassification({
        conceptFlow,
        implementationEvidence,
        targetConcept: questionUnderstanding.targetConcept
      });
  const cleanedOutputs = cleanedOutputsFromFlow(conceptFlow);
  const confidence = positiveEvidence.length >= 3 || structuredFactsHaveEvidence(topic, structuredFacts)
    ? "high"
    : positiveEvidence.length
      ? "medium"
      : "low";
  const augmentedReport = augmentReportWithAgenticUnderstanding(
    augmentExplainReport(input.explainReport, positiveEvidence, questionUnderstanding),
    agenticKernelResult
  );
  const explainResult = await explainProjectWithLlm({
    provider: input.provider,
    userPrompt: understandingPrompt,
    report: augmentedReport,
    providerAnswerMode: "natural_text"
  });

  let answerMarkdown = explainResult.answerMarkdown;
  let evidenceRefs = uniqueStrings([
    ...explainResult.usedEvidenceRefs,
    ...positiveEvidence.slice(0, 20).map((item) => item.ref)
  ]);
  const validationErrors = [
    ...explainResult.unsupportedOrUnclearParts
  ];
  let fallbackUsed = false;
  let fallbackReason: string | undefined;
  let agenticUsedForFinalAnswer = false;
  let answerShapeValidation = validateAnswer({
    question: understandingPrompt,
    answerMarkdown,
    intent,
    questionUnderstanding,
    topic,
    positiveEvidence,
    structuredFacts,
    implementationEvidence,
    conceptFlow,
    conceptResolution
  });
  let coverageValidation = validateConceptCoverage({
    answerMarkdown,
    targetConcept: questionUnderstanding.targetConcept,
    requestedFacets: questionUnderstanding.requestedFacets,
    implementationEvidence,
    conceptFlow
  });
  let languageValidation = validateAnswerLanguage({
    answerMarkdown,
    expected: intent.language
  });
  let targetEvidenceValidation = validateTargetEvidence({
    answerMarkdown,
    questionUnderstanding,
    conceptResolution,
    conceptFlow
  });
  let mechanismCoverageValidation = validateMechanismCoverage({
    targetConcept: questionUnderstanding.targetConcept,
    mechanismChain,
    graph: projectIntelligenceGraph,
    answerMarkdown
  });
  let readLaneAnswerValidation = validateAnswerAgainstReadLaneEvidence({
    answerMarkdown,
    targetConcept: questionUnderstanding.targetConcept,
    readLaneRun
  });
  validationErrors.push(...coverageValidation.errors);
  validationErrors.push(...roleClassificationValidation.errors, ...languageValidation.errors, ...dedupeValidation.errors, ...outputCleanupValidation.errors);
  validationErrors.push(...answerShapeValidation.errors, ...targetEvidenceValidation.errors, ...mechanismCoverageValidation.errors, ...readLaneAnswerValidation.errors);
  validationErrors.push(...detectStaleCannedOuterloopAnswer(answerMarkdown, questionUnderstanding));

  if (validationErrors.length) {
    throw new Error(`provider_answer_failed_local_validation_after_repair: ${uniqueStrings(validationErrors).slice(0, 8).join("; ")}`);
  }

  const finalCitationGuard = guardFinalAnswerCitations({
    answerMarkdown,
    evidenceRefs,
    prompt: understandingPrompt,
    language: intent.language,
    fileExists: input.tools.workspace.fileExists.bind(input.tools.workspace)
  });
  answerMarkdown = finalCitationGuard.answerMarkdown;
  evidenceRefs = finalCitationGuard.evidenceRefs;
  if (projectUnderstanding?.mode === "on") {
    answerMarkdown = projectUnderstanding.finalAnswerMarkdown;
    evidenceRefs = projectUnderstanding.evidenceRefs;
    fallbackUsed = projectUnderstanding.decision !== "ANSWER";
    fallbackReason = projectUnderstanding.decisionReason;
    agenticUsedForFinalAnswer = projectUnderstanding.decision === "ANSWER";
    validationErrors.splice(
      0,
      validationErrors.length,
      ...projectUnderstanding.claimLedger.claims
        .filter((claim) => claim.material && claim.status !== "supported")
        .map((claim) => `Unsupported project-understanding claim: ${claim.text}`)
    );
  }

  const openedFiles = uniqueStrings([
    ...positiveEvidence.map((item) => item.path),
    ...search.openedFiles,
    ...structuredFacts.inspectedFiles,
    ...readLaneRun.artifacts.flatMap((artifact) => artifact.inspectedFiles)
  ]).slice(0, SEARCH_LIMITS.maxOpenedFiles);
  const candidateFiles = uniqueStrings([
    ...search.candidateFiles,
    ...positiveEvidence.map((item) => item.path),
    ...laneScopedFiles
  ]).slice(0, SEARCH_LIMITS.maxCandidateFiles);
  const provenanceReport = evidenceProvenanceReport(uniqueEvidence([
    ...allCollectedEvidence,
    ...positiveEvidence
  ]));
  const evidenceReport = buildEvidenceTruthReport({
    prompt: understandingPrompt,
    excluded: evidenceScope.excluded,
    candidateFiles,
    openedFiles,
    finalEvidenceRefs: evidenceRefs,
    groundedEvidence: provenanceReport.groundedEvidence,
    rejectedEvidence: provenanceReport.rejectedEvidence
  });

  return {
    question: input.userPrompt,
    intent,
    topic,
    questionUnderstanding,
    queryPlan,
    searchIterations: search.searchIterations,
    candidateFiles,
    openedFiles,
    positiveEvidence,
    negativeEvidence: conceptResolution.userVisibleNegativeEvidence,
    suppressedNegativeQueries: search.suppressedNegativeQueries,
    conceptResolution,
    evidenceBuckets,
    targetEvidenceValidation,
    literalSearch: conceptResolution.literalTerms,
    aliasSearch: conceptResolution.aliasTerms,
    behavioralSearch: conceptResolution.behavioralTerms,
    architecturalPatternSearch: conceptResolution.architecturalTerms,
    rejectedGeneralEvidence: conceptResolution.rejectedGeneralEvidence,
    userVisibleNegativeEvidence: conceptResolution.userVisibleNegativeEvidence,
    projectIntelligenceGraphSummary: projectIntelligenceGraph.summary,
    mechanismChain,
    mechanismEvidence,
    mechanismCoverageValidation,
    statusOnlyEvidence: mechanismEvidence.statusOnlyEvidence,
    contextOnlyEvidence: mechanismEvidence.contextOnlyEvidence,
    testEndpointExpectations: mechanismEvidence.testEndpointExpectations,
    targetScopedStorageEvidence: mechanismEvidence.targetScopedStorageEvidence,
    generalStorageEvidence: mechanismEvidence.generalStorageEvidence,
    mechanismExpansionTrace: projectIntelligenceGraph.mechanismExpansionTrace,
    rejectedMechanismEvidence: mechanismEvidence.rejectedMechanismEvidence,
    missingMechanismLinks: mechanismChain.missingLinks,
    graphExpansionTrace: projectIntelligenceGraph.graphExpansionTrace,
    implementationEvidence,
    evidenceGroups: dedupeValidation.groups,
    canonicalActions,
    artifactPreparationEvidence,
    evidenceRoles: countEvidenceRoles(implementationEvidence, positiveEvidence),
    semanticEvidenceRoles: countEvidenceRoles(implementationEvidence, positiveEvidence),
    suppressedEvidence,
    conceptFlow,
    coverageValidation,
    roleClassificationValidation,
    languageValidation,
    dedupeValidation,
    outputCleanupValidation,
    cleanedOutputs,
    structuredFacts,
    confidence,
    answerShapeValidation,
    validationErrors: uniqueStrings(validationErrors),
    fallbackUsed,
    fallbackReason,
    evidenceReport,
    investigationConceptResolution: {
      ...investigationConceptResolution,
      resolutionStatus: conceptResolution.resolutionStatus,
      confidence: conceptResolution.confidence
    },
    projectIntelligenceGraph,
    evidenceTiers: evidenceBuckets,
    readLaneRun,
    readLaneArtifacts: readLaneRun.artifacts,
    laneSynthesizedGraph: readLaneRun.synthesizedGraph,
    evidenceReview: readLaneRun.evidenceReview,
    agenticTask: agenticKernelResult
      ? createAgenticDebug(agenticKernelResult, agenticUsedForFinalAnswer)
      : createDisabledAgenticDebug(agenticIntent, agenticConfig),
    projectUnderstanding,
    answerMarkdown,
    evidenceRefs,
    usedEvidenceRefs: evidenceRefs,
    unsupportedOrUnclearParts: uniqueStrings(validationErrors),
    revisionCount: explainResult.revisionCount,
    validationWarnings: uniqueStrings([...explainResult.validationWarnings, ...conceptResolution.userVisibleNegativeEvidence, ...finalCitationGuard.warnings]),
    grounding: explainResult.grounding,
    augmentedReport,
    answerStrategy: createProjectAnswerStrategy(explainResult)
  };
}

function createProjectAnswerStrategy(explainResult: Awaited<ReturnType<typeof explainProjectWithLlm>>): ProjectAnswerStrategy {
  return {
    strategy: explainResult.revisionCount > 0 ? "provider_revision_final" : "provider_final",
    finalAnswerSource: "provider",
    providerDraftStatus: explainResult.revisionCount > 0 ? "accepted_revision" : "accepted_first",
    fallbackUsed: false
  };
}

function createAgenticDebug(result: AgenticTaskResult, usedForFinalAnswer: boolean): AgenticProjectExplainDebug {
  return {
    enabled: true,
    usedForFinalAnswer,
    mode: result.intent.mode,
    intent: result.intent,
    readPlan: result.readPlan,
    openedFiles: result.openedFiles.map((file) => file.path),
    relationshipsFollowed: result.evidenceGraph.relationships,
    evidenceAccepted: result.evidenceGraph.accepted.map((item) => item.id),
    evidenceDowngraded: result.evidenceGraph.downgraded.map((item) => item.id),
    evidenceRejected: result.evidenceGraph.rejected.map((item) => item.id),
    fallbackReason: result.trace.fallbackReason,
    claimValidationSummary: result.trace.claimValidationSummary,
    finalOutputValidationStatus: result.finalOutput.validationStatus
  };
}

function createDisabledAgenticDebug(intent: AgenticTaskIntent, config: AgenticTaskKernelConfig): AgenticProjectExplainDebug {
  return {
    enabled: false,
    usedForFinalAnswer: false,
    mode: intent.mode,
    intent,
    readPlan: {
      mode: intent.mode,
      strategy: "kernel_not_selected",
      budget: {
        maxOpenedFiles: config.agenticTaskMaxOpenedFiles,
        maxRelationshipDepth: config.agenticTaskMaxRelationshipDepth,
        maxCharsPerFile: config.agenticTaskMaxFileChars,
        maxTotalChars: config.agenticTaskMaxTotalReadChars,
        maxEvidenceItems: config.agenticTaskMaxEvidenceItems,
        timeoutMs: config.agenticTaskProviderTimeoutMs
      },
      steps: []
    },
    openedFiles: [],
    relationshipsFollowed: [],
    evidenceAccepted: [],
    evidenceDowngraded: [],
    evidenceRejected: [],
    fallbackReason: "none",
    claimValidationSummary: {
      supported: 0,
      partially_supported: 0,
      unsupported: 0,
      contradicted: 0,
      opinion: 0,
      unknown: 0
    },
    finalOutputValidationStatus: "valid"
  };
}

function inferUniversalInspectTopic(
  message: string,
  intent: WorkspaceIntentUnderstanding
): UniversalInspectTopic {
  const normalized = message.toLowerCase();
  if (/\b(ui controls|buttons?|actions?|clicks?|inputs?)\b/i.test(message) || /[\u0600-\u06ff]*(?:زر|ازرار|أزرار|اكشن|أكشن|تحكم)[\u0600-\u06ff]*/.test(message)) {
    return "ui_controls";
  }
  if (/\b(training|inference|train|predict|separation)\b/i.test(message) || /(?:تدريب|استدلال|تنبؤ|منفصل)/.test(message)) {
    return "training_inference";
  }
  if ((intent.answerGoal === "trace_flow" || looksLikeFlowQuestion(message)) && intent.requiredFacets.includes("algorithms_models")) {
    return "code_flow";
  }
  if (intent.requiredFacets.includes("ui_structure")) return "frontend";
  if (intent.requiredFacets.includes("algorithms_models")) return "algorithms";
  if (intent.answerGoal === "trace_flow" || /\b(flow|trace|how does it work|how is)\b/i.test(message) || /(?:ازاي|إزاي|كيف|بيتطبق|تسلسل)/.test(normalized)) {
    return "code_flow";
  }
  return "general";
}

function createQuestionUnderstanding(
  question: string,
  intent: WorkspaceIntentUnderstanding,
  topic: UniversalInspectTopic
): ProjectQuestionUnderstanding {
  const entities = extractEntities(question);
  const rawTerms = uniqueStrings([
    ...intent.topicTerms,
    ...tokenizeQuestion(question),
    ...entities
  ]).filter((term) => !COMMON_STOP_WORDS.has(term.toLowerCase()));
  const normalizedTerms = uniqueStrings([
    ...rawTerms.map(normalizeTerm),
    ...intent.requiredFacets.flatMap((facet) => FACET_ALIASES[facet]),
    ...(topic === "training_inference" ? TRAINING_INFERENCE_ALIASES : [])
  ].filter(Boolean)).slice(0, 40);
  const targetConcept = inferTargetConcept({
    question,
    topicPhrase: intent.topicPhrase,
    topicTerms: rawTerms,
    entities
  });
  const detailLevel = inferDetailLevel(question, intent);
  const wantsCode = wantsCodeExamples(question);
  const expectedShape = expectedAnswerShape(question, intent);
  return {
    actionMode: intent.actionMode,
    answerGoal: isYesNoQuestion(question) ? "yes_no" : intent.answerGoal,
    topicPhrase: intent.topicPhrase,
    targetConcept,
    questionScope: questionScope(question, intent, topic),
    requestedFacets: inferRequestedFacets(question, {
      expectedAnswerShape: expectedShape,
      detailLevel,
      wantsCodeExamples: wantsCode
    }),
    topicTerms: rawTerms.slice(0, 20),
    normalizedTerms,
    entities,
    language: intent.language,
    requiredFacets: intent.requiredFacets,
    expectedAnswerShape: expectedShape,
    detailLevel,
    wantsCodeExamples: wantsCode,
    wantsComparisons: wantsComparisons(question),
    wantsJudgment: wantsLogicJudgment(question)
  };
}

function applyInvestigationConceptResolution(
  understanding: ProjectQuestionUnderstanding,
  resolution: InvestigationConceptResolution,
  question: string
): ProjectQuestionUnderstanding {
  if (isStructuralFileContextQuestion(question)) return understanding;
  if (!resolution.isTargeted || !resolution.targetConcept || resolution.targetConcept === "general") return understanding;
  if (resolution.resolutionStatus === "not_found" && isStructuralResolutionTarget(resolution.targetConcept)) return understanding;
  return {
    ...understanding,
    targetConcept: resolution.targetConcept,
    topicPhrase: resolution.requestedConceptText || understanding.topicPhrase,
    questionScope: resolution.targetConcept.includes("loop") || resolution.targetConcept === "feedback"
      ? "concept"
      : understanding.questionScope,
    normalizedTerms: uniqueStrings([
      ...understanding.normalizedTerms,
      ...resolution.literalTerms,
      ...resolution.aliasTerms,
      ...resolution.behavioralTerms,
      ...resolution.architecturalTerms
    ]).slice(0, 80),
    topicTerms: uniqueStrings([
      ...understanding.topicTerms,
      resolution.requestedConceptText,
      resolution.targetConcept,
      ...resolution.labelsOrModifiers
    ]).filter(Boolean).slice(0, 30),
    entities: uniqueStrings([
      ...understanding.entities,
      ...resolution.userIntentEntities,
      ...(resolution.resolvedName ? [resolution.resolvedName] : []),
      ...(resolution.inferredPatternName ? [resolution.inferredPatternName] : [])
    ]).slice(0, 30),
    requestedFacets: uniqueStrings([
      ...understanding.requestedFacets,
      ...(resolution.targetConcept === "feedback" || resolution.targetConcept.includes("loop") ? ["downstream_usage", "output", "uncertainty"] as RequestedQuestionFacet[] : [])
    ]) as RequestedQuestionFacet[]
  };
}

function isStructuralFileContextQuestion(question: string) {
  return isEntrypointInventoryQuestion(question) || isSourceFlowFileQuestion(question);
}

function isEntrypointInventoryQuestion(question: string) {
  const normalized = normalizeTerm(question);
  return /\b(?:main\s+)?entry\s*points?\b|\bentrypoints?\b|\bentry\s+files?\b/.test(normalized)
    || /\bwhat\s+are\s+the\s+main\s+files\b/.test(normalized)
    || /\buse\s+the\s+detected\s+candidates\b/.test(normalized) && /\bmain\b|\bentry\b|\bbackend\s+main\b|\bapp\s+js\b|\bapp\s+ts\b|\bapp\s+tsx\b|\bapp\s+jsx\b/.test(normalized);
}

function isSourceFlowFileQuestion(question: string) {
  const normalized = normalizeTerm(question);
  return /\bdetected\s+source\s+files\b/.test(normalized) && /\bconnect\b/.test(normalized) && /\bflow\b/.test(normalized)
    || /\bbackend\b/.test(normalized) && /\bfrontend\b/.test(normalized) && /\b(connect|wire|flow|source\s+files)\b/.test(normalized)
    || /\buse\s+only\s+project\s+files\s+such\s+as\b/.test(normalized) && /\b(connect|flow|backend|frontend)\b/.test(normalized);
}

function isStructuralResolutionTarget(targetConcept: string) {
  const normalized = normalizeTerm(targetConcept);
  return COMMON_STOP_WORDS.has(normalized)
    || /^(chain|flow|path|pipeline|stage|stages|step|steps|relationship|handoff)$/i.test(normalized);
}

function createSearchPlan(
  understanding: ProjectQuestionUnderstanding,
  topic: UniversalInspectTopic
): ProjectQuestionSearchQuery[] {
  const queries: ProjectQuestionSearchQuery[] = [];
  const add = (query: string, source: ProjectQuestionSearchQuery["source"], iteration: number) => {
    const compact = sanitizeSearchQuery(query);
    if (!compact || compact.length < 2) return;
    if (queries.some((item) => item.query.toLowerCase() === compact.toLowerCase())) return;
    queries.push({ query: compact, source, iteration });
  };

  add(understanding.targetConcept, "topic_term", 1);
  for (const entity of understanding.entities) add(entity, "entity", 1);
  for (const term of understanding.topicTerms) add(term, "topic_term", 1);
  for (const term of understanding.normalizedTerms.slice(0, 16)) add(term, "alias", 2);
  if (understanding.questionScope === "concept" && (topic === "code_flow" || topic === "general")) {
    for (const alias of conceptResolutionAliases(understanding.targetConcept).slice(0, 8)) add(alias, "alias", 2);
    if (shouldSearchArchitecturePatterns(understanding)) {
      for (const alias of ARCHITECTURAL_PATTERN_TERMS.slice(0, 12)) add(alias, "alias", 3);
    }
  }
  for (const facet of understanding.requiredFacets) {
    for (const alias of FACET_ALIASES[facet].slice(0, 8)) add(alias, "facet", 2);
  }
  if (topic === "training_inference" || /train|predict|inference/i.test(understanding.topicPhrase)) {
    for (const alias of TRAINING_INFERENCE_ALIASES) add(alias, "facet", 2);
  }
  if (!queries.length || topic === "general") {
    for (const term of understanding.normalizedTerms.slice(0, 20)) add(term, "topic_term", 3);
    for (const alias of FACET_ALIASES.code_symbols.slice(0, 8)) add(alias, "facet", 3);
  }
  return queries.slice(0, 60);
}

function collectLocalEvidence(
  tools: ToolRegistry,
  filePaths: string[],
  queryPlan: ProjectQuestionSearchQuery[],
  intent: WorkspaceIntentUnderstanding
) {
  const positiveEvidence: ProjectQuestionEvidence[] = [];
  const negativeEvidence: string[] = [];
  const suppressedNegativeQueries: string[] = [];
  const openedFiles: string[] = [];
  const candidateFiles = new Set<string>();
  const matchesByIteration = new Map<number, number>();
  const candidatesByIteration = new Map<number, Set<string>>();
  const perFileSnippetCount = new Map<string, number>();
  const fileCache = new Map<string, string>();

  const sortedFiles = [...filePaths].sort((left, right) => sourceScore(right) - sourceScore(left) || left.localeCompare(right));
  for (const query of queryPlan) {
    const before = positiveEvidence.length;
    const normalizedQuery = normalizeTerm(query.query);
    for (const filePath of sortedFiles) {
      if (positiveEvidence.length >= SEARCH_LIMITS.maxEvidenceItems) break;
      if ((perFileSnippetCount.get(filePath) ?? 0) >= SEARCH_LIMITS.maxSnippetsPerFile && !filePath.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      const content = readSearchFile(tools, filePath, fileCache);
      if (content === undefined) continue;
      if (!openedFiles.includes(filePath)) openedFiles.push(filePath);
      const normalizedPath = normalizeTerm(filePath);
      const pathMatch = normalizedPath.includes(normalizedQuery);
      const lines = content.split(/\r?\n/);
      let fileMatches = 0;
      if (pathMatch) {
        const snippet = firstUsefulSnippet(lines);
        positiveEvidence.push(createEvidence({
          filePath,
          line: 1,
          snippet,
          query: query.query,
          querySource: query.source,
          reason: `Path matched query "${query.query}".`,
          intent
        }));
        candidateFiles.add(filePath);
        perFileSnippetCount.set(filePath, (perFileSnippetCount.get(filePath) ?? 0) + 1);
        fileMatches++;
      }
      for (const [index, rawLine] of lines.entries()) {
        if (positiveEvidence.length >= SEARCH_LIMITS.maxEvidenceItems) break;
        if ((perFileSnippetCount.get(filePath) ?? 0) >= SEARCH_LIMITS.maxSnippetsPerFile) break;
        if (!normalizeTerm(rawLine).includes(normalizedQuery)) continue;
        const snippet = snippetAround(lines, index);
        positiveEvidence.push(createEvidence({
          filePath,
          line: index + 1,
          snippet,
          query: query.query,
          querySource: query.source,
          reason: `Line matched query "${query.query}".`,
          intent
        }));
        candidateFiles.add(filePath);
        perFileSnippetCount.set(filePath, (perFileSnippetCount.get(filePath) ?? 0) + 1);
        fileMatches++;
      }
      if (candidateFiles.size >= SEARCH_LIMITS.maxCandidateFiles && positiveEvidence.length >= 20) break;
      if (openedFiles.length >= sortedFiles.length) continue;
    }
    const gained = positiveEvidence.length - before;
    matchesByIteration.set(query.iteration, (matchesByIteration.get(query.iteration) ?? 0) + gained);
    const bucket = candidatesByIteration.get(query.iteration) ?? new Set<string>();
    for (const file of candidateFiles) bucket.add(file);
    candidatesByIteration.set(query.iteration, bucket);
    if (!gained) {
      const message = `No local matches for query "${query.query}".`;
      if (shouldExposeNegativeQuery(query.query)) negativeEvidence.push(message);
      else suppressedNegativeQueries.push(message);
    }
  }

  const searchIterations = Array.from({ length: SEARCH_LIMITS.maxIterations }, (_, index) => {
    const iteration = index + 1;
    return {
      iteration,
      queries: queryPlan.filter((query) => query.iteration === iteration).map((query) => query.query),
      matches: matchesByIteration.get(iteration) ?? 0,
      candidateFiles: Array.from(candidatesByIteration.get(iteration) ?? []).slice(0, SEARCH_LIMITS.maxCandidateFiles)
    };
  }).filter((iteration) => iteration.queries.length);

  return {
    positiveEvidence: uniqueEvidence(positiveEvidence),
    negativeEvidence: uniqueStrings(negativeEvidence).slice(0, 40),
    suppressedNegativeQueries: uniqueStrings(suppressedNegativeQueries).slice(0, 40),
    openedFiles: uniqueStrings(openedFiles).slice(0, SEARCH_LIMITS.maxOpenedFiles),
    candidateFiles: Array.from(candidateFiles).slice(0, SEARCH_LIMITS.maxCandidateFiles),
    searchIterations
  };
}

function resolveConceptEvidence(input: {
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  queryPlan: ProjectQuestionSearchQuery[];
  localEvidence: ProjectQuestionEvidence[];
  structuredEvidence: ProjectQuestionEvidence[];
  mechanismEvidence: MechanismEvidence[];
  investigationConceptResolution: InvestigationConceptResolution;
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
  negativeEvidence: string[];
  prompt: string;
  fileExists: (relativePath: string) => boolean;
}): ConceptResolution {
  const literalTerms = uniqueStrings([
    ...literalConceptTerms(input.questionUnderstanding.targetConcept),
    ...input.investigationConceptResolution.literalTerms
  ]);
  const aliasTerms = uniqueStrings([
    ...conceptResolutionAliases(input.questionUnderstanding.targetConcept),
    ...input.investigationConceptResolution.aliasTerms
  ])
    .filter((term) => !literalTerms.map(normalizeTerm).includes(normalizeTerm(term)));
  const behavioralTerms = uniqueStrings([
    ...(shouldSearchArchitecturePatterns(input.questionUnderstanding)
      ? ARCHITECTURAL_PATTERN_TERMS.filter((term) => /loop|cycle|agent|orchestrat|scheduler|feedback|retry|retrain|decision|planner|executor/i.test(term))
      : []),
    ...input.investigationConceptResolution.behavioralTerms
  ]);
  const architecturalTerms = uniqueStrings([
    ...(shouldSearchArchitecturePatterns(input.questionUnderstanding) ? ARCHITECTURAL_PATTERN_TERMS : []),
    ...input.investigationConceptResolution.architecturalTerms
  ]);
  const implementationEvidenceItems = proveEvidenceItems(
    input.implementationEvidence.map(implementationToQuestionEvidence),
    input.prompt,
    input.fileExists
  );
  const mechanismEvidenceItems = proveEvidenceItems(
    input.mechanismEvidence.map((item) =>
      mechanismToQuestionEvidence(item, input.questionUnderstanding.targetConcept, input.investigationConceptResolution)
    ),
    input.prompt,
    input.fileExists
  );
  const allEvidence = uniqueEvidence([
    ...input.localEvidence,
    ...input.structuredEvidence,
    ...implementationEvidenceItems,
    ...mechanismEvidenceItems
  ]);
  const directTargetEvidence: ProjectQuestionEvidence[] = [];
  const aliasTargetEvidence: ProjectQuestionEvidence[] = [];
  const behavioralTargetEvidence: ProjectQuestionEvidence[] = [];
  const architecturalPatternEvidence: ProjectQuestionEvidence[] = [];
  const generalProjectEvidence: ProjectQuestionEvidence[] = [];
  const noiseEvidence: ProjectQuestionEvidence[] = [];
  for (const item of allEvidence) {
    const text = evidenceText(item);
    const mechanismItem = mechanismEvidenceItems.find((mechanism) => mechanism.ref === item.ref);
    const selfReferentialExplainEvidence = isSelfReferentialExplainEvidence(item, input.questionUnderstanding);
    const canProveDirect = canProveImplementation(item.provenance) && !selfReferentialExplainEvidence;
    const canSupportTarget = isProductionEvidence(item.provenance) && !selfReferentialExplainEvidence;
    if (
      canProveDirect && (
        termsMatch(text, literalTerms)
        || implementationEvidenceItems.some((impl) => impl.ref === item.ref && impl.sourceRole === "implementation")
        || (mechanismItem && isDirectMechanismEvidence(mechanismItem, input.questionUnderstanding.targetConcept))
      )
    ) {
      directTargetEvidence.push(item);
    } else if (canSupportTarget && termsMatch(text, aliasTerms)) {
      aliasTargetEvidence.push(item);
    } else if (canSupportTarget && (termsMatch(text, behavioralTerms) || (mechanismItem && isBehavioralMechanismEvidence(mechanismItem)))) {
      behavioralTargetEvidence.push(item);
    } else if (canSupportTarget && (isArchitecturalPatternEvidence(text, architecturalTerms) || (mechanismItem && isArchitecturalMechanismEvidence(mechanismItem, input.questionUnderstanding.targetConcept)))) {
      architecturalPatternEvidence.push(item);
    } else if (isLikelyNoiseEvidence(item, input.questionUnderstanding)) {
      noiseEvidence.push(item);
    } else {
      generalProjectEvidence.push(item);
    }
  }
  const status: ConceptResolutionStatus = directTargetEvidence.length
    ? "direct_found"
    : aliasTargetEvidence.length
      ? "alias_found"
      : behavioralTargetEvidence.length
        ? "behavioral_found"
        : architecturalPatternEvidence.length
          ? "architectural_pattern_found"
          : "not_found";
  const targetEvidence = uniqueEvidence([
    ...directTargetEvidence,
    ...aliasTargetEvidence,
    ...behavioralTargetEvidence,
    ...architecturalPatternEvidence
  ]);
  return {
    targetConcept: input.questionUnderstanding.targetConcept,
    resolvedName: input.investigationConceptResolution.resolvedName,
    inferredPatternName: input.investigationConceptResolution.inferredPatternName,
    labelsOrModifiers: input.investigationConceptResolution.labelsOrModifiers,
    secondaryConcepts: input.investigationConceptResolution.secondaryConcepts,
    literalTerms,
    aliasTerms,
    behavioralTerms,
    architecturalTerms,
    resolutionStatus: status,
    confidence: status === "direct_found" ? "high" : status === "alias_found" || status === "behavioral_found" ? "medium" : status === "architectural_pattern_found" ? "low" : "low",
    targetEvidenceRefs: targetEvidence.map((item) => item.ref),
    directTargetEvidence: uniqueEvidence(directTargetEvidence),
    aliasTargetEvidence: uniqueEvidence(aliasTargetEvidence),
    behavioralTargetEvidence: uniqueEvidence(behavioralTargetEvidence),
    architecturalPatternEvidence: uniqueEvidence(architecturalPatternEvidence),
    generalProjectEvidence: uniqueEvidence(generalProjectEvidence),
    noiseEvidence: uniqueEvidence(noiseEvidence),
    rejectedGeneralEvidence: uniqueEvidence(generalProjectEvidence),
    userVisibleNegativeEvidence: userVisibleNegativeEvidence(input.negativeEvidence, literalTerms, aliasTerms)
  };
}

function evidenceForAnswer(input: {
  allCollectedEvidence: ProjectQuestionEvidence[];
  conceptResolution: ConceptResolution;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
}) {
  if (!isTargetedConceptQuestion(input.questionUnderstanding, input.topic)) {
    return input.allCollectedEvidence;
  }
  const targetEvidence = uniqueEvidence([
    ...input.conceptResolution.directTargetEvidence,
    ...input.conceptResolution.aliasTargetEvidence,
    ...input.conceptResolution.behavioralTargetEvidence,
    ...input.conceptResolution.architecturalPatternEvidence
  ]);
  return targetEvidence.slice(0, SEARCH_LIMITS.maxEvidenceItems);
}

function implementationToQuestionEvidence(item: ImplementationEvidence): ProjectQuestionEvidence {
  return {
    ref: item.ref,
    markdownLink: item.markdownLink,
    path: item.path,
    line: item.line,
    title: `${item.semanticRole}: ${item.ownerSymbol}`,
    reason: item.roleReason,
    snippet: item.snippet,
    query: "implementation-evidence",
    querySource: "structured",
    confidence: item.confidence,
    sourceRole: item.semanticRole
  };
}

function mechanismToQuestionEvidence(
  item: MechanismEvidence,
  targetConcept: string,
  resolution: InvestigationConceptResolution
): ProjectQuestionEvidence {
  const role = mechanismEvidenceSourceRole(item);
  return {
    ref: `${item.path}:${item.line}`,
    markdownLink: link(item.path, item.line),
    path: item.path,
    line: item.line,
    title: `${item.role}: ${item.ownerSymbol ?? item.endpoint ?? item.storageTarget ?? targetConcept}`,
    reason: item.reason,
    snippet: item.snippet,
    query: resolution.requestedConceptText || targetConcept || "investigation-graph",
    querySource: "structured",
    confidence: item.confidence,
    sourceRole: role
  };
}

function mechanismEvidenceSourceRole(item: MechanismEvidence): SourceRole {
  if (item.role === "test_endpoint_expectation" || item.role === "test") return "test";
  if (item.role === "documentation") return "documentation";
  if (item.role === "unrelated_name_match" || item.role === "general_storage") return "unrelated_name_match";
  if (item.role === "ui_state" || item.role === "ui_event_handler") return "orchestration";
  if (item.role === "api_client_call" || item.role === "backend_route" || item.role === "service_logic" || item.role === "storage_write" || item.role === "log_append") return "implementation";
  if (item.role === "storage_target" || item.role === "storage_read" || item.role === "lifecycle_status") return "orchestration";
  return "downstream_stage";
}

function isDirectMechanismEvidence(item: ProjectQuestionEvidence, targetConcept: string) {
  const target = normalizeTerm(targetConcept);
  if (target.includes("loop") || target === "outerloop" || target === "inner outer loop") return false;
  return /\b(api_client_call|backend_route|service_logic|storage_write|log_append)\b/.test(item.title)
    && !/\bgeneral_storage\b/.test(item.title);
}

function isBehavioralMechanismEvidence(item: ProjectQuestionEvidence) {
  return /\b(lifecycle_status|training_or_retraining|job_or_scheduler|context_only|storage_target)\b/.test(item.title);
}

function isArchitecturalMechanismEvidence(item: ProjectQuestionEvidence, targetConcept: string) {
  const target = normalizeTerm(targetConcept);
  return (target.includes("loop") || target === "outerloop" || target === "inner_outer_loop")
    && /\b(orchestrator|executor|decision|review|feedback|outcome|retrain|action|selected_action|low_gap|high_gap|retention|offer|lifecycle_status|context_only|training_or_retraining)\b/i.test(evidenceText(item));
}

function literalConceptTerms(targetConcept: string) {
  const normalized = normalizeTerm(targetConcept);
  return uniqueStrings([
    targetConcept,
    normalized,
    normalized.replace(/\s+/g, "_"),
    normalized.replace(/\s+/g, ""),
    normalized.replace(/\s+/g, "-")
  ].filter((term) => term && !INTERNAL_SEARCH_TERMS.has(normalizeTerm(term))));
}

function conceptResolutionAliases(targetConcept: string) {
  const normalized = normalizeTerm(targetConcept);
  const resolved = resolveInvestigationConcept(targetConcept);
  return uniqueStrings([
    ...resolved.aliasTerms,
    ...resolved.behavioralTerms,
    ...resolved.architecturalTerms,
    ...(CONCEPT_RESOLUTION_ALIASES[normalized] ?? []),
    ...literalConceptTerms(targetConcept)
  ]);
}

function shouldSearchArchitecturePatterns(understanding: ProjectQuestionUnderstanding) {
  const target = normalizeTerm(understanding.targetConcept);
  const knownConcrete = new Set(["dbscan", "fcm", "svm", "shap", "sarima"]);
  return understanding.questionScope === "concept"
    && understanding.expectedAnswerShape === "flow"
    && (!knownConcrete.has(target) || target.includes("loop") || target.includes("cycle"));
}

function termsMatch(text: string, terms: string[]) {
  const normalized = normalizeTerm(text);
  return terms.some((term) => {
    const clean = normalizeTerm(term);
    return clean.length >= 2 && normalized.includes(clean);
  });
}

function isArchitecturalPatternEvidence(text: string, terms: string[]) {
  const normalized = normalizeTerm(text);
  const hitCount = terms.filter((term) => normalized.includes(normalizeTerm(term))).length;
  return hitCount >= 2 || /\b(orchestrator|scheduler|planner|executor)\b/.test(normalized);
}

function isLikelyNoiseEvidence(item: ProjectQuestionEvidence, understanding: ProjectQuestionUnderstanding) {
  const normalizedQuery = normalizeTerm(item.query);
  if (INTERNAL_SEARCH_TERMS.has(normalizedQuery)) return true;
  if (item.sourceRole === "visualization" && !termsMatch(evidenceText(item), literalConceptTerms(understanding.targetConcept))) return true;
  return false;
}

function isSelfReferentialExplainEvidence(item: ProjectQuestionEvidence, understanding: ProjectQuestionUnderstanding) {
  return isSelfReferentialExplainPath(item.path, understanding);
}

function filterSelfReferentialProjectIntelligenceGraph(
  graph: ProjectIntelligenceGraph,
  understanding: ProjectQuestionUnderstanding
): ProjectIntelligenceGraph {
  const rejectedSelfEvidence = graph.evidence.filter((item) => isSelfReferentialExplainPath(item.path, understanding));
  if (!rejectedSelfEvidence.length) return graph;
  const evidence = graph.evidence.filter((item) => !isSelfReferentialExplainPath(item.path, understanding));
  const nodes = graph.nodes.filter((node) => !node.path || !isSelfReferentialExplainPath(node.path, understanding));
  const edges = graph.edges.filter((edge) => {
    const parsed = parseEvidenceRef(edge.evidenceRef);
    return !parsed || !isSelfReferentialExplainPath(parsed.path, understanding);
  });
  return {
    ...graph,
    nodes,
    edges,
    evidence,
    summary: summarizeFilteredProjectIntelligenceGraph(graph, nodes.length, edges.length, evidence),
    testEndpointExpectations: evidence.filter((item) => item.role === "test_endpoint_expectation"),
    targetScopedStorageEvidence: evidence.filter((item) => (item.role === "storage_target" || item.role === "storage_write" || item.role === "storage_read" || item.role === "log_append") && item.targetScoped !== false),
    generalStorageEvidence: evidence.filter((item) => item.role === "general_storage" || ((item.role === "storage_target" || item.role === "storage_write" || item.role === "storage_read" || item.role === "log_append") && item.targetScoped === false)),
    rejectedMechanismEvidence: uniqueMechanismEvidence([...graph.rejectedMechanismEvidence, ...rejectedSelfEvidence])
  };
}

function summarizeFilteredProjectIntelligenceGraph(
  graph: ProjectIntelligenceGraph,
  nodeCount: number,
  edgeCount: number,
  evidence: MechanismEvidence[]
): ProjectIntelligenceGraphSummary {
  const roles = { ...graph.summary.roles };
  for (const role of Object.keys(roles) as Array<keyof typeof roles>) roles[role] = 0;
  for (const item of evidence) roles[item.role] = (roles[item.role] ?? 0) + 1;
  return {
    nodeCount,
    edgeCount,
    evidenceCount: evidence.length,
    roles,
    importantFiles: uniqueStrings(evidence.map((item) => item.path)).slice(0, 12)
  };
}

function uniqueMechanismEvidence(items: MechanismEvidence[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.path}:${item.line}:${item.role}:${item.endpoint ?? item.storageTarget ?? item.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isSelfReferentialExplainPath(filePath: string, understanding: ProjectQuestionUnderstanding) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const explainPath = /apps\/agent-runtime\/src\/runtime\/(UniversalProjectQuestionEngine|ProjectQuestionConceptEngine|ProjectIntelligenceKernel|InspectExplainReadLanes|ProjectQuestionGrounding|EvidenceHygiene|LlmProjectExplainer)\.ts$/i.test(normalizedPath);
  if (!explainPath) return false;
  const promptText = `${understanding.topicPhrase} ${understanding.entities.join(" ")} ${understanding.normalizedTerms.join(" ")}`.toLowerCase();
  return !/\b(explain|project question|grounding|evidence|provenance|universal project question|read lane|concept engine)\b/.test(promptText);
}

function evidenceText(item: ProjectQuestionEvidence) {
  return `${item.path}\n${item.title}\n${item.reason}\n${item.query}\n${item.snippet ?? ""}`;
}

function isTargetedConceptQuestion(understanding: ProjectQuestionUnderstanding, topic: UniversalInspectTopic) {
  return understanding.questionScope === "concept"
    && topic !== "algorithms"
    && topic !== "frontend"
    && Boolean(understanding.targetConcept)
    && understanding.targetConcept !== "general";
}

function conceptHasTargetEvidence(resolution: ConceptResolution) {
  return resolution.directTargetEvidence.length > 0
    || resolution.aliasTargetEvidence.length > 0
    || resolution.behavioralTargetEvidence.length > 0
    || resolution.architecturalPatternEvidence.length > 0;
}

function userVisibleNegativeEvidence(negativeEvidence: string[], literalTerms: string[], aliasTerms: string[]) {
  const visibleTerms = [...literalTerms, ...aliasTerms].map(normalizeTerm).filter(Boolean);
  return uniqueStrings(negativeEvidence.filter((message) => {
    const normalized = normalizeTerm(message);
    if (Array.from(INTERNAL_SEARCH_TERMS).some((term) => normalized.includes(`query "${term}"`) || normalized.endsWith(` ${term}`))) return false;
    return visibleTerms.some((term) => normalized.includes(term));
  }).map(formatVisibleNegativeEvidence)).slice(0, 8);
}

function formatVisibleNegativeEvidence(message: string) {
  const query = message.match(/query "([^"]+)"/i)?.[1];
  if (!query) return message.replace(/^No local matches for query/i, "No local literal match for");
  return `No literal/local match was found for "${query}".`;
}

function collectStructuredFacts(
  tools: ToolRegistry,
  filePaths: string[],
  topic: UniversalInspectTopic,
  targetConcept: string
): InspectExplainFacts {
  const facts: InspectExplainFacts = {
    kind: "inspect_explain",
    inspectedFiles: [],
    uncertainties: []
  };

  if (topic === "frontend") {
    facts.frontend = analyzeFrontendStructure(tools.workspace, filePaths);
    facts.inspectedFiles.push(...facts.frontend.inspectedFiles);
  } else if (topic === "ui_controls") {
    facts.uiControls = analyzeUIControls(tools.workspace, filePaths);
    facts.inspectedFiles.push(...facts.uiControls.inspectedFiles);
  } else if (topic === "algorithms") {
    facts.algorithms = analyzeAlgorithmInventory(tools.workspace, filePaths);
    facts.inspectedFiles.push(...facts.algorithms.inspectedFiles);
  } else if (topic === "training_inference") {
    facts.trainingInference = analyzeTrainingInference(tools.workspace, filePaths);
    facts.inspectedFiles.push(...facts.trainingInference.inspectedFiles);
  } else if (topic === "code_flow") {
    facts.algorithms = analyzeAlgorithmInventory(tools.workspace, filePaths);
    facts.codeFlow = analyzeCodeFlow(tools.workspace, filePaths, facts.algorithms, targetConcept);
    facts.inspectedFiles.push(...facts.algorithms.inspectedFiles, ...facts.codeFlow.inspectedFiles);
  }

  facts.inspectedFiles = uniqueStrings(facts.inspectedFiles);
  return facts;
}

function structuredFactsToEvidence(facts: InspectExplainFacts): ProjectQuestionEvidence[] {
  const evidence: ProjectQuestionEvidence[] = [];
  const add = (path: string, title: string, reason: string, snippet?: string) => {
    evidence.push({
      ref: `${path}:1`,
      markdownLink: link(path, 1),
      path,
      line: 1,
      title,
      reason,
      snippet,
      query: "structured-facts",
      querySource: "structured",
      confidence: "high",
      sourceRole: sourceRoleForPath(path)
    });
  };
  for (const item of facts.frontend?.items ?? []) add(item.sourceRef, `Frontend ${item.type}: ${item.name}`, item.purpose, item.name);
  for (const item of facts.uiControls?.controls ?? []) add(item.sourceRef, `UI control: ${item.text}`, item.action, item.text);
  for (const item of facts.algorithms?.items ?? []) add(item.sourceRef, `Algorithm/model: ${item.name}`, item.description, item.name);
  for (const item of facts.trainingInference?.training ?? []) add(item.sourceRef, `Training: ${item.name}`, item.type, item.name);
  for (const item of facts.trainingInference?.inference ?? []) add(item.sourceRef, `Inference: ${item.name}`, item.type, item.name);
  for (const item of facts.trainingInference?.persistence ?? []) add(item.sourceRef, `Persistence: ${item.method}`, item.method, item.method);
  for (const item of facts.codeFlow?.steps ?? []) add(item.sourceRef, `Flow step: ${item.label}`, item.description, item.label);
  return evidence;
}

function proveEvidenceItems(
  items: ProjectQuestionEvidence[],
  prompt: string,
  fileExists: (relativePath: string) => boolean
): ProjectQuestionEvidence[] {
  return items.map((item) => {
    const provenance = createEvidenceProvenance({
      sourceFile: item.path,
      citedPath: item.path,
      line: item.line,
      snippet: item.snippet,
      prompt,
      fileExists
    });
    return {
      ...item,
      confidence: lowerConfidence(item.confidence, provenance.confidence),
      sourceRole: sourceRoleForProvenance(item.path, item.sourceRole, provenance),
      provenance
    };
  });
}

function sourceRoleForProvenance(
  filePath: string,
  fallback: SourceRole,
  provenance: EvidenceProvenance
): SourceRole {
  if (provenance.sourceType === "test_source" || provenance.sourceType === "fixture_generated_path") return "test";
  if (provenance.sourceType === "documentation") return "documentation";
  if (provenance.sourceType === "tmp_artifact" || provenance.sourceType === "memory_artifact" || provenance.sourceType === "generated_report" || provenance.sourceType === "runtime_state") return "unrelated_name_match";
  return sourceRoleForPath(filePath) ?? fallback;
}

function lowerConfidence(left: "high" | "medium" | "low", right: "high" | "medium" | "low") {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[left] < rank[right] ? left : right;
}

function evidenceProvenanceReport(items: ProjectQuestionEvidence[]): {
  groundedEvidence: GroundedEvidenceItem[];
  rejectedEvidence: RejectedEvidenceItem[];
} {
  const groundedEvidence: GroundedEvidenceItem[] = [];
  const rejectedEvidence: RejectedEvidenceItem[] = [];
  for (const item of items) {
    if (!item.provenance) continue;
    const reportItem = evidenceItemForReport({ ref: item.ref, provenance: item.provenance });
    if ("existsOnDisk" in reportItem) groundedEvidence.push(reportItem);
    else rejectedEvidence.push(reportItem);
  }
  return {
    groundedEvidence: dedupeGroundedEvidence(groundedEvidence),
    rejectedEvidence: dedupeRejectedEvidence(rejectedEvidence)
  };
}

function dedupeGroundedEvidence(items: GroundedEvidenceItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.ref}:${item.sourceType}:${item.directness}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRejectedEvidence(items: RejectedEvidenceItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.ref}:${item.sourceType}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readLaneFindingsToEvidence(artifacts: InspectExplainReadLaneArtifact[]): ProjectQuestionEvidence[] {
  const findings = artifacts.flatMap((artifact) => artifact.findings);
  return findings.map((finding) => ({
    ref: `${finding.path}:${finding.line}`,
    markdownLink: link(finding.path, finding.line),
    path: finding.path,
    line: finding.line,
    title: `Read lane ${finding.lane} finding`,
    reason: `${finding.status}: structured read-lane evidence.`,
    snippet: finding.snippet,
    query: publicReadLaneQuery(finding),
    querySource: "structured" as const,
    confidence: finding.confidence,
    sourceRole: sourceRoleForReadLaneFinding(finding)
  }));
}

function publicReadLaneQuery(finding: InspectExplainReadLaneFinding) {
  return finding.relatedNames.find((name) => !isInternalReadLaneName(name))
    ?? finding.endpoint
    ?? finding.storageTarget
    ?? "read-lane";
}

function isInternalReadLaneName(value: string) {
  return /^(ui_state|ui_event_handler|api_client_call|backend_route|service_logic|storage_target|storage_write|storage_read|log_append|training_or_retraining|job_or_scheduler|lifecycle_status|test_endpoint_expectation|algorithm_implementation|page_structure|wrapper_or_context|general_storage|documentation_context|unrelated_name_match)$/i.test(value);
}

function sourceRoleForReadLaneFinding(finding: InspectExplainReadLaneFinding): SourceRole {
  if (finding.role === "test_endpoint_expectation") return "test";
  if (finding.role === "documentation_context") return "documentation";
  if (finding.role === "unrelated_name_match" || finding.role === "general_storage") return "unrelated_name_match";
  if (finding.role === "page_structure" || finding.role === "ui_state" || finding.role === "ui_event_handler") return "visualization";
  if (finding.role === "storage_target" || finding.role === "wrapper_or_context" || finding.role === "lifecycle_status") return "orchestration";
  if (finding.role === "training_or_retraining" || finding.role === "job_or_scheduler") return "downstream_stage";
  return "implementation";
}

function validateAnswer(input: {
  question: string;
  answerMarkdown: string;
  intent: WorkspaceIntentUnderstanding;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  positiveEvidence: ProjectQuestionEvidence[];
  structuredFacts: InspectExplainFacts;
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
  conceptResolution: ConceptResolution;
}): AnswerShapeValidation {
  const errors: string[] = [];
  const targetSpecific = isTargetedConceptQuestion(input.questionUnderstanding, input.topic);
  const hasTargetEvidence = conceptHasTargetEvidence(input.conceptResolution);
  const hasEvidence = targetSpecific
    ? hasTargetEvidence
    : input.positiveEvidence.length > 0 || structuredFactsHaveEvidence(input.topic, input.structuredFacts);
  const charCount = input.answerMarkdown.trim().length;
  const sectionCount = countAnswerSections(input.answerMarkdown);
  const citationCount = (input.answerMarkdown.match(/hivo-file:/gi) ?? []).length;
  const codeFenceCount = (input.answerMarkdown.match(/```/g) ?? []).length / 2;
  const minCharCount = input.questionUnderstanding.detailLevel === "deep"
    ? 1_400
    : input.questionUnderstanding.detailLevel === "detailed"
      ? 900
      : 0;
  const minSectionCount = input.questionUnderstanding.detailLevel === "deep" || input.questionUnderstanding.detailLevel === "detailed" ? 3 : 0;
  let tooShallow = false;
  if (hasEvidence && !answerHasWorkspaceCitation(input.answerMarkdown)) {
    errors.push("Answer has local evidence but no workspace citations.");
  }
  if (hasEvidence && answerLooksLikeNotFound(input.answerMarkdown)) {
    errors.push("Answer says the topic was not found even though local evidence exists.");
  }
  if (isForecastingAssessmentQuestion(input.question, input.questionUnderstanding)) {
    const repeatedGenericForecasting = (input.answerMarkdown.match(/forecasting implementation:\s*The implementation applies forecasting in this code block/gi) ?? []).length;
    if (repeatedGenericForecasting >= 3) {
      errors.push("Forecasting answer repeats a generic implementation template instead of synthesizing evidence.");
    }
    const routeLineOneRefs = (input.answerMarkdown.match(/\bbackend\/routes\.py:1\b/g) ?? []).length;
    const arimaLineOneRefs = (input.answerMarkdown.match(/\bbackend\/services\/arima_model\.py:1\b/g) ?? []).length;
    if (routeLineOneRefs + arimaLineOneRefs >= 3 && /\b(fit_cluster_models|get_cluster_state|trend_multiplier|normalized_trend|SARIMAX?|cluster)\b/i.test(input.positiveEvidence.map((item) => item.snippet ?? "").join("\n"))) {
      errors.push("Forecasting answer cites only shallow line-1 locations while deeper forecasting evidence is available.");
    }
    const answerText = input.answerMarkdown;
    const mentionsScope = /\b(cluster-level|per-cluster|per-segment|predicted_cluster|get_cluster_state|customer-level|per customer|aggregate|global)\b|(?:مستوى\s+cluster|لكل\s+cluster|للعميل|للـ\s*customer)/i.test(answerText);
    if (!mentionsScope) {
      errors.push("Forecasting answer must explain whether the forecast is cluster-level, aggregate, or customer-level.");
    }
    if (forecastingQuestionRequestsJudgment(input.question) && !/\b(wrong|correct|logical|reasonable|production|demo|academic|weak|flaw|issue)\b|(?:منطقي|غلط|مقبول|ضعيف|خلل|production|demo|أكاديمي|اكاديمي)/iu.test(answerText)) {
      errors.push("Forecasting answer does not answer the requested logic/correctness judgment.");
    }
  }
  const repeatedGenericImplementation = (input.answerMarkdown.match(/\b[\w -]+ implementation:\s*The implementation applies [\w -]+ in this code block\./gi) ?? []).length;
  if (repeatedGenericImplementation >= 3) {
    errors.push("Answer repeats a generic implementation template instead of synthesizing project evidence.");
  }
  const citationLineRefs = Array.from(input.answerMarkdown.matchAll(/\b(?:backend|frontend|src|app|services?)\/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx):(\d+)\b/g));
  const shallowLineOneRefs = citationLineRefs.filter((match) => Number(match[1]) === 1).length;
  const hasDeeperAnswerRef = citationLineRefs.some((match) => Number(match[1]) > 1);
  const hasDeeperEvidence = input.positiveEvidence.some((item) => item.line > 1);
  if (targetSpecific && shallowLineOneRefs >= 8 && hasDeeperEvidence && !hasDeeperAnswerRef && (input.questionUnderstanding.detailLevel === "deep" || input.questionUnderstanding.detailLevel === "detailed")) {
    errors.push("Answer over-cites shallow line-1 references while deeper target evidence is available.");
  }
  if (input.questionUnderstanding.targetConcept === "multi_agent_system") {
    const answerText = input.answerMarkdown;
    if (!/\b(build_default_agents|ReActOrchestrator|choose_route|agent_recommendations|agent_consensus|ActionExecutor|orchestrator)\b/i.test(answerText)) {
      errors.push("Multi-agent answer does not mention the actual agent/orchestrator wiring.");
    }
    if (!/\b(logical|reasonable|advisory|lightweight|central orchestrator|wrong|incorrect)\b|(?:منطقي|مقبول|استشار|خفيف|غلط|خطأ)/iu.test(answerText)) {
      errors.push("Multi-agent answer does not answer the requested logic/correctness judgment.");
    }
  }
  if (responseLooksOffIntent(input.answerMarkdown, {
    intent: input.intent,
    evidencePack: {
      items: input.positiveEvidence,
      topicItems: input.positiveEvidence,
      byFacet: emptyFacetEvidenceMap(input.positiveEvidence),
      missingRequiredFacets: [],
      partial: false
    },
    understanding: {
      moduleSummary: "",
      entrypoints: [],
      projectHints: []
    }
  })) {
    errors.push("Answer appears to be about a different topic than the user asked.");
  }
  if (hasEvidence && minCharCount && charCount < minCharCount) {
    tooShallow = true;
    errors.push(`Detailed answer is too shallow: ${charCount} chars, expected at least ${minCharCount}.`);
  }
  if (hasEvidence && minSectionCount && sectionCount < minSectionCount) {
    tooShallow = true;
    errors.push(`Detailed answer has too few sections: ${sectionCount}, expected at least ${minSectionCount}.`);
  }
  if (hasEvidence && input.questionUnderstanding.expectedAnswerShape === "flow" && input.questionUnderstanding.detailLevel !== "brief") {
    const mentionsImplementationShape = /\b(def|function|class|endpoint|route|api|fit|fit_predict|predict|predict_proba|SVC|DBSCAN|cmeans|FCM|SHAP|joblib|pickle|train_|predict_|eps|min_samples)\b/i.test(input.answerMarkdown);
    if (!mentionsImplementationShape) {
      errors.push("Detailed flow answer does not mention concrete functions, endpoints, or implementation symbols.");
    }
  }
  if (input.implementationEvidence.some((item) => item.semanticRole === "implementation") && /\btests?\//i.test(input.answerMarkdown) && !input.implementationEvidence.some((item) => item.semanticRole === "implementation" && input.answerMarkdown.includes(item.path))) {
    errors.push("Answer cites tests while omitting available implementation evidence.");
  }
  if (hasEvidence && input.questionUnderstanding.wantsCodeExamples && codeFenceCount < 1) {
    errors.push("User asked for code/examples, but the answer has no code snippet block.");
  }
  return {
    valid: errors.length === 0,
    errors,
    tooShallow,
    charCount,
    sectionCount,
    citationCount,
    codeFenceCount,
    minCharCount,
    minSectionCount
  };
}

function detectStaleCannedOuterloopAnswer(answerMarkdown: string, understanding: ProjectQuestionUnderstanding) {
  const target = normalizeTerm(understanding.targetConcept);
  if (target !== "outerloop" && !target.includes("loop")) return [];
  const errors: string[] = [];
  const oldArabicDirectClaim = /لقيت\s+`?outerloop`?\s+كدليل\s+مباشر/i.test(answerMarkdown);
  const oldArabicSections = answerMarkdown.includes("## الفلو المثبت") && answerMarkdown.includes("## النواتج أو الحالات المثبتة");
  const oldArabicBullets = /جزئي:\s*فيه\s+مرحلة\s+model\/decision\/action/i.test(answerMarkdown)
    || /feedback\/outcome stage تربط القرار بنتيجة لاحقة/i.test(answerMarkdown);
  const oldEnglishDirectClaim = /I found direct target evidence for `?outerloop`? and built the answer from compatible code links/i.test(answerMarkdown);
  const oldEnglishSections = answerMarkdown.includes("## Proven Flow") && answerMarkdown.includes("## Proven Outputs Or States");
  const oldSignalShape = answerMarkdown.includes("model/decision/action")
    && answerMarkdown.includes("feedback/outcome stage")
    && answerMarkdown.includes("ACTION_LOG_PATH")
    && answerMarkdown.includes("observed_outcome");
  if (oldArabicDirectClaim || (oldArabicSections && oldArabicBullets) || oldEnglishDirectClaim || oldEnglishSections || oldSignalShape) {
    errors.push("answerMarkdown matches stale canned outerloop explanation template.");
  }
  return errors;
}

function answerHasWorkspaceCitation(answerMarkdown: string) {
  return /hivo-file:/i.test(answerMarkdown)
    || /\b(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+:\d+\b/.test(answerMarkdown);
}

function guardFinalAnswerCitations(input: {
  answerMarkdown: string;
  evidenceRefs: string[];
  prompt: string;
  language: WorkspaceIntentUnderstanding["language"];
  fileExists: (relativePath: string) => boolean;
}) {
  const warnings: string[] = [];
  const allowedRefs = uniqueStrings(input.evidenceRefs.filter((ref) => {
    const parsed = parseEvidenceRef(ref);
    if (!parsed) return false;
    const verdict = finalCitationVerdict(parsed.path, input.prompt, input.fileExists);
    if (!verdict.allowed) warnings.push(`Removed invalid evidence ref ${ref}: ${verdict.reason}`);
    return verdict.allowed;
  }));
  let answerMarkdown = input.answerMarkdown.replace(
    /\[([^\]]+)\]\(hivo-file:([^)\s]+):(\d+)\)/g,
    (full, _label: string, encodedPath: string, line: string) => {
      let filePath = encodedPath;
      try {
        filePath = decodeURIComponent(encodedPath);
      } catch {
        // Keep the undecoded path for the rejection reason.
      }
      const verdict = finalCitationVerdict(filePath, input.prompt, input.fileExists);
      if (verdict.allowed) return full;
      warnings.push(`Removed invalid hivo-file citation ${filePath}:${line}: ${verdict.reason}`);
      return invalidCitationReplacement(filePath, input.language);
    }
  );
  answerMarkdown = answerMarkdown.replace(
    /\b((?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+):(\d+)\b/g,
    (full, filePath: string, line: string) => {
      const verdict = finalCitationVerdict(filePath, input.prompt, input.fileExists);
      if (verdict.allowed) return full;
      warnings.push(`Removed invalid plain citation ${filePath}:${line}: ${verdict.reason}`);
      return invalidCitationReplacement(filePath, input.language);
    }
  );
  return {
    answerMarkdown,
    evidenceRefs: allowedRefs,
    warnings: uniqueStrings(warnings)
  };
}

function finalCitationVerdict(
  filePath: string,
  prompt: string,
  fileExists: (relativePath: string) => boolean
): { allowed: true; reason: string } | { allowed: false; reason: string } {
  const provenance = createEvidenceProvenance({
    sourceFile: filePath,
    citedPath: filePath,
    prompt,
    fileExists
  });
  if (!provenance.pathVerification.safePath) return { allowed: false, reason: "unsafe path" };
  if (!provenance.pathVerification.existsOnDisk) return { allowed: false, reason: "path does not exist in workspace" };
  if (provenance.sourceType === "fixture_generated_path") return { allowed: false, reason: "fixture-generated path" };
  if (
    provenance.sourceType === "tmp_artifact"
    || provenance.sourceType === "memory_artifact"
    || provenance.sourceType === "generated_report"
    || provenance.sourceType === "runtime_state"
  ) {
    return { allowed: false, reason: `non-production artifact: ${provenance.sourceType}` };
  }
  return { allowed: true, reason: provenance.reason };
}

function invalidCitationReplacement(filePath: string, language: WorkspaceIntentUnderstanding["language"]) {
  const normalized = filePath.replaceAll("\\", "/");
  if (language === "arabic") return `\`${normalized}\` (مسار غير مثبت في workspace الحالي)`;
  return `\`${normalized}\` (not a verified workspace citation)`;
}

function validateTargetEvidence(input: {
  answerMarkdown: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  conceptResolution: ConceptResolution;
  conceptFlow: ConceptFlow;
}): TargetEvidenceValidation {
  const errors: string[] = [];
  if (input.questionUnderstanding.questionScope !== "concept") return { valid: true, errors };
  const answer = normalizeTerm(input.answerMarkdown);
  const target = normalizeTerm(input.questionUnderstanding.targetConcept);
  if (!target || target === "general") return { valid: true, errors };
  const hasTargetEvidence = conceptHasTargetEvidence(input.conceptResolution);
  if (input.conceptResolution.resolutionStatus === "not_found" && hasTargetEvidence) {
    errors.push("Concept resolution says not_found even though target evidence buckets are populated.");
  }
  if (input.conceptResolution.resolutionStatus === "not_found") {
    if (!answerLooksLikeNotFound(input.answerMarkdown)) {
      errors.push("Answer should preserve concept-specific not-found when no target evidence exists.");
    }
    const assertiveTargetClaim = target && answer.includes(target)
      && /\b(applied|implemented|works|flow|pipeline|training|prediction|cluster|model|clearly|obvious|found)\b/i.test(input.answerMarkdown)
      && !answerLooksLikeNotFound(input.answerMarkdown);
    if (assertiveTargetClaim) errors.push("Answer claims the target concept is implemented even though resolution did not find target evidence.");
  }
  if (!hasTargetEvidence && input.conceptResolution.generalProjectEvidence.length && /\b(SARIMA|DBSCAN|SVM|SHAP|Fuzzy|cmeans)\b/i.test(input.answerMarkdown) && !answerLooksLikeNotFound(input.answerMarkdown)) {
    errors.push("Answer uses general project algorithms as proof for a target-specific concept.");
  }
  if (/No local matches for query\s+"(?:interface|def|export|import|function|class|type|router|endpoint)"/i.test(input.answerMarkdown)) {
    errors.push("Answer exposes internal search strategy queries.");
  }
  if (/outputs? (?:are )?not (?:explicit|clear|proven)|النواتج.*غير واضحة|النواتج.*غير مثبتة/i.test(input.answerMarkdown) && input.conceptFlow.steps.some((step) => step.outputNames.length)) {
    errors.push("Answer says outputs are unclear even though concept flow has outputNames.");
  }
  if (/downstream.*not (?:explicit|clear|proven)|المستهلك.*غير واضح|الربط اللاحق.*غير مثبت/i.test(input.answerMarkdown) && input.conceptFlow.steps.some((step) => step.nextConsumers.length)) {
    errors.push("Answer says downstream is unclear even though concept flow has nextConsumers.");
  }
  return { valid: errors.length === 0, errors };
}

function bucketMechanismEvidence(evidence: MechanismEvidence[]): MechanismEvidenceBuckets {
  return {
    directMechanismEvidence: evidence.filter((item) => ["api_client_call", "backend_route", "service_logic", "storage_write", "log_append"].includes(item.role)),
    uiEvidence: evidence.filter((item) => item.role === "ui_state" || item.role === "ui_event_handler"),
    apiLinkEvidence: evidence.filter((item) => item.role === "api_client_call"),
    backendHandlerEvidence: evidence.filter((item) => item.role === "backend_route" || item.role === "service_logic"),
    storageEvidence: evidence.filter((item) => item.role === "storage_target" || item.role === "storage_write" || item.role === "storage_read" || item.role === "log_append"),
    testEndpointExpectations: evidence.filter((item) => item.role === "test_endpoint_expectation"),
    targetScopedStorageEvidence: evidence.filter((item) => (item.role === "storage_target" || item.role === "storage_write" || item.role === "storage_read" || item.role === "log_append") && item.targetScoped !== false),
    generalStorageEvidence: evidence.filter((item) => item.role === "general_storage" || (item.role === "storage_target" || item.role === "storage_write" || item.role === "storage_read" || item.role === "log_append") && item.targetScoped === false),
    rejectedMechanismEvidence: evidence.filter((item) => item.role === "general_storage" || item.role === "unrelated_name_match"),
    downstreamConsumerEvidence: evidence.filter((item) => item.role === "training_or_retraining" || item.role === "job_or_scheduler"),
    statusOnlyEvidence: evidence.filter((item) => item.role === "lifecycle_status"),
    contextOnlyEvidence: evidence.filter((item) => item.role === "context_only")
  };
}

function mergeReadLaneGraphIntoMechanismChain(chain: MechanismChain, readLaneRun: InspectExplainReadLaneRun): MechanismChain {
  const baseSteps = [...chain.steps];
  const existingRelations = new Set(baseSteps.map((step) => step.relation));
  const addedSteps: MechanismChain["steps"] = [];
  for (const edge of readLaneRun.synthesizedGraph.edges) {
    if (edge.status === "rejected" || edge.status === "unproven") continue;
    const role = roleForLaneRelation(edge.relation);
    if (!role) continue;
    const stepFromEdge: MechanismChain["steps"][number] = {
      order: baseSteps.length + addedSteps.length + 1,
      role,
      label: edge.reason,
      relation: edge.relation,
      status: edge.status,
      ownerSymbol: edge.from,
      from: edge.from,
      to: edge.to,
      confidence: edge.confidence,
      evidenceRefs: edge.evidenceRefs,
      files: uniqueStrings(edge.evidenceRefs.map((ref) => ref.split(":").slice(0, -1).join(":")).filter(Boolean))
    };
    const existingIndex = baseSteps.findIndex((step) => step.relation === edge.relation);
    if (existingIndex >= 0) {
      const existing = baseSteps[existingIndex];
      if (existing && proofStatusRank(edge.status) > proofStatusRank(existing.status)) {
        baseSteps[existingIndex] = { ...stepFromEdge, order: existing.order };
      }
      continue;
    }
    addedSteps.push(stepFromEdge);
  }
  const steps = [...baseSteps, ...addedSteps].map((step, index) => ({ ...step, order: index + 1 }));
  if (!addedSteps.length && steps.every((step, index) => step === chain.steps[index])) return chain;
  const provenRelations = new Set(steps.filter((step) => step.status === "proven").map((step) => step.relation));
  const missingLinks = chain.missingLinks.filter((linkName) => !laneRelationSatisfiesMissingLink(linkName, provenRelations));
  const status = readLaneRun.synthesizedGraph.status === "confirmed" || (chain.status === "confirmed" && missingLinks.length === 0)
    ? "confirmed"
    : steps.length
      ? "partial"
      : "not_found";
  return {
    ...chain,
    status,
    confidence: status === "confirmed" ? "high" : status === "partial" ? "medium" : "low",
    steps,
    confirmedFiles: uniqueStrings([...chain.confirmedFiles, ...addedSteps.flatMap((step) => step.files)]),
    missingLinks
  };
}

function proofStatusRank(status: MechanismChain["steps"][number]["status"]) {
  if (status === "proven") return 3;
  if (status === "partial") return 2;
  if (status === "unproven") return 1;
  return 0;
}

function roleForLaneRelation(relation: string): MechanismChain["steps"][number]["role"] | undefined {
  if (relation === "frontend_surface") return "ui_event_handler";
  if (relation === "frontend_to_api") return "api_client_call";
  if (relation === "api_to_backend") return "backend_route";
  if (relation === "backend_to_storage") return "log_append";
  if (relation === "downstream_feedback_consumer") return "training_or_retraining";
  if (relation === "decision_action_stage") return "service_logic";
  if (relation === "feedback_or_outcome_stage") return "lifecycle_status";
  if (relation === "state_log_or_retraining_update") return "training_or_retraining";
  if (relation === "target_implementation_evidence") return "service_logic";
  return undefined;
}

function laneRelationSatisfiesMissingLink(linkName: string, provenRelations: Set<string>) {
  if (linkName === "frontend_feedback_surface") return provenRelations.has("frontend_surface");
  if (linkName === "frontend_to_backend_request") return provenRelations.has("frontend_to_api");
  if (linkName === "backend_feedback_handler") return provenRelations.has("api_to_backend");
  if (linkName === "feedback_storage_or_log_usage") return provenRelations.has("backend_to_storage");
  if (linkName === "downstream_feedback_consumer") return provenRelations.has("downstream_feedback_consumer");
  if (linkName === "inner_model_or_decision_stage") return provenRelations.has("decision_action_stage");
  if (linkName === "feedback_or_outcome_stage") return provenRelations.has("feedback_or_outcome_stage");
  if (linkName === "state_log_or_retraining_update") return provenRelations.has("state_log_or_retraining_update");
  if (linkName === "next_cycle_effect") return provenRelations.has("downstream_feedback_consumer") || provenRelations.has("state_log_or_retraining_update");
  return false;
}

function isMechanismQuestion(understanding: ProjectQuestionUnderstanding, buckets: MechanismEvidenceBuckets) {
  const target = normalizeTerm(understanding.targetConcept);
  if (["svm", "dbscan", "fcm", "shap", "sarima"].includes(target)) return false;
  if (target === "feedback") return true;
  if (target === "multi_agent_system") return true;
  if (["outerloop", "inner loop", "inner outer loop", "inner_outer_loop", "retraining loop", "human review loop", "action loop"].includes(target)
    || target.includes("loop")) return true;
  return Boolean(
    buckets.uiEvidence.length ||
    buckets.apiLinkEvidence.length ||
    buckets.backendHandlerEvidence.length ||
    buckets.storageEvidence.length ||
    buckets.statusOnlyEvidence.length
  ) && /\b(feedback|submit|endpoint|api|route|log|storage|backend|frontend)\b/i.test(understanding.topicPhrase);
}

function composeMechanismNarrativeAnswer(input: {
  questionUnderstanding: ProjectQuestionUnderstanding;
  conceptResolution: ConceptResolution;
  mechanismChain: MechanismChain;
  mechanismEvidence: MechanismEvidenceBuckets;
  intent: WorkspaceIntentUnderstanding;
  projectSourceFiles?: string[];
  readFile?: (relativePath: string) => string;
}) {
  return input.intent.language === "arabic"
    ? composeArabicMechanismFlowAnswer(input)
    : composeEnglishMechanismFlowAnswer(input);
}

function composeArabicMechanismFlowAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  return composeArabicProjectInvestigationAnswer(input);
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const lines: string[] = ["## الخلاصة"];
  if (input.mechanismChain.status === "confirmed") {
    lines.push(`\`${target}\` مثبت كمسار تنفيذ من الواجهة للـ backend ثم التخزين أو الاستهلاك اللاحق، حسب الأدلة المذكورة تحت.`);
  } else if (input.mechanismChain.status === "partial") {
    lines.push(`وجدت أجزاء من \`${target}\` في المشروع، لكن المسار الكامل غير مثبت من الملفات المقروءة. يعني لا ينفع نقول إنه متوصل end-to-end إلا في الحدود المثبتة تحت.`);
  } else {
    lines.push(`لم أجد آلية مثبتة لـ \`${target}\` في الملفات التي تم فحصها.`);
  }

  if (target === "feedback") {
    const hasRuntimePath = input.mechanismChain.steps.some((step) => step.relation === "frontend_to_api" && step.status === "proven")
      && input.mechanismChain.steps.some((step) => step.relation === "api_to_backend" && step.status === "proven");
    const hasStorage = input.mechanismChain.steps.some((step) => step.relation === "backend_to_storage" && step.status === "proven");
    const negativeImpactEvidence = negativeFeedbackImpactEvidence(input);
    lines.push(
      "",
      "## الحكم المختصر",
      hasRuntimePath && hasStorage
        ? "الربط الأساسي منطقي: الواجهة تبعت feedback، والـ backend يستقبله، وبعدها يحصل تسجيل/تحديث للحالة. فالمشكلة مش إن feedback متطبق غلط من ناحية wiring."
        : "التصميم واضح جزئيا فقط: فيه إشارات feedback، لكن في روابط ناقصة تمنع الحكم إنه متوصل صح end-to-end.",
      "التحفظ المهم: ده أقرب لـ simulated/customer-response feedback داخل المنتج، مش نظام feedback حر كامل. لو الهدف feedback حقيقي من مستخدمين حقيقيين، محتاج طبقة تحقق/مصدر بيانات أوضح."
    );
    if (negativeImpactEvidence.shouldExplain) {
      lines.push(
        "",
        "## تأثير الرد السلبي",
        negativeImpactEvidence.refs
          ? `الرد السلبي مش بيتسجل بس: الكود يفسره كإشارة سلبية، يجعل \`should_trigger_outer_loop\` true، وبعدها مسار submit يشغل retraining عند تحقق الإشارة. ${negativeImpactEvidence.refs}`
          : "الرد السلبي مش بيتسجل بس: الكود يتعامل معه كإشارة ممكن تشغل outer loop/retraining، لكن الأدلة المتاحة في هذه الإجابة لا تكفي لربط كل سطر."
      );
    }
  }

  if (input.mechanismChain.steps.length) {
    lines.push("");
    lines.push("## الفلو المثبت");
    for (const step of input.mechanismChain.steps) {
      lines.push(`- ${arabicMechanismStep(step)} ${step.evidenceRefs.slice(0, 2).map((ref) => linkFromRef(ref)).join(", ")}`);
    }
  }

  if (input.mechanismEvidence.uiEvidence.length) {
    lines.push("");
    lines.push("## الواجهة");
    lines.push(mechanismSentence("ui", input.mechanismEvidence.uiEvidence));
  }

  if (input.mechanismEvidence.apiLinkEvidence.length) {
    lines.push("");
    lines.push("## الربط بين الواجهة والـ API");
    lines.push(mechanismSentence("api", input.mechanismEvidence.apiLinkEvidence));
  } else if (input.mechanismEvidence.uiEvidence.length) {
    lines.push("");
    lines.push("## الربط بين الواجهة والـ API");
    lines.push("وجدت واجهة أو state مرتبطة بالسؤال، لكن لم أجد من الأدلة الحالية request واضح يرسلها للـ backend.");
  }

  if (input.mechanismEvidence.backendHandlerEvidence.length) {
    lines.push("");
    lines.push("## الـ backend");
    lines.push(mechanismSentence("backend", input.mechanismEvidence.backendHandlerEvidence));
  } else if (input.mechanismEvidence.apiLinkEvidence.length) {
    lines.push("");
    lines.push("## الـ backend");
    lines.push("وجدت request من ناحية العميل، لكن لم يثبت handler مطابق في الـ backend من المقاطع التي دخلت في الـ graph.");
  }

  if (input.mechanismEvidence.targetScopedStorageEvidence.length) {
    const writes = input.mechanismEvidence.targetScopedStorageEvidence.filter((item) => item.role === "storage_write" || item.role === "log_append" || item.role === "storage_read");
    const targets = input.mechanismEvidence.targetScopedStorageEvidence.filter((item) => item.role === "storage_target");
    lines.push("");
    lines.push("## التخزين والـ logs");
    if (writes.length) {
      lines.push(mechanismSentence("storage", writes));
    } else {
      lines.push(`وجدت مسار تخزين أو log مثل ${targets.slice(0, 3).map((item) => `\`${item.storageTarget ?? item.symbol ?? item.relatedNames[0] ?? "path"}\``).join(", ")}، لكن لم أجد دالة قراءة أو كتابة تثبت استخدامه فعليًا. ${mechanismRefs(targets)}`);
    }
  }

  if (input.mechanismEvidence.downstreamConsumerEvidence.length) {
    lines.push("");
    lines.push("## الاستهلاك اللاحق");
    lines.push(mechanismSentence("downstream", input.mechanismEvidence.downstreamConsumerEvidence));
  }

  if (input.mechanismEvidence.testEndpointExpectations.length || input.mechanismEvidence.generalStorageEvidence.length || input.mechanismEvidence.statusOnlyEvidence.length || input.mechanismEvidence.contextOnlyEvidence.length || input.mechanismChain.missingLinks.length) {
    lines.push("");
    lines.push("## ما لا يثبته الدليل");
    if (input.mechanismEvidence.testEndpointExpectations.length) {
      lines.push(`- الاختبارات تشير إلى endpoint متوقع مثل ${mechanismNames(input.mechanismEvidence.testEndpointExpectations).join(", ") || "endpoint"}، لكنها لا تثبت أن الواجهة تستدعيه فعليًا. ${mechanismRefs(input.mechanismEvidence.testEndpointExpectations)}`);
    }
    if (input.mechanismEvidence.generalStorageEvidence.length) {
      lines.push(`- وجدت تخزينًا عامًا في المشروع، لكنه غير مربوط بـ \`${target}\` كدليل مباشر، لذلك لا أستخدمه كإثبات لتخزين feedback. ${mechanismRefs(input.mechanismEvidence.generalStorageEvidence)}`);
    }
    if (input.mechanismEvidence.statusOnlyEvidence.length) {
      lines.push(`- وجدت حالات أو نصوص lifecycle مرتبطة مثل \`awaiting_feedback\`، لكنها تعني أن النظام ينتظر feedback أو يسجل حالة، وليست وحدها دليلًا على إرسال أو تخزين feedback. ${mechanismRefs(input.mechanismEvidence.statusOnlyEvidence)}`);
    }
    if (input.mechanismEvidence.contextOnlyEvidence.length) {
      lines.push(`- وجدت سياق قرارات أو actions قريب، لكنه context مساعد وليس إثباتًا مباشرًا للآلية. ${mechanismRefs(input.mechanismEvidence.contextOnlyEvidence)}`);
    }
    for (const linkName of input.mechanismChain.missingLinks.slice(0, 5)) {
      lines.push(`- الرابط غير المثبت: ${arabicMissingMechanismLink(linkName)}.`);
    }
  }
  return lines.join("\n");
}

function composeEnglishMechanismFlowAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  return composeEnglishProjectInvestigationAnswer(input);
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const lines: string[] = ["## Summary"];
  lines.push(input.mechanismChain.status === "confirmed"
    ? `I found a proven mechanism chain for \`${target}\`.`
    : input.mechanismChain.status === "partial"
      ? `I found partial mechanism evidence for \`${target}\`, but not a complete end-to-end chain.`
      : `I could not prove a mechanism for \`${target}\` from the inspected files.`);
  if (input.mechanismEvidence.uiEvidence.length) lines.push(`\n## UI\n${mechanismSentence("ui", input.mechanismEvidence.uiEvidence)}`);
  if (input.mechanismEvidence.apiLinkEvidence.length) lines.push(`\n## API Link\n${mechanismSentence("api", input.mechanismEvidence.apiLinkEvidence)}`);
  if (input.mechanismEvidence.backendHandlerEvidence.length) lines.push(`\n## Backend\n${mechanismSentence("backend", input.mechanismEvidence.backendHandlerEvidence)}`);
  if (input.mechanismChain.steps.length) lines.push(`\n## Proven Flow\n${input.mechanismChain.steps.map((step) => `- ${englishMechanismStep(step)} ${step.evidenceRefs.slice(0, 2).map((ref) => linkFromRef(ref)).join(", ")}`).join("\n")}`);
  if (input.mechanismEvidence.storageEvidence.length) lines.push(`\n## Storage\n${mechanismSentence("storage", input.mechanismEvidence.targetScopedStorageEvidence)}`);
  if (input.mechanismEvidence.testEndpointExpectations.length) lines.push(`\n## Test Evidence\nTests expect ${mechanismNames(input.mechanismEvidence.testEndpointExpectations).join(", ") || "an endpoint"}, but tests do not prove production frontend calls.`);
  if (input.mechanismChain.missingLinks.length) lines.push(`\n## Not Proven\n${input.mechanismChain.missingLinks.map((item) => `- Missing link: ${item}.`).join("\n")}`);
  return lines.join("\n");
}

function composeArabicEvidenceGraphLoopAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const chain = input.mechanismChain;
  const resolution = input.conceptResolution;
  const directEvidence = resolution.directTargetEvidence.slice(0, 5);
  const allFiles = uniqueStrings([
    ...chain.confirmedFiles,
    ...chain.steps.flatMap((step) => step.files),
    ...directEvidence.map((item) => item.path)
  ]).slice(0, 10);
  const lines: string[] = ["## الخلاصة"];

  if (chain.status === "confirmed") {
    lines.push(`الـ \`${target}\` هنا ظاهر كحلقة تشغيل حقيقية من كذا مرحلة، مش كجملة محفوظة: قرار/اختيار action، بعدها تنفيذ أو routing، بعدها outcome/feedback، وبعدها logging/state update ممكن يجهز الدورة التالية. الثقة: ${arabicConfidence(chain.confidence)}.`);
  } else if (chain.status === "partial") {
    lines.push(`الـ \`${target}\` هنا مثبت جزئيًا فقط: لقيت مراحل من الحلقة، لكن مش كل الروابط مقفولة end-to-end من الأدلة الحالية. الثقة: ${arabicConfidence(chain.confidence)}.`);
  } else {
    lines.push(`ماقدرتش أثبت \`${target}\` كحلقة تنفيذ من ملفات المشروع الحالية. أي تشابه في الأسماء هيتعامل كإشارة ضعيفة وليس implementation.`);
  }

  if (allFiles.length) {
    lines.push(`الملفات اللي شايلة الدليل الأساسي: ${allFiles.map((file) => `\`${file}\``).join(", ")}.`);
  }

  lines.push("", "## مسار الحلقة من الأدلة");
  if (chain.steps.length) {
    for (const step of chain.steps) {
      const refs = step.evidenceRefs.slice(0, 3).map((ref) => linkFromRef(ref)).join(", ");
      lines.push(`- ${step.order}. ${arabicLoopStepTitle(step)}`);
      lines.push(`  - الدور في الحلقة: ${arabicLoopStageExplanation(step.relation)}.`);
      if (step.ownerSymbol || step.to || step.from) {
        lines.push(`  - الرموز/الاتجاه: ${[step.ownerSymbol ? `owner=\`${step.ownerSymbol}\`` : "", step.from ? `from=\`${step.from}\`` : "", step.to ? `to=\`${step.to}\`` : ""].filter(Boolean).join(", ")}.`);
      }
      lines.push(`  - الدليل: ${refs || "لا يوجد ref مباشر في هذه الخطوة"}.`);
    }
  } else {
    lines.push("- مفيش chain steps كفاية لبناء outerloop موثق.");
  }

  if (directEvidence.length) {
    lines.push("", "## أدلة الاسم أو المفهوم");
    for (const item of directEvidence) {
      const sourceType = item.provenance?.sourceType ?? "unknown";
      const directness = item.provenance?.directness ?? "unknown";
      lines.push(`- ${item.markdownLink}: source=\`${sourceType}\`, directness=\`${directness}\`, confidence=\`${item.confidence}\`.`);
      lines.push(`  - السبب: ${item.reason}`);
      lines.push(`  - مقتطف: \`${compactSnippet(item.snippet ?? "")}\``);
    }
  }

  const outputs = mechanismOutputNames(input.mechanismEvidence, chain);
  if (outputs.length) {
    lines.push("", "## البيانات التي تقفل أو تغذي الدورة");
    lines.push(`- ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
    lines.push("- أتعامل معها كـ state/outcome/log targets، وليس كدليل كامل على retraining إلا لو ظهر consumer واضح يستخدمها في دورة لاحقة.");
  }

  const evidenceSlices = [
    { title: "decision/action", items: input.mechanismEvidence.contextOnlyEvidence.concat(input.mechanismEvidence.directMechanismEvidence).slice(0, 4) },
    { title: "feedback/outcome", items: input.mechanismEvidence.statusOnlyEvidence.slice(0, 4) },
    { title: "storage/log/update", items: input.mechanismEvidence.targetScopedStorageEvidence.slice(0, 4) },
    { title: "downstream/retraining", items: input.mechanismEvidence.downstreamConsumerEvidence.slice(0, 4) }
  ].filter((group) => group.items.length);
  if (evidenceSlices.length) {
    lines.push("", "## طبقات الدليل");
    for (const group of evidenceSlices) {
      const refs = group.items.map((item) => linkFromRef(`${item.path}:${item.line}`)).slice(0, 3).join(", ");
      const names = mechanismNames(group.items).slice(0, 5).map((item) => `\`${item}\``).join(", ");
      lines.push(`- ${group.title}: ${names || "إشارات كود مرتبطة"} (${refs}).`);
    }
  }

  const missing = uniqueStrings([
    ...chain.missingLinks,
    ...(input.mechanismEvidence.generalStorageEvidence.length ? ["general_storage_not_target_proof"] : []),
    ...(input.mechanismEvidence.testEndpointExpectations.length ? ["test_expectation_not_runtime_flow"] : [])
  ]);
  lines.push("", "## حدود الثقة");
  if (missing.length) {
    for (const item of missing.slice(0, 6)) {
      lines.push(`- ${arabicLoopUncertainty(item, target)}.`);
    }
  } else {
    lines.push("- مفيش فجوة كبيرة ظهرت في chain الحالية، لكن الاستنتاج يظل مربوطًا بالملفات والسطور المذكورة فقط.");
  }

  lines.push("", "## الحكم العملي");
  if (chain.status === "confirmed") {
    lines.push(`أقدر أقول إن \`${target}\` متطبق كـ orchestration/control loop موثق: النظام يختار action، يراقب outcome/status، ويسجل state يمكن استخدامها في دورة لاحقة. لو قصدك ML retraining loop صارم، فده محتاج دليل إضافي على job/consumer يعيد تدريب النموذج من نفس الـ logs.`);
  } else if (chain.status === "partial") {
    lines.push(`أقدر أقول إن فيه أجزاء outerloop، لكن مش حلقة كاملة مثبتة. الجزء الناقص فوق هو اللي يمنعني أقول إنها closed loop بالكامل.`);
  } else {
    lines.push(`لا أقدر أقول إن outerloop متطبق هنا من غير دليل production مباشر.`);
  }
  return lines.join("\n");
}

function mechanismSentence(kind: "ui" | "api" | "backend" | "storage" | "downstream", evidence: MechanismEvidence[]) {
  const refs = mechanismRefs(evidence);
  const names = mechanismNames(evidence);
  const namesText = names.length ? names.map((item) => `\`${item}\``).join(", ") : "الأدلة المذكورة";
  if (kind === "ui") {
    const hasControl = evidence.some((item) => item.relatedNames.some((name) => /^(form|button|input|textarea|select|onSubmit|onClick|onChange|submit|handle)/i.test(name)));
    return hasControl
      ? `لقيت control أو handler في الواجهة مرتبط بـ ${namesText}. ده يثبت نقطة بداية في UI، لكنه لا يثبت التخزين أو الـ backend إلا لو ظهر request بعده. ${refs}`
      : `لقيت state مرتبط بـ ${namesText}، لكن لم أجد control إرسال واضح في الواجهة من الأدلة الحالية. ${refs}`;
  }
  if (kind === "api") return `فيه request أو client call مرتبط بـ ${namesText}. دي هي حلقة الربط التي تثبت أن الكود يحاول إرسال البيانات خارج الواجهة. ${refs}`;
  if (kind === "backend") return `الـ backend فيه handler أو service مرتبط بـ ${namesText}. ده يثبت أن فيه جهة تستقبل أو تعالج الطلب، حسب الدليل الموجود. ${refs}`;
  if (kind === "storage") return `التخزين أو الـ log مثبت من خلال ${namesText}. لو الدليل writer/append فهو يثبت كتابة فعلية، ولو constant فقط فهو مجرد target للتخزين. ${refs}`;
  return `فيه استهلاك لاحق مرتبط بـ ${namesText}. ده يثبت أن الناتج يدخل خطوة لاحقة فقط عندما يظهر call أو data dependency واضح. ${refs}`;
}

function composeArabicProjectInvestigationAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  if (input.questionUnderstanding.targetConcept === "multi_agent_system") {
    return composeArabicMultiAgentSystemAnswer(input);
  }
  if (input.questionUnderstanding.targetConcept === "outerloop" || input.questionUnderstanding.targetConcept.includes("loop")) {
    return composeArabicEvidenceGraphLoopAnswer(input);
  }
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const resolution = input.conceptResolution;
  const pattern = resolution.inferredPatternName ?? resolution.resolvedName;
  const lines: string[] = ["## الخلاصة"];
  if (resolution.resolutionStatus === "not_found" && input.mechanismChain.status === "not_found") {
    lines.push(`لم أجد \`${target}\` كاسم أو pattern مثبت من الملفات المقروءة.`);
  } else if (input.mechanismChain.status === "partial") {
    lines.push(`وجدت أجزاء مرتبطة بـ \`${target}\`، لكن المسار الكامل غير مثبت من كل حلقة. الشرح تحت يفرق بين المثبت والجزئي.`);
  } else if (resolution.directTargetEvidence.length) {
    lines.push(`لقيت \`${target}\` كدليل مباشر، وبنيت الشرح على الروابط المثبتة في الكود، مش على mentions عامة.`);
  } else if (pattern) {
    lines.push(`لم أجد \`${target}\` كاسم رسمي مباشر، لكن أقرب pattern مثبت هو: \`${pattern}\`. الثقة: ${arabicConfidence(input.mechanismChain.confidence)}.`);
  } else {
    lines.push(`لقيت أدلة جزئية مرتبطة بـ \`${target}\`، لكن السلسلة الكاملة ليست مثبتة من كل حلقة.`);
  }
  if (resolution.labelsOrModifiers.length) {
    lines.push(`الـ labels المذكورة في السؤال (${resolution.labelsOrModifiers.map((item) => `\`${item}\``).join(", ")}) اتعاملت معها كقيم/مخرجات للـ feedback، مش كمفهوم مستقل.`);
  }

  lines.push("", "## الفلو المثبت");
  if (input.mechanismChain.steps.length) {
    for (const step of input.mechanismChain.steps) {
      lines.push(`- ${arabicMechanismRelation(step)} ${step.evidenceRefs.slice(0, 2).map((ref) => linkFromRef(ref)).join(", ")}`);
    }
  } else {
    lines.push("- لم تظهر روابط تنفيذ كافية لبناء flow موثق.");
  }

  if (target === "feedback") {
    const hasRuntimePath = input.mechanismChain.steps.some((step) => step.relation === "frontend_to_api" && step.status === "proven")
      && input.mechanismChain.steps.some((step) => step.relation === "api_to_backend" && step.status === "proven");
    const hasStorage = input.mechanismChain.steps.some((step) => step.relation === "backend_to_storage" && step.status === "proven");
    const negativeImpactEvidence = negativeFeedbackImpactEvidence(input);
    lines.push(
      "",
      "## الحكم المختصر",
      hasRuntimePath && hasStorage
        ? "الربط الأساسي منطقي: الواجهة تبعت feedback، والـ backend يستقبله، وبعدها يحصل تسجيل/تحديث للحالة. فالمشكلة مش إن feedback متطبق غلط من ناحية wiring."
        : "التصميم واضح جزئيا فقط: فيه إشارات feedback، لكن في روابط ناقصة تمنع الحكم إنه متوصل صح end-to-end.",
      "التحفظ المهم: ده أقرب لـ simulated/customer-response feedback داخل المنتج، مش نظام feedback حر كامل. لو الهدف feedback حقيقي من مستخدمين حقيقيين، محتاج طبقة تحقق/مصدر بيانات أوضح."
    );
    if (negativeImpactEvidence.shouldExplain) {
      lines.push(
        "",
        "## تأثير الرد السلبي",
        negativeImpactEvidence.refs
          ? `الرد السلبي مش بيتسجل بس: الكود يفسره كإشارة سلبية، يجعل \`should_trigger_outer_loop\` true، وبعدها مسار submit يشغل retraining عند تحقق الإشارة. ${negativeImpactEvidence.refs}`
          : "الرد السلبي مش بيتسجل بس: الكود يتعامل معه كإشارة ممكن تشغل outer loop/retraining، لكن الأدلة المتاحة في هذه الإجابة لا تكفي لربط كل سطر."
      );
    }
  }

  const outputs = mechanismOutputNames(input.mechanismEvidence, input.mechanismChain);
  if (outputs.length) {
    lines.push("", "## النواتج أو الحالات المثبتة", `- ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
  }

  const hasProductionApiCall = input.mechanismChain.steps.some((step) => step.relation === "frontend_to_api" && step.status === "proven");
  const tests = hasProductionApiCall ? [] : input.mechanismEvidence.testEndpointExpectations;
  const generalStorage = input.mechanismEvidence.generalStorageEvidence;
  const missing = input.mechanismChain.missingLinks;
  if (tests.length || generalStorage.length || missing.length) {
    lines.push("", "## غير المثبت");
    if (tests.length) {
      lines.push(`- الاختبارات تثبت توقع endpoint مثل ${mechanismNames(tests).map((item) => `\`${item}\``).join(", ") || "`endpoint`"}، لكنها لا تثبت أن الواجهة تستدعيه فعليًا. ${mechanismRefs(tests)}`);
    }
    if (generalStorage.length) {
      lines.push(`- وجدت تخزينًا عامًا، لكنه ليس proof لتخزين \`${target}\` إلا لو كان مربوطًا بالـ target أو handler نفسه. ${mechanismRefs(generalStorage)}`);
    }
    for (const linkName of missing.slice(0, 5)) {
      lines.push(`- الرابط الناقص: ${arabicMissingMechanismLink(linkName)}.`);
    }
  }
  return lines.join("\n");
}

function composeArabicMultiAgentSystemAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  const refs = multiAgentSystemEvidenceRefs(input);
  const lines = [
    "## الخلاصة",
    "النظام هنا متطبق كـ multi-agentic decision-support خفيف: عنده agents متخصصة بتقترح قرارات، وبعدها orchestrator مركزي يوزن/يفصل بينها ويختار route/action. فالفكرة منطقية كتصميم decision routing، لكنها مش multi-agent system مستقل بالكامل بمعنى agents عندها أدوات وذاكرة وتخطيط منفصل.",
    "",
    "## الفلو الفعلي",
    `- تعريف الـ agents: فيه agents متخصصة مثل Reliability/Forecast/ClusterHealth، وكل واحدة ترجع recommendation وreason وvote_weight.${refs.agentDefinitions ? ` ${refs.agentDefinitions}` : ""}`,
    `- تهيئة التشغيل: النظام يبني \`ActionExecutor\`، يعمل \`build_default_agents()\`، وينشئ \`ReActOrchestrator\`.${refs.initialization ? ` ${refs.initialization}` : ""}`,
    `- وقت القرار: كل agent يعمل \`recommend(model_context)\`، ثم \`orchestrator.choose_route(..., agent_recommendations)\` يقرر المسار النهائي.${refs.runtimeDecision ? ` ${refs.runtimeDecision}` : ""}`,
    `- النتيجة بتتسجل في trace: \`agent_consensus\`, \`agent_recommendations\`, و\`orchestrator_snapshot\` تظهر ضمن reason/action trace.${refs.traceOutput ? ` ${refs.traceOutput}` : ""}`,
    "",
    "## الحكم المختصر",
    "التطبيق منطقي لو المقصود agents استشارية فوق موديلات وRAG وrules. مش غلط من ناحية wiring: agents -> orchestrator -> action executor -> trace.",
    "التحفظ المهم: ده مش swarm أو agents مستقلة بتنفذ مهام منفصلة؛ هو central orchestrator ومعاه rule-based specialist advisors. لو المنتج بيسميه multi-agentic system يبقى الوصف مقبول بشرط توضيح إنه advisory/lightweight، مش autonomous multi-agent orchestration."
  ];
  return lines.join("\n");
}

function composeEnglishMultiAgentSystemAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  const refs = multiAgentSystemEvidenceRefs(input);
  const lines = [
    "## Summary",
    "This is implemented as a lightweight multi-agentic decision-support system: specialist agents recommend actions, then a central orchestrator weighs the recommendations and chooses the route/action. That is logical for decision routing, but it is not a fully autonomous multi-agent swarm.",
    "",
    "## Actual Flow",
    `- Agent definitions: Reliability/Forecast/ClusterHealth-style agents return a recommendation, reason, and vote weight.${refs.agentDefinitions ? ` ${refs.agentDefinitions}` : ""}`,
    `- Runtime setup: the system creates \`ActionExecutor\`, \`build_default_agents()\`, and \`ReActOrchestrator\`.${refs.initialization ? ` ${refs.initialization}` : ""}`,
    `- Decision time: each agent calls \`recommend(model_context)\`, then \`orchestrator.choose_route(..., agent_recommendations)\` chooses the final route.${refs.runtimeDecision ? ` ${refs.runtimeDecision}` : ""}`,
    `- Trace output: \`agent_consensus\`, \`agent_recommendations\`, and \`orchestrator_snapshot\` are stored in the result trace.${refs.traceOutput ? ` ${refs.traceOutput}` : ""}`,
    "",
    "## Verdict",
    "The wiring is logical for advisory agents around models/RAG/rules. The caveat is naming: it is a central orchestrator with deterministic specialist advisors, not independent agents with separate tools, memory, and planning loops."
  ];
  return lines.join("\n");
}

function multiAgentSystemEvidenceRefs(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  const directRefs = directMultiAgentSystemRefs(input);
  const evidence = uniqueMechanismEvidence([
    ...input.mechanismEvidence.directMechanismEvidence,
    ...input.mechanismEvidence.backendHandlerEvidence,
    ...input.mechanismEvidence.downstreamConsumerEvidence,
    ...input.mechanismEvidence.contextOnlyEvidence,
    ...input.mechanismEvidence.statusOnlyEvidence
  ]);
  const refsFor = (pattern: RegExp, category: "agentDefinitions" | "initialization" | "runtimeDecision" | "traceOutput") => mechanismRefs(evidence
    .filter((item) => pattern.test(`${item.path}\n${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`))
    .sort((left, right) => multiAgentEvidenceScore(right, category) - multiAgentEvidenceScore(left, category) || left.path.localeCompare(right.path) || left.line - right.line)
    .slice(0, 3));
  return {
    agentDefinitions: directRefs.agentDefinitions || refsFor(/agents\.py|BaseAgent|ReliabilityAgent|ForecastAgent|ClusterHealthAgent|build_default_agents/i, "agentDefinitions"),
    initialization: directRefs.initialization || refsFor(/\bagents\s*=\s*build_default_agents\(|\borchestrator\s*=\s*ReActOrchestrator\(|\baction_executor\s*=\s*ActionExecutor\(|build_default_agents|ReActOrchestrator|ActionExecutor/i, "initialization"),
    runtimeDecision: directRefs.runtimeDecision || refsFor(/agent_recommendations\s*=|\bagent\.recommend\b|orchestrator\.choose_route|choose_route/i, "runtimeDecision"),
    traceOutput: directRefs.traceOutput || refsFor(/agent_consensus|agent_recommendations|orchestrator_snapshot|decision_trace|reason/i, "traceOutput")
  };
}

type MultiAgentSystemRefs = {
  agentDefinitions: string;
  initialization: string;
  runtimeDecision: string;
  traceOutput: string;
};

function directMultiAgentSystemRefs(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]): MultiAgentSystemRefs {
  if (!input.readFile) {
    return {
      agentDefinitions: "",
      initialization: "",
      runtimeDecision: "",
      traceOutput: ""
    };
  }
  const evidenceFiles = uniqueMechanismEvidence([
    ...input.mechanismEvidence.directMechanismEvidence,
    ...input.mechanismEvidence.backendHandlerEvidence,
    ...input.mechanismEvidence.downstreamConsumerEvidence,
    ...input.mechanismEvidence.contextOnlyEvidence,
    ...input.mechanismEvidence.statusOnlyEvidence
  ]).map((item) => item.path);
  const candidates = uniqueStrings([
    ...(input.projectSourceFiles ?? []),
    ...evidenceFiles
  ]).filter((filePath) => SOURCE_FILE_RE.test(filePath) && /(agents?|orchestrator|routes?|main|action_executor)/i.test(filePath));
  const refs = {
    agentDefinitions: "",
    initialization: "",
    runtimeDecision: "",
    traceOutput: ""
  };
  for (const filePath of candidates) {
    let content = "";
    try {
      content = input.readFile(filePath);
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const foundAgentDefinitions = refs.agentDefinitions || findMultiAgentRefs(filePath, lines, /class\s+(?:BaseAgent|ReliabilityAgent|ForecastAgent|ClusterHealthAgent)\b|def\s+build_default_agents\b/i);
    const foundInitialization = refs.initialization || findMultiAgentRefs(filePath, lines, /\bagents\s*=\s*build_default_agents\(|\borchestrator\s*=\s*ReActOrchestrator\(|\baction_executor\s*=\s*ActionExecutor\(/i);
    const foundRuntimeDecision = refs.runtimeDecision || findMultiAgentRefs(filePath, lines, /agent_recommendations\s*=.*agent\.recommend|orchestrator\.choose_route\(/i);
    const foundTraceOutput = refs.traceOutput || findMultiAgentRefs(filePath, lines, /["']agent_consensus["']|["']agent_recommendations["']|["']orchestrator_snapshot["']/i);
    refs.agentDefinitions = foundAgentDefinitions;
    refs.initialization = foundInitialization;
    refs.runtimeDecision = foundRuntimeDecision;
    refs.traceOutput = foundTraceOutput;
  }
  return refs;
}

function findMultiAgentRefs(filePath: string, lines: string[], pattern: RegExp) {
  const refs: string[] = [];
  lines.forEach((lineText, index) => {
    if (refs.length >= 3) return;
    if (pattern.test(lineText)) refs.push(link(filePath, index + 1));
  });
  return refs.join(", ");
}

function multiAgentEvidenceScore(item: MechanismEvidence, category: "agentDefinitions" | "initialization" | "runtimeDecision" | "traceOutput") {
  const text = `${item.path}\n${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`;
  let score = 0;
  if (category === "agentDefinitions") {
    if (/services\/agents\.py/i.test(item.path)) score += 140;
    if (/class\s+(?:BaseAgent|ReliabilityAgent|ForecastAgent|ClusterHealthAgent)|build_default_agents/i.test(text)) score += 120;
    if (/\brecommend\b|vote_weight|recommended_action_name|reasoning/i.test(text)) score += 40;
  } else if (category === "initialization") {
    if (/routes?\.py|main\.py/i.test(item.path)) score += 140;
    if (/\bagents\s*=\s*build_default_agents\(|\borchestrator\s*=\s*ReActOrchestrator\(|\baction_executor\s*=\s*ActionExecutor\(/i.test(text)) score += 130;
    if (/SYSTEM_STATE.*(?:agents|orchestrator|action_executor)|["'](?:agents|orchestrator|action_executor)["']\s*:/i.test(text)) score += 80;
    if (/services\/agents\.py/i.test(item.path)) score -= 30;
  } else if (category === "runtimeDecision") {
    if (/routes?\.py/i.test(item.path)) score += 150;
    if (/agent_recommendations\s*=.*agent\.recommend|orchestrator\.choose_route/i.test(text)) score += 150;
    if (/services\/orchestrator\.py/i.test(item.path) && /choose_route|weighted_votes|weighted_winner/i.test(text)) score += 95;
  } else {
    if (/routes?\.py/i.test(item.path)) score += 150;
    if (/decision_trace|["']reason["']|agent_consensus|agent_recommendations|orchestrator_snapshot/i.test(text)) score += 140;
    if (/services\/orchestrator\.py/i.test(item.path) && /agent_consensus|weighted_votes/i.test(text)) score += 60;
  }
  if (/ActionExecutor|execute_action/i.test(text)) score += 20;
  return score;
}

function composeEnglishProjectInvestigationAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  if (input.questionUnderstanding.targetConcept === "multi_agent_system") {
    return composeEnglishMultiAgentSystemAnswer(input);
  }
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const resolution = input.conceptResolution;
  const pattern = resolution.inferredPatternName ?? resolution.resolvedName;
  const lines: string[] = ["## Summary"];
  if (resolution.resolutionStatus === "not_found" && input.mechanismChain.status === "not_found") {
    lines.push(`I could not prove \`${target}\` as a literal name or supported architectural pattern from the inspected files.`);
  } else if (resolution.directTargetEvidence.length) {
    lines.push(`I found direct target evidence for \`${target}\` and built the answer from compatible code links.`);
  } else if (pattern) {
    lines.push(`I did not find \`${target}\` as an official literal name, but the nearest supported pattern is \`${pattern}\` with ${input.mechanismChain.confidence} confidence.`);
  } else {
    lines.push(`I found partial mechanism evidence for \`${target}\`, but the full chain is not proven.`);
  }
  if (resolution.labelsOrModifiers.length) {
    lines.push(`Labels/modifiers in the question (${resolution.labelsOrModifiers.map((item) => `\`${item}\``).join(", ")}) were treated as feedback values, not the target concept.`);
  }

  lines.push("", "## Proven Flow");
  if (input.mechanismChain.steps.length) {
    for (const step of input.mechanismChain.steps) {
      lines.push(`- ${englishMechanismRelation(step)} ${step.evidenceRefs.slice(0, 2).map((ref) => linkFromRef(ref)).join(", ")}`);
    }
  } else {
    lines.push("- No compatible mechanism links were proven.");
  }

  const outputs = mechanismOutputNames(input.mechanismEvidence, input.mechanismChain);
  if (outputs.length) {
    lines.push("", "## Proven Outputs Or States", `- ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
  }

  if (input.mechanismEvidence.testEndpointExpectations.length || input.mechanismEvidence.generalStorageEvidence.length || input.mechanismChain.missingLinks.length) {
    lines.push("", "## Not Proven");
    if (input.mechanismEvidence.testEndpointExpectations.length) {
      lines.push(`- Tests expect ${mechanismNames(input.mechanismEvidence.testEndpointExpectations).map((item) => `\`${item}\``).join(", ") || "an endpoint"}, but tests do not prove production frontend calls.`);
    }
    if (input.mechanismEvidence.generalStorageEvidence.length) {
      lines.push("- General storage evidence is kept as context only; it is not proof for the target mechanism.");
    }
    for (const linkName of input.mechanismChain.missingLinks.slice(0, 5)) lines.push(`- Missing link: ${linkName}.`);
  }
  return lines.join("\n");
}

function arabicMechanismRelation(step: MechanismChain["steps"][number]) {
  const status = step.status === "proven" ? "مثبت" : step.status === "partial" ? "جزئي" : "غير مثبت";
  const target = step.to ? ` إلى \`${step.to}\`` : "";
  if (step.relation === "frontend_surface") return `${status}: الواجهة فيها feedback state/control${step.ownerSymbol ? ` داخل \`${step.ownerSymbol}\`` : ""}.`;
  if (step.relation === "frontend_to_api") return `${status}: الواجهة أو client بيبعت request${target}.`;
  if (step.relation === "test_expected_endpoint") return `${status}: الاختبار يتوقع endpoint${target}، لكنه ليس frontend runtime flow.`;
  if (step.relation === "api_to_backend") return `${status}: الـ backend يعرف handler مطابق${target}${step.ownerSymbol ? ` داخل \`${step.ownerSymbol}\`` : ""}.`;
  if (step.relation === "backend_to_storage") return `${status}: handler/backend بيكتب أو يضيف في storage/log${target}.`;
  if (step.relation === "feedback_lifecycle_status") return `${status}: فيه lifecycle/status يوضح حالة feedback أو انتظار outcome.`;
  if (step.relation === "downstream_consumer") return `${status}: فيه مستهلك لاحق مثل retraining/job/review.`;
  if (step.relation === "decision_action_stage" || step.relation === "inner_model_decision") return `${status}: فيه مرحلة model/decision/action داخل النظام.`;
  if (step.relation === "feedback_or_outcome_stage") return `${status}: فيه feedback/outcome stage تربط القرار بنتيجة لاحقة.`;
  if (step.relation === "state_log_or_retraining_update") return `${status}: فيه log/state/retraining update ممكن تقفل الحلقة لو اتثبتت صلتها.`;
  return `${status}: ${step.label}`;
}

function arabicLoopStepTitle(step: MechanismChain["steps"][number]) {
  const status = step.status === "proven" ? "مثبت" : step.status === "partial" ? "جزئي" : "غير مثبت";
  if (step.relation === "decision_action_stage" || step.relation === "inner_model_decision") return `مرحلة القرار واختيار الـ action (${status})`;
  if (step.relation === "feedback_or_outcome_stage") return `مرحلة رجوع النتيجة أو الـ feedback بعد التنفيذ (${status})`;
  if (step.relation === "state_log_or_retraining_update") return `مرحلة حفظ الحالة أو تحديث log يمكن أن يغذي الدورة التالية (${status})`;
  if (step.relation === "downstream_consumer") return `مرحلة الاستهلاك اللاحق أو retraining/review (${status})`;
  if (step.relation === "frontend_to_api") return `مرحلة إرسال event/request من الواجهة (${status})`;
  if (step.relation === "api_to_backend") return `مرحلة استقبال الطلب في backend (${status})`;
  if (step.relation === "backend_to_storage") return `مرحلة كتابة أثر القرار أو النتيجة في storage/log (${status})`;
  return `${step.label} (${status})`;
}

function arabicLoopStageExplanation(relation: string) {
  if (relation === "decision_action_stage" || relation === "inner_model_decision") return "دي بداية الحلقة: النظام بيحوّل model/score/context إلى action أو قرار قابل للتنفيذ";
  if (relation === "feedback_or_outcome_stage") return "دي مرحلة الملاحظة بعد القرار: outcome أو feedback بيرجع يوضح نتيجة الاختيار";
  if (relation === "state_log_or_retraining_update") return "دي ذاكرة الحلقة: النتيجة أو الحالة بتتسجل بحيث ينفع تستخدمها دورة لاحقة";
  if (relation === "downstream_consumer") return "دي قفلة أقوى للحلقة: consumer لاحق يقرأ الناتج ويأثر على قرار أو تدريب جديد";
  if (relation === "frontend_to_api") return "دي وصلة عبور من الواجهة إلى backend، مهمة لو الحلقة تبدأ من user/event";
  if (relation === "api_to_backend") return "دي نقطة استقبال وتنفيذ في backend";
  if (relation === "backend_to_storage") return "دي نقطة persist/log تحفظ أثر القرار أو النتيجة";
  if (relation === "test_expected_endpoint") return "دي توقع اختبار فقط، مفيد للسلوك المتوقع لكنه ليس runtime proof";
  return "إشارة مرتبطة بالحلقة، لكن معناها الدقيق يعتمد على السطر المذكور";
}

function arabicLoopUncertainty(value: string, target: string) {
  if (value === "general_storage_not_target_proof") return `فيه storage عام، لكنه لا يثبت \`${target}\` إلا لو مربوط بنفس handler أو outcome`;
  if (value === "test_expectation_not_runtime_flow") return "الدليل القادم من tests يثبت توقعات، وليس أن runtime production ينفذ المسار فعلا";
  if (value === "next_cycle_effect") return "تأثير الدورة التالية غير مثبت بالكامل؛ محتاج consumer/job يقرأ الـ state ويغير قرار لاحق";
  if (value === "downstream_feedback_consumer") return "لم يظهر consumer لاحق كافي يثبت أن feedback/outcome يدخل في قرار جديد";
  if (value === "feedback_storage_or_log_usage") return "لم يظهر ربط كافي بين outcome/log وبين تخزين مستهدف للحلقة";
  return `الرابط غير المثبت: ${value}`;
}

function compactSnippet(snippet: string, max = 180) {
  const compact = snippet.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function englishMechanismRelation(step: MechanismChain["steps"][number]) {
  const status = step.status === "proven" ? "Proven" : step.status === "partial" ? "Partial" : "Unproven";
  const target = step.to ? ` to \`${step.to}\`` : "";
  if (step.relation === "frontend_surface") return `${status}: the UI has feedback state/control${step.ownerSymbol ? ` in \`${step.ownerSymbol}\`` : ""}.`;
  if (step.relation === "frontend_to_api") return `${status}: client code sends a request${target}.`;
  if (step.relation === "test_expected_endpoint") return `${status}: a test expects endpoint${target}, but this is not frontend runtime flow.`;
  if (step.relation === "api_to_backend") return `${status}: the backend has a matching handler${target}${step.ownerSymbol ? ` in \`${step.ownerSymbol}\`` : ""}.`;
  if (step.relation === "backend_to_storage") return `${status}: backend code writes/appends target data${target}.`;
  if (step.relation === "feedback_lifecycle_status") return `${status}: lifecycle/status evidence records feedback/outcome state.`;
  if (step.relation === "downstream_consumer") return `${status}: a downstream retraining/job/review consumer is present.`;
  if (step.relation === "decision_action_stage" || step.relation === "inner_model_decision") return `${status}: model/decision/action stage is present.`;
  if (step.relation === "feedback_or_outcome_stage") return `${status}: feedback/outcome stage is present.`;
  if (step.relation === "state_log_or_retraining_update") return `${status}: log/state/retraining update evidence is present.`;
  return `${status}: ${step.label}`;
}

function negativeFeedbackImpactEvidence(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
  const text = [
    input.conceptResolution.labelsOrModifiers.join(" "),
    input.conceptResolution.secondaryConcepts.join(" "),
    input.questionUnderstanding.topicPhrase,
    input.questionUnderstanding.topicTerms.join(" "),
    input.questionUnderstanding.normalizedTerms.join(" ")
  ].join("\n");
  const shouldExplain = /\bnegative|retrain|retraining|retraining_loop\b/i.test(text)
    || /(?:\u0633\u0644\u0628\u064a|\u0633\u0644\u0628\u0649|\u0627\u0639\u0627\u062f\u0629\s+\u062a\u062f\u0631\u064a\u0628|\u0625\u0639\u0627\u062f\u0629\s+\u062a\u062f\u0631\u064a\u0628)/.test(text);
  if (!shouldExplain) return { shouldExplain: false, refs: "" };
  const candidates = uniqueMechanismEvidence([
    ...input.mechanismEvidence.directMechanismEvidence,
    ...input.mechanismEvidence.backendHandlerEvidence,
    ...input.mechanismEvidence.downstreamConsumerEvidence,
    ...input.mechanismEvidence.targetScopedStorageEvidence,
    ...input.mechanismEvidence.statusOnlyEvidence,
    ...input.mechanismEvidence.contextOnlyEvidence
  ]).filter((item) => /negative|should_trigger_outer_loop|retrain_with_rollback|interpret_customer_feedback|submit_customer_feedback|_append_customer_feedback_log/i.test(`${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`));
  const sorted = candidates.sort((left, right) => negativeFeedbackEvidenceScore(right) - negativeFeedbackEvidenceScore(left) || left.path.localeCompare(right.path) || left.line - right.line);
  return { shouldExplain: true, refs: mechanismRefs(sorted.slice(0, 5)) };
}

function negativeFeedbackEvidenceScore(item: MechanismEvidence) {
  const text = `${item.path}\n${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`;
  let score = 0;
  if (/interpret_customer_feedback/i.test(text)) score += 80;
  if (/response_label.*negative|negative.*response_label|should_trigger_outer_loop/i.test(text)) score += 70;
  if (/retrain_with_rollback/i.test(text)) score += 60;
  if (/submit_customer_feedback/i.test(text)) score += 50;
  if (/_append_customer_feedback_log|CUSTOMER_FEEDBACK_LOG_PATH/i.test(text)) score += 30;
  return score;
}

function mechanismOutputNames(evidence: MechanismEvidenceBuckets, chain: MechanismChain) {
  return uniqueStrings([
    ...chain.steps.flatMap((step) => [step.to ?? "", step.relation.includes("status") ? "status/outcome" : ""]),
    ...evidence.statusOnlyEvidence.flatMap((item) => Array.from(item.snippet.matchAll(/\b(status|observed_outcome|selected_action_name|action_type|timing)\b/g)).map((match) => match[1] ?? "")),
    ...evidence.contextOnlyEvidence.flatMap((item) => Array.from(item.snippet.matchAll(/\b(status|selected_action_name|action_type|timing|low_gap|high_gap)\b/g)).map((match) => match[1] ?? "")),
    ...evidence.targetScopedStorageEvidence.flatMap((item) => item.storageTarget ? [item.storageTarget] : [])
  ]).filter((item) => item && !/^\//.test(item) && !/[\r\n]/.test(item)).sort((left, right) => feedbackNameScore(right) - feedbackNameScore(left)).slice(0, 10);
}

function feedbackNameScore(value: string) {
  if (/\bcustomer_feedback|customer-feedback|customer feedback|feedback_log|feedback[-_]?log\b/i.test(value)) return 100;
  if (/\bfeedback\b/i.test(value)) return 50;
  if (/\bretrain|retraining\b/i.test(value)) return 10;
  return 0;
}

function arabicConfidence(value: "high" | "medium" | "low") {
  if (value === "high") return "عالية";
  if (value === "medium") return "متوسطة";
  return "منخفضة";
}

function mechanismNames(evidence: MechanismEvidence[]) {
  return uniqueStrings(evidence.flatMap((item) => [
    item.endpoint ?? "",
    item.storageTarget ?? "",
    item.ownerSymbol ?? "",
    item.symbol ?? "",
    ...item.relatedNames
  ]))
    .filter((name) => !/^(section|lede|Tracks|how|Action|Testing)$/i.test(name))
    .slice(0, 6);
}

function arabicMechanismStep(step: MechanismChain["steps"][number]) {
  const owner = step.ownerSymbol ? ` داخل \`${step.ownerSymbol}\`` : "";
  const target = step.to ? ` إلى \`${step.to}\`` : "";
  if (step.role === "ui_state") return `الواجهة تحتفظ بحالة مرتبطة بالسؤال${owner}.`;
  if (step.role === "ui_event_handler") return `المستخدم يتفاعل مع control أو handler في الواجهة${owner}${target}.`;
  if (step.role === "api_client_call") return `الواجهة أو client code يرسل request${target}${owner}.`;
  if (step.role === "backend_route") return `الـ backend يعرّف route يستقبل الطلب${target}${owner}.`;
  if (step.role === "service_logic") return `الخدمة تعالج البيانات المرتبطة بالسؤال${owner}.`;
  if (step.role === "storage_target") return `يوجد هدف تخزين أو log مرتبط بالمفهوم${target}.`;
  if (step.role === "storage_write" || step.role === "log_append") return `الكود يكتب أو يضيف للـ log${target}${owner}.`;
  if (step.role === "storage_read") return `الكود يقرأ من التخزين أو الـ log${target}${owner}.`;
  if (step.role === "training_or_retraining") return `يوجد استهلاك لاحق في training/retraining${owner}.`;
  if (step.role === "job_or_scheduler") return `يوجد job أو scheduler مرتبط بالخطوة${owner}.`;
  return step.label;
}

function englishMechanismStep(step: MechanismChain["steps"][number]) {
  const owner = step.ownerSymbol ? ` in \`${step.ownerSymbol}\`` : "";
  const target = step.to ? ` to \`${step.to}\`` : "";
  if (step.role === "api_client_call") return `Client code sends a request${target}${owner}.`;
  if (step.role === "backend_route") return `Backend route receives the request${target}${owner}.`;
  if (step.role === "storage_write" || step.role === "log_append") return `Code writes/appends target data${target}${owner}.`;
  return `${step.label}.`;
}

function linkFromRef(ref: string) {
  const match = ref.match(/^(.+):(\d+)$/);
  return link(match?.[1] ?? ref, match?.[2] ? Number(match[2]) : 1);
}

function parseEvidenceRef(ref: string) {
  const match = ref.match(/^(.+):(\d+)$/);
  if (!match) return undefined;
  return {
    path: (match[1] ?? "").replaceAll("\\", "/"),
    line: Number(match[2])
  };
}

type ForecastingAssessmentSignal =
  | "model_type"
  | "scope"
  | "training_path"
  | "runtime_path"
  | "score_impact"
  | "data_validity"
  | "drift_logic";

type ForecastingAssessmentEvidence = {
  signal: ForecastingAssessmentSignal;
  path: string;
  line: number;
  snippet: string;
};

type ForecastingAssessment = {
  modelType: "SARIMAX/SARIMA" | "SARIMA" | "ARIMA" | "forecasting/trend logic" | "unknown";
  scope: "cluster_level" | "per_customer" | "aggregate_global" | "mixed" | "unknown";
  hasPersistenceFallback: boolean;
  hasScoreNormalizationIssue: boolean;
  hasSyntheticTimeSignals: boolean;
  evidence: ForecastingAssessmentEvidence[];
};

function isForecastingAssessmentQuestion(question: string, understanding: ProjectQuestionUnderstanding) {
  if (isStructuralFileContextQuestion(question)) return false;
  if (isDecisionPolicyQuestion(question, understanding)) return false;
  const normalizedTarget = normalizeTerm(understanding.targetConcept);
  const text = `${question}\n${understanding.topicPhrase}\n${understanding.topicTerms.join(" ")}\n${understanding.entities.join(" ")}`;
  const asksForecasting = normalizedTarget === "sarima"
    || /\b(forecast|forecasting|sarima|sarimax|arima|trend_multiplier|trend|drift)\b/i.test(text);
  if (!asksForecasting) return false;
  return true;
}

function isDecisionPolicyQuestion(question: string, understanding: ProjectQuestionUnderstanding) {
  const text = normalizeTerm([
    question,
    understanding.topicPhrase,
    understanding.targetConcept,
    ...understanding.topicTerms,
    ...understanding.normalizedTerms,
    ...understanding.entities,
    ...understanding.requiredFacets
  ].join(" "));
  const asksDecision =
    /\b(when|why|how|decide|decides|decision|rule|rules|policy|route|routing|orchestrator|choose|instead|versus|vs|link|connect)\b/i.test(text)
    || /(?:\u0627\u0645\u062a\u0649|\u064a\u0642\u0631\u0631|\u0644\u064a\u0647|\u0627\u0632\u0627\u064a|\u0627\u0631\u0628\u0637|\u0642\u0648\u0627\u0639\u062f|\u0642\u0631\u0627\u0631|\u0628\u062f\u0644|\u064a\u0628\u0639\u062a)/u.test(text);
  const hasActionChoice =
    /\b(re\s*[- ]?\s*cluster|recluster|offer|strong offer|retention offer|human review|no action|dispatch|selected_action_name|recommended_action_name|selected action|recommended action)\b/i.test(text);
  const hasRoutingTerms =
    /\b(orchestrator|choose_route|route_result|routing|weighted_votes|weighted_winner|agent_consensus|agent_recommendations|selected_action_name|recommended_action_name|selected action|recommended action|dispatch)\b/i.test(text);
  const hasRoutingEvidence =
    /\b(drift|drift_detected|drift detection|membership|membership_strength|fcm|orchestrator|choose_route|agent_recommendations|weighted_votes|weighted_winner|agent_consensus|route_result)\b/i.test(text);
  return asksDecision && (hasActionChoice || (hasRoutingTerms && hasRoutingEvidence));
}

function forecastingQuestionRequestsJudgment(question: string) {
  return /\b(wrong|correct|logical|logic|reasonable|sensible|valid|invalid|bug|flaw|production|demo|academic)\b/i.test(question)
    || /(?:منطقي|غلط|صح|صحيح|خطأ|خطا|مقبول|ينفع|مش\s+منطقي|متطبق\s+غلط|بشكل\s+غلط|ب\s*شكل\s+غلط|هل\s+دا)/u.test(question);
}

function buildForecastingAssessment(input: {
  question: string;
  positiveEvidence: ProjectQuestionEvidence[];
  projectSourceFiles: string[];
  readFile: (relativePath: string) => string;
}): ForecastingAssessment {
  const evidence: ForecastingAssessmentEvidence[] = [];
  const candidateFiles = uniqueStrings([
    ...input.positiveEvidence.map((item) => item.path),
    ...input.projectSourceFiles.filter((filePath) => /forecast|arima|sarima|model|routes?|service|agents?|orchestrator|data_generator|generator|train|predict/i.test(filePath))
  ]).filter((filePath) => SOURCE_FILE_RE.test(filePath));

  for (const filePath of candidateFiles.slice(0, 160)) {
    let content = "";
    try {
      content = input.readFile(filePath);
    } catch {
      continue;
    }
    collectForecastingEvidenceFromFile(filePath, content, evidence);
  }

  const evidenceText = evidence.map((item) => `${item.path}\n${item.snippet}`).join("\n");
  const modelType = /\bSARIMAX\b/i.test(evidenceText)
    ? "SARIMAX/SARIMA"
    : /\bSARIMA|SARIMAForecastingService\b/i.test(evidenceText)
      ? "SARIMA"
      : /\bARIMA\b/i.test(evidenceText)
        ? "ARIMA"
        : /\bforecast|trend_multiplier|drift_detected\b/i.test(evidenceText)
          ? "forecasting/trend logic"
          : "unknown";
  const clusterScoped = /\b(cluster_forecasts|cluster_series|cluster_trend_multipliers|cluster_label|cluster_id|fit_cluster_models|get_cluster_state|predicted_cluster|per-cluster|cluster-level)\b/i.test(evidenceText);
  const perCustomer = /\b(customer_history|customer_series|forecast_customer|per customer|customer-level|for customer)\b/i.test(evidenceText);
  const aggregate = /\b(global_history|get_global_history|aggregate|overall|all customers|portfolio|cohort)\b/i.test(evidenceText);
  const scope = clusterScoped
    ? "cluster_level"
    : perCustomer && aggregate
      ? "mixed"
      : perCustomer
        ? "per_customer"
        : aggregate
          ? "aggregate_global"
          : "unknown";
  return {
    modelType,
    scope,
    hasPersistenceFallback: /\b(persistence|fallback|last observed|last value|naive)\b/i.test(evidenceText),
    hasScoreNormalizationIssue: /normalized_trend\s*=\s*max\([^=\n]+trend_multiplier[^=\n]+\)\s*\/\s*1\.25/i.test(evidenceText)
      || /\/\s*1\.25/.test(evidenceText) && /\bnormalized_trend|trend_multiplier\b/i.test(evidenceText),
    hasSyntheticTimeSignals: /\b(behavior_period|stable_period|drift_period|period_date|month|synthetic|random)\b/i.test(evidenceText),
    evidence: uniqueForecastingEvidence(evidence).slice(0, 80)
  };
}

function collectForecastingEvidenceFromFile(filePath: string, content: string, evidence: ForecastingAssessmentEvidence[]) {
  const lines = content.split(/\r?\n/);
  const patterns: Array<{ signal: ForecastingAssessmentSignal; re: RegExp }> = [
    { signal: "model_type", re: /\b(SARIMAForecastingService|SARIMAX|SARIMA|ARIMA|statsmodels\.tsa|persistence|fallback)\b/i },
    { signal: "scope", re: /\b(build_cluster_series|cluster_series|cluster_forecasts|cluster_trend_multipliers|cluster_label|cluster_id|groupby|get_cluster_state|predicted_cluster|global_history|churn_label|mean)\b/i },
    { signal: "training_path", re: /\b(fit_cluster_models|save_state|train_offline_artifacts|retrain_with_rollback|training_y|clean_df)\b/i },
    { signal: "runtime_path", re: /\b(get_cluster_state|predicted_cluster|forecast_state|process_customer|predict|prediction)\b/i },
    { signal: "score_impact", re: /\b(_compute_intelligent_score|calculate_intelligent_score|intelligent_score|trend_multiplier|normalized_trend|\/\s*1\.25)\b/i },
    { signal: "data_validity", re: /\b(behavior_period|stable_period|drift_period|period_date|month|data_generator|synthetic|random|global_history|churn_label)\b/i },
    { signal: "drift_logic", re: /\b(drift_detected|massive_drift|deviation|delta|trend_direction|forecast_values)\b/i }
  ];
  const perSignalCount = new Map<ForecastingAssessmentSignal, number>();
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const current = perSignalCount.get(pattern.signal) ?? 0;
      if (current >= maxForecastingSignalMatches(pattern.signal)) continue;
      if (!pattern.re.test(line)) continue;
      evidence.push({
        signal: pattern.signal,
        path: filePath,
        line: index + 1,
        snippet: snippetAround(lines, index)
      });
      perSignalCount.set(pattern.signal, current + 1);
    }
  });
}

function maxForecastingSignalMatches(signal: ForecastingAssessmentSignal) {
  if (signal === "score_impact" || signal === "runtime_path" || signal === "scope") return 24;
  if (signal === "training_path" || signal === "data_validity") return 16;
  return 8;
}

function uniqueForecastingEvidence(evidence: ForecastingAssessmentEvidence[]) {
  const seen = new Set<string>();
  const signalPriority: Record<ForecastingAssessmentSignal, number> = {
    model_type: 100,
    scope: 95,
    training_path: 90,
    runtime_path: 88,
    score_impact: 86,
    data_validity: 82,
    drift_logic: 70
  };
  return evidence
    .filter((item) => {
      const key = `${item.signal}:${item.path}:${item.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const priorityDelta = signalPriority[right.signal] - signalPriority[left.signal];
      if (priorityDelta) return priorityDelta;
      const pathDelta = forecastingPathScore(right.path) - forecastingPathScore(left.path);
      if (pathDelta) return pathDelta;
      return left.line - right.line;
    });
}

function forecastingPathScore(filePath: string) {
  let score = sourceScore(filePath);
  if (/arima|forecast|model/i.test(filePath)) score += 40;
  if (/routes?|api|controller/i.test(filePath)) score += 30;
  if (/data_generator|generator/i.test(filePath)) score += 25;
  if (/tests?|\.(test|spec)\./i.test(filePath)) score -= 50;
  return score;
}

function composeForecastingAssessmentAnswer(assessment: ForecastingAssessment, language: WorkspaceIntentUnderstanding["language"]) {
  return language === "arabic"
    ? composeArabicForecastingAssessmentAnswer(assessment)
    : composeEnglishForecastingAssessmentAnswer(assessment);
}

function evidenceBySignal(assessment: ForecastingAssessment, signal: ForecastingAssessmentSignal) {
  return assessment.evidence.filter((item) => item.signal === signal);
}

function evidenceMatching(assessment: ForecastingAssessment, pattern: RegExp) {
  return assessment.evidence.filter((item) => pattern.test(`${item.path}\n${item.snippet}`));
}

function formatForecastingRefs(items: ForecastingAssessmentEvidence[], limit = 3) {
  return items.slice(0, limit).map((item) => link(item.path, item.line)).join(", ");
}

function composeArabicForecastingAssessmentAnswer(assessment: ForecastingAssessment) {
  const modelRefs = formatForecastingRefs(evidenceBySignal(assessment, "model_type"));
  const scopeRefs = formatForecastingRefs(evidenceBySignal(assessment, "scope"));
  const trainingRefs = formatForecastingRefs(evidenceBySignal(assessment, "training_path"));
  const runtimeRefs = formatForecastingRefs([
    ...evidenceBySignal(assessment, "runtime_path"),
    ...evidenceMatching(assessment, /\b(get_cluster_state|predicted_cluster|forecast_state)\b/i)
  ]);
  const scoreRefs = formatForecastingRefs([
    ...evidenceBySignal(assessment, "score_impact"),
    ...evidenceMatching(assessment, /\b(trend_multiplier|normalized_trend|\/\s*1\.25|intelligent_score)\b/i)
  ]);
  const dataRefs = formatForecastingRefs(evidenceBySignal(assessment, "data_validity"));
  const scopeSentence = assessment.scope === "cluster_level"
    ? "متطبق كـ `cluster-level / per-cluster churn trend signal`: النظام يبني forecast لكل cluster/segment، وبعدها يستخدم `predicted_cluster` أو `get_cluster_state` عشان يجيب forecast الخاص بالـ cluster."
    : assessment.scope === "per_customer"
      ? "الأدلة تميل إلى forecast مرتبط بالـ customer نفسه، لكن لازم يتراجع هل فيه history حقيقي لكل customer."
      : assessment.scope === "aggregate_global"
        ? "الأدلة تميل إلى forecast aggregate/global، مش model مستقل لكل customer."
        : "الـ scope غير مثبت كفاية من الأدلة المقروءة.";
  const scoreSentence = assessment.hasScoreNormalizationIssue
    ? "فيه نقطة منطقية مهمة: `normalized_trend = ... / 1.25` تجعل `trend_multiplier` ليس multiplier حقيقي للسكور. مثلًا `1.15` تتحول تقريبًا إلى `0.92`، فزيادة الخطر لا ترفع السكور فعليًا، لكنها تقلله أقل من stable/decreasing."
    : "لم أجد في الأدلة صيغة `normalized_trend = ... / 1.25`، لذلك لا أقدر أثبت مشكلة multiplier من السطور المقروءة.";
  const dataSentence = assessment.hasSyntheticTimeSignals
    ? "جودة الـ forecasting محدودة لو الزمن مبني من `behavior_period` و`month` أو data synthetic/صف واحد لكل customer؛ ده يصلح demo/academic أكثر من production forecasting."
    : "لم أجد دليل واضح على synthetic time أو history ضعيف؛ لذلك الحكم على جودة البيانات يفضل يبقى بحذر.";
  const lines = [
    "## الخلاصة",
    `الـ forecasting هنا نوعه \`${assessment.modelType}\`، و${scopeSentence}`,
    "الحكم: مقبول كـ demo/academic signal لو الهدف متابعة churn trend على مستوى cluster، لكنه ضعيف أو مضلل كـ production customer-level forecast لو مفيش time-series حقيقي لكل customer.",
    "",
    "## إزاي بيتطبق",
    `- نوع النموذج: \`${assessment.modelType}\`${modelRefs ? ` مثبت من ${modelRefs}` : "، لكن لم أجد سطر نموذج قوي كفاية."}.`,
    `- الـ scope: ${scopeSentence}${scopeRefs ? ` الدليل: ${scopeRefs}.` : ""}`,
    `- التدريب/بناء الحالة: بيدور حول \`fit_cluster_models\` و\`save_state\`${trainingRefs ? ` في ${trainingRefs}` : "، لكن مكانه التفصيلي غير مثبت من الأدلة الحالية."}.`,
    `- وقت الـ runtime: المفروض يسترجع forecast cluster عبر \`get_cluster_state(predicted_cluster)\`${runtimeRefs ? ` في ${runtimeRefs}` : "، لو الأدلة دي موجودة في المشروع."}.`,
    `- تأثيره على القرار: \`trend_multiplier\` يدخل في intelligent score أو scoring logic${scoreRefs ? ` في ${scoreRefs}` : "، لكن لم أجد formula كافية."}.`,
    "",
    "## هل ده منطقي؟",
    `- المنطقي: استخدام forecast على مستوى cluster ممكن يكون إشارة مساعدة للـ agent: هل خطر الـ churn في segment معين بيزيد أو بيقل.`,
    `- غير المنطقي/المحدود: ${dataSentence}`,
    `- خلل الـ score المحتمل: ${scoreSentence}`,
    "",
    "## الحكم النهائي",
    "ده ليس forecast حقيقي للعميل الفردي إلا لو المشروع عنده history زمني حقيقي لكل customer. الأدلة الأقوى تقول إنه cluster-level churn trend signal. كـ demo مفهوم؛ كـ production forecasting محتاج backtesting، history حقيقي، وفصل أوضح بين probability للعميل وtrend للـ cluster."
  ];
  const snippets = assessment.evidence
    .filter((item) => item.signal === "score_impact" || item.signal === "scope" || item.signal === "data_validity")
    .slice(0, 3);
  if (snippets.length) {
    lines.push("", "## مقتطفات حاسمة");
    for (const item of snippets) {
      lines.push(`من ${link(item.path, item.line)}:`);
      lines.push("```");
      lines.push(formatSnippetBlock(item.snippet));
      lines.push("```");
    }
  }
  return lines.join("\n");
}

function composeEnglishForecastingAssessmentAnswer(assessment: ForecastingAssessment) {
  const modelRefs = formatForecastingRefs(evidenceBySignal(assessment, "model_type"));
  const scopeRefs = formatForecastingRefs(evidenceBySignal(assessment, "scope"));
  const trainingRefs = formatForecastingRefs(evidenceBySignal(assessment, "training_path"));
  const runtimeRefs = formatForecastingRefs([
    ...evidenceBySignal(assessment, "runtime_path"),
    ...evidenceMatching(assessment, /\b(get_cluster_state|predicted_cluster|forecast_state)\b/i)
  ]);
  const scoreRefs = formatForecastingRefs([
    ...evidenceBySignal(assessment, "score_impact"),
    ...evidenceMatching(assessment, /\b(trend_multiplier|normalized_trend|\/\s*1\.25|intelligent_score)\b/i)
  ]);
  const scopeSentence = assessment.scope === "cluster_level"
    ? "implemented as a cluster-level / per-cluster churn trend signal, not a fresh customer-level forecast"
    : assessment.scope === "per_customer"
      ? "appears customer-scoped, but the real customer history needs to be checked"
      : assessment.scope === "aggregate_global"
        ? "appears aggregate/global rather than customer-specific"
        : "not proven clearly enough from the inspected files";
  const lines = [
    "## Summary",
    `The forecasting here is \`${assessment.modelType}\` and ${scopeSentence}.`,
    "Verdict: reasonable as a demo/academic trend signal, weak as production-grade customer forecasting unless the project has real time-series history per customer.",
    "",
    "## How It Runs",
    `- Model type: \`${assessment.modelType}\`${modelRefs ? ` from ${modelRefs}` : ""}.`,
    `- Scope: ${scopeSentence}${scopeRefs ? ` Evidence: ${scopeRefs}.` : ""}`,
    `- Training/state path: \`fit_cluster_models\` / \`save_state\`${trainingRefs ? ` in ${trainingRefs}` : " appears in the local synthesis, but the exact training citation was not retained in the compact evidence slice"}.`,
    `- Runtime path: \`get_cluster_state(predicted_cluster)\`${runtimeRefs ? ` in ${runtimeRefs}` : " is the inferred cluster lookup path from the cluster-scope evidence"}.`,
    `- Score impact: \`trend_multiplier\`${scoreRefs ? ` in ${scoreRefs}` : assessment.hasScoreNormalizationIssue ? " is present through the `normalized_trend = ... / 1.25` scoring formula." : " was not fully proven from the inspected evidence"}.`,
    "",
    "## Logic Assessment",
    assessment.hasSyntheticTimeSignals
      ? "- Data validity risk: the evidence includes synthetic/derived time signals such as `behavior_period`, `month`, or `period_date`, so this is not strong production forecasting evidence by itself."
      : "- Data validity: I did not find enough evidence to prove whether the time history is synthetic or real.",
    assessment.hasScoreNormalizationIssue
      ? "- Score issue: `normalized_trend = ... / 1.25` means `trend_multiplier` is not used as a true multiplier. An increasing-risk `1.15` becomes about `0.92`, so it does not actually boost the score; it only penalizes less."
      : "- Score issue: I did not find the `/ 1.25` normalization pattern in the inspected evidence.",
    "",
    "## Final Verdict",
    "This is best described as a cluster churn trend signal. It is acceptable for a demo, but if the product claims customer-level forecasting, that claim is not supported by this implementation."
  ];
  return lines.join("\n");
}

function mechanismRefs(evidence: MechanismEvidence[]) {
  return evidence
    .slice(0, 3)
    .map((item) => link(item.path, item.line))
    .join(", ");
}

function arabicMissingMechanismLink(value: string) {
  if (value === "frontend_feedback_surface") return "واجهة أو state feedback";
  if (value === "frontend_to_backend_request") return "request يربط الواجهة بالـ backend";
  if (value === "backend_feedback_handler") return "route أو service تستقبل feedback";
  if (value === "feedback_storage_or_log_usage") return "قراءة أو كتابة feedback في storage/log";
  if (value === "downstream_feedback_consumer") return "مستهلك لاحق مثل retraining أو review مثبت باعتماد بيانات";
  return value;
}

function composeResolutionAwareAnswer(input: {
  question: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
  conceptResolution: ConceptResolution;
  negativeEvidence: string[];
  intent: WorkspaceIntentUnderstanding;
}) {
  if (input.conceptResolution.resolutionStatus === "direct_found" && input.conceptFlow.steps.length) {
    return composeConceptCentricAnswer(input);
  }
  return input.intent.language === "arabic"
    ? composeArabicResolutionAwareAnswer(input)
    : composeEnglishResolutionAwareAnswer(input);
}

function composeArabicResolutionAwareAnswer(input: Parameters<typeof composeResolutionAwareAnswer>[0]) {
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const resolution = input.conceptResolution;
  const targetEvidence = uniqueEvidence([
    ...resolution.directTargetEvidence,
    ...resolution.aliasTargetEvidence,
    ...resolution.behavioralTargetEvidence,
    ...resolution.architecturalPatternEvidence
  ]);
  const lines: string[] = ["## النتيجة"];
  if (resolution.resolutionStatus === "not_found") {
    lines.push(`لم أقدر أثبت \`${target}\` من ملفات المشروع الحالية.`);
    if (resolution.generalProjectEvidence.length) {
      lines.push("لقيت أدلة عامة في المشروع، لكنها لا تثبت إن المفهوم المطلوب موجود أو متطبق.");
    }
  } else if (resolution.resolutionStatus === "architectural_pattern_found") {
    lines.push(`لم أجد اسم \`${target}\` حرفيًا، لكن وجدت نمطًا معماريًا قريبًا بثقة ${resolution.confidence}.`);
  } else if (resolution.resolutionStatus === "behavioral_found") {
    lines.push(`لم أجد الاسم كاستدعاء مباشر كافي، لكن وجدت سلوكًا قريبًا من \`${target}\` بثقة ${resolution.confidence}.`);
  } else if (resolution.resolutionStatus === "alias_found") {
    lines.push(`لم أجد \`${target}\` بنفس الاسم فقط، لكن وجدت alias أو تسمية قريبة مدعومة بأدلة.`);
  } else {
    lines.push(`وجدت \`${target}\` كدليل مباشر في المشروع.`);
  }

  lines.push("");
  lines.push("## هل الاسم موجود حرفيًا؟");
  if (resolution.directTargetEvidence.length) {
    for (const item of resolution.directTargetEvidence.slice(0, 4)) lines.push(`- نعم: ${summarizeEvidence(item)} ${item.markdownLink}`);
  } else {
    const searched = resolution.literalTerms.slice(0, 5).map((term) => `\`${term}\``).join(", ");
    lines.push(`- لم يظهر دليل مباشر كافٍ للاسم بعد البحث عن: ${searched || `\`${target}\``}.`);
  }

  if (resolution.aliasTargetEvidence.length || resolution.behavioralTargetEvidence.length || resolution.architecturalPatternEvidence.length) {
    lines.push("");
    lines.push("## الأدلة القريبة أو النمط المعماري");
    for (const item of targetEvidence.filter((item) => !resolution.directTargetEvidence.some((direct) => direct.ref === item.ref)).slice(0, 6)) {
      lines.push(`- ${summarizeEvidence(item)} ${item.markdownLink}`);
    }
  }

  if (input.conceptFlow.steps.length) {
    lines.push("");
    lines.push("## تسلسل التنفيذ المثبت");
    for (const step of input.conceptFlow.steps) {
      lines.push(`- ${step.ownerSymbol}: ${arabicStepDescription(target, step)} ${link(step.evidenceRef.split(":").slice(0, -1).join(":") || step.evidenceRef, Number(step.evidenceRef.split(":").pop()) || 1)}`);
    }
  }

  const outputs = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.outputNames));
  const consumers = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.nextConsumers));
  lines.push("");
  lines.push("## النواتج والربط اللاحق");
  if (outputs.length) lines.push(`- النواتج المثبتة: ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
  else lines.push("- لم تظهر نواتج مباشرة مثبتة لهذا المفهوم.");
  if (consumers.length) lines.push(`- الربط اللاحق المثبت: ${consumers.map((item) => `\`${item}\``).join(", ")}.`);
  else lines.push("- لم يظهر مستهلك لاحق مثبت لهذا المفهوم.");

  lines.push("");
  lines.push("## ما لم يثبت");
  const uncertainties = uniqueStrings([...input.conceptFlow.uncertainties, ...resolution.userVisibleNegativeEvidence]);
  if (uncertainties.length) {
    for (const item of uncertainties.slice(0, 5)) lines.push(`- ${arabicUncertainty(item)}`);
  } else if (resolution.resolutionStatus === "not_found") {
    lines.push("- لا يوجد direct أو alias أو behavioral أو architectural evidence كافي للمفهوم المطلوب.");
  } else {
    lines.push("- أي تفاصيل خارج الملفات المذكورة غير مفترضة.");
  }
  return lines.join("\n");
}

function composeEnglishResolutionAwareAnswer(input: Parameters<typeof composeResolutionAwareAnswer>[0]) {
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const resolution = input.conceptResolution;
  const targetEvidence = uniqueEvidence([
    ...resolution.directTargetEvidence,
    ...resolution.aliasTargetEvidence,
    ...resolution.behavioralTargetEvidence,
    ...resolution.architecturalPatternEvidence
  ]);
  const lines: string[] = ["## Result"];
  if (resolution.resolutionStatus === "not_found") {
    lines.push(`I could not prove \`${target}\` from the current project files.`);
    if (resolution.generalProjectEvidence.length) lines.push("I found general project evidence, but it does not prove the requested concept.");
  } else if (resolution.resolutionStatus === "architectural_pattern_found") {
    lines.push(`I did not find the literal name \`${target}\`, but I found a nearby architectural pattern with ${resolution.confidence} confidence.`);
  } else {
    lines.push(`I found target-scoped evidence for \`${target}\` with status \`${resolution.resolutionStatus}\`.`);
  }
  lines.push("");
  lines.push("## Evidence");
  if (targetEvidence.length) {
    for (const item of targetEvidence.slice(0, 8)) lines.push(`- ${summarizeEvidence(item)} ${item.markdownLink}`);
  } else {
    lines.push(`- No direct, alias, behavioral, or architectural-pattern evidence was found for \`${target}\`.`);
  }
  const outputs = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.outputNames));
  const consumers = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.nextConsumers));
  lines.push("");
  lines.push("## Outputs And Downstream");
  lines.push(outputs.length ? `- Proven outputs: ${outputs.map((item) => `\`${item}\``).join(", ")}.` : "- No direct outputs were proven for this concept.");
  lines.push(consumers.length ? `- Proven downstream links: ${consumers.map((item) => `\`${item}\``).join(", ")}.` : "- No downstream consumer was proven for this concept.");
  return lines.join("\n");
}

function composeConceptCentricAnswer(input: {
  question: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
  negativeEvidence: string[];
  intent: WorkspaceIntentUnderstanding;
}) {
  if (input.intent.language === "arabic") {
    return composeArabicConceptCentricAnswer(input);
  }
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const primary = input.implementationEvidence.filter((item) => item.semanticRole === "implementation");
  const secondary = input.implementationEvidence.filter((item) => item.semanticRole === "orchestration" || item.semanticRole === "downstream_stage" || item.semanticRole === "artifact_preparation");
  const main = primary[0] ?? input.implementationEvidence[0];
  const lines = [
    "## Summary",
    `This answer is centered on \`${target}\`, not the whole project pipeline. The strongest implementation evidence is ${main?.markdownLink ?? input.positiveEvidence[0]?.markdownLink ?? "not available"}.`,
    ""
  ];

  lines.push("## Concept Flow");
  for (const step of input.conceptFlow.steps) {
    lines.push(`### ${step.order}. ${step.label}`);
    lines.push(`- What happens: ${step.whatHappens}`);
    lines.push(`- Evidence role: ${step.semanticRole} (${step.roleReason}).`);
    if (step.inputData) lines.push(`- Input data: \`${step.inputData}\`.`);
    if (step.parameters.length) lines.push(`- Parameters/arguments: ${step.parameters.map((item) => `\`${item}\``).join(", ")}.`);
    if (step.outputNames.length) lines.push(`- Output: ${step.outputNames.map((item) => `\`${item}\``).join(", ")}.`);
    if (step.nextConsumers.length) lines.push(`- Related downstream/upstream names: ${step.nextConsumers.map((item) => `\`${item}\``).join(", ")}.`);
    lines.push(`- Evidence: ${link(step.evidenceRef.split(":").slice(0, -1).join(":") || step.evidenceRef, Number(step.evidenceRef.split(":").pop()) || 1)}.`);
    lines.push("");
  }

  lines.push("## Direct Answers");
  lines.push(`- Where: ${primary.map((item) => item.markdownLink).slice(0, 4).join(", ") || main?.markdownLink || "not proven from implementation files"}.`);
  lines.push(`- Evidence roles: ${primary.length ? "direct implementation is available and preferred over orchestration, downstream, tests, docs, or visualization evidence." : "no direct implementation source was stronger than secondary evidence."}`);
  const allParams = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.parameters));
  if (allParams.length) lines.push(`- Parameters: ${allParams.map((item) => `\`${item}\``).join(", ")}.`);
  const outputs = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.outputNames.length ? step.outputNames : [step.output ?? ""]).filter(Boolean));
  if (outputs.length) lines.push(`- Outputs/assigned values: ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
  const routeEvidence = secondary.filter((item) => item.semanticRole === "orchestration" || item.semanticRole === "downstream_stage" || item.semanticRole === "artifact_preparation");
  if (routeEvidence.length) {
    const relatedNames = uniqueStrings(routeEvidence.flatMap((item) => [...item.symbols, ...item.calls.map((call) => call.name)])).slice(0, 8);
    lines.push(`- Relationship/usage: ${routeEvidence.map((item) => `${item.semanticRole} ${item.markdownLink}`).slice(0, 3).join(", ")} shows how the implementation is wired or consumed later${relatedNames.length ? ` through ${relatedNames.map((item) => `\`${item}\``).join(", ")}` : ""}.`);
  }
  if (!/\b(joblib|pickle|dump|load|save|store)\b/i.test(input.implementationEvidence.map((item) => item.snippet).join("\n"))) {
    lines.push("- Persistence/storage: not proven for this concept from the inspected implementation evidence.");
  }
  lines.push("");

  const snippets = input.implementationEvidence
    .filter((item) => item.semanticRole === "implementation")
    .slice(0, input.questionUnderstanding.wantsCodeExamples || input.questionUnderstanding.detailLevel === "deep" ? 3 : 2);
  if (snippets.length) {
    lines.push("## Important Snippets");
    for (const item of snippets) {
      lines.push(`From ${item.markdownLink}:`);
      lines.push("```");
      lines.push(formatSnippetBlock(item.snippet));
      lines.push("```");
    }
    lines.push("");
  }

  lines.push("## Uncertainty");
  const uncertainties = uniqueStrings([
    ...input.conceptFlow.uncertainties,
    ...input.negativeEvidence.filter((item) => item.toLowerCase().includes(target.toLowerCase())).slice(0, 2)
  ]);
  if (uncertainties.length) {
    for (const item of uncertainties) lines.push(`- ${item}`);
  } else {
    lines.push("- The answer is limited to the cited implementation paths; behavior outside those files is left unclaimed.");
  }

  return lines.join("\n");
}

function composeArabicConceptCentricAnswer(input: {
  question: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
  negativeEvidence: string[];
  intent: WorkspaceIntentUnderstanding;
}) {
  const target = input.questionUnderstanding.targetConcept || input.questionUnderstanding.topicPhrase;
  const primary = input.implementationEvidence.filter((item) => item.semanticRole === "implementation");
  const secondary = input.implementationEvidence.filter((item) => item.semanticRole === "orchestration" || item.semanticRole === "downstream_stage");
  const main = primary[0] ?? input.implementationEvidence[0];
  const lines = [
    "## الخلاصة",
    `الإجابة هنا مركزة على \`${target}\` نفسه، مش على فلو المشروع كله. أقوى دليل للتنفيذ المباشر هو ${main?.markdownLink ?? input.positiveEvidence[0]?.markdownLink ?? "غير متاح"}.`,
    ""
  ];

  lines.push("## تسلسل التنفيذ الخاص بالمفهوم");
  for (const step of input.conceptFlow.steps) {
    lines.push(`### ${step.order}. ${step.label}`);
    lines.push(`- ماذا يحدث: ${arabicStepDescription(target, step)}`);
    lines.push(`- نوع الدليل: ${arabicRoleSummary(step.semanticRole)}.`);
    if (step.inputData) lines.push(`- البيانات الداخلة: \`${step.inputData}\`.`);
    if (step.parameters.length) lines.push(`- الـ parameters/arguments: ${step.parameters.map((item) => `\`${item}\``).join(", ")}.`);
    if (step.outputNames.length) lines.push(`- الناتج: ${step.outputNames.map((item) => `\`${item}\``).join(", ")}.`);
    if (step.nextConsumers.length) lines.push(`- أسماء مرتبطة قبل/بعد الخطوة: ${step.nextConsumers.map((item) => `\`${item}\``).join(", ")}.`);
    lines.push(`- الدليل: ${link(step.evidenceRef.split(":").slice(0, -1).join(":") || step.evidenceRef, Number(step.evidenceRef.split(":").pop()) || 1)}.`);
    lines.push("");
  }

  lines.push("## إجابات مباشرة");
  lines.push(`- المكان: ${primary.map((item) => item.markdownLink).slice(0, 4).join(", ") || main?.markdownLink || "غير مثبت من ملفات implementation"}.`);
  lines.push(`- فصل الأدوار: ${primary.length ? "فيه تنفيذ مباشر مثبت، والـ wrappers أو التحضير أو الاستخدام اللاحق بيتعاملوا كأدلة مساعدة فقط." : "لم يظهر تنفيذ مباشر أقوى من الأدلة الثانوية."}`);
  const allParams = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.parameters));
  if (allParams.length) lines.push(`- الـ parameters: ${allParams.map((item) => `\`${item}\``).join(", ")}.`);
  const outputs = uniqueStrings(input.conceptFlow.steps.flatMap((step) => step.outputNames.length ? step.outputNames : [step.output ?? ""]).filter(Boolean));
  if (outputs.length) lines.push(`- النواتج أو المتغيرات الناتجة: ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
  if (secondary.length) {
    lines.push(`- الاستخدام أو الربط اللاحق: ${summarizeArabicRelationships(secondary)}.`);
  }
  if (!/\b(joblib|pickle|dump|load|save|store)\b/i.test(input.implementationEvidence.map((item) => item.snippet).join("\n"))) {
    lines.push("- التخزين: غير مثبت لهذا المفهوم من أدلة implementation التي تم فحصها.");
  }
  lines.push("");

  const snippets = input.implementationEvidence
    .filter((item) => item.semanticRole === "implementation")
    .slice(0, input.questionUnderstanding.wantsCodeExamples || input.questionUnderstanding.detailLevel === "deep" ? 3 : 2);
  if (snippets.length) {
    lines.push("## مقتطفات مهمة");
    for (const item of snippets) {
      lines.push(`من ${item.markdownLink}:`);
      lines.push("```");
      lines.push(formatSnippetBlock(item.snippet));
      lines.push("```");
    }
    lines.push("");
  }

  lines.push("## غير مؤكد");
  const uncertainties = uniqueStrings([
    ...input.conceptFlow.uncertainties,
    ...input.negativeEvidence.filter((item) => item.toLowerCase().includes(target.toLowerCase())).slice(0, 2)
  ]);
  if (uncertainties.length) {
    for (const item of uncertainties) lines.push(`- ${arabicUncertainty(item)}`);
  } else {
    lines.push("- الإجابة مقيدة بالملفات المذكورة فقط؛ أي سلوك خارج الأدلة دي غير مفترض.");
  }

  return lines.join("\n");
}

function arabicStepDescription(target: string, step: ConceptFlow["steps"][number]) {
  const params = step.parameters.length ? ` بالـ parameters ${step.parameters.map((item) => `\`${item}\``).join(", ")}` : "";
  const output = step.outputNames.length ? ` والناتج المتغيرات ${step.outputNames.map((item) => `\`${item}\``).join(", ")}` : "";
  const inputData = step.inputData ? ` الدالة بتشتغل على \`${step.inputData}\`` : " الدالة بتشتغل على البيانات اللي داخلة لها في نفس موضع التنفيذ";
  if (target === "dbscan") {
    return `هنا الكود بيشغل DBSCAN فعليًا داخل \`${step.ownerSymbol}\`${params}.${inputData}.${output ? output + "." : ""} دي خطوة clustering بالكثافة، وليست مجرد wrapper أو استخدام لاحق للـ labels.`;
  }
  if (target === "fcm") {
    return `هنا الكود بيشغل Fuzzy C-Means فعليًا داخل \`${step.ownerSymbol}\`${params}.${inputData}.${output ? output + "." : ""} دي خطوة soft clustering، وليست استدعاء DBSCAN أو wrapper عام.`;
  }
  if (target === "svm") {
    return `هنا الكود بيطبق SVM داخل \`${step.ownerSymbol}\`${params}.${inputData}.${output ? output + "." : ""} الخطوة دي خاصة بالتدريب أو التنبؤ حسب الدالة المثبتة في الدليل.`;
  }
  return `هنا التنفيذ المباشر لـ \`${target}\` موجود داخل \`${step.ownerSymbol}\`${params}.${inputData}.${output ? output + "." : ""}`;
}

function arabicRoleSummary(role: SourceRole) {
  if (role === "implementation") return "تنفيذ مباشر";
  if (role === "orchestration") return "تنسيق أو استدعاء wrapper";
  if (role === "artifact_preparation") return "تحضير payload أو artifact من نتائج موجودة";
  if (role === "downstream_stage") return "مرحلة لاحقة تستخدم الناتج";
  if (role === "visualization") return "عرض أو visualization";
  if (role === "test") return "اختبار";
  if (role === "documentation") return "توثيق";
  return "تطابق اسم غير كاف للتنفيذ";
}

function summarizeArabicRelationships(evidence: ImplementationEvidence[]) {
  const groups = new Map<SourceRole, ImplementationEvidence[]>();
  for (const item of evidence) {
    const current = groups.get(item.semanticRole) ?? [];
    current.push(item);
    groups.set(item.semanticRole, current);
  }
  const parts: string[] = [];
  for (const [role, items] of groups.entries()) {
    const names = uniqueStrings(items.flatMap((item) => [
      ...item.symbols,
      ...item.calls.map((call) => call.name),
      ...Array.from(item.snippet.matchAll(/\b(train_[A-Za-z0-9_]+|predict_[A-Za-z0-9_]+|[A-Za-z0-9_]*svm[A-Za-z0-9_]*)\b/gi)).map((match) => match[1] ?? "")
    ]))
      .sort((left, right) => relationshipNameScore(right) - relationshipNameScore(left))
      .slice(0, 6);
    const refs = items.slice(0, 2).map((item) => item.markdownLink).join(", ");
    if (role === "orchestration") parts.push(`فيه كود بينسق الاستدعاء أو يربطه بالـ API عبر ${names.map((item) => `\`${item}\``).join(", ") || "دوال وسيطة"} (${refs})`);
    if (role === "artifact_preparation") parts.push(`فيه كود بيجهز payload/artifact من النتائج الموجودة، وده استخدام للناتج مش تشغيل للخوارزمية (${refs})`);
    if (role === "downstream_stage") parts.push(`فيه مراحل لاحقة بتستهلك الناتج أو تكمل عليه عبر ${names.map((item) => `\`${item}\``).join(", ") || "دوال لاحقة"} (${refs})`);
  }
  return parts.join("، ") || "لم يظهر ربط لاحق مثبت خارج التنفيذ المباشر";
}

function relationshipNameScore(name: string) {
  if (/\b(train|svm|predict|api|route)\b/i.test(name)) return 40;
  if (/\b(build|fit|segment|cluster)\b/i.test(name)) return 25;
  if (/^(str|dict|list|len|Number|rgba)$/i.test(name)) return -20;
  return 0;
}

function arabicUncertainty(value: string) {
  if (/parameters are not proven/i.test(value)) return "الـ parameters غير مثبتة من المقاطع التي تم فحصها.";
  if (/returned values or assigned outputs/i.test(value)) return "النواتج أو المتغيرات الناتجة غير واضحة من المقاطع التي تم فحصها.";
  if (/downstream consumers/i.test(value)) return "المستهلكون اللاحقون غير واضحين من مقاطع التنفيذ المباشر التي تم فحصها.";
  return value;
}

function composeDetailedEvidenceAnswer(input: {
  question: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  negativeEvidence: string[];
  intent: WorkspaceIntentUnderstanding;
}) {
  if (input.intent.language === "arabic") {
    return composeDetailedArabicAnswer(input);
  }
  return composeDetailedEnglishAnswer(input);
}

function composeDetailedArabicAnswer(input: {
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  negativeEvidence: string[];
}) {
  const citations = input.positiveEvidence.slice(0, 8).map((item) => item.markdownLink).join(", ");
  const lines = [
    "## الخلاصة",
    `السؤال هنا محتاج شرح تفصيلي، فالإجابة مش مجرد إن العنصر موجود. من الأدلة المحلية واضح إن \`${input.questionUnderstanding.topicPhrase}\` مرتبط بتسلسل تنفيذ داخل المشروع، والدليل الأساسي جاي من: ${citations || "الأدلة المنظمة داخل التقرير"}.`,
    "هقسمها كفلو: كل خطوة بتقول إيه اللي بيحصل، ليه مهمة، ومكانها في الكود.",
    ""
  ];

  if (input.topic === "training_inference" && input.structuredFacts.trainingInference) {
    const facts = input.structuredFacts.trainingInference;
    lines.push("## الفصل بين التدريب والتنبؤ");
    lines.push(`الحكم من الأدلة: ${facts.separation === "yes" ? "فيه فصل واضح" : facts.separation === "partial" ? "فيه فصل جزئي" : "الفصل غير مكتمل أو غير مؤكد"}. التدريب هو الجزء اللي يبني أو يجهز الموديل من features/labels، أما inference فهو الجزء اللي يستخدم موديل جاهز أو دالة جاهزة لإرجاع prediction لمدخلات جديدة.`);
    lines.push("");
    lines.push("## أماكن التدريب");
    if (facts.training.length) {
      for (const item of facts.training) {
        const evidence = bestEvidenceForPath(input.positiveEvidence, item.sourceRef);
        lines.push(`- **${item.name}**: ده موضع training أو تجهيز model. مكانه ${link(item.sourceRef, evidence?.line ?? 1)}. أهميته إنه يمثل مرحلة تعلم أو بناء state قبل الاستخدام الفعلي.`);
      }
    } else {
      lines.push("- لم تظهر دوال تدريب مؤكدة في الأدلة المنظمة.");
    }
    lines.push("");
    lines.push("## أماكن التنبؤ أو inference");
    if (facts.inference.length) {
      for (const item of facts.inference) {
        const evidence = bestEvidenceForPath(input.positiveEvidence, item.sourceRef);
        lines.push(`- **${item.name}**: ده موضع inference أو prediction. مكانه ${link(item.sourceRef, evidence?.line ?? 1)}. وظيفته استخدام المدخلات الجديدة لإنتاج نتيجة بدل إعادة التدريب من الصفر.`);
      }
    } else {
      lines.push("- لم تظهر دوال inference مؤكدة في الأدلة المنظمة.");
    }
    if (facts.persistence.length) {
      lines.push("");
      lines.push("## التخزين والتحميل");
      for (const item of facts.persistence) {
        const evidence = bestEvidenceForPath(input.positiveEvidence, item.sourceRef);
        lines.push(`- **${item.method}**: ده دليل persistence في ${link(item.sourceRef, evidence?.line ?? 1)}. وجوده مهم لأنه يوضح هل الموديل بيتحفظ ويتحمل بين التدريب والاستخدام.`);
      }
    }
  } else if (input.topic === "code_flow" && input.structuredFacts.codeFlow?.steps.length) {
    lines.push("## التسلسل");
    for (const step of input.structuredFacts.codeFlow.steps) {
      const evidence = bestEvidenceForPath(input.positiveEvidence, step.sourceRef);
      const symbols = extractSymbols(evidence?.snippet ?? "").slice(0, 4);
      lines.push(`### ${step.order}. ${step.label}`);
      lines.push(`- **ماذا يحدث:** ${step.description}. الدليل بيقول إن دي خطوة فعلية في الفلو، مش مجرد اسم مذكور في README.`);
      lines.push(`- **لماذا مهمة:** الخطوة دي بتغذي أو تستخدم الخطوة اللي بعدها. لو هي training مثلًا فهي بتجهز الموديل، ولو prediction فهي بتستخدم الموديل على بيانات جديدة، ولو explainability فهي بتشرح سبب القرار.`);
      lines.push(`- **أين في الكود:** ${link(step.sourceRef, evidence?.line ?? 1)}.`);
      if (symbols.length) lines.push(`- **رموز مرتبطة:** ${symbols.map((symbol) => `\`${symbol}\``).join(", ")}.`);
      lines.push("");
    }
  } else {
    lines.push("## الأدلة الأساسية");
    for (const item of input.positiveEvidence.slice(0, 10)) {
      lines.push(`- ${summarizeEvidence(item)} ${item.markdownLink}`);
    }
  }

  const snippets = selectSnippetBlocks(input.positiveEvidence, input.questionUnderstanding);
  if (snippets.length) {
    lines.push("## مقتطفات مهمة");
    for (const item of snippets) {
      lines.push(`من ${item.markdownLink}:`);
      lines.push("```");
      lines.push(formatSnippetBlock(item.snippet ?? ""));
      lines.push("```");
    }
  }

  lines.push("## العلاقة بين الأجزاء");
  if (input.structuredFacts.codeFlow?.steps.length) {
    lines.push(`العلاقة المختصرة: ${input.structuredFacts.codeFlow.steps.map((step) => step.label).join(" -> ")}. يعني البيانات أو الحالة بتتحضر الأول، بعدين يحصل تدريب أو تحميل للموديل، بعدين prediction، وبعدها ممكن النتيجة تتشرح أو تتستخدم في API/service flow.`);
  } else if (input.structuredFacts.trainingInference) {
    lines.push("العلاقة إن training ينتج أو يجهز model/state، وinference يستخدم الناتج ده مع بيانات جديدة. وجود persistence لو ظاهر في الأدلة يوضح الجسر بين المرحلتين.");
  } else {
    lines.push("الأدلة مرتبطة بنفس السؤال، لكن مافيش structured flow كافي يثبت كل خطوة كمرحلة مستقلة.");
  }

  const uncertainties = uniqueStrings([
    ...(input.structuredFacts.uncertainties ?? []),
    ...(input.structuredFacts.codeFlow?.uncertainties ?? []),
    ...(input.structuredFacts.trainingInference?.uncertainties ?? []),
    ...input.negativeEvidence.slice(0, 4)
  ]);
  if (uncertainties.length) {
    lines.push("");
    lines.push("## غير مؤكد من الأدلة");
    for (const item of uncertainties.slice(0, 5)) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function composeDetailedEnglishAnswer(input: {
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  negativeEvidence: string[];
}) {
  const lines = [
    "## Summary",
    `The answer is grounded in local project evidence for \`${input.questionUnderstanding.topicPhrase}\`, not a canned explanation.`,
    ""
  ];
  if (input.topic === "code_flow" && input.structuredFacts.codeFlow?.steps.length) {
    lines.push("## Flow");
    for (const step of input.structuredFacts.codeFlow.steps) {
      const evidence = bestEvidenceForPath(input.positiveEvidence, step.sourceRef);
      const symbols = extractSymbols(evidence?.snippet ?? "").slice(0, 4);
      lines.push(`### ${step.order}. ${step.label}`);
      lines.push(`- What happens: ${step.description}.`);
      lines.push("- Why it matters: this step either prepares model state, trains/loads the model, predicts on new inputs, explains the result, or exposes it through the service flow.");
      lines.push(`- Code location: ${link(step.sourceRef, evidence?.line ?? 1)}.`);
      if (symbols.length) lines.push(`- Related symbols: ${symbols.map((symbol) => `\`${symbol}\``).join(", ")}.`);
      lines.push("");
    }
  } else {
    lines.push("## Evidence");
    for (const item of input.positiveEvidence.slice(0, 10)) lines.push(`- ${summarizeEvidence(item)} ${item.markdownLink}`);
  }
  const snippets = selectSnippetBlocks(input.positiveEvidence, input.questionUnderstanding);
  if (snippets.length) {
    lines.push("## Important Snippets");
    for (const item of snippets) {
      lines.push(`From ${item.markdownLink}:`);
      lines.push("```");
      lines.push(formatSnippetBlock(item.snippet ?? ""));
      lines.push("```");
    }
  }
  lines.push("## How The Pieces Connect");
  lines.push(input.structuredFacts.codeFlow?.steps.length
    ? input.structuredFacts.codeFlow.steps.map((step) => step.label).join(" -> ")
    : "The evidence supports the requested topic, but not every step is proven as a separate stage.");
  return lines.join("\n");
}

function augmentExplainReport(
  report: ProjectExplainReport,
  evidence: ProjectQuestionEvidence[],
  understanding: ProjectQuestionUnderstanding
): ProjectExplainReport {
  const refs: ProjectExplainEvidenceRef[] = evidence.slice(0, 80).map((item) => ({
    type: "search",
    path: item.path,
    reason: item.reason,
    lineStart: item.line,
    lineEnd: item.line,
    snippet: item.snippet,
    excerpt: item.snippet,
    language: languageForPath(item.path)
  }));
  const sections: ProjectExplainSection[] = evidence.slice(0, 80).map((item) => ({
    title: item.title,
    explanation: item.reason,
    filePath: item.path,
    lineStart: item.line,
    lineEnd: item.line,
    language: languageForPath(item.path),
    snippet: item.snippet ?? "",
    whyItMatters: `Direct local evidence for ${understanding.topicPhrase}.`
  }));
  return {
    ...report,
    sections: uniqueSections([...sections, ...report.sections]),
    findings: uniqueSections([...sections, ...report.findings]),
    evidence: uniqueEvidenceRefs([...refs, ...report.evidence]),
    importantFiles: uniqueStrings([...evidence.map((item) => item.path), ...report.importantFiles]).slice(0, 50)
  };
}

function createEvidence(input: {
  filePath: string;
  line: number;
  snippet: string;
  query: string;
  querySource: ProjectQuestionEvidence["querySource"];
  reason: string;
  intent: WorkspaceIntentUnderstanding;
}): ProjectQuestionEvidence {
  const item: ProjectQuestionEvidence = {
    ref: `${input.filePath}:${input.line}`,
    markdownLink: link(input.filePath, input.line),
    path: input.filePath,
    line: input.line,
    title: `Search evidence for ${input.query}`,
    reason: input.reason,
    snippet: input.snippet,
    query: input.query,
    querySource: input.querySource,
    confidence: "medium",
    sourceRole: sourceRoleForPath(input.filePath)
  };
  const facets = facetsForEvidenceItem(item);
  const requiredFacetHit = facets.some((facet) => input.intent.requiredFacets.includes(facet));
  if (requiredFacetHit || SOURCE_FILE_RE.test(input.filePath)) item.confidence = "high";
  return item;
}

function readSearchFile(tools: ToolRegistry, filePath: string, cache: Map<string, string>) {
  if (cache.has(filePath)) return cache.get(filePath);
  try {
    const content = tools.workspace.readWholeFile(filePath).slice(0, SEARCH_LIMITS.maxReadChars);
    cache.set(filePath, content);
    return content;
  } catch {
    cache.set(filePath, "");
    return "";
  }
}

function extractEntities(question: string) {
  const entities = [
    ...Array.from(question.matchAll(/`([^`]{2,80})`/g)).map((match) => match[1] ?? ""),
    ...Array.from(question.matchAll(/["']([^"']{2,80})["']/g)).map((match) => match[1] ?? ""),
    ...Array.from(question.matchAll(/(?:^|\s)(\/api\/[A-Za-z0-9_./:-]+)/g)).map((match) => match[1] ?? ""),
    ...Array.from(question.matchAll(/\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+\b/g)).map((match) => match[0]),
    ...Array.from(question.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)).map((match) => match[0])
  ];
  return uniqueStrings(entities.map((entity) => entity.trim()).filter((entity) => entity.length >= 2)).slice(0, 20);
}

function tokenizeQuestion(question: string) {
  return uniqueStrings(
    question
      .replace(/[^\p{L}\p{N}_./:-]+/gu, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
      .filter((token) => !COMMON_STOP_WORDS.has(token.toLowerCase()))
  ).slice(0, 20);
}

function expectedAnswerShape(
  question: string,
  intent: WorkspaceIntentUnderstanding
): ProjectQuestionUnderstanding["expectedAnswerShape"] {
  if (isYesNoQuestion(question)) return "yes_no";
  if (intent.answerGoal === "count") return "count";
  if (intent.answerGoal === "list") return "list";
  if (intent.answerGoal === "trace_flow" || looksLikeFlowQuestion(question)) return "flow";
  if (intent.answerGoal === "locate") return "locate";
  if (intent.answerGoal === "compare") return "compare";
  return "summary";
}

function questionScope(
  question: string,
  intent: WorkspaceIntentUnderstanding,
  topic: UniversalInspectTopic
): ProjectQuestionUnderstanding["questionScope"] {
  if (intent.answerGoal === "count" || intent.answerGoal === "list" || topic === "algorithms" || topic === "frontend") return "inventory";
  if (intent.answerGoal === "locate") return "location";
  if (intent.answerGoal === "compare") return "comparison";
  if (intent.answerGoal === "trace_flow" || looksLikeFlowQuestion(question)) {
    return /\b(pipeline|whole|entire|all|end to end|e2e)\b/i.test(question) || /(?:كله|كامل|النظام كله|البايبلاين)/.test(question)
      ? "pipeline"
      : "concept";
  }
  return "general";
}

function looksLikeFlowQuestion(question: string) {
  return /\b(flow|trace|how does it work|how is|how are|applied|apply|implemented|implementation|works?|used|usage|pipeline|walkthrough|step by step)\b/i.test(question);
}

function isYesNoQuestion(question: string) {
  return /^\s*(are|is|do|does|did|can|has|have)\b/i.test(question) || /(?:^|\s)(هل|فيه|عندي|عندنا)\b/.test(question);
}

function inferDetailLevel(
  question: string,
  intent: WorkspaceIntentUnderstanding
): ProjectQuestionUnderstanding["detailLevel"] {
  if (intent.style === "concise" || /\b(brief|short|quick|concise)\b/i.test(question) || /(?:مختصر|باختصار)/.test(question)) {
    return "brief";
  }
  if (/\b(deep dive|full flow|exhaustive|very detailed|in full detail|thorough)\b/i.test(question)
    || /(?:بالتفصيل\s*جدا|بالتفاصيل\s*جدا|شرح\s*كامل|تفصيلي\s*جدا)/.test(question)) {
    return "deep";
  }
  if (intent.style === "detailed" || intent.outputShape === "walkthrough"
    || /\b(detailed|details?|in detail|with details|walkthrough|step by step|full)\b/i.test(question)
    || /(?:بالتفصيل|بالتفاصيل|خطوة\s*بخطوة)/.test(question)) {
    return "detailed";
  }
  return "normal";
}

function wantsCodeExamples(question: string) {
  return /\b(code|snippet|snippets|example|examples|sample|implementation)\b/i.test(question)
    || /(?:كود|مثال|أمثلة|امثلة|مقتطف|مقتطفات|تنفيذ)/.test(question);
}

function wantsComparisons(question: string) {
  return /\b(compare|comparison|difference|differences|versus|vs)\b/i.test(question)
    || /(?:قارن|مقارنة|الفرق|فرق|مقابل)/.test(question);
}

function wantsLogicJudgment(question: string) {
  return /\b(wrong|right|correct|incorrect|logical|logic|reasonable|sensible|valid|invalid|bug|flaw|issue|should it|does this make sense|is this ok|is this okay)\b/i.test(question)
    || /(?:منطقي|مش\s+منطقي|غلط|صح|صحيح|خطأ|خطا|مقبول|ينفع|هل\s+دا|هل\s+ده|متطبق\s+غلط|بشكل\s+غلط|ب\s*شكل\s+غلط)/u.test(question);
}

function isSearchablePath(filePath: string) {
  return TEXT_FILE_RE.test(filePath) && !IGNORED_PATH_RE.test(filePath);
}

function sourceScore(filePath: string) {
  let score = 0;
  if (SOURCE_FILE_RE.test(filePath)) score += 60;
  if (/package\.json|pyproject\.toml|Cargo\.toml|README\.md$/i.test(filePath)) score += 20;
  if (/\.test\.|\.spec\.|(^|\/)tests?\//i.test(filePath)) score -= 10;
  if (/\.(css|scss|md)$/i.test(filePath)) score -= 15;
  return score;
}

function sourceRoleForPath(filePath: string): SourceRole {
  if (/\.test\.|\.spec\.|(^|\/)tests?\//i.test(filePath)) return "test";
  if (/\.(md|mdx|txt)$/i.test(filePath) || /(^|\/)docs?\//i.test(filePath)) return "documentation";
  if (/routes?|api|controller|endpoint/i.test(filePath)) return "orchestration";
  if (/(^|\/)(runtime|orchestration|agents?|scheduler|tools|memory|swarm)\//i.test(filePath)) return "orchestration";
  if (/\.(tsx?|jsx?|css|scss|html)$/i.test(filePath) && /(^|\/)(frontend|client|web|ui|components|pages|app)\//i.test(filePath)) return "visualization";
  return "implementation";
}

function shouldExposeNegativeQuery(query: string) {
  const normalized = normalizeTerm(query);
  if (!normalized || normalized.length < 3) return false;
  if (COMMON_STOP_WORDS.has(normalized)) return false;
  if (INTERNAL_SEARCH_TERMS.has(normalized)) return false;
  if (/^(explain|detail|detailed|here|how|work|works|applied|apply|code|snippet|snippets)$/i.test(normalized)) return false;
  if (/^(ازاي|إزاي|كيف|اشرح|بالتفصيل|هنا|ده|دا|دي)$/u.test(query.trim())) return false;
  return /[A-Za-z0-9_/.-]/.test(query) || normalized.length > 5;
}

function countEvidenceRoles(implementationEvidence: ImplementationEvidence[], positiveEvidence: ProjectQuestionEvidence[]) {
  const counts: Record<SourceRole, number> = {
    implementation: 0,
    orchestration: 0,
    artifact_preparation: 0,
    downstream_stage: 0,
    visualization: 0,
    test: 0,
    documentation: 0,
    unrelated_name_match: 0
  };
  for (const item of implementationEvidence) counts[item.sourceRole] += 1;
  for (const item of positiveEvidence) counts[item.sourceRole] += 1;
  return counts;
}

function snippetAround(lines: string[], index: number) {
  return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join("\n").trim().slice(0, 700);
}

function firstUsefulSnippet(lines: string[]) {
  return lines.find((line) => line.trim().length > 0)?.trim().slice(0, 700) ?? "";
}

function summarizeEvidence(item: ProjectQuestionEvidence) {
  const snippet = item.snippet?.replace(/\s+/g, " ").trim();
  if (snippet) return snippet.length > 160 ? `${snippet.slice(0, 157)}...` : snippet;
  return `${item.path}:${item.line}`;
}

function link(path: string, line: number) {
  return `[${path}:${line}](hivo-file:${encodeURIComponent(path)}:${line})`;
}

function bestEvidenceForPath(evidence: ProjectQuestionEvidence[], filePath: string) {
  return evidence.find((item) => item.path === filePath)
    ?? evidence.find((item) => item.path.endsWith(filePath) || filePath.endsWith(item.path));
}

function selectSnippetBlocks(
  evidence: ProjectQuestionEvidence[],
  understanding: ProjectQuestionUnderstanding
) {
  const shouldIncludeSnippets =
    understanding.wantsCodeExamples ||
    understanding.detailLevel === "deep" ||
    understanding.detailLevel === "detailed";
  if (!shouldIncludeSnippets) return [];
  const maxBlocks = understanding.wantsCodeExamples || understanding.detailLevel === "deep" ? 3 : 2;
  const topicNeedles = uniqueStrings([
    understanding.topicPhrase,
    ...understanding.topicTerms,
    ...understanding.normalizedTerms.slice(0, 12)
  ].map((term) => normalizeTerm(term)).filter(Boolean));
  const seen = new Set<string>();
  return evidence
    .filter((item) => item.snippet && SOURCE_FILE_RE.test(item.path))
    .filter((item) => {
      if (understanding.wantsCodeExamples || understanding.detailLevel === "deep") return true;
      const lineCount = item.snippet?.split(/\r?\n/).filter((line) => line.trim()).length ?? 0;
      return lineCount <= 8 && /\b(def|class|function|const|SVC|fit|predict|joblib|shap|@app\.)\b/i.test(item.snippet ?? "");
    })
    .sort((left, right) => snippetRelevanceScore(right, topicNeedles) - snippetRelevanceScore(left, topicNeedles))
    .filter((item) => {
      const key = `${item.path}:${formatSnippetBlock(item.snippet ?? "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxBlocks);
}

function snippetRelevanceScore(item: ProjectQuestionEvidence, topicNeedles: string[]) {
  const haystack = normalizeTerm(`${item.path}\n${item.snippet ?? ""}`);
  let score = item.confidence === "high" ? 20 : 0;
  for (const term of topicNeedles) {
    if (term.length > 2 && haystack.includes(term)) score += 8;
  }
  if (/\b(def|class|function)\s+[A-Za-z_][A-Za-z0-9_]*/.test(item.snippet ?? "")) score += 12;
  if (/\b(SVC|LinearSVC|fit|predict|predict_proba|fit_predict|joblib|KernelExplainer|shap_values)\b/i.test(item.snippet ?? "")) score += 24;
  if (/@(?:app|router)\.(?:get|post|put|delete|patch)\(/.test(item.snippet ?? "")) score += 10;
  if (/\.test\.|\.spec\.|(^|\/)tests?\//i.test(item.path)) score -= 20;
  return score;
}

function formatSnippetBlock(snippet: string) {
  return snippet
    .split(/\r?\n/)
    .slice(0, 8)
    .join("\n")
    .trim();
}

function extractSymbols(snippet: string) {
  const symbols = [
    ...Array.from(snippet.matchAll(/\b(?:def|class|function)\s+([A-Za-z_][A-Za-z0-9_]*)/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/@(?:app|router)\.(?:get|post|put|delete|patch)\(["']([^"']+)["']/g)).map((match) => match[1] ?? ""),
    ...Array.from(snippet.matchAll(/\b(SVC|LinearSVC|predict_proba|predict|fit|fit_predict|joblib\.dump|joblib\.load|KernelExplainer|shap_values)\b/g)).map((match) => match[1] ?? "")
  ];
  return uniqueStrings(symbols).slice(0, 8);
}

function countAnswerSections(answer: string) {
  const markdownHeadings = (answer.match(/^#{2,4}\s+/gm) ?? []).length;
  const boldHeadings = (answer.match(/^\*\*[^*\n]{3,80}\*\*/gm) ?? []).length;
  return markdownHeadings + boldHeadings;
}

function normalizeTerm(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function languageForPath(filePath: string) {
  if (/\.tsx?$/i.test(filePath)) return "typescript";
  if (/\.jsx?$/i.test(filePath)) return "javascript";
  if (/\.py$/i.test(filePath)) return "python";
  if (/\.rs$/i.test(filePath)) return "rust";
  if (/\.html$/i.test(filePath)) return "html";
  if (/\.css$/i.test(filePath)) return "css";
  if (/\.md$/i.test(filePath)) return "markdown";
  if (/\.json$/i.test(filePath)) return "json";
  return "text";
}

function answerLooksLikeNotFound(answerMarkdown: string) {
  return /\b(could not find|not found|cannot confirm|no .* evidence|missing evidence|not proven)\b/i.test(answerMarkdown)
    || /(?:مالقيتش|ما لقيتش|لم أجد|لا أقدر أؤكد|مش لاقي|غير مؤكد|غير مثبت)/.test(answerMarkdown);
}

function structuredFactsHaveEvidence(topic: UniversalInspectTopic, facts: InspectExplainFacts) {
  if (topic === "frontend") return Boolean(facts.frontend?.items.length);
  if (topic === "ui_controls") return Boolean(facts.uiControls?.controls.length);
  if (topic === "algorithms") return Boolean(facts.algorithms?.items.length);
  if (topic === "training_inference") {
    return Boolean(facts.trainingInference && (
      facts.trainingInference.training.length ||
      facts.trainingInference.inference.length ||
      facts.trainingInference.persistence.length
    ));
  }
  if (topic === "code_flow") return Boolean(facts.codeFlow?.steps.length);
  return false;
}

function emptyFacetEvidenceMap(items: WorkspaceEvidenceLike[]) {
  const map: Record<WorkspaceEvidenceFacet, WorkspaceEvidenceLike[]> = {
    ui_structure: [],
    code_symbols: [],
    algorithms_models: [],
    numeric_logic: [],
    data_flow: [],
    tests_docs: []
  };
  for (const item of items) {
    for (const facet of facetsForEvidenceItem(item)) {
      map[facet].push(item);
    }
  }
  return map;
}

function augmentReportWithAgenticUnderstanding(
  report: ProjectExplainReport,
  result: AgenticTaskResult | undefined
): ProjectExplainReport {
  if (!result || (!result.evidenceGraph.accepted.length && !result.mentalModel.relationships.length)) return report;
  const relationshipSummary = result.mentalModel.relationships
    .slice(0, 12)
    .map((relationship) => relationship.toPath
      ? `${relationship.kind}: ${relationship.fromPath} -> ${relationship.toPath}`
      : `${relationship.kind}: ${relationship.fromPath}${relationship.symbol ? `#${relationship.symbol}` : ""}`)
    .join(" | ");
  const modelSummary = [
    `Agentic mental model confidence: ${result.mentalModel.confidence}.`,
    result.mentalModel.dataOrControlFlow.length ? `Data/control flow: ${result.mentalModel.dataOrControlFlow.slice(0, 8).join(" | ")}.` : "",
    relationshipSummary ? `Relationships followed: ${relationshipSummary}.` : "",
    result.mentalModel.unknowns.length ? `Unknowns: ${result.mentalModel.unknowns.join(" | ")}.` : "",
    result.mentalModel.risks.length ? `Risks: ${result.mentalModel.risks.join(" | ")}.` : ""
  ].filter(Boolean).join(" ");
  const evidence: ProjectExplainEvidenceRef[] = result.evidenceGraph.accepted.slice(0, 30).map((item) => ({
    type: "file",
    path: item.path,
    lineStart: item.lineStart ?? 1,
    lineEnd: item.lineEnd,
    symbol: item.symbol,
    language: languageForPath(item.path),
    snippet: item.snippet,
    excerpt: item.snippet,
    reason: [
      "Agentic relationship-model evidence.",
      item.relevanceReason,
      item.readMode ? `readMode=${item.readMode}` : "",
      item.confidence ? `confidence=${item.confidence}` : ""
    ].filter(Boolean).join(" ")
  }));
  const sections: ProjectExplainSection[] = result.evidenceGraph.accepted.slice(0, 16).map((item, index) => ({
    title: `Agentic understanding evidence ${index + 1}`,
    explanation: truncateForReport([
      item.relevanceReason,
      result.mentalModel.responsibilities.find((entry) => entry.evidenceIds.includes(item.id))?.summary ?? "",
      relationshipSummary ? `Relationship context: ${relationshipSummary}` : ""
    ].filter(Boolean).join(" ")),
    filePath: item.path,
    lineStart: item.lineStart ?? 1,
    lineEnd: item.lineEnd ?? item.lineStart ?? 1,
    symbol: item.symbol,
    language: languageForPath(item.path),
    snippet: item.snippet,
    whyItMatters: "This source was accepted by the agentic project-understanding reader as production evidence for the query-specific mental model."
  }));
  return {
    ...report,
    sections: uniqueSections([...sections, ...report.sections]),
    findings: uniqueSections([...sections, ...report.findings]),
    evidence: uniqueEvidenceRefs([...evidence, ...report.evidence]),
    risksAndUnknowns: uniqueStrings([
      modelSummary,
      ...result.mentalModel.unknowns,
      ...result.mentalModel.risks,
      ...report.risksAndUnknowns
    ]).slice(0, 40)
  };
}

function truncateForReport(value: string, max = 700) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function uniqueEvidence(items: ProjectQuestionEvidence[]) {
  const seen = new Set<string>();
  const result: ProjectQuestionEvidence[] = [];
  for (const item of items) {
    const key = `${item.path}:${item.line}:${item.query}:${item.snippet ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((left, right) => evidenceScore(right) - evidenceScore(left) || left.path.localeCompare(right.path) || left.line - right.line);
}

function evidenceScore(item: ProjectQuestionEvidence) {
  return (item.confidence === "high" ? 100 : item.confidence === "medium" ? 50 : 10)
    + (item.querySource === "entity" ? 180 : item.querySource === "topic_term" ? 120 : item.querySource === "path" ? 100 : item.querySource === "structured" ? 90 : item.querySource === "alias" ? 25 : 10)
    + (SOURCE_FILE_RE.test(item.path) ? 20 : 0)
    - (/\.(css|md)$/i.test(item.path) ? 15 : 0);
}

function uniqueSections(sections: ProjectExplainSection[]) {
  const seen = new Set<string>();
  const result: ProjectExplainSection[] = [];
  for (const section of sections) {
    const key = `${section.filePath}:${section.lineStart}:${section.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(section);
  }
  return result;
}

function uniqueEvidenceRefs(refs: ProjectExplainEvidenceRef[]) {
  const seen = new Set<string>();
  const result: ProjectExplainEvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.path}:${ref.lineStart ?? 1}:${ref.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}
