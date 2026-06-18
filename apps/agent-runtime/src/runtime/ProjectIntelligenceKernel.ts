export type ProjectIntelligenceNodeKind =
  | "file"
  | "symbol"
  | "function"
  | "class"
  | "component"
  | "state"
  | "route"
  | "endpoint"
  | "service"
  | "storage_file"
  | "log_file"
  | "config"
  | "test"
  | "documentation";

export type ProjectIntelligenceEdgeKind =
  | "imports"
  | "calls"
  | "renders"
  | "handles_event"
  | "fetches_endpoint"
  | "route_handles"
  | "reads_from"
  | "writes_to"
  | "persists_to"
  | "triggers"
  | "consumes_output"
  | "updates_state"
  | "schedules"
  | "returns";

export type MechanismEvidenceRole =
  | "ui_state"
  | "ui_event_handler"
  | "api_client_call"
  | "backend_route"
  | "service_logic"
  | "storage_target"
  | "storage_write"
  | "storage_read"
  | "log_append"
  | "job_or_scheduler"
  | "training_or_retraining"
  | "lifecycle_status"
  | "context_only"
  | "general_storage"
  | "test_endpoint_expectation"
  | "test"
  | "documentation"
  | "unrelated_name_match";

export type ProjectIntelligenceNode = {
  id: string;
  kind: ProjectIntelligenceNodeKind;
  label: string;
  path?: string;
  line?: number;
};

export type ProjectIntelligenceEdge = {
  from: string;
  to: string;
  kind: ProjectIntelligenceEdgeKind;
  evidenceRef: string;
  label?: string;
  relation?: string;
  confidence?: "high" | "medium" | "low";
  status?: "proven" | "partial" | "unproven";
};

export type MechanismEvidence = {
  id: string;
  role: MechanismEvidenceRole;
  path: string;
  line: number;
  snippet: string;
  reason: string;
  symbol?: string;
  endpoint?: string;
  storageTarget?: string;
  ownerSymbol?: string;
  from?: string;
  to?: string;
  targetScoped?: boolean;
  relatedNames: string[];
  confidence: "high" | "medium" | "low";
};

export type ProjectIntelligenceGraphSummary = {
  nodeCount: number;
  edgeCount: number;
  evidenceCount: number;
  roles: Record<MechanismEvidenceRole, number>;
  importantFiles: string[];
};

export type ProjectIntelligenceGraph = {
  targetConcept: string;
  nodes: ProjectIntelligenceNode[];
  edges: ProjectIntelligenceEdge[];
  evidence: MechanismEvidence[];
  graphExpansionTrace: string[];
  summary: ProjectIntelligenceGraphSummary;
  testEndpointExpectations: MechanismEvidence[];
  targetScopedStorageEvidence: MechanismEvidence[];
  generalStorageEvidence: MechanismEvidence[];
  mechanismExpansionTrace: string[];
  rejectedMechanismEvidence: MechanismEvidence[];
};

export type MechanismChainStep = {
  order: number;
  role: MechanismEvidenceRole;
  label: string;
  relation: string;
  status: "proven" | "partial" | "unproven";
  ownerSymbol?: string;
  from?: string;
  to?: string;
  confidence: "high" | "medium" | "low";
  evidenceRefs: string[];
  files: string[];
};

export type MechanismChainStatus = "confirmed" | "partial" | "not_found";

export type MechanismChain = {
  targetConcept: string;
  status: MechanismChainStatus;
  confidence: "high" | "medium" | "low";
  steps: MechanismChainStep[];
  confirmedFiles: string[];
  missingLinks: string[];
};

export type MechanismCoverageValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  missingLinks: string[];
};

export type ProjectIntelligenceBuildInput = {
  targetConcept?: string;
  filePaths: string[];
  readFile: (relativePath: string) => string;
  maxFiles?: number;
  maxReadChars?: number;
};

export type InvestigationResolutionStatus =
  | "direct_found"
  | "alias_found"
  | "behavioral_found"
  | "architectural_pattern_found"
  | "not_found";

export type InvestigationConceptResolution = {
  targetConcept: string;
  requestedConceptText: string;
  literalTerms: string[];
  aliasTerms: string[];
  behavioralTerms: string[];
  architecturalTerms: string[];
  labelsOrModifiers: string[];
  secondaryConcepts: string[];
  userIntentEntities: string[];
  resolvedName?: string;
  inferredPatternName?: string;
  resolutionStatus: InvestigationResolutionStatus;
  confidence: "high" | "medium" | "low";
  isTargeted: boolean;
  notes: string[];
};

const TEXT_FILE_RE = /\.(c|cc|conf|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/i;
const FRONTEND_RE = /\.(tsx|jsx|vue|svelte|html)$/i;
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|py|rs|go|java|cs)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[a-z0-9]+$/i;
const DOC_RE = /\.(md|mdx|rst|txt)$/i;
const GENERATED_RE = /(^|\/)(\.git|\.agent_memory|node_modules|dist|build|coverage|target|__pycache__|\.next|\.turbo)(\/|$)/i;

const ROLE_ORDER: MechanismEvidenceRole[] = [
  "ui_state",
  "ui_event_handler",
  "api_client_call",
  "backend_route",
  "service_logic",
  "storage_target",
  "storage_write",
  "log_append",
  "storage_read",
  "training_or_retraining",
  "job_or_scheduler",
  "lifecycle_status",
  "context_only",
  "general_storage",
  "test_endpoint_expectation",
  "test",
  "documentation",
  "unrelated_name_match"
];

const CONCEPT_ALIASES: Record<string, string[]> = {
  feedback: [
    "feedback",
    "customer feedback",
    "customer_feedback",
    "customerFeedback",
    "submitFeedback",
    "feedback_log",
    "awaiting_feedback",
    "review feedback",
    "positive",
    "negative",
    "neutral",
    "outcome"
  ],
  outerloop: [
    "outerloop",
    "outer_loop",
    "outer loop",
    "control loop",
    "agent loop",
    "planning loop",
    "feedback loop",
    "orchestrator",
    "action executor",
    "actionexecutor",
    "action loop",
    "decision loop",
    "review loop",
    "human review",
    "human_review",
    "retention offer",
    "retention_offer",
    "selected_action",
    "selected_action_name",
    "low_gap",
    "high_gap",
    "awaiting_feedback",
    "retraining log",
    "customer feedback",
    "observed_outcome",
    "recommendation",
    "action selection"
  ],
  inner_loop: [
    "inner loop",
    "inner_loop",
    "innerloop",
    "model pipeline",
    "prediction",
    "clustering",
    "svm",
    "shap",
    "recommendation",
    "decision"
  ],
  inner_outer_loop: [
    "inner loop",
    "outer loop",
    "inner_loop",
    "outer_loop",
    "feedback loop",
    "decision loop",
    "model pipeline",
    "action executor",
    "actionexecutor",
    "selected_action",
    "selected_action_name",
    "predict_customer_state",
    "svm",
    "dbscan",
    "retraining"
  ],
  multi_agent_system: [
    "multi agent",
    "multi-agent",
    "multi agentic",
    "multi-agentic",
    "multiagent",
    "agentic system",
    "agent system",
    "agents",
    "specialist agents",
    "build_default_agents",
    "BaseAgent",
    "ReliabilityAgent",
    "ForecastAgent",
    "ClusterHealthAgent",
    "ReActOrchestrator",
    "orchestrator",
    "agent_recommendations",
    "agent_consensus",
    "weighted_votes",
    "choose_route",
    "ActionExecutor"
  ],
  dbscan: ["dbscan", "DBSCAN", "fit_dbscan"],
  fcm: ["fcm", "FCM", "cmeans", "fuzzy c"],
  svm: ["svm", "SVM", "SVC", "support vector"],
  retraining_loop: ["retraining loop", "retrain", "retraining", "training job", "scheduler", "feedback log"],
  human_review_loop: [
    "human review",
    "manual review",
    "review loop",
    "awaiting_feedback",
    "review",
    "\u0645\u0631\u0627\u062c\u0639\u0629 \u0628\u0634\u0631\u064a\u0629",
    "\u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0628\u0634\u0631\u064a\u0629",
    "\u0645\u0631\u0627\u062c\u0639\u0629 \u064a\u062f\u0648\u064a\u0629",
    "\u062a\u062d\u0648\u064a\u0644 \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629",
    "\u0628\u0648\u0627\u0628\u0629 \u0645\u0631\u0627\u062c\u0639\u0629",
    "\u062a\u062f\u062e\u0644 \u0628\u0634\u0631\u064a"
  ],
  action_loop: [
    "action loop",
    "action executor",
    "direct dispatch",
    "dispatch",
    "selected_action",
    "selected_action_name",
    "retention offer",
    "recommendation",
    "\u062a\u0646\u0641\u064a\u0630 \u0645\u0628\u0627\u0634\u0631",
    "\u062a\u0648\u062c\u064a\u0647 \u0645\u0628\u0627\u0634\u0631",
    "\u0625\u0631\u0633\u0627\u0644 \u0645\u0628\u0627\u0634\u0631",
    "\u0627\u0644\u0625\u062c\u0631\u0627\u0621 \u0627\u0644\u0641\u0627\u0626\u0632",
    "\u0627\u0644\u0623\u0643\u0634\u0646"
  ]
};

