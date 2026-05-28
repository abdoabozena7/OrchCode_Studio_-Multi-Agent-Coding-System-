import type { EvidenceTruthReport, ProjectExplainEvidenceRef, ProjectExplainReport, ProjectExplainSection } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { analyzeAlgorithmInventory } from "./AlgorithmInventoryAnalyzer.js";
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
  filterProjectEvidencePaths
} from "./EvidenceHygiene.js";
import { analyzeTrainingInference } from "./TrainingInferenceAnalyzer.js";
import { analyzeUIControls } from "./UIControlAnalyzer.js";
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
};

const SEARCH_LIMITS = {
  maxIterations: 3,
  maxCandidateFiles: 80,
  maxOpenedFiles: 24,
  maxSnippetsPerFile: 8,
  maxReadChars: 20_000,
  maxEvidenceItems: 120
};

const TEXT_FILE_RE = /\.(c|cc|conf|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/i;
const SOURCE_FILE_RE = /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|py|rs|ts|tsx)$/i;
const IGNORED_PATH_RE = /(^|\/)(\.cache|\.git|\.next|\.nuxt|\.pytest_cache|\.ruff_cache|\.svelte-kit|\.turbo|\.venv|\.vite|__pycache__|build|coverage|dist|env|node_modules|out|output|outputs|playwright-report|site-packages|target|test-results|venv)(\/|$)/i;

