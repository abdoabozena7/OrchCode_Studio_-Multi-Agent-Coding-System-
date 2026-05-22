import type { ProjectExplainEvidenceRef, ProjectExplainReport, ProjectExplainSection } from "@orchcode/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { analyzeAlgorithmInventory } from "./AlgorithmInventoryAnalyzer.js";
import { analyzeCodeFlow } from "./CodeFlowAnalyzer.js";
import { analyzeFrontendStructure } from "./FrontendStructureAnalyzer.js";
import { composeAnswer } from "./InspectExplainComposer.js";
import type { InspectExplainFacts } from "./InspectExplainFacts.js";
import { explainProjectWithLlm } from "./LlmProjectExplainer.js";
import { analyzeTrainingInference } from "./TrainingInferenceAnalyzer.js";
import { analyzeUIControls } from "./UIControlAnalyzer.js";
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
  topicTerms: string[];
  normalizedTerms: string[];
  entities: string[];
  language: WorkspaceIntentUnderstanding["language"];
  requiredFacets: WorkspaceEvidenceFacet[];
  expectedAnswerShape: "count" | "list" | "flow" | "locate" | "compare" | "yes_no" | "summary";
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
  structuredFacts: InspectExplainFacts;
  confidence: "high" | "medium" | "low";
  validationErrors: string[];
  fallbackUsed: boolean;
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
  const structuredFacts = collectStructuredFacts(input.tools, allFiles, topic);
  const questionUnderstanding = createQuestionUnderstanding(input.userPrompt, intent, topic);
  const queryPlan = createSearchPlan(questionUnderstanding, topic);
  const search = collectLocalEvidence(input.tools, allFiles, queryPlan, intent);
  const positiveEvidence = uniqueEvidence([
    ...search.positiveEvidence,
    ...structuredFactsToEvidence(structuredFacts)
  ]).slice(0, SEARCH_LIMITS.maxEvidenceItems);
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
  let fallbackUsed = explainResult.unsupportedOrUnclearParts.length > 0;
  const validation = validateAnswer({
    answerMarkdown,
    intent,
    topic,
    positiveEvidence,
    structuredFacts
  });
  validationErrors.push(...validation);

  if (validationErrors.length) {
    answerMarkdown = createEvidenceFallbackAnswer({
      question: input.userPrompt,
      questionUnderstanding,
      topic,
      structuredFacts,
      positiveEvidence,
      negativeEvidence: search.negativeEvidence,
      intent
    });
    evidenceRefs = positiveEvidence.slice(0, 20).map((item) => item.ref);
    fallbackUsed = true;
  }

  const openedFiles = uniqueStrings([
    ...positiveEvidence.map((item) => item.path),
    ...search.openedFiles,
    ...structuredFacts.inspectedFiles
  ]).slice(0, SEARCH_LIMITS.maxOpenedFiles);
  const candidateFiles = uniqueStrings([
    ...search.candidateFiles,
    ...positiveEvidence.map((item) => item.path)
  ]).slice(0, SEARCH_LIMITS.maxCandidateFiles);

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
    negativeEvidence: search.negativeEvidence,
    structuredFacts,
    confidence,
    validationErrors: uniqueStrings(validationErrors),
    fallbackUsed,
    answerMarkdown,
    evidenceRefs,
    usedEvidenceRefs: evidenceRefs,
    unsupportedOrUnclearParts: uniqueStrings(validationErrors),
    revisionCount: explainResult.revisionCount,
    validationWarnings: uniqueStrings([...explainResult.validationWarnings, ...search.negativeEvidence]),
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
  if (intent.answerGoal === "trace_flow" && intent.requiredFacets.includes("algorithms_models")) {
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
  return {
    actionMode: intent.actionMode,
    answerGoal: isYesNoQuestion(question) ? "yes_no" : intent.answerGoal,
    topicPhrase: intent.topicPhrase,
    topicTerms: rawTerms.slice(0, 20),
    normalizedTerms,
    entities,
    language: intent.language,
    requiredFacets: intent.requiredFacets,
    expectedAnswerShape: expectedAnswerShape(question, intent)
  };
}

function createSearchPlan(
  understanding: ProjectQuestionUnderstanding,
  topic: UniversalInspectTopic
): ProjectQuestionSearchQuery[] {
  const queries: ProjectQuestionSearchQuery[] = [];
  const add = (query: string, source: ProjectQuestionSearchQuery["source"], iteration: number) => {
    const compact = query.trim();
    if (!compact || compact.length < 2) return;
    if (queries.some((item) => item.query.toLowerCase() === compact.toLowerCase())) return;
    queries.push({ query: compact, source, iteration });
  };

  for (const entity of understanding.entities) add(entity, "entity", 1);
  for (const term of understanding.topicTerms) add(term, "topic_term", 1);
  for (const term of understanding.normalizedTerms.slice(0, 16)) add(term, "alias", 2);
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
    if (!gained) negativeEvidence.push(`No local matches for query "${query.query}".`);
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
    openedFiles: uniqueStrings(openedFiles).slice(0, SEARCH_LIMITS.maxOpenedFiles),
    candidateFiles: Array.from(candidateFiles).slice(0, SEARCH_LIMITS.maxCandidateFiles),
    searchIterations
  };
}

function collectStructuredFacts(
  tools: ToolRegistry,
  filePaths: string[],
  topic: UniversalInspectTopic
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
    facts.codeFlow = analyzeCodeFlow(tools.workspace, filePaths, facts.algorithms);
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
      confidence: "high"
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

function validateAnswer(input: {
  answerMarkdown: string;
  intent: WorkspaceIntentUnderstanding;
  topic: UniversalInspectTopic;
  positiveEvidence: ProjectQuestionEvidence[];
  structuredFacts: InspectExplainFacts;
}) {
  const errors: string[] = [];
  const hasEvidence = input.positiveEvidence.length > 0 || structuredFactsHaveEvidence(input.topic, input.structuredFacts);
  if (hasEvidence && !/orchcode-file:/i.test(input.answerMarkdown)) {
    errors.push("Answer has local evidence but no orchcode-file citations.");
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
  return errors;
}

function createEvidenceFallbackAnswer(input: {
  question: string;
  questionUnderstanding: ProjectQuestionUnderstanding;
  topic: UniversalInspectTopic;
  structuredFacts: InspectExplainFacts;
  positiveEvidence: ProjectQuestionEvidence[];
  negativeEvidence: string[];
  intent: WorkspaceIntentUnderstanding;
}) {
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
    confidence: "medium"
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
  if (intent.answerGoal === "trace_flow") return "flow";
  if (intent.answerGoal === "locate") return "locate";
  if (intent.answerGoal === "compare") return "compare";
  return "summary";
}

function isYesNoQuestion(question: string) {
  return /^\s*(are|is|do|does|did|can|has|have)\b/i.test(question) || /(?:^|\s)(هل|فيه|عندي|عندنا)\b/.test(question);
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
  return `[${path}:${line}](orchcode-file:${encodeURIComponent(path)}:${line})`;
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