const ARCHITECTURE_PATTERN_ALIASES = [
  "orchestrator",
  "action executor",
  "actionexecutor",
  "feedback log",
  "customer feedback",
  "positive",
  "negative",
  "neutral",
  "outcome",
  "retraining log",
  "review",
  "pass",
  "low_gap",
  "high_gap",
  "human review",
  "human_review",
  "retention offer",
  "retention_offer",
  "selected_action",
  "selected_action_name",
  "recommendation",
  "action selection",
  "state update",
  "metrics update",
  "retry",
  "retrain",
  "cycle"
];

const QUESTION_MODIFIER_TERMS = [
  "positive",
  "negative",
  "neutral",
  "pass",
  "review"
];

export function resolveInvestigationConcept(question: string): InvestigationConceptResolution {
  const normalized = normalizeInvestigationText(question);
  const asciiTokens = extractAsciiTokens(question).map(normalizeConcept).filter(Boolean);
  const hasFeedbackSignal = /\b(?:feedback|customer feedback|customer_feedback|submitfeedback|awaiting_feedback|outcome|positive|negative|neutral)\b/i.test(normalized)
    || /(?:\u0641\u064a\u062f\u0628\u0627\u0643|\u0627\u0644\u0641\u064a\u062f\u0628\u0627\u0643|\u0633\u0644\u0628\u064a|\u0633\u0644\u0628\u0649|\u0627\u064a\u062c\u0627\u0628\u064a|\u0625\u064a\u062c\u0627\u0628\u064a)/.test(question);
  const hasRetrainingSignal = /\b(?:retraining loop|retrain|retraining)\b/i.test(normalized)
    || /(?:\u0627\u0639\u0627\u062f\u0629\s+\u062a\u062f\u0631\u064a\u0628|\u0625\u0639\u0627\u062f\u0629\s+\u062a\u062f\u0631\u064a\u0628|\u062a\u062f\u0631\u064a\u0628|retraining)/i.test(question);
  const labelsOrModifiers = uniqueStrings([
    ...QUESTION_MODIFIER_TERMS.filter((term) => normalized.includes(term)),
    ...(/\bpositive\b/i.test(question) ? ["positive"] : []),
    ...(/\bnegative\b/i.test(question) || /(?:\u0633\u0644\u0628\u064a|\u0633\u0644\u0628\u0649)/.test(question) ? ["negative"] : []),
    ...(/\bneutral\b/i.test(question) ? ["neutral"] : [])
  ]);
  const notes: string[] = [];
  let targetConcept = "";
  let requestedConceptText = "";
  let resolvedName: string | undefined;
  let inferredPatternName: string | undefined;
  let secondaryConcepts: string[] = [];

  if (/\b(?:tech|technology)\s+stack\b/i.test(normalized)) {
    targetConcept = "general";
    requestedConceptText = "tech stack";
    notes.push("Tech-stack inventory is a structural project question, not a literal implementation concept.");
  } else if (/\b(?:dbscan|fit_dbscan)\b/i.test(normalized) || asciiTokens.includes("dbscan")) {
    targetConcept = "dbscan";
    requestedConceptText = "DBSCAN";
    resolvedName = "DBSCAN";
  } else if (/\b(?:fcm|cmeans|fuzzy c|fuzzy c means)\b/i.test(normalized)) {
    targetConcept = "fcm";
    requestedConceptText = "FCM";
    resolvedName = "Fuzzy C-Means";
  } else if (/\b(?:svm|svc|support vector)\b/i.test(normalized)) {
    targetConcept = "svm";
    requestedConceptText = "SVM";
    resolvedName = "SVM";
  } else if (/\b(?:shap|shap_values|kernelexplainer)\b/i.test(normalized)) {
    targetConcept = "shap";
    requestedConceptText = "SHAP";
    resolvedName = "SHAP";
  } else if (/\b(?:sarima|sarimax|arima)\b/i.test(normalized)) {
    targetConcept = "sarima";
    requestedConceptText = "SARIMA";
    resolvedName = "SARIMA";
  } else if (/\b(?:multi\s+agent(?:ic)?|multi-agent(?:ic)?|multiagent|agentic\s+system|agent\s+system|specialist\s+agents)\b/i.test(normalized)) {
    targetConcept = "multi_agent_system";
    requestedConceptText = "multi agentic system";
    resolvedName = "multi-agentic system";
    inferredPatternName = "specialist agents plus central orchestrator";
  } else if (/\binner\s+loop\b|\binner_loop\b|\binnerloop\b/i.test(normalized) && /\bouter\s+loop\b|\bouter_loop\b|\bouterloop\b/i.test(normalized)) {
    targetConcept = "inner_outer_loop";
    requestedConceptText = "inner loop / outer loop";
    resolvedName = "inner loop vs outer loop";
    inferredPatternName = "model decision loop vs feedback/action loop";
    secondaryConcepts = ["inner_loop", "outerloop"];
  } else if (/\b(?:outerloop|outer loop|outer_loop|outer-loop)\b/i.test(normalized)) {
    targetConcept = "outerloop";
    requestedConceptText = "outerloop";
    inferredPatternName = "decision/action feedback loop";
  } else if (/\b(?:innerloop|inner loop|inner_loop|inner-loop)\b/i.test(normalized)) {
    targetConcept = "inner_loop";
    requestedConceptText = "inner loop";
    inferredPatternName = "model/prediction decision loop";
  } else if (hasFeedbackSignal && hasRetrainingSignal) {
    targetConcept = "feedback";
    requestedConceptText = "feedback";
    resolvedName = "feedback";
    secondaryConcepts = ["retraining_loop"];
    notes.push("Mixed feedback/retraining question kept centered on feedback impact.");
    if (labelsOrModifiers.length) notes.push(`Feedback labels/modifiers detected: ${labelsOrModifiers.join(", ")}.`);
  } else if (/\b(?:retraining loop|retrain|retraining)\b/i.test(normalized)) {
    targetConcept = "retraining_loop";
    requestedConceptText = "retraining loop";
    inferredPatternName = "feedback-to-retraining loop";
  } else if (/\b(?:human review|manual review|review loop)\b/i.test(normalized)
    || /(?:\u0645\u0631\u0627\u062c\u0639\u0629\s+\u0628\u0634\u0631\u064a\u0629|\u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629\s+\u0627\u0644\u0628\u0634\u0631\u064a\u0629|\u0645\u0631\u0627\u062c\u0639\u0629\s+\u064a\u062f\u0648\u064a\u0629|\u062a\u062d\u0648\u064a\u0644\s+\u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629|\u062a\u062f\u062e\u0644\s+\u0628\u0634\u0631\u064a)/.test(question)) {
    targetConcept = "human_review_loop";
    requestedConceptText = "human review loop";
    inferredPatternName = "review/action loop";
  } else if (/\b(?:action loop|action executor|direct dispatch|dispatch|selected_action|retention offer)\b/i.test(normalized)
    || /(?:\u062a\u0646\u0641\u064a\u0630\s+\u0645\u0628\u0627\u0634\u0631|\u062a\u0648\u062c\u064a\u0647\s+\u0645\u0628\u0627\u0634\u0631|\u0625\u0631\u0633\u0627\u0644\s+\u0645\u0628\u0627\u0634\u0631|\u0627\u0644\u0625\u062c\u0631\u0627\u0621\s+\u0627\u0644\u0641\u0627\u0626\u0632)/.test(question)) {
    targetConcept = "action_loop";
    requestedConceptText = "action loop";
    inferredPatternName = "decision/action loop";
  } else if (/\b(?:feedback|customer feedback|customer_feedback|submitfeedback|awaiting_feedback|outcome|positive|negative|neutral)\b/i.test(normalized)
    || /(?:\u0641\u064a\u062f\u0628\u0627\u0643|\u0627\u0644\u0641\u064a\u062f\u0628\u0627\u0643)/.test(question)) {
    targetConcept = "feedback";
    requestedConceptText = "feedback";
    resolvedName = "feedback";
    if (labelsOrModifiers.length) notes.push(`Feedback labels/modifiers detected: ${labelsOrModifiers.join(", ")}.`);
  }

  if (!targetConcept) {
    const firstEntity = asciiTokens.find((token) => !isInvestigationStopWord(token) && token.length > 2);
    targetConcept = firstEntity ?? "general";
    requestedConceptText = firstEntity ?? "this project";
  }

  const literalTerms = literalTermsForResolvedConcept(targetConcept, requestedConceptText);
  const aliasTerms = uniqueStrings([...(CONCEPT_ALIASES[targetConcept] ?? []), requestedConceptText, targetConcept])
    .filter(Boolean);
  const isArchitectureConcept = isArchitectureLevelConcept(targetConcept);
  const behavioralTerms = isArchitectureConcept
    ? ARCHITECTURE_PATTERN_ALIASES.filter((term) => /feedback|outcome|review|action|decision|offer|pass|gap|retrain|cycle|orchestrator/i.test(term))
    : targetConcept === "feedback"
      ? ["positive", "negative", "neutral", "outcome", "awaiting_feedback", "customer feedback", "feedback log"]
      : [];
  const architecturalTerms = isArchitectureConcept ? uniqueStrings([...ARCHITECTURE_PATTERN_ALIASES, ...aliasTerms]) : [];
  const isTargeted = targetConcept !== "general";
  const confidence = ["dbscan", "fcm", "svm", "shap", "sarima", "feedback"].includes(targetConcept)
    ? "high"
    : isArchitectureConcept
      ? "medium"
      : "low";

  return {
    targetConcept,
    requestedConceptText,
    literalTerms,
    aliasTerms,
    behavioralTerms,
    architecturalTerms,
    labelsOrModifiers,
    secondaryConcepts,
    userIntentEntities: asciiTokens.filter((token) => !isInvestigationStopWord(token)).slice(0, 12),
    resolvedName,
    inferredPatternName,
    resolutionStatus: "not_found",
    confidence,
    isTargeted,
    notes
  };
}