const COMMON_STOP_WORDS = new Set([
  "about", "after", "all", "and", "answer", "are", "code", "current", "does", "each",
  "explain", "file", "files", "find", "for", "from", "have", "here", "how", "inside",
  "is", "list", "many", "me", "of", "project", "show", "system", "that", "the",
  "this", "what", "where", "which", "with", "work", "works"
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
}): Promise<UniversalProjectQuestionResult> {
  const intent = input.intent ?? inferWorkspaceIntent(input.userPrompt);
  const topic = inferUniversalInspectTopic(input.userPrompt, intent);
  const allFiles = input.tools.workspace
    .listFiles(10_000)
    .filter((file) => !file.isDir && !file.isSecretCandidate)
    .map((file) => file.path)
    .filter(isSearchablePath);
  const evidenceScope = filterProjectEvidencePaths(allFiles, input.userPrompt);
  const projectSourceFiles = evidenceScope.included;
  const investigationConceptResolution = resolveInvestigationConcept(input.userPrompt);
  const questionUnderstanding = applyInvestigationConceptResolution(
    createQuestionUnderstanding(input.userPrompt, intent, topic),
    investigationConceptResolution
  );
  const readLaneRun = runInspectExplainReadLanes({
    userPrompt: input.userPrompt,
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
  const structuredEvidence = structuredFactsToEvidence(structuredFacts);
  const readLaneEvidence = readLaneFindingsToEvidence(readLaneRun.artifacts);
  const projectIntelligenceGraph = buildProjectIntelligenceGraph({
    targetConcept: questionUnderstanding.targetConcept,
    filePaths: laneScopedFiles,
    readFile: (relativePath) => input.tools.workspace.readWholeFile(relativePath)
  });
  const mechanismChain = mergeReadLaneGraphIntoMechanismChain(
    resolveMechanismChain(projectIntelligenceGraph, questionUnderstanding.targetConcept),
    readLaneRun
  );
  const mechanismEvidence = bucketMechanismEvidence(projectIntelligenceGraph.evidence);
  const allCollectedEvidence = uniqueEvidence([
    ...search.positiveEvidence,
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
    localEvidence: uniqueEvidence([...search.positiveEvidence, ...readLaneEvidence]),
    structuredEvidence,
    mechanismEvidence: projectIntelligenceGraph.evidence,
    investigationConceptResolution,
    implementationEvidence,
    conceptFlow,
    negativeEvidence: search.negativeEvidence
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
  const roleClassificationValidation = validateRoleClassification({
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
  const augmentedReport = augmentExplainReport(input.explainReport, positiveEvidence, questionUnderstanding);
  const explainResult = await explainProjectWithLlm({
    provider: input.provider,
    userPrompt: input.userPrompt,
    report: augmentedReport
  });

  let answerMarkdown = explainResult.answerMarkdown;
  let evidenceRefs = uniqueStrings([
    ...explainResult.usedEvidenceRefs,
    ...positiveEvidence.slice(0, 20).map((item) => item.ref)
  ]);
  const validationErrors = [
    ...explainResult.unsupportedOrUnclearParts
  ];
  let fallbackUsed = explainResult.fallbackUsed || explainResult.unsupportedOrUnclearParts.length > 0;
  let fallbackReason = explainResult.fallbackReason;
  let answerShapeValidation = validateAnswer({
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

  if (validationErrors.length) {
    const initialValidationErrors = [...validationErrors];
    answerMarkdown = createEvidenceFallbackAnswer({
      question: input.userPrompt,
      questionUnderstanding,
      topic,
      structuredFacts,
      positiveEvidence,
      implementationEvidence,
      conceptFlow,
      conceptResolution,
      mechanismChain,
      mechanismEvidence,
      negativeEvidence: conceptResolution.userVisibleNegativeEvidence,
      intent
    });
    evidenceRefs = positiveEvidence.slice(0, 20).map((item) => item.ref);
    fallbackUsed = true;
    fallbackReason = `local_validation_failed: ${initialValidationErrors.slice(0, 3).join("; ")}`;
    answerShapeValidation = {
      ...validateAnswer({
        answerMarkdown,
        intent,
        questionUnderstanding,
        topic,
        positiveEvidence,
        structuredFacts,
        implementationEvidence,
        conceptFlow,
        conceptResolution
      }),
      repairedFrom: initialValidationErrors
    };
    coverageValidation = validateConceptCoverage({
      answerMarkdown,
      targetConcept: questionUnderstanding.targetConcept,
      requestedFacets: questionUnderstanding.requestedFacets,
      implementationEvidence,
      conceptFlow
    });
    languageValidation = validateAnswerLanguage({
      answerMarkdown,
      expected: intent.language
    });
    targetEvidenceValidation = validateTargetEvidence({
      answerMarkdown,
      questionUnderstanding,
      conceptResolution,
      conceptFlow
    });
    mechanismCoverageValidation = validateMechanismCoverage({
      targetConcept: questionUnderstanding.targetConcept,
      mechanismChain,
      graph: projectIntelligenceGraph,
      answerMarkdown
    });
    readLaneAnswerValidation = validateAnswerAgainstReadLaneEvidence({
      answerMarkdown,
      targetConcept: questionUnderstanding.targetConcept,
      readLaneRun
    });
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
  const evidenceReport = buildEvidenceTruthReport({
    prompt: input.userPrompt,
    excluded: evidenceScope.excluded,
    candidateFiles,
    openedFiles,
    finalEvidenceRefs: evidenceRefs
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
    answerMarkdown,
    evidenceRefs,
    usedEvidenceRefs: evidenceRefs,
    unsupportedOrUnclearParts: uniqueStrings(validationErrors),
    revisionCount: explainResult.revisionCount,
    validationWarnings: uniqueStrings([...explainResult.validationWarnings, ...conceptResolution.userVisibleNegativeEvidence]),
    grounding: explainResult.grounding,
    augmentedReport
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
    wantsComparisons: wantsComparisons(question)
  };
}

function applyInvestigationConceptResolution(
  understanding: ProjectQuestionUnderstanding,
  resolution: InvestigationConceptResolution
): ProjectQuestionUnderstanding {
  if (!resolution.isTargeted || !resolution.targetConcept || resolution.targetConcept === "general") return understanding;
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
  const implementationEvidenceItems = input.implementationEvidence.map(implementationToQuestionEvidence);
  const mechanismEvidenceItems = input.mechanismEvidence.map((item) =>
    mechanismToQuestionEvidence(item, input.questionUnderstanding.targetConcept, input.investigationConceptResolution)
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
    if (
      termsMatch(text, literalTerms)
      || implementationEvidenceItems.some((impl) => impl.ref === item.ref && impl.sourceRole === "implementation")
      || (mechanismItem && isDirectMechanismEvidence(mechanismItem, input.questionUnderstanding.targetConcept))
    ) {
      directTargetEvidence.push(item);
    } else if (termsMatch(text, aliasTerms)) {
      aliasTargetEvidence.push(item);
    } else if (termsMatch(text, behavioralTerms) || (mechanismItem && isBehavioralMechanismEvidence(mechanismItem))) {
      behavioralTargetEvidence.push(item);
    } else if (isArchitecturalPatternEvidence(text, architecturalTerms) || (mechanismItem && isArchitecturalMechanismEvidence(mechanismItem, input.questionUnderstanding.targetConcept))) {
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
  if (hasEvidence && !/hivo-file:/i.test(input.answerMarkdown)) {
    errors.push("Answer has local evidence but no hivo-file citations.");
  }
  if (hasEvidence && answerLooksLikeNotFound(input.answerMarkdown)) {
    errors.push("Answer says the topic was not found even though local evidence exists.");
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
  const existingRelations = new Set(chain.steps.map((step) => step.relation));
  const addedSteps: MechanismChain["steps"] = [];
  for (const edge of readLaneRun.synthesizedGraph.edges) {
    if (edge.status === "rejected" || edge.status === "unproven") continue;
    if (existingRelations.has(edge.relation)) continue;
    const role = roleForLaneRelation(edge.relation);
    if (!role) continue;
    addedSteps.push({
      order: chain.steps.length + addedSteps.length + 1,
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
    });
  }
  if (!addedSteps.length) return chain;
  const steps = [...chain.steps, ...addedSteps].map((step, index) => ({ ...step, order: index + 1 }));
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

  const outputs = mechanismOutputNames(input.mechanismEvidence, input.mechanismChain);
  if (outputs.length) {
    lines.push("", "## النواتج أو الحالات المثبتة", `- ${outputs.map((item) => `\`${item}\``).join(", ")}.`);
  }

  const tests = input.mechanismEvidence.testEndpointExpectations;
  const generalStorage = input.mechanismEvidence.generalStorageEvidence;
  const missing = input.mechanismChain.missingLinks;
  if (tests.length || generalStorage.length || missing.length || input.mechanismEvidence.contextOnlyEvidence.length) {
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

function composeEnglishProjectInvestigationAnswer(input: Parameters<typeof composeMechanismNarrativeAnswer>[0]) {
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

function mechanismOutputNames(evidence: MechanismEvidenceBuckets, chain: MechanismChain) {
  return uniqueStrings([
    ...chain.steps.flatMap((step) => [step.to ?? "", step.relation.includes("status") ? "status/outcome" : ""]),
    ...evidence.statusOnlyEvidence.flatMap((item) => Array.from(item.snippet.matchAll(/\b(status|observed_outcome|selected_action_name|action_type|timing)\b/g)).map((match) => match[1] ?? "")),
    ...evidence.contextOnlyEvidence.flatMap((item) => Array.from(item.snippet.matchAll(/\b(status|selected_action_name|action_type|timing|low_gap|high_gap)\b/g)).map((match) => match[1] ?? "")),
    ...evidence.targetScopedStorageEvidence.flatMap((item) => item.storageTarget ? [item.storageTarget] : [])
  ]).filter((item) => item && !/^\//.test(item)).slice(0, 10);
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

function createEvidenceFallbackAnswer(input: {
  question: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  implementationEvidence: ImplementationEvidence[];
  conceptFlow: ConceptFlow;
  conceptResolution: ConceptResolution;
  mechanismChain: MechanismChain;
  mechanismEvidence: MechanismEvidenceBuckets;
  negativeEvidence: string[];
  intent: WorkspaceIntentUnderstanding;
}) {
  const needsDetailedSynthesis = input.questionUnderstanding.detailLevel === "detailed" || input.questionUnderstanding.detailLevel === "deep";
  if (isMechanismQuestion(input.questionUnderstanding, input.mechanismEvidence)) {
    return composeMechanismNarrativeAnswer(input);
  }
  if (isTargetedConceptQuestion(input.questionUnderstanding, input.topic)) {
    return composeResolutionAwareAnswer(input);
  }
  if (needsDetailedSynthesis && input.conceptFlow.steps.length) {
    return composeConceptCentricAnswer(input);
  }
  if (
    needsDetailedSynthesis &&
    (input.topic === "code_flow" || input.topic === "training_inference") &&
    structuredFactsHaveEvidence(input.topic, input.structuredFacts)
  ) {
    return composeDetailedEvidenceAnswer(input);
  }
  if (structuredFactsHaveEvidence(input.topic, input.structuredFacts) && input.topic !== "general") {
    return composeAnswer(input.structuredFacts, input.topic, input.intent.language, input.intent.style);
  }
  const evidence = input.positiveEvidence.slice(0, 10);
  if (!evidence.length) {
    const searched = input.negativeEvidence.slice(0, 8).join("; ");
    if (input.intent.language === "arabic") {
      return [
        `لم أقدر أثبت \`${input.questionUnderstanding.topicPhrase}\` من ملفات المشروع بعد بحث محلي موثق.`,
        "",
        searched ? `البحث الذي تم: ${searched}.` : "لم تظهر أدلة محلية كافية لهذا السؤال.",
        "هذا ليس معناه أنه مستحيل، لكنه غير مثبت من الملفات التي تم تفتيشها."
      ].join("\n");
    }
    return [
      `I could not prove \`${input.questionUnderstanding.topicPhrase}\` from the project files after a documented local search.`,
      "",
      searched ? `Search performed: ${searched}.` : "No sufficient local evidence was collected for this question.",
      "That does not prove it cannot exist elsewhere; it is not proven by the inspected files."
    ].join("\n");
  }

  if (needsDetailedSynthesis) {
    return composeDetailedEvidenceAnswer(input);
  }

  const lines = evidence.map((item) => `- ${summarizeEvidence(item)} ${item.markdownLink}`);
  if (input.intent.language === "arabic") {
    const header = input.questionUnderstanding.expectedAnswerShape === "flow"
      ? "ده الفلو اللي قدرت أثبته من ملفات المشروع:"
      : input.questionUnderstanding.expectedAnswerShape === "locate"
        ? "أقوى أماكن مرتبطة بالسؤال في المشروع:"
        : `دورت على \`${input.questionUnderstanding.topicPhrase}\` ودي أقوى الأدلة من الملفات:`;
    return [header, "", ...lines].join("\n");
  }
  const header = input.questionUnderstanding.expectedAnswerShape === "flow"
    ? "This is the flow I can prove from the project files:"
    : input.questionUnderstanding.expectedAnswerShape === "locate"
      ? "Strongest locations related to the question:"
      : `I searched for \`${input.questionUnderstanding.topicPhrase}\`; strongest local evidence:`;
  return [header, "", ...lines].join("\n");
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
  if (/\.(tsx?|jsx?|css|scss|html)$/i.test(filePath)) return "visualization";
  if (/routes?|api|controller|endpoint/i.test(filePath)) return "orchestration";
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