export function buildProjectIntelligenceGraph(input: ProjectIntelligenceBuildInput): ProjectIntelligenceGraph {
  const targetConcept = normalizeConcept(input.targetConcept ?? "") || resolveInvestigationConcept(input.targetConcept ?? "").targetConcept;
  const targetTerms = termsForConcept(targetConcept);
  const nodes = new Map<string, ProjectIntelligenceNode>();
  const edges = new Map<string, ProjectIntelligenceEdge>();
  const evidence = new Map<string, MechanismEvidence>();
  const expansionTrace: string[] = [];
  const files = input.filePaths
    .map(normalizePath)
    .filter((file) => TEXT_FILE_RE.test(file) && !GENERATED_RE.test(file))
    .slice(0, input.maxFiles ?? 160);

  for (const filePath of files) {
    let text = "";
    try {
      text = input.readFile(filePath).slice(0, input.maxReadChars ?? 300_000);
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    addNode(nodes, nodeId("file", filePath), fileKind(filePath), filePath, filePath);
    scanFile({
      filePath,
      text,
      targetConcept,
      targetTerms,
      nodes,
      edges,
      evidence
    });
  }

  addGraphExpansionTrace(evidence, expansionTrace);
  const graphEvidence = [...evidence.values()]
    .sort((left, right) =>
      mechanismEvidencePriority(right, targetConcept) - mechanismEvidencePriority(left, targetConcept)
      || roleRank(left.role) - roleRank(right.role)
      || left.path.localeCompare(right.path)
      || left.line - right.line
    )
    .slice(0, 160);
  const graphNodes = [...nodes.values()].slice(0, 240);
  const graphEdges = [...edges.values()].slice(0, 240);
  const summary = summarizeProjectIntelligenceGraph({
    targetConcept,
    nodes: graphNodes,
    edges: graphEdges,
    evidence: graphEvidence,
    graphExpansionTrace: expansionTrace,
    summary: emptySummary(),
    testEndpointExpectations: [],
    targetScopedStorageEvidence: [],
    generalStorageEvidence: [],
    mechanismExpansionTrace: expansionTrace,
    rejectedMechanismEvidence: []
  });
  return {
    targetConcept,
    nodes: graphNodes,
    edges: graphEdges,
    evidence: graphEvidence,
    graphExpansionTrace: expansionTrace,
    summary,
    testEndpointExpectations: graphEvidence.filter((item) => item.role === "test_endpoint_expectation"),
    targetScopedStorageEvidence: graphEvidence.filter((item) => isTargetStorageRole(item.role) && item.targetScoped !== false),
    generalStorageEvidence: graphEvidence.filter((item) => item.role === "general_storage" || (isTargetStorageRole(item.role) && item.targetScoped === false)),
    mechanismExpansionTrace: expansionTrace,
    rejectedMechanismEvidence: graphEvidence.filter((item) => item.role === "general_storage" || item.role === "unrelated_name_match")
  };
}

export function resolveMechanismChain(graph: ProjectIntelligenceGraph, targetConcept = graph.targetConcept): MechanismChain {
  const concept = normalizeConcept(targetConcept);
  const steps = buildMechanismSteps(graph, concept);
  const confirmedFiles = uniqueStrings(steps.flatMap((step) => step.files));
  const missingLinks = missingMechanismLinks(concept, graph.evidence);
  const hasCoreMechanism = concept === "feedback"
    ? hasProvenRelation(steps, "frontend_to_api") &&
      hasProvenRelation(steps, "api_to_backend") &&
      hasProvenRelation(steps, "backend_to_storage")
    : isArchitectureLevelConcept(concept)
      ? hasArchitectureLoopEvidence(steps)
      : steps.some((step) => step.status === "proven" && !["context_only", "general_storage", "lifecycle_status", "test_endpoint_expectation", "test", "documentation", "unrelated_name_match"].includes(step.role));
  const hasAnyEvidence = steps.length > 0 || graph.evidence.some((item) => item.role !== "unrelated_name_match" && item.role !== "general_storage");
  const status: MechanismChainStatus = hasCoreMechanism ? "confirmed" : hasAnyEvidence ? "partial" : "not_found";
  const confidence = status === "confirmed" ? "high" : status === "partial" ? "medium" : "low";
  return {
    targetConcept: concept,
    status,
    confidence,
    steps,
    confirmedFiles,
    missingLinks
  };
}

export function validateMechanismCoverage(input: {
  targetConcept: string;
  mechanismChain: MechanismChain;
  graph: ProjectIntelligenceGraph;
  answerMarkdown?: string;
}): MechanismCoverageValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const target = normalizeConcept(input.targetConcept);
  const answer = input.answerMarkdown ?? "";
  if (target === "feedback") {
    if (input.mechanismChain.status !== "confirmed" && /\b(applied|implemented|wired|backend|stored|persisted|sent|submitted)\b/i.test(answer)) {
      errors.push("Answer claims feedback is applied end-to-end without a confirmed mechanism chain.");
    }
    if (hasAnyRole(input.graph.evidence, ["storage_target"]) && !hasAnyRole(input.graph.evidence, ["storage_write", "storage_read", "log_append"])) {
      warnings.push("Storage/log path was found, but no read/write mechanism was proven.");
    }
  }
  if (hasAnyRole(input.graph.evidence, ["lifecycle_status"]) && !hasAnyRole(input.graph.evidence, ["ui_event_handler", "api_client_call", "backend_route", "storage_write", "log_append"])) {
    warnings.push("Only lifecycle/status evidence was found; it must not be treated as implementation.");
  }
  if (target === "feedback" && hasAnyRole(input.graph.evidence, ["test_endpoint_expectation"]) && !hasAnyRole(input.graph.evidence, ["api_client_call"]) && /\b(frontend|client|UI|sent|submitted|الواجهة|يرسل)\b/i.test(answer)) {
    errors.push("Answer treats test endpoint evidence as a production frontend/client flow.");
  }
  if (target === "feedback" && hasAnyRole(input.graph.evidence, ["general_storage"]) && /CUSTOMERS_PATH|save_dataset|to_csv|general_storage/i.test(answer)) {
    errors.push("Answer uses general storage evidence as proof for target feedback storage.");
  }
  if (/\b(ui_state|backend_route|behavioral_found|directMechanismEvidence|mechanismCoverageValidation)\b/.test(answer)) {
    errors.push("Answer exposes audit/debug role labels instead of a user-facing explanation.");
  }
  if (/outputs? (?:are )?not (?:clear|proven|explicit)|النواتج غير واضحة/i.test(answer) && input.graph.evidence.some((item) => item.role === "storage_write" || item.role === "log_append")) {
    errors.push("Answer says outputs are unclear even though storage/log outputs are proven.");
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    missingLinks: input.mechanismChain.missingLinks
  };
}

export function summarizeProjectIntelligenceGraph(graph: ProjectIntelligenceGraph): ProjectIntelligenceGraphSummary {
  const roles = emptyRoleCounts();
  for (const item of graph.evidence) roles[item.role] += 1;
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    evidenceCount: graph.evidence.length,
    roles,
    importantFiles: uniqueStrings(graph.evidence.map((item) => item.path)).slice(0, 12)
  };
}

function scanFile(input: {
  filePath: string;
  text: string;
  targetConcept: string;
  targetTerms: string[];
  nodes: Map<string, ProjectIntelligenceNode>;
  edges: Map<string, ProjectIntelligenceEdge>;
  evidence: Map<string, MechanismEvidence>;
}) {
  const lines = input.text.split(/\r?\n/);
  const storageNames = collectStorageNames(lines);
  const ownerByLine = indexOwnerSymbols(lines);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const snippet = snippetAround(lines, index);
    const lineNumber = index + 1;
    const role = classifyMechanismRole(input.filePath, line, snippet, input.targetConcept, input.targetTerms, storageNames);
    if (!role) continue;
    const endpoint = endpointForRole(role, line, snippet);
    const storageTarget = storageTargetForRole(role, line, snippet, storageNames);
    const ownerSymbol = ownerSymbolForRole(role, lines, index, ownerByLine, snippet);
    const symbol = extractNearestSymbol(snippet) ?? ownerSymbol;
    const targetScoped = isTargetScopedEvidence({
      role,
      filePath: input.filePath,
      line,
      snippet,
      targetConcept: input.targetConcept,
      targetTerms: input.targetTerms,
      endpoint,
      storageTarget,
      ownerSymbol
    });
    const relatedNames = uniqueStrings([
      ...(role === "ui_state" || role === "ui_event_handler" ? extractUiMechanismNames(snippet) : extractIdentifiers(line)),
      ...(endpoint ? [endpoint] : []),
      ...(storageTarget ? [storageTarget] : [])
    ]).slice(0, 12);
    const evidenceItem: MechanismEvidence = {
      id: `${input.filePath}:${lineNumber}:${role}`,
      role,
      path: input.filePath,
      line: lineNumber,
      snippet,
      reason: roleReason(role, input.targetConcept),
      symbol,
      endpoint,
      storageTarget,
      ownerSymbol,
      from: inferFrom(role, ownerSymbol, endpoint, storageTarget),
      to: inferTo(role, endpoint, storageTarget),
      targetScoped,
      relatedNames,
      confidence: roleConfidence(role)
    };
    addEvidence(input.evidence, evidenceItem);
    addMechanismNodesAndEdges(input.nodes, input.edges, evidenceItem);
  }
}

function classifyMechanismRole(
  filePath: string,
  line: string,
  snippet: string,
  targetConcept: string,
  targetTerms: string[],
  storageNames: string[]
): MechanismEvidenceRole | undefined {
  const haystack = `${line}\n${snippet}`;
  const targetSeen = !targetConcept || targetTerms.some((term) => includesTerm(haystack, term));
  if (TEST_RE.test(filePath) && (targetSeen || endpointMatchesTarget(haystack, targetTerms))) {
    return extractEndpoint(haystack) ? "test_endpoint_expectation" : "test";
  }
  if (DOC_RE.test(filePath) && targetSeen) return "documentation";
  if (isClientSourceFile(filePath)
    && /\b(fetch|axios\.(?:get|post|put|patch|delete)|request\(|client\.(?:get|post|put|patch|delete)|apiGet|apiPost|postJson|getJson)\b/.test(haystack)
    && isConcreteEndpoint(extractEndpoint(line) ?? extractEndpoint(snippet))
    && (targetSeen || endpointMatchesTarget(haystack, targetTerms))) return "api_client_call";
  if (isRouteLine(line)) return endpointMatchesTarget(line, targetTerms) ? "backend_route" : undefined;
  if (/\b(CUSTOMER_[A-Z0-9_]*LOG_PATH|[A-Z0-9_]*(?:LOG|CSV|FILE|PATH)[A-Z0-9_]*)\b/.test(line) && storageNames.some((name) => line.includes(name))) {
    return isTargetScopedStorage(haystack, targetConcept, targetTerms, extractStorageTarget(line, storageNames) ?? extractStorageTarget(snippet, storageNames)) ? "storage_target" : "general_storage";
  }
  if (isStorageWrite(line) && storageNames.some((name) => haystack.includes(name))) return isTargetScopedStorage(haystack, targetConcept, targetTerms, extractStorageTarget(line, storageNames) ?? extractStorageTarget(snippet, storageNames)) ? isLogLike(haystack) ? "log_append" : "storage_write" : "general_storage";
  if (targetSeen && /(?:^|[^A-Za-z0-9_])_?(?:append|record|write|save|persist|log)_[A-Za-z0-9_]*(?:feedback|outcome|retrain|log)|(?:^|[^A-Za-z0-9_])_?[A-Za-z0-9_]*(?:feedback|outcome|retrain|log)[A-Za-z0-9_]*(?:append|record|write|save|persist|log)\b/i.test(line)) return "log_append";
  if (isStorageRead(line) && storageNames.some((name) => haystack.includes(name))) return isTargetScopedStorage(haystack, targetConcept, targetTerms, extractStorageTarget(line, storageNames) ?? extractStorageTarget(snippet, storageNames)) ? "storage_read" : "general_storage";
  if (normalizeConcept(targetConcept) === "feedback" && SOURCE_RE.test(filePath) && /\b(should_trigger_outer_loop|retrain_with_rollback|interpret_customer_feedback|submit_customer_feedback)\b/i.test(haystack)) {
    return /\b(retrain_with_rollback|retraining_event)\b/i.test(haystack) ? "training_or_retraining" : "lifecycle_status";
  }
  if (FRONTEND_RE.test(filePath) && targetSeen && /\b(onSubmit|onClick|handle[A-Z][A-Za-z0-9_]*|submit[A-Z][A-Za-z0-9_]*|addEventListener)\b/.test(haystack)) return "ui_event_handler";
  if (FRONTEND_RE.test(filePath) && targetSeen && /\b(useState|state|set[A-Z][A-Za-z0-9_]*|feedback\s*:|submitting\s*:)\b/.test(haystack)) return "ui_state";
  if (targetSeen && /\b(retrain|training|train_|fit\(|scheduler|cron|job|queue|interval)\b/i.test(haystack)) return /\b(scheduler|cron|job|queue|interval)\b/i.test(haystack) ? "job_or_scheduler" : "training_or_retraining";
  if (targetSeen && /\b(route|service|controller|handler|process|execute|apply|save|submit)\b/i.test(haystack) && SOURCE_RE.test(filePath)) return "service_logic";
  if (targetSeen && /\b(awaiting_feedback|pending_feedback|status|observed_outcome|lifecycle|state)\b/i.test(haystack)) return "lifecycle_status";
  if (targetSeen && /\b(action|decision|review|probability|recommendation|offer|human_review)\b/i.test(haystack)) return "context_only";
  if (targetSeen) return "unrelated_name_match";
  return undefined;
}

function endpointForRole(role: MechanismEvidenceRole, line: string, snippet: string) {
  if (role === "backend_route") return extractEndpoint(line);
  if (role === "api_client_call" || role === "test_endpoint_expectation") return extractEndpoint(line) ?? extractEndpoint(snippet);
  return undefined;
}

function storageTargetForRole(role: MechanismEvidenceRole, line: string, snippet: string, storageNames: string[]) {
  if (!isTargetStorageRole(role) && role !== "general_storage") return undefined;
  return extractStorageTarget(line, storageNames) ?? extractStorageTarget(snippet, storageNames);
}

function ownerSymbolForRole(
  role: MechanismEvidenceRole,
  lines: string[],
  index: number,
  ownerByLine: Array<string | undefined>,
  snippet: string
) {
  if (role === "backend_route") return nextOwnerSymbol(lines, index) ?? ownerByLine[index] ?? extractNearestSymbol(snippet);
  return ownerByLine[index] ?? extractNearestSymbol(snippet);
}

function nextOwnerSymbol(lines: string[], index: number) {
  for (let cursor = index + 1; cursor < Math.min(lines.length, index + 6); cursor += 1) {
    const line = lines[cursor] ?? "";
    const match = line.match(/^\s*(?:async\s+)?(?:function\s+|def\s+)([A-Za-z_][A-Za-z0-9_]*)|^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(?/);
    if (match?.[1] || match?.[2]) return match[1] ?? match[2];
    if (line.trim() && !line.trim().startsWith("@")) break;
  }
  return undefined;
}

function addMechanismNodesAndEdges(
  nodes: Map<string, ProjectIntelligenceNode>,
  edges: Map<string, ProjectIntelligenceEdge>,
  evidence: MechanismEvidence
) {
  const fileNodeId = nodeId("file", evidence.path);
  addNode(nodes, fileNodeId, fileKind(evidence.path), evidence.path, evidence.path, evidence.line);
  const mechanismNodeId = nodeId(evidence.role, `${evidence.path}:${evidence.line}:${evidence.symbol ?? evidence.endpoint ?? evidence.storageTarget ?? ""}`);
  addNode(nodes, mechanismNodeId, nodeKindForRole(evidence.role), evidence.symbol ?? evidence.endpoint ?? evidence.storageTarget ?? evidence.role, evidence.path, evidence.line);
  addEdge(edges, fileNodeId, mechanismNodeId, edgeKindForRole(evidence.role), `${evidence.path}:${evidence.line}`, evidence.role);
  if (evidence.endpoint) {
    const endpointId = nodeId("endpoint", evidence.endpoint);
    addNode(nodes, endpointId, "endpoint", evidence.endpoint, evidence.path, evidence.line);
    addEdge(edges, mechanismNodeId, endpointId, evidence.role === "backend_route" || evidence.role === "test_endpoint_expectation" ? "route_handles" : "fetches_endpoint", `${evidence.path}:${evidence.line}`);
  }
  if (evidence.storageTarget) {
    const storageId = nodeId("storage", evidence.storageTarget);
    addNode(nodes, storageId, isLogLike(evidence.storageTarget) ? "log_file" : "storage_file", evidence.storageTarget, evidence.path, evidence.line);
    addEdge(edges, mechanismNodeId, storageId, evidence.role === "storage_read" ? "reads_from" : "writes_to", `${evidence.path}:${evidence.line}`);
  }
}

function addGraphExpansionTrace(evidence: Map<string, MechanismEvidence>, trace: string[]) {
  const items = [...evidence.values()];
  const ui = items.filter((item) => item.role === "ui_state" || item.role === "ui_event_handler");
  if (ui.length) trace.push(`UI feedback evidence found in ${uniqueStrings(ui.map((item) => item.path)).join(", ")}; scanned for submit handlers, fetch/POST calls, and matching backend routes.`);
  const endpoints = uniqueStrings(items.flatMap((item) => item.endpoint ? [item.endpoint] : []));
  for (const endpoint of endpoints.slice(0, 6)) {
    const hasClient = items.some((item) => item.role === "api_client_call" && item.endpoint === endpoint);
    const hasRoute = items.some((item) => item.role === "backend_route" && item.endpoint === endpoint);
    const hasTest = items.some((item) => item.role === "test_endpoint_expectation" && item.endpoint === endpoint);
    trace.push(hasClient && hasRoute
      ? `Endpoint ${endpoint} is linked from frontend/client evidence to backend route evidence.`
      : `Endpoint ${endpoint} was found via ${[hasClient ? "client" : "", hasRoute ? "route" : "", hasTest ? "test" : ""].filter(Boolean).join("+") || "evidence"}; matching ${hasClient ? "backend route" : "production client call"} remains unproven.`);
  }
  const storageTargets = uniqueStrings(items.flatMap((item) => item.storageTarget ? [item.storageTarget] : []));
  for (const target of storageTargets.slice(0, 6)) {
    const hasTarget = items.some((item) => item.role === "storage_target" && item.storageTarget === target);
    const hasWrite = items.some((item) => (item.role === "storage_write" || item.role === "log_append") && item.storageTarget === target);
    const hasRead = items.some((item) => item.role === "storage_read" && item.storageTarget === target);
    const isGeneral = items.some((item) => item.role === "general_storage" && item.storageTarget === target);
    if (hasTarget || isGeneral) trace.push(`Storage target ${target} scanned for usages: targetScoped=${!isGeneral}, write=${hasWrite}, read=${hasRead}.`);
  }
}

function buildMechanismSteps(graph: ProjectIntelligenceGraph, targetConcept: string) {
  if (targetConcept === "feedback") return buildFeedbackMechanismSteps(graph.evidence);
  if (isArchitectureLevelConcept(targetConcept)) return buildArchitectureMechanismSteps(graph.evidence, targetConcept);
  return buildRoleOrderedMechanismSteps(graph.evidence);
}

function missingMechanismLinks(targetConcept: string, evidence: MechanismEvidence[]) {
  if (isArchitectureLevelConcept(targetConcept)) {
    const missing: string[] = [];
    if (!hasAnyRole(evidence, ["service_logic", "context_only", "backend_route", "training_or_retraining"])) missing.push("inner_model_or_decision_stage");
    if (!hasAnyRole(evidence, ["lifecycle_status", "api_client_call", "backend_route", "storage_write", "log_append"])) missing.push("feedback_or_outcome_stage");
    if (!hasAnyRole(evidence, ["storage_write", "log_append", "training_or_retraining", "job_or_scheduler"])) missing.push("state_log_or_retraining_update");
    if (!hasAnyRole(evidence, ["training_or_retraining", "job_or_scheduler", "service_logic"])) missing.push("next_cycle_effect");
    return missing;
  }
  if (targetConcept !== "feedback") return [];
  const missing: string[] = [];
  if (!hasAnyRole(evidence, ["ui_state", "ui_event_handler", "api_client_call"])) missing.push("frontend_feedback_surface");
  if (!hasAnyRole(evidence, ["api_client_call"])) missing.push("frontend_to_backend_request");
  const endpoints = targetEndpointSet(evidence);
  if (!hasMatchingEndpoint(evidence, "backend_route", endpoints) && !hasAnyRole(evidence, ["service_logic"])) missing.push("backend_feedback_handler");
  if (!hasTargetScopedStorageWrite(evidence)) missing.push("feedback_storage_or_log_usage");
  if (!hasAnyRole(evidence, ["training_or_retraining", "job_or_scheduler"])) missing.push("downstream_feedback_consumer");
  return missing;
}

function userFacingMechanismLabel(role: MechanismEvidenceRole, items: MechanismEvidence[]) {
  const first = items[0];
  const location = first ? `${first.path}:${first.line}` : "unknown";
  if (role === "ui_state") return `UI state related to the target appears at ${location}`;
  if (role === "ui_event_handler") return `UI handler or submit action appears at ${location}`;
  if (role === "api_client_call") return `Client/API request is made at ${location}`;
  if (role === "backend_route") return `Backend route handles the endpoint at ${location}`;
  if (role === "service_logic") return `Service logic processes the target at ${location}`;
  if (role === "storage_target") return `Storage/log target is declared at ${location}`;
  if (role === "storage_write" || role === "log_append") return `Storage or log write is performed at ${location}`;
  if (role === "storage_read") return `Storage or log read is performed at ${location}`;
  if (role === "training_or_retraining") return `Training/retraining consumer appears at ${location}`;
  if (role === "job_or_scheduler") return `Job/scheduler link appears at ${location}`;
  if (role === "lifecycle_status") return `Lifecycle/status evidence appears at ${location}`;
  if (role === "context_only") return `Context-only decision/action evidence appears at ${location}`;
  if (role === "general_storage") return `General storage evidence appears at ${location}`;
  if (role === "test_endpoint_expectation") return `Test expects endpoint behavior at ${location}`;
  return `${role} appears at ${location}`;
}

function buildFeedbackMechanismSteps(evidence: MechanismEvidence[]) {
  const steps: MechanismChainStep[] = [];
  const ui = evidence.filter((item) => item.role === "ui_event_handler" || item.role === "ui_state");
  const apiCalls = evidence.filter((item) => item.role === "api_client_call" && item.endpoint);
  const tests = evidence.filter((item) => item.role === "test_endpoint_expectation" && item.endpoint);
  const endpoints = targetEndpointSet(evidence);
  const backendRoutes = evidence.filter((item) => item.role === "backend_route" && (!endpoints.size || endpoints.has(endpointMatchKey(item.endpoint))));
  const services = evidence.filter((item) => item.role === "service_logic");
  const storage = targetScopedStorageWrites(evidence);
  const storageTargets = evidence.filter((item) => item.role === "storage_target" && item.targetScoped !== false);
  const statuses = evidence.filter((item) => item.role === "lifecycle_status");
  const downstream = evidence.filter((item) => item.role === "training_or_retraining" || item.role === "job_or_scheduler");

  if (ui.length) pushMechanismStep(steps, {
    role: ui.some((item) => item.role === "ui_event_handler") ? "ui_event_handler" : "ui_state",
    relation: "frontend_surface",
    status: ui.some((item) => item.role === "ui_event_handler") ? "proven" : "partial",
    label: feedbackStepLabel("frontend_surface", ui),
    items: ui
  });

  if (apiCalls.length) {
    for (const endpoint of uniqueStrings(apiCalls.map((item) => item.endpoint ?? "")).slice(0, 4)) {
      const items = apiCalls.filter((item) => endpointMatchKey(item.endpoint) === endpointMatchKey(endpoint));
      pushMechanismStep(steps, {
        role: "api_client_call",
        relation: "frontend_to_api",
        status: "proven",
        label: `Client code sends feedback to ${endpoint}.`,
        items,
        from: items[0]?.ownerSymbol,
        to: endpoint
      });
    }
  } else if (tests.length) {
    for (const endpoint of uniqueStrings(tests.map((item) => item.endpoint ?? "")).slice(0, 2)) {
      const items = tests.filter((item) => item.endpoint === endpoint);
      pushMechanismStep(steps, {
        role: "test_endpoint_expectation",
        relation: "test_expected_endpoint",
        status: "partial",
        label: `Tests expect feedback endpoint ${endpoint}, but this is not production client flow.`,
        items,
        from: "test",
        to: endpoint
      });
    }
  }

  const seenBackendEndpointKeys = new Set<string>();
  for (const endpoint of uniqueStrings([...apiCalls, ...tests, ...backendRoutes].map((item) => item.endpoint ?? "")).slice(0, 4)) {
    const endpointKey = endpointMatchKey(endpoint);
    if (seenBackendEndpointKeys.has(endpointKey)) continue;
    seenBackendEndpointKeys.add(endpointKey);
    const routeItems = backendRoutes.filter((item) => endpointMatchKey(item.endpoint) === endpointMatchKey(endpoint));
    if (!routeItems.length) continue;
    pushMechanismStep(steps, {
      role: "backend_route",
      relation: "api_to_backend",
      status: "proven",
      label: `Backend route handles feedback endpoint ${endpoint}.`,
      items: routeItems,
      from: endpoint,
      to: routeItems[0]?.ownerSymbol ?? endpoint
    });
  }

  if (!backendRoutes.length && services.length) {
    pushMechanismStep(steps, {
      role: "service_logic",
      relation: "backend_service_logic",
      status: "partial",
      label: "Backend/service code mentions feedback, but no matching route edge was proven.",
      items: services
    });
  }

  if (storage.length) {
    const routeOwners = new Set(backendRoutes.map((item) => item.ownerSymbol).filter(Boolean));
    const ownerScoped = storage.filter((item) => !routeOwners.size || routeOwners.has(item.ownerSymbol));
    pushMechanismStep(steps, {
      role: storage.some((item) => item.role === "log_append") ? "log_append" : "storage_write",
      relation: "backend_to_storage",
      status: ownerScoped.length ? "proven" : "partial",
      label: ownerScoped.length
        ? "Backend handler writes or appends feedback to target-scoped storage/log."
        : "Target-scoped feedback storage write exists, but the exact route-to-writer owner edge is partial.",
      items: ownerScoped.length ? ownerScoped : storage,
      from: ownerScoped[0]?.ownerSymbol ?? storage[0]?.ownerSymbol,
      to: ownerScoped[0]?.storageTarget ?? storage[0]?.storageTarget
    });
  } else if (storageTargets.length) {
    pushMechanismStep(steps, {
      role: "storage_target",
      relation: "storage_target_declared",
      status: "partial",
      label: "Feedback storage/log target is declared, but no writer/read edge was proven.",
      items: storageTargets,
      to: storageTargets[0]?.storageTarget
    });
  }

  if (statuses.length) pushMechanismStep(steps, {
    role: "lifecycle_status",
    relation: "feedback_lifecycle_status",
    status: "partial",
    label: "Lifecycle/status evidence shows the system can wait for or record feedback state.",
    items: statuses
  });

  if (downstream.length) pushMechanismStep(steps, {
    role: downstream.some((item) => item.role === "training_or_retraining") ? "training_or_retraining" : "job_or_scheduler",
    relation: "downstream_consumer",
    status: "partial",
    label: "A downstream retraining/job/review consumer is nearby; data dependency is proven only where cited.",
    items: downstream
  });

  return steps;
}

function buildArchitectureMechanismSteps(evidence: MechanismEvidence[], targetConcept: string) {
  const steps: MechanismChainStep[] = [];
  const decision = evidence.filter((item) =>
    item.role === "service_logic"
    || item.role === "context_only"
    || item.role === "backend_route"
    || /\b(orchestrator|executor|decision|selected_action|recommendation|predict|svm|cluster|shap|low_gap|high_gap)\b/i.test(item.snippet)
  );
  const feedback = evidence.filter((item) =>
    item.role === "lifecycle_status"
    || item.role === "api_client_call"
    || item.role === "backend_route"
    || item.role === "storage_target"
    || item.role === "storage_write"
    || item.role === "log_append"
    || /\b(feedback|outcome|positive|negative|neutral|awaiting_feedback)\b/i.test(item.snippet)
  );
  const updates = evidence.filter((item) =>
    item.role === "training_or_retraining"
    || item.role === "job_or_scheduler"
    || item.role === "storage_write"
    || item.role === "log_append"
    || /\b(retrain|metric|update|review|log|csv|write|append)\b/i.test(item.snippet)
  );

  if (decision.length) pushMechanismStep(steps, {
    role: decision.some((item) => item.role === "service_logic") ? "service_logic" : "context_only",
    relation: targetConcept === "inner_loop" ? "inner_model_decision" : "decision_action_stage",
    status: "partial",
    label: "The code has a model/decision/action stage that can be part of the loop.",
    items: decision
  });
  if (feedback.length) pushMechanismStep(steps, {
    role: feedback.some((item) => item.role === "backend_route") ? "backend_route" : feedback.some((item) => item.role === "lifecycle_status") ? "lifecycle_status" : "context_only",
    relation: "feedback_or_outcome_stage",
    status: feedback.some((item) => item.role === "api_client_call" || item.role === "backend_route" || item.role === "storage_write" || item.role === "log_append") ? "proven" : "partial",
    label: "The code has feedback/outcome evidence that may close the outer loop.",
    items: feedback
  });
  if (updates.length) pushMechanismStep(steps, {
    role: updates.some((item) => item.role === "training_or_retraining") ? "training_or_retraining" : updates.some((item) => item.role === "log_append") ? "log_append" : "storage_write",
    relation: "state_log_or_retraining_update",
    status: updates.some((item) => item.role === "training_or_retraining" || item.role === "job_or_scheduler") ? "proven" : "partial",
    label: "The code has log/state/retraining update evidence tied to later behavior.",
    items: updates
  });
  return steps;
}

function buildRoleOrderedMechanismSteps(evidence: MechanismEvidence[]) {
  const steps: MechanismChainStep[] = [];
  const grouped = new Map<MechanismEvidenceRole, MechanismEvidence[]>();
  for (const item of evidence) {
    const current = grouped.get(item.role) ?? [];
    current.push(item);
    grouped.set(item.role, current);
  }
  for (const role of ROLE_ORDER) {
    const items = grouped.get(role) ?? [];
    if (!items.length || role === "general_storage" || role === "test_endpoint_expectation" || role === "unrelated_name_match" || role === "test" || role === "documentation") continue;
    pushMechanismStep(steps, {
      role,
      relation: role,
      status: role === "lifecycle_status" || role === "context_only" || role === "storage_target" ? "partial" : "proven",
      label: userFacingMechanismLabel(role, items),
      items
    });
  }
  return steps;
}

function pushMechanismStep(
  steps: MechanismChainStep[],
  input: {
    role: MechanismEvidenceRole;
    relation: string;
    status: "proven" | "partial" | "unproven";
    label: string;
    items: MechanismEvidence[];
    from?: string;
    to?: string;
  }
) {
  const items = input.items.filter(Boolean).slice(0, 8);
  if (!items.length) return;
  steps.push({
    order: steps.length + 1,
    role: input.role,
    relation: input.relation,
    status: input.status,
    label: input.label,
    ownerSymbol: items[0]?.ownerSymbol,
    from: input.from ?? items[0]?.from,
    to: input.to ?? items[0]?.to,
    confidence: input.status === "proven" ? strongestConfidence(items) : input.status === "partial" ? "medium" : "low",
    evidenceRefs: items.slice(0, 4).map((item) => `${item.path}:${item.line}`),
    files: uniqueStrings(items.map((item) => item.path)).slice(0, 6)
  });
}

function feedbackStepLabel(relation: string, items: MechanismEvidence[]) {
  if (relation === "frontend_surface") {
    const controls = uniqueStrings(items.flatMap((item) => item.relatedNames)).filter((name) => /^(form|button|input|textarea|select|onSubmit|onClick|onChange|submit|handle)/i.test(name));
    return controls.length
      ? `Feedback UI surface has controls/handlers: ${controls.slice(0, 4).join(", ")}.`
      : "Feedback UI state exists, but no submit control is proven from this evidence.";
  }
  return userFacingMechanismLabel(items[0]?.role ?? "context_only", items);
}

function collectStorageNames(lines: string[]) {
  const names = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/\b([A-Z][A-Z0-9_]*(?:LOG|CSV|FILE|PATH)[A-Z0-9_]*)\b/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

function extractStorageTarget(text: string, storageNames: string[]) {
  for (const name of storageNames) {
    if (text.includes(name)) return name;
  }
  const constant = text.match(/\b([A-Z][A-Z0-9_]*(?:LOG|CSV|FILE|PATH)[A-Z0-9_]*)\b/);
  if (constant?.[1]) return constant[1];
  const pathLike = text.match(/["']([^"'\r\n]*(?:feedback|log|csv)[^"'\r\n]*)["']/i);
  return pathLike?.[1];
}

function extractEndpoint(text: string) {
  const route = text.match(/(?:@\w+\.(?:get|post|put|patch|delete)|router\.(?:get|post|put|patch|delete)|app\.(?:get|post|put|patch|delete)|fetch|apiGet|apiPost|postJson|getJson|axios\.(?:get|post|put|patch|delete)|client\.(?:get|post|put|patch|delete)|self\.client\.(?:get|post|put|patch|delete))\s*\(?\s*["'`]([^"'`]+)["'`]/i);
  if (route?.[1]) return route[1];
  const methodObject = text.match(/\burl\s*:\s*["'`]([^"'`]+)["'`]/i);
  return methodObject?.[1];
}

function endpointMatchKey(endpoint?: string) {
  if (!endpoint) return "";
  return endpoint.replace(/\/+$/g, "").replace(/^\/api(?=\/)/i, "") || "/";
}

function isConcreteEndpoint(endpoint?: string) {
  const key = endpointMatchKey(endpoint);
  return key !== "" && key !== "/" && key.startsWith("/") && !key.includes("${");
}

function isRouteLine(line: string) {
  return /(?:@\w+\.(?:get|post|put|patch|delete)\(|router\.(?:get|post|put|patch|delete)\(|app\.(?:get|post|put|patch|delete)\()/i.test(line);
}

function isStorageWrite(text: string) {
  return /\b(open\s*\([^)]*["'](?:a|w|a\+|w\+)["']|writeFile|appendFile|\.write\s*\(|writerow|DictWriter|to_csv\s*\(|json\.dump|pickle\.dump|joblib\.dump)\b/i.test(text);
}

function isStorageRead(text: string) {
  return /\b(open\s*\([^)]*["']r["']|readFile|read_csv\s*\(|json\.load|pickle\.load|joblib\.load)\b/i.test(text);
}

function endpointMatchesTarget(text: string, terms: string[]) {
  const endpoint = extractEndpoint(text);
  return Boolean(endpoint && terms.some((term) => includesTerm(endpoint, term)));
}

function extractNearestSymbol(snippet: string) {
  const symbol = snippet.match(/\b(?:function|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)|(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return symbol?.[1] ?? symbol?.[2];
}

function extractIdentifiers(text: string) {
  return [...text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)]
    .map((match) => match[0])
    .filter((value) => !["const", "return", "function", "class", "from", "import", "export", "await", "section", "lede", "Tracks", "how", "Action", "Testing"].includes(value))
    .slice(0, 20);
}

function extractUiMechanismNames(snippet: string) {
  const names: string[] = [];
  for (const tag of ["form", "button", "input", "textarea", "select"]) {
    if (new RegExp(`<${tag}\\b`, "i").test(snippet)) names.push(tag);
  }
  for (const match of snippet.matchAll(/\b(onSubmit|onClick|onChange)\s*=\s*\{?([A-Za-z_][A-Za-z0-9_]*)?/g)) {
    if (match[1]) names.push(match[1]);
    if (match[2]) names.push(match[2]);
  }
  for (const match of snippet.matchAll(/\b(handle[A-Z][A-Za-z0-9_]*|submit[A-Z][A-Za-z0-9_]*|set[A-Z][A-Za-z0-9_]*)\b/g)) {
    if (match[1]) names.push(match[1]);
  }
  for (const match of snippet.matchAll(/\b(feedback\.[A-Za-z_][A-Za-z0-9_]*|feedback\s*:\s*\{[^}\n]+|submitting|message|label)\b/g)) {
    if (match[1]) names.push(match[1].replace(/\s+/g, " ").slice(0, 80));
  }
  return uniqueStrings(names).slice(0, 12);
}

function indexOwnerSymbols(lines: string[]) {
  const owners: Array<string | undefined> = [];
  let currentClass = "";
  let currentFunction = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch?.[1]) currentClass = classMatch[1];
    const functionMatch = line.match(/^\s*(?:async\s+)?(?:function\s+|def\s+)([A-Za-z_][A-Za-z0-9_]*)|^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(?/);
    if (functionMatch?.[1] || functionMatch?.[2]) currentFunction = functionMatch[1] ?? functionMatch[2] ?? "";
    owners[index] = currentFunction ? (currentClass ? `${currentClass}.${currentFunction}` : currentFunction) : currentClass || undefined;
  }
  return owners;
}

function isClientSourceFile(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  if (TEST_RE.test(normalized)) return false;
  if (/(^|\/)(backend|server|api|routes?|controllers?)\//i.test(normalized)) return false;
  return FRONTEND_RE.test(normalized) || /(^|\/)(frontend|client|web|ui|components|hooks|pages|app)\//i.test(normalized);
}

function isTargetScopedEvidence(input: {
  role: MechanismEvidenceRole;
  filePath: string;
  line: string;
  snippet: string;
  targetConcept: string;
  targetTerms: string[];
  endpoint?: string;
  storageTarget?: string;
  ownerSymbol?: string;
}) {
  if (!isTargetStorageRole(input.role) && input.role !== "general_storage") return true;
  return isTargetScopedStorage(`${input.line}\n${input.snippet}\n${input.ownerSymbol ?? ""}\n${input.endpoint ?? ""}`, input.targetConcept, input.targetTerms, input.storageTarget);
}

function isTargetScopedStorage(text: string, targetConcept: string, targetTerms: string[], storageTarget?: string) {
  const targetText = `${text}\n${storageTarget ?? ""}`.toLowerCase();
  const terms = uniqueStrings([targetConcept, ...targetTerms]).filter(Boolean);
  if (terms.some((term) => targetText.includes(term.toLowerCase()))) return true;
  if (targetConcept === "feedback" && /\b(customer_feedback|feedback[_-]?log|feedback|observed_outcome|label|rating)\b/i.test(targetText)) return true;
  return false;
}

function isTargetStorageRole(role: MechanismEvidenceRole) {
  return role === "storage_target" || role === "storage_write" || role === "storage_read" || role === "log_append";
}

function inferFrom(role: MechanismEvidenceRole, ownerSymbol?: string, endpoint?: string, storageTarget?: string) {
  if (role === "api_client_call") return ownerSymbol;
  if (role === "backend_route") return endpoint;
  if (role === "storage_write" || role === "log_append" || role === "storage_read") return ownerSymbol;
  if (role === "test_endpoint_expectation") return "test";
  return ownerSymbol ?? endpoint ?? storageTarget;
}

function inferTo(role: MechanismEvidenceRole, endpoint?: string, storageTarget?: string) {
  if (role === "api_client_call" || role === "backend_route" || role === "test_endpoint_expectation") return endpoint;
  if (role === "storage_target" || role === "storage_write" || role === "log_append" || role === "storage_read" || role === "general_storage") return storageTarget;
  return undefined;
}

function strongestConfidence(items: MechanismEvidence[]): "high" | "medium" | "low" {
  if (items.some((item) => item.confidence === "high")) return "high";
  if (items.some((item) => item.confidence === "medium")) return "medium";
  return "low";
}

function roleReason(role: MechanismEvidenceRole, targetConcept: string) {
  const target = targetConcept || "the target";
  if (role === "ui_state") return `UI state mentions ${target}; this proves surface/state, not backend submission.`;
  if (role === "ui_event_handler") return `A UI handler mentions ${target}; it may initiate a mechanism.`;
  if (role === "api_client_call") return `Client code calls an endpoint related to ${target}.`;
  if (role === "backend_route") return `Backend route endpoint is related to ${target}.`;
  if (role === "storage_target") return `Storage/log path is declared for ${target}; declaration alone is not a write.`;
  if (role === "storage_write" || role === "log_append") return `Code writes/appends target-related data.`;
  if (role === "lifecycle_status") return `Status text mentions ${target}; this is lifecycle evidence only.`;
  if (role === "context_only") return `Nearby action/decision context mentions ${target}, but does not prove the mechanism.`;
  if (role === "general_storage") return `Storage exists nearby, but it is not target-scoped proof for ${target}.`;
  if (role === "test_endpoint_expectation") return `A test expects endpoint behavior for ${target}; this is not production frontend/client flow.`;
  return `Evidence is related to ${target}.`;
}

function roleConfidence(role: MechanismEvidenceRole): "high" | "medium" | "low" {
  if (["api_client_call", "backend_route", "storage_write", "storage_read", "log_append"].includes(role)) return "high";
  if (role === "test_endpoint_expectation") return "medium";
  if (["ui_event_handler", "service_logic", "training_or_retraining", "job_or_scheduler", "storage_target"].includes(role)) return "medium";
  return "low";
}

function nodeKindForRole(role: MechanismEvidenceRole): ProjectIntelligenceNodeKind {
  if (role === "ui_state") return "state";
  if (role === "ui_event_handler") return "function";
  if (role === "api_client_call" || role === "backend_route") return "endpoint";
  if (role === "storage_target" || role === "storage_write" || role === "storage_read" || role === "log_append") return "storage_file";
  if (role === "test" || role === "test_endpoint_expectation") return "test";
  if (role === "documentation") return "documentation";
  return "symbol";
}

function edgeKindForRole(role: MechanismEvidenceRole): ProjectIntelligenceEdgeKind {
  if (role === "ui_event_handler") return "handles_event";
  if (role === "api_client_call") return "fetches_endpoint";
  if (role === "backend_route") return "route_handles";
  if (role === "storage_read") return "reads_from";
  if (role === "storage_target" || role === "storage_write" || role === "log_append" || role === "general_storage") return "writes_to";
  if (role === "test_endpoint_expectation") return "route_handles";
  if (role === "training_or_retraining") return "consumes_output";
  if (role === "job_or_scheduler") return "schedules";
  if (role === "ui_state") return "updates_state";
  return "calls";
}

function fileKind(filePath: string): ProjectIntelligenceNodeKind {
  if (TEST_RE.test(filePath)) return "test";
  if (DOC_RE.test(filePath)) return "documentation";
  if (/config|\.json$|\.ya?ml$|\.toml$/i.test(filePath)) return "config";
  return "file";
}

function snippetAround(lines: string[], index: number) {
  const start = Math.max(0, index - 2);
  const end = Math.min(lines.length, index + 3);
  return lines.slice(start, end).join("\n").trim().slice(0, 1200);
}

function addNode(nodes: Map<string, ProjectIntelligenceNode>, id: string, kind: ProjectIntelligenceNodeKind, label: string, path?: string, line?: number) {
  if (nodes.has(id)) return;
  nodes.set(id, { id, kind, label, path, line });
}

function addEdge(edges: Map<string, ProjectIntelligenceEdge>, from: string, to: string, kind: ProjectIntelligenceEdgeKind, evidenceRef: string, label?: string) {
  const key = `${from}->${kind}->${to}:${evidenceRef}`;
  if (edges.has(key)) return;
  edges.set(key, { from, to, kind, evidenceRef, label, relation: label, confidence: "high", status: "proven" });
}

function addEvidence(evidence: Map<string, MechanismEvidence>, item: MechanismEvidence) {
  const key = `${item.path}:${item.line}:${item.role}:${item.endpoint ?? item.storageTarget ?? item.symbol ?? ""}`;
  if (!evidence.has(key)) evidence.set(key, item);
}

function emptySummary(): ProjectIntelligenceGraphSummary {
  return {
    nodeCount: 0,
    edgeCount: 0,
    evidenceCount: 0,
    roles: emptyRoleCounts(),
    importantFiles: []
  };
}

function emptyRoleCounts(): Record<MechanismEvidenceRole, number> {
  return {
    ui_state: 0,
    ui_event_handler: 0,
    api_client_call: 0,
    backend_route: 0,
    service_logic: 0,
    storage_target: 0,
    storage_write: 0,
    storage_read: 0,
    log_append: 0,
    job_or_scheduler: 0,
    training_or_retraining: 0,
    lifecycle_status: 0,
    context_only: 0,
    general_storage: 0,
    test_endpoint_expectation: 0,
    test: 0,
    documentation: 0,
    unrelated_name_match: 0
  };
}

function termsForConcept(targetConcept: string) {
  const terms = uniqueStrings([
    targetConcept,
    ...(CONCEPT_ALIASES[targetConcept] ?? [])
  ]).filter(Boolean);
  if (!terms.length) return [];
  return terms;
}

function normalizeConcept(value: string) {
  return value
    .trim()
    .replace(/^ال/i, "")
    .replace(/^[\u0627][\u0644]/, "")
    .toLowerCase()
    .replace(/[^\u0600-\u06ffa-z0-9_\-\s]/g, "");
}

function includesTerm(text: string, term: string) {
  if (!term) return false;
  const normalizedText = text.toLowerCase();
  const normalizedTerm = term.toLowerCase();
  return normalizedText.includes(normalizedTerm);
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/");
}

function nodeId(kind: string, value: string) {
  return `${kind}:${value}`;
}

function roleRank(role: MechanismEvidenceRole) {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

function mechanismEvidencePriority(item: MechanismEvidence, targetConcept: string) {
  const target = normalizeConcept(targetConcept);
  const text = `${item.endpoint ?? ""}\n${item.storageTarget ?? ""}\n${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`;
  let score = 0;
  if (target === "feedback") {
    if (/submit_customer_feedback|interpret_customer_feedback/i.test(text)) score += 120;
    if (/should_trigger_outer_loop|retrain_with_rollback|response_label.*negative|negative.*response_label/i.test(text)) score += 110;
    if (/\bcustomer_feedback|customer-feedback|customer feedback|feedback_log|CUSTOMER_FEEDBACK_LOG_PATH\b/i.test(text)) score += 90;
    else if (/\bfeedback\b/i.test(text)) score += 50;
    if (/\/customer-feedback/i.test(text)) score += 80;
    if (/\bretrain|retraining\b/i.test(text) && !/should_trigger_outer_loop|retrain_with_rollback|customer_feedback|feedback/i.test(text)) score -= 20;
  }
  if (target === "multi_agent_system") {
    if (/services\/agents\.py|class\s+(?:BaseAgent|ReliabilityAgent|ForecastAgent|ClusterHealthAgent)|build_default_agents/i.test(`${item.path}\n${text}`)) score += 120;
    if (/services\/orchestrator\.py|class\s+ReActOrchestrator|choose_route|weighted_votes|weighted_winner/i.test(`${item.path}\n${text}`)) score += 110;
    if (/routes?\.py/i.test(item.path) && /\bagents\s*=\s*build_default_agents\(|\borchestrator\s*=\s*ReActOrchestrator\(|\baction_executor\s*=\s*ActionExecutor\(/i.test(text)) score += 160;
    if (/routes?\.py/i.test(item.path) && /agent_recommendations\s*=.*agent\.recommend|orchestrator\.choose_route|execute_action/i.test(text)) score += 155;
    if (/routes?\.py/i.test(item.path) && /agent_consensus|agent_recommendations|orchestrator_snapshot/i.test(text)) score += 130;
    if (/\btrend_multiplier\b/i.test(text) && !/ForecastAgent|agent_recommendations|orchestrator/i.test(text)) score -= 70;
  }
  return score;
}

function hasAnyRole(evidence: MechanismEvidence[], roles: MechanismEvidenceRole[]) {
  return evidence.some((item) => roles.includes(item.role));
}

function hasProvenRelation(steps: MechanismChainStep[], relation: string) {
  return steps.some((step) => step.relation === relation && step.status === "proven");
}

function hasArchitectureLoopEvidence(steps: MechanismChainStep[]) {
  const relations = new Set(steps.map((step) => step.relation));
  return relations.has("decision_action_stage")
    && relations.has("feedback_or_outcome_stage")
    && relations.has("state_log_or_retraining_update");
}

function targetEndpointSet(evidence: MechanismEvidence[]) {
  return new Set(
    evidence
      .filter((item) => item.endpoint && endpointLooksTargetScoped(item.endpoint, item.relatedNames))
      .map((item) => endpointMatchKey(item.endpoint))
  );
}

function hasMatchingEndpoint(evidence: MechanismEvidence[], role: MechanismEvidenceRole, endpoints: Set<string>) {
  return evidence.some((item) => item.role === role && item.endpoint && (!endpoints.size || endpoints.has(endpointMatchKey(item.endpoint))));
}

function hasTargetScopedStorageWrite(evidence: MechanismEvidence[]) {
  return targetScopedStorageWrites(evidence).length > 0;
}

function targetScopedStorageWrites(evidence: MechanismEvidence[]) {
  return evidence.filter((item) =>
    (item.role === "storage_write" || item.role === "log_append" || item.role === "storage_read")
    && item.targetScoped !== false
  ).sort((left, right) => feedbackStorageScore(right) - feedbackStorageScore(left) || left.path.localeCompare(right.path) || left.line - right.line);
}

function feedbackStorageScore(item: MechanismEvidence) {
  const text = `${item.storageTarget ?? ""}\n${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`;
  let score = item.role === "log_append" || item.role === "storage_write" ? 30 : 0;
  if (/\bcustomer_feedback|customer-feedback|customer feedback|feedback_log|feedback[-_]?log\b/i.test(text)) score += 100;
  else if (/\bfeedback\b/i.test(text)) score += 50;
  if (/\bretrain|retraining\b/i.test(text) && !/\bcustomer_feedback|customer-feedback|feedback_log\b/i.test(text)) score -= 25;
  return score;
}

function endpointLooksTargetScoped(endpoint: string, relatedNames: string[]) {
  const text = `${endpoint}\n${relatedNames.join("\n")}`.toLowerCase();
  return /\b(feedback|customer-feedback|customer_feedback|review|outcome|retrain)\b/.test(text);
}

function isArchitectureLevelConcept(targetConcept: string) {
  return [
    "outerloop",
    "inner_loop",
    "inner_outer_loop",
    "multi_agent_system",
    "retraining_loop",
    "human_review_loop",
    "action_loop"
  ].includes(normalizeConcept(targetConcept));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isLogLike(value: string) {
  return /\blog\b|LOG|\.log|csv/i.test(value);
}

function literalTermsForResolvedConcept(targetConcept: string, requestedConceptText: string) {
  const normalized = normalizeConcept(requestedConceptText || targetConcept);
  return uniqueStrings([
    targetConcept,
    requestedConceptText,
    normalized,
    normalized.replace(/\s+/g, "_"),
    normalized.replace(/\s+/g, "-"),
    normalized.replace(/\s+/g, "")
  ].filter(Boolean));
}

function normalizeInvestigationText(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^ال([A-Za-z])/g, "$1")
    .replace(/ال([A-Za-z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAsciiTokens(value: string) {
  return Array.from(value.matchAll(/[A-Za-z][A-Za-z0-9_./:-]*/g)).map((match) => match[0] ?? "");
}

function isInvestigationStopWord(value: string) {
  return new Set([
    "how", "what", "where", "why", "does", "do", "is", "are", "the", "this", "that",
    "here", "project", "code", "explain", "detail", "detailed", "work", "works",
    "applied", "apply", "changes", "change", "after", "before", "user", "system",
    "tell", "show", "describe", "summarize", "list", "me", "full"
  ]).has(value);
}
