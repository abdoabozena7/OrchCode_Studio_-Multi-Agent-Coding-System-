import type { ProjectExplainReport } from "@orchcode/protocol";

export type WorkspaceActionMode = "answer_only" | "edit" | "run" | "debug";
export type WorkspaceAnswerGoal = "explain" | "count" | "list" | "compare" | "trace_flow" | "locate" | "summarize";
export type WorkspaceOutputShape = "concise" | "bullets" | "table" | "walkthrough";
export type WorkspaceAnswerStyle = "child_simple" | "technical" | "concise" | "detailed" | "default";
export type WorkspaceEvidenceFacet =
  | "ui_structure"
  | "code_symbols"
  | "algorithms_models"
  | "numeric_logic"
  | "data_flow"
  | "tests_docs";

export type WorkspaceEvidenceLike = {
  ref: string;
  markdownLink: string;
  path: string;
  line: number;
  title: string;
  reason: string;
  snippet?: string;
};

export type WorkspaceIntentUnderstanding = {
  actionMode: WorkspaceActionMode;
  answerGoal: WorkspaceAnswerGoal;
  topicPhrase: string;
  topicTerms: string[];
  outputShape: WorkspaceOutputShape;
  style: WorkspaceAnswerStyle;
  language: "arabic" | "english";
  requiredFacets: WorkspaceEvidenceFacet[];
  optionalFacets: WorkspaceEvidenceFacet[];
};

export type WorkspaceEvidencePack = {
  items: WorkspaceEvidenceLike[];
  topicItems: WorkspaceEvidenceLike[];
  byFacet: Record<WorkspaceEvidenceFacet, WorkspaceEvidenceLike[]>;
  missingRequiredFacets: WorkspaceEvidenceFacet[];
  partial: boolean;
};

export type WorkspaceUnderstanding = {
  moduleSummary: string;
  entrypoints: string[];
  projectHints: string[];
};

export type WorkspaceReasoning = {
  intent: WorkspaceIntentUnderstanding;
  evidencePack: WorkspaceEvidencePack;
  understanding: WorkspaceUnderstanding;
};

const ALL_FACETS: WorkspaceEvidenceFacet[] = [
  "ui_structure",
  "code_symbols",
  "algorithms_models",
  "numeric_logic",
  "data_flow",
  "tests_docs"
];

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "code", "codebase", "current",
  "do", "does", "each", "every", "explain", "for", "from", "give", "have", "here",
  "how", "i", "in", "inside", "is", "it", "me", "many", "much", "of", "one", "please",
  "project", "selected", "show", "system", "tell", "that", "the", "this", "to", "what",
  "which", "with", "work", "works", "workspace", "you"
]);

const ARABIC_STOP_WORDS = new Set([
  "\u0627\u0634\u0631\u062d",
  "\u0627\u0634\u0631\u062d\u0644\u064a",
  "\u0634\u0631\u062d",
  "\u0627\u0644\u0645\u0634\u0631\u0648\u0639",
  "\u0645\u0634\u0631\u0648\u0639",
  "\u0627\u0644\u0633\u064a\u0633\u062a\u0645",
  "\u0633\u064a\u0633\u062a\u0645",
  "\u062f\u0627",
  "\u062f\u0647",
  "\u062f\u064a",
  "\u0647\u0646\u0627",
  "\u0641",
  "\u0641\u064a",
  "\u0645\u0646",
  "\u0639\u0644\u0649",
  "\u0627\u064a\u0647",
  "\u0625\u064a\u0647",
  "\u0643\u0627\u0645",
  "\u0648\u0643\u0644",
  "\u0643\u0644",
  "\u0648\u0627\u062d\u062f\u0629",
  "\u0648\u0627\u062d\u062f\u0647",
  "\u0648\u0627\u062d\u062f",
  "\u064a\u0639\u0646\u064a",
  "\u0647\u0627\u062a\u0644\u064a",
  "\u0642\u0648\u0644\u064a",
  "\u0627\u0632\u0627\u064a",
  "\u0625\u0632\u0627\u064a"
]);

const STYLE_WORDS = new Set([
  "child", "kid", "kids", "simple", "simply", "eli5", "beginner", "technical", "detailed",
  "\u0637\u0641\u0644", "\u0644\u0637\u0641\u0644", "\u0628\u0628\u0633\u0627\u0637\u0629", "\u0645\u0628\u0633\u0637", "\u0645\u0628\u0633\u0637\u0629"
]);

const FACET_PATTERNS: Record<WorkspaceEvidenceFacet, RegExp> = {
  ui_structure: /\b(BrowserRouter|createBrowserRouter|Routes|Route|router|path\s*:|href=|data-view|data-page|CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b|<\s*(nav|section|aside|main|a|button)\b/i,
  code_symbols: /\b(class|def|function|const|let|var|interface|type|enum|struct|impl|service|controller|router|endpoint|export|import)\b/i,
  algorithms_models: /\b(algorithm|model|classifier|classification|regression|cluster|clustering|forecast|forecasting|arima|sarima|svm|svc|kmeans|k-means|randomforest|logisticregression|isolationforest|shap|fuzzy|cmeans|fit\(|predict\(|fit_predict|transform\(|train|training|sklearn|scikit|statsmodels|scipy|numpy|pandas)\b/i,
  numeric_logic: /\b(threshold|threshlod|cutoff|floor|minimum|maximum|score|weight|gap|cosine|membership|severity|trend|drift|delta|deviation|f1|accuracy|guardrail|formula|condition|compare|orchestrator)\b|[<>]=?|==/i,
  data_flow: /\b(dataset|data set|records?|rows?|csv|ingest|ingestion|stream|consumer|producer|fetch|poll|polling|refresh|socket|websocket|api\/|snapshot|timestamp|schema|message|pipeline|loader|storage|database|output|input)\b/i,
  tests_docs: /\b(test|tests|spec|readme|docs|documentation|architecture|scenario)\b/i
};

const FACET_PATH_PATTERNS: Record<WorkspaceEvidenceFacet, RegExp> = {
  ui_structure: /(^|\/)(frontend|dashboard_ui|ui|web|client|pages|screens|views|routes|components)\/|(^|\/)(app|main|index)\.(jsx|tsx|js|ts|mjs|html)$/i,
  code_symbols: /\.(ts|tsx|js|jsx|py|rs|go|java|cs|cpp|c)$/i,
  algorithms_models: /(model|models|classifier|classification|cluster|clustering|forecast|arima|sarima|shap|pipeline|analytics|ml|ai|service)/i,
  numeric_logic: /(orchestrator|agents?|routes?|policy|decision|score|threshold|guardrail|arima|forecast|model)/i,
  data_flow: /(ingest|stream|consumer|producer|pipeline|dataset|data|schema|api|route|service|storage|repository)/i,
  tests_docs: /(^|\/)(tests?|__tests__|docs?)\/|readme|\.test\.|\.spec\.|\.md$/i
};

const FACET_TOPIC_TERMS: Record<WorkspaceEvidenceFacet, string[]> = {
  ui_structure: ["page", "pages", "screen", "screens", "view", "views", "route", "routes", "\u0635\u0641\u062d\u0629", "\u0635\u0641\u062d\u0647", "\u0634\u0627\u0634\u0629"],
  code_symbols: ["code", "function", "class", "module", "service", "\u0643\u0648\u062f", "\u062f\u0627\u0644\u0629", "\u0643\u0644\u0627\u0633"],
  algorithms_models: ["algorithm", "algorithms", "model", "models", "classifier", "clustering", "svm", "svc", "dbscan", "fcm", "cmeans", "shap", "sarima", "arima", "kmeans", "randomforest", "\u0627\u0644\u062c\u0648\u0631\u064a\u062b\u0645", "\u0627\u0644\u062c\u0648\u0631\u064a\u0632\u0645", "\u062e\u0648\u0627\u0631\u0632\u0645", "\u0645\u0648\u062f\u064a\u0644"],
  numeric_logic: ["threshold", "thresholds", "threshlod", "threshlods", "number", "numbers", "formula", "formulas", "compare", "\u0623\u0631\u0642\u0627\u0645", "\u0627\u0631\u0642\u0627\u0645", "\u0645\u0639\u0627\u062f\u0644\u0627\u062a", "\u0628\u0642\u0627\u0631\u0646", "\u0639\u062a\u0628\u0629"],
  data_flow: ["data", "dataset", "flow", "realtime", "api", "storage", "\u062f\u0627\u062a\u0627", "\u0628\u064a\u0627\u0646\u0627\u062a", "\u062f\u0627\u062a\u0627 \u0633\u064a\u062a"],
  tests_docs: ["test", "tests", "docs", "readme", "\u062a\u0633\u062a", "\u062f\u0648\u0643\u064a\u0648\u0645\u0646\u062a"]
};

const EXPLICIT_ALGORITHM_TOPIC_RE = /\b(svm|svc|support vector|dbscan|fcm|cmeans|c-means|fuzzy c|shap|sarima|arima|kmeans|k-means|random\s*forest|randomforest|logistic\s*regression|isolation\s*forest)\b/i;

export function inferWorkspaceIntent(userPrompt: string): WorkspaceIntentUnderstanding {
  const language = /[\u0600-\u06ff]/.test(userPrompt) ? "arabic" : "english";
  const normalized = normalizeForIntent(userPrompt);
  const raw = userPrompt.toLowerCase();
  const style = detectStyle(raw, normalized);
  const actionMode = detectActionMode(raw, normalized);
  const answerGoal = detectAnswerGoal(raw, normalized);
  const requiredFacets = normalizeFacetPriorities(detectRequiredFacets(raw, normalized), raw, normalized);
  const optionalFacets = uniqueFacets([
    ...requiredFacets,
    "code_symbols",
    answerGoal === "trace_flow" ? "data_flow" : undefined,
    answerGoal === "compare" ? "numeric_logic" : undefined,
    actionMode === "edit" ? "tests_docs" : undefined
  ].filter(Boolean) as WorkspaceEvidenceFacet[]);
  const outputShape = detectOutputShape(raw, normalized, answerGoal, requiredFacets);
  const topicTerms = extractTopicTerms(userPrompt, requiredFacets);
  const topicPhrase = topicTerms.length
    ? topicTerms.slice(0, 4).join(" ")
    : requiredFacets[0]
      ? humanizeFacet(requiredFacets[0])
      : "current project";

  return {
    actionMode,
    answerGoal,
    topicPhrase,
    topicTerms,
    outputShape,
    style,
    language,
    requiredFacets,
    optionalFacets
  };
}

export function analyzeWorkspaceReasoning(input: {
  userPrompt: string;
  report: ProjectExplainReport;
  evidenceItems: WorkspaceEvidenceLike[];
  actionModeHint?: WorkspaceActionMode;
}): WorkspaceReasoning {
  const baseIntent = inferWorkspaceIntent(input.userPrompt);
  const intent: WorkspaceIntentUnderstanding = input.actionModeHint
    ? { ...baseIntent, actionMode: input.actionModeHint }
    : baseIntent;
  const byFacet = emptyFacetMap();
  const scored = input.evidenceItems
    .map((item) => {
      const facets = facetsForEvidenceItem(item);
      for (const facet of facets) byFacet[facet].push(item);
      return {
        item,
        facets,
        score: scoreEvidenceForIntent(item, facets, intent)
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.item.path.localeCompare(right.item.path));
  const topicItems = uniqueEvidenceItems(scored.map((entry) => entry.item)).slice(0, 30);
  const missingRequiredFacets = intent.requiredFacets.filter((facet) => !byFacet[facet].length);
  return {
    intent,
    evidencePack: {
      items: uniqueEvidenceItems([
        ...topicItems,
        ...intent.requiredFacets.flatMap((facet) => byFacet[facet].slice(0, 10)),
        ...intent.optionalFacets.flatMap((facet) => byFacet[facet].slice(0, 5)),
        ...input.evidenceItems.slice(0, 8)
      ]).slice(0, 50),
      topicItems,
      byFacet: mapFacetItems(byFacet),
      missingRequiredFacets,
      partial: missingRequiredFacets.length > 0
    },
    understanding: {
      moduleSummary: input.report.moduleMap.slice(0, 6).map((module) => `${module.root}: ${module.responsibility}`).join(" | ") || input.report.overview,
      entrypoints: input.report.entryPoints.slice(0, 10),
      projectHints: [input.report.overview, input.report.architecture, input.report.dataFlow].filter(Boolean)
    }
  };
}

export function createWorkspaceReasoningPrompt(reasoning: WorkspaceReasoning) {
  return [
    "Unified workspace reasoning:",
    `- actionMode: ${reasoning.intent.actionMode}`,
    `- answerGoal: ${reasoning.intent.answerGoal}`,
    `- topicPhrase: ${reasoning.intent.topicPhrase}`,
    `- outputShape: ${reasoning.intent.outputShape}`,
    `- style: ${reasoning.intent.style}`,
    `- requiredFacets: ${reasoning.intent.requiredFacets.join(", ") || "none"}`,
    `- optionalFacets: ${reasoning.intent.optionalFacets.join(", ") || "none"}`,
    `- missingRequiredFacets: ${reasoning.evidencePack.missingRequiredFacets.join(", ") || "none"}`,
    `- topEvidenceRefs: ${reasoning.evidencePack.topicItems.slice(0, 10).map((item) => item.ref).join(", ") || "none"}`,
    `- moduleSummary: ${reasoning.understanding.moduleSummary}`
  ].join("\n");
}

export function createEvidenceBasedAnswerFallback(reasoning: WorkspaceReasoning, validationErrors: string[] = []) {
  const intent = reasoning.intent;
  if (reasoning.evidencePack.missingRequiredFacets.length && !reasoning.evidencePack.topicItems.length) {
    return createGenericNotFoundAnswer(reasoning);
  }
  if (intent.requiredFacets.includes("ui_structure")) return createUiStructureAnswer(reasoning);
  if (intent.requiredFacets.includes("algorithms_models")) return createAlgorithmsAnswer(reasoning);
  if (intent.requiredFacets.includes("numeric_logic") || intent.outputShape === "table" && hasFacet(reasoning, "numeric_logic")) {
    return createNumericLogicAnswer(reasoning);
  }
  if (intent.requiredFacets.includes("data_flow")) return createDataFlowAnswer(reasoning);
  if (intent.answerGoal === "locate" || intent.answerGoal === "list" || intent.answerGoal === "count") return createGenericInventoryAnswer(reasoning);
  return createGenericGroundedAnswer(reasoning, validationErrors);
}

export function responseLooksOffIntent(answer: string, reasoning: WorkspaceReasoning) {
  const text = normalizeForIntent(answer);
  const required = reasoning.intent.requiredFacets;
  if (required.includes("algorithms_models")) {
    return /\bthreshold|threshlod|membership|cosine|dispatch|orchestrator\b/i.test(answer)
      && !/\balgorithm|model|classifier|cluster|forecast|arima|sarima|svm|fit|predict\b/i.test(answer);
  }
  if (required.includes("ui_structure")) {
    return /\bthreshold|threshlod|formula|cosine|membership|forecasting|sarima\b/i.test(answer)
      && !/\bpage|screen|view|route|section|tab\b|[\u0635\u0641\u062d\u0634\u0627\u0634]/i.test(answer);
  }
  if (required.includes("numeric_logic")) {
    return /\bpage|screen|route|section|tab\b/i.test(answer) && !/\d|threshold|score|formula|condition/i.test(answer);
  }
  void text;
  return false;
}

export function evidenceItemsForWorkspaceReasoning(reasoning: WorkspaceReasoning) {
  return reasoning.evidencePack.items;
}

export function facetsForEvidenceItem(item: WorkspaceEvidenceLike): WorkspaceEvidenceFacet[] {
  const text = evidenceText(item);
  const facets: WorkspaceEvidenceFacet[] = [];
  for (const facet of ALL_FACETS) {
    if (FACET_PATTERNS[facet].test(text) || FACET_PATH_PATTERNS[facet].test(item.path)) facets.push(facet);
  }
  return uniqueFacets(facets);
}

export function textMatchesWorkspaceFacet(text: string, facet: WorkspaceEvidenceFacet) {
  return FACET_PATTERNS[facet].test(text);
}

function detectStyle(raw: string, normalized: string): WorkspaceAnswerStyle {
  if (/\b(eli5|child|kid|kids|simple|simply|beginner)\b/.test(normalized)
    || /(?:\u0644\s*\u0637\u0641\u0644|\u0644\u0644\u0637\u0641\u0644|\u0637\u0641\u0644.*\u064a\u0641\u0647\u0645|\u0628\u0628\u0633\u0627\u0637\u0629|\u0645\u0628\u0633\u0637)/.test(raw)) return "child_simple";
  if (/\b(technical|architecture|internals|code level|deep dive)\b/.test(normalized)) return "technical";
  if (/\b(concise|brief|short|quick)\b/.test(normalized) || /(?:\u0645\u062e\u062a\u0635\u0631|\u0628\u0627\u062e\u062a\u0635\u0627\u0631)/.test(raw)) return "concise";
  if (/\b(detailed|thorough|step by step|full)\b/.test(normalized) || /(?:\u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644|\u062e\u0637\u0648\u0629)/.test(raw)) return "detailed";
  return "default";
}

function detectActionMode(raw: string, normalized: string): WorkspaceActionMode {
  if (/\b(run|launch|start|serve|open)\b/.test(normalized) || /(?:\u0634\u063a\u0644|\u0627\u0628\u062f\u0623|\u0627\u0641\u062a\u062d)/.test(raw)) return "run";
  if (/\b(debug|error|failed|bug|crash|broken)\b/.test(normalized) || /(?:\u0628\u0627\u064a\u0638|\u0645\u0634\u0643\u0644\u0629|\u0627\u0631\u0648\u0631)/.test(raw)) return "debug";
  if (/\b(change|changing|edit|fix|add|implement|update|write|create|make|build|modify|remove)\b/.test(normalized)
    || /(?:\u063a\u064a\u0631|\u0639\u062f\u0644|\u0635\u0644\u062d|\u0627\u0636\u0641|\u0646\u0641\u0630|\u0627\u0643\u062a\u0628|\u0627\u0639\u0645\u0644|\u0627\u0628\u0646\u064a)/.test(raw)) return "edit";
  return "answer_only";
}

function detectAnswerGoal(raw: string, normalized: string): WorkspaceAnswerGoal {
  if (/\b(how many|count|number of)\b/.test(normalized) || /(?:\u0643\u0627\u0645|\u0639\u062f\u062f)/.test(raw)) return "count";
  if (/\b(list|all|every|inventory|show me)\b/.test(normalized) || /(?:\u0643\u0644|\u0647\u0627\u062a\u0644\u064a|\u0627\u0639\u0631\u0636)/.test(raw)) return "list";
  if (/\b(compare|difference|versus|vs)\b/.test(normalized) || /(?:\u0642\u0627\u0631\u0646|\u0627\u0644\u0641\u0631\u0642)/.test(raw)) return "compare";
  if (/\b(where|locate|find|which file)\b/.test(normalized) || /(?:\u0641\u064a\u0646|\u0645\u0643\u0627\u0646|\u0627\u0646\u0647\u064a \u0645\u0644\u0641)/.test(raw)) return "locate";
  if (/\b(flow|trace|path|from.*to|how.*work)\b/.test(normalized) || /(?:\u0627\u0632\u0627\u064a|\u0625\u0632\u0627\u064a|\u0643\u064a\u0641|\u0641\u0644\u0648|\u0628\u064a\u062d\u0635\u0644|\u0628\u064a\u062a\u0637\u0628\u0642)/.test(raw)) return "trace_flow";
  if (/\b(summarize|summary|overview)\b/.test(normalized) || /(?:\u0644\u062e\u0635|\u0645\u0644\u062e\u0635)/.test(raw)) return "summarize";
  return "explain";
}

function detectRequiredFacets(raw: string, normalized: string): WorkspaceEvidenceFacet[] {
  const facets: WorkspaceEvidenceFacet[] = [];
  for (const facet of ALL_FACETS) {
    if (FACET_TOPIC_TERMS[facet].some((term) => normalized.includes(normalizeForIntent(term)))) facets.push(facet);
  }
  if (/(?:\u062e\u0648\u0627\u0631\u0632\u0645|\u0627\u0644\u062c\u0648\u0631\u064a\u062b\u0645|\u0627\u0644\u062c\u0648\u0631\u064a\u0632\u0645|\u0645\u0648\u062f\u064a\u0644)/.test(raw)) facets.push("algorithms_models");
  if (EXPLICIT_ALGORITHM_TOPIC_RE.test(raw) || EXPLICIT_ALGORITHM_TOPIC_RE.test(normalized)) facets.push("algorithms_models");
  if (/(?:\u0635\u0641\u062d|\u0634\u0627\u0634|\u0648\u0627\u062c\u0647)/.test(raw)) facets.push("ui_structure");
  if (/(?:\u062f\u0627\u062a\u0627|\u0628\u064a\u0627\u0646\u0627\u062a|\u062a\u062d\u062f\u064a\u062b|\u0644\u062d\u0638\u064a)/.test(raw)) facets.push("data_flow");
  if (/(?:threshold|threshlod|\u0639\u062a\u0628\u0629|\u062d\u062f\u0648\u062f|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644|\u0628\u0642\u0627\u0631\u0646|\u0628\u064a\u0642\u0627\u0631\u0646)|(?:^|\s)\u062d\u062f(?:\s|$)/.test(raw)) facets.push("numeric_logic");
  return uniqueFacets(facets.length ? facets : ["code_symbols", "data_flow"]);
}

function normalizeFacetPriorities(facets: WorkspaceEvidenceFacet[], raw: string, normalized: string): WorkspaceEvidenceFacet[] {
  let result = uniqueFacets(facets);
  const hasExplicitPageQuestion = /\b(how many|pages?|screens?|views?|routes?)\b.{0,60}\b(do|does|each|every|work|works|purpose)\b/.test(normalized)
    || /(?:\u0643\u0627\u0645\s+(?:\u0635\u0641\u062d|\u0634\u0627\u0634)|(?:\u0635\u0641\u062d|\u0634\u0627\u0634).{0,80}(?:\u0628\u062a\u0639\u0645\u0644|\u062a\u0639\u0645\u0644|\u0648\u0638\u064a\u0641|\u0627\u064a\u0647|\u0625\u064a\u0647))/.test(raw);
  const hasExplicitNumericQuestion = /\b(threshold|thresholds|threshlod|threshlods|formula|formulas|compare|comparison|cutoff|score|weight)\b/.test(normalized)
    || /(?:\u0628\u0642\u0627\u0631\u0646|\u0628\u064a\u0642\u0627\u0631\u0646|\u0639\u062a\u0628\u0629|\u062d\u062f\u0648\u062f|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644)/.test(raw);
  const hasAlgorithmQuestion = result.includes("algorithms_models")
    && (/\b(algorithm|algorithms|models?|classifier|clustering)\b/.test(normalized)
      || EXPLICIT_ALGORITHM_TOPIC_RE.test(raw)
      || EXPLICIT_ALGORITHM_TOPIC_RE.test(normalized)
      || /(?:\u062e\u0648\u0627\u0631\u0632\u0645|\u0627\u0644\u062c\u0648\u0631\u064a\u062b\u0645|\u0627\u0644\u062c\u0648\u0631\u064a\u0632\u0645|\u0645\u0648\u062f\u064a\u0644)/.test(raw));
  if (!hasExplicitPageQuestion) result = result.filter((facet) => facet !== "ui_structure");
  if (!hasExplicitNumericQuestion) result = result.filter((facet) => facet !== "numeric_logic");
  if (!hasAlgorithmQuestion) result = result.filter((facet) => facet !== "algorithms_models");
  if (hasAlgorithmQuestion) result = result.filter((facet) => facet !== "numeric_logic");
  return result.length ? result : ["code_symbols", "data_flow"];
}

function detectOutputShape(
  raw: string,
  normalized: string,
  answerGoal: WorkspaceAnswerGoal,
  facets: WorkspaceEvidenceFacet[]
): WorkspaceOutputShape {
  if (/\b(table)\b/.test(normalized) || /(?:\u062c\u062f\u0648\u0644)/.test(raw)) return "table";
  if (facets.includes("numeric_logic") && (answerGoal === "list" || answerGoal === "count" || answerGoal === "compare")) return "table";
  if (facets.includes("ui_structure") && (answerGoal === "list" || answerGoal === "count")) return "table";
  if (/\b(detailed|walkthrough|step by step|full flow)\b/.test(normalized) || /(?:\u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644|\u062e\u0637\u0648\u0629)/.test(raw)) return "walkthrough";
  if (answerGoal === "list" || answerGoal === "count") return "bullets";
  return "concise";
}

function extractTopicTerms(userPrompt: string, facets: WorkspaceEvidenceFacet[]) {
  const normalized = normalizeForIntent(userPrompt);
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !ENGLISH_STOP_WORDS.has(token))
    .filter((token) => !ARABIC_STOP_WORDS.has(token))
    .filter((token) => !STYLE_WORDS.has(token));
  const facetTerms = facets.flatMap((facet) => FACET_TOPIC_TERMS[facet].map(normalizeForIntent));
  const preferred = tokens.filter((token) => facetTerms.some((term) => term.includes(token) || token.includes(term)));
  return uniqueStrings(preferred.length ? preferred : tokens).slice(0, 8);
}

function scoreEvidenceForIntent(item: WorkspaceEvidenceLike, facets: WorkspaceEvidenceFacet[], intent: WorkspaceIntentUnderstanding) {
  let score = 0;
  const text = normalizeForIntent(evidenceText(item));
  for (const facet of facets) {
    if (intent.requiredFacets.includes(facet)) score += 120;
    else if (intent.optionalFacets.includes(facet)) score += 45;
    else score += 10;
  }
  for (const term of intent.topicTerms) {
    if (text.includes(normalizeForIntent(term))) score += 50;
  }
  if (/\.(ts|tsx|js|jsx|py|rs|go|java)$/i.test(item.path)) score += 20;
  if (/package\.json|requirements\.txt|readme\.md$/i.test(item.path)) score -= 20;
  if (item.snippet && item.snippet.length > 20) score += 10;
  return score;
}

function createGenericNotFoundAnswer(reasoning: WorkspaceReasoning) {
  const topic = reasoning.intent.topicPhrase;
  const inspected = formatEvidenceLinks(reasoning.evidencePack.items.slice(0, 6));
  if (reasoning.intent.language === "arabic") {
    return [
      `\u0645\u0627\u0644\u0642\u064a\u062a\u0634 \`${topic}\` \u0628\u062f\u0644\u064a\u0644 \u0643\u0627\u0641\u064a \u0641\u064a \u0627\u0644\u0640 workspace \u0627\u0644\u062d\u0627\u0644\u064a.`,
      "",
      inspected ? `\u0631\u0627\u062c\u0639\u062a: ${inspected}.` : "\u0645\u0627\u0641\u064a\u0634 \u0623\u062f\u0644\u0629 \u0643\u0641\u0627\u064a\u0629 \u0627\u062a\u062c\u0645\u0639\u062a \u0644\u0644\u0633\u0624\u0627\u0644 \u062f\u0627.",
      reasoning.evidencePack.missingRequiredFacets.length
        ? `\u0627\u0644\u062c\u0632\u0621 \u0627\u0644\u0646\u0627\u0642\u0635: ${reasoning.evidencePack.missingRequiredFacets.map(humanizeFacet).join(", ")}.`
        : "",
      "\u0644\u0648 \u0627\u0644\u0645\u0648\u0636\u0648\u0639 \u0645\u0648\u062c\u0648\u062f \u0641\u064a \u0645\u0644\u0641 \u062a\u0627\u0646\u064a\u060c \u0627\u062f\u064a\u0646\u064a \u0627\u0633\u0645\u0647 \u0648\u0647\u062f\u0648\u0631 \u0639\u0644\u064a\u0647 \u0645\u0628\u0627\u0634\u0631\u0629."
    ].filter(Boolean).join("\n");
  }
  return [
    `I could not confirm \`${topic}\` from the current workspace evidence.`,
    "",
    inspected ? `I inspected: ${inspected}.` : "No enough evidence was collected for this question.",
    reasoning.evidencePack.missingRequiredFacets.length
      ? `Missing evidence facet(s): ${reasoning.evidencePack.missingRequiredFacets.map(humanizeFacet).join(", ")}.`
      : "",
    "Point me to the file/module if it exists elsewhere."
  ].filter(Boolean).join("\n");
}

function createAlgorithmsAnswer(reasoning: WorkspaceReasoning) {
  const items = uniqueEvidenceItems([
    ...reasoning.evidencePack.byFacet.algorithms_models,
    ...reasoning.evidencePack.byFacet.code_symbols,
    ...reasoning.evidencePack.byFacet.data_flow,
    ...reasoning.evidencePack.topicItems
  ]);
  const specificAlgorithm = detectSpecificAlgorithmFromIntent(reasoning.intent.topicPhrase);
  if (specificAlgorithm && (reasoning.intent.answerGoal === "trace_flow" || reasoning.intent.outputShape === "walkthrough" || reasoning.intent.answerGoal === "explain")) {
    return createSpecificAlgorithmAnswer(reasoning, specificAlgorithm, items);
  }
  const facts = extractAlgorithmFacts(items);
  if (!facts.length) return createGenericInventoryAnswer(reasoning);
  if (reasoning.intent.language === "arabic") {
    const lines = [
      `\u0644\u0642\u064a\u062a ${facts.length} algorithm/model \u0641\u0639\u0644\u064a\u064a\u0646 \u0645\u0646 \u0627\u0644\u0643\u0648\u062f. \u0627\u0644\u0640 services \u0623\u0648 wrappers \u0645\u0634 \u0628\u0639\u062f\u0647\u0627 \u0643\u062e\u0648\u0627\u0631\u0632\u0645\u064a\u0627\u062a \u0645\u0633\u062a\u0642\u0644\u0629:`,
      ""
    ];
    for (const fact of facts) {
      lines.push(`- ${fact.name}: ${fact.summary} ${fact.link}`);
    }
    return lines.join("\n");
  }
  return [
    `I found ${facts.length} algorithm/model item(s) in the code:`,
    "",
    ...facts.map((fact) => `- ${fact.name}: ${fact.summary} ${fact.link}`)
  ].join("\n");
}

function createNumericLogicAnswer(reasoning: WorkspaceReasoning) {
  const facts = extractNumericFacts(uniqueEvidenceItems([
    ...reasoning.evidencePack.byFacet.numeric_logic,
    ...reasoning.evidencePack.topicItems
  ])).slice(0, 28);
  if (!facts.length) return createGenericInventoryAnswer(reasoning);
  const header = reasoning.intent.language === "arabic"
    ? "\u062f\u064a \u0627\u0644\u0623\u0631\u0642\u0627\u0645 \u0648\u0627\u0644\u0634\u0631\u0648\u0637 \u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647\u0627 \u0641\u064a \u0627\u0644\u0643\u0648\u062f:"
    : "These are the numeric rules I found in the code:";
  const rows = [
    "| Signal | Value | Condition/formula | Evidence |",
    "| --- | ---: | --- | --- |",
    ...facts.map((fact) => `| ${escapeTableCell(fact.signal)} | ${escapeTableCell(fact.value)} | ${escapeTableCell(fact.condition)} | ${fact.link} |`)
  ];
  return [header, "", ...rows].join("\n");
}

function createUiStructureAnswer(reasoning: WorkspaceReasoning) {
  const candidates = extractUiCandidates(uniqueEvidenceItems([
    ...reasoning.evidencePack.byFacet.ui_structure,
    ...reasoning.evidencePack.topicItems
  ]));
  if (!candidates.length) return createGenericNotFoundAnswer(reasoning);
  if (reasoning.intent.language === "arabic") {
    return [
      `\u0648\u0627\u0636\u062d \u0625\u0646 \u062f\u064a UI structure \u0645\u062a\u0623\u0643\u062f\u0629 \u0645\u0646 \u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0648\u0627\u062c\u0647\u0629. \u0644\u0642\u064a\u062a ${candidates.length} item:`,
      "",
      "| \u0627\u0644\u0627\u0633\u0645 | \u0627\u0644\u0646\u0648\u0639 | \u0628\u062a\u0639\u0645\u0644 \u0625\u064a\u0647 | \u0627\u0644\u062f\u0644\u064a\u0644 |",
      "| --- | --- | --- | --- |",
      ...candidates.map((item) => `| ${escapeTableCell(item.name)} | ${escapeTableCell(item.type)} | ${escapeTableCell(item.summary)} | ${item.link} |`)
    ].join("\n");
  }
  return [
    `I found ${candidates.length} UI item(s) from frontend structure evidence:`,
    "",
    "| Name | Type | What it does | Evidence |",
    "| --- | --- | --- | --- |",
    ...candidates.map((item) => `| ${escapeTableCell(item.name)} | ${escapeTableCell(item.type)} | ${escapeTableCell(item.summary)} | ${item.link} |`)
  ].join("\n");
}

function createDataFlowAnswer(reasoning: WorkspaceReasoning) {
  const items = uniqueEvidenceItems([
    ...reasoning.evidencePack.byFacet.data_flow,
    ...reasoning.evidencePack.byFacet.code_symbols,
    ...reasoning.evidencePack.topicItems
  ]).slice(0, 8);
  if (!items.length) return createGenericNotFoundAnswer(reasoning);
  const bullets = items.slice(0, 5).map((item) => `- ${summarizeEvidenceItem(item)} ${item.markdownLink}`);
  if (reasoning.intent.language === "arabic") {
    return [
      "\u0627\u0644\u0641\u0644\u0648 \u0627\u0644\u0644\u064a \u0642\u062f\u0631\u062a \u0623\u062b\u0628\u062a\u0647 \u0645\u0646 \u0627\u0644\u0645\u0644\u0641\u0627\u062a:",
      "",
      ...bullets
    ].join("\n");
  }
  return ["The flow I could prove from the files:", "", ...bullets].join("\n");
}

function createGenericInventoryAnswer(reasoning: WorkspaceReasoning) {
  const items = reasoning.evidencePack.topicItems.length ? reasoning.evidencePack.topicItems : reasoning.evidencePack.items;
  if (!items.length) return createGenericNotFoundAnswer(reasoning);
  const top = items.slice(0, 8);
  if (reasoning.intent.language === "arabic") {
    return [
      `\u062f\u0648\u0631\u062a \u0639\u0644\u0649 \`${reasoning.intent.topicPhrase}\` \u0648\u062f\u064a \u0623\u0642\u0648\u0649 \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647\u0627:`,
      "",
      ...top.map((item) => `- ${summarizeEvidenceItem(item)} ${item.markdownLink}`)
    ].join("\n");
  }
  return [
    `I searched for \`${reasoning.intent.topicPhrase}\`; strongest evidence:`,
    "",
    ...top.map((item) => `- ${summarizeEvidenceItem(item)} ${item.markdownLink}`)
  ].join("\n");
}

function createGenericGroundedAnswer(reasoning: WorkspaceReasoning, validationErrors: string[]) {
  const items = reasoning.evidencePack.topicItems.length ? reasoning.evidencePack.topicItems : reasoning.evidencePack.items;
  if (!items.length) return createGenericNotFoundAnswer(reasoning);
  const top = items.slice(0, 5);
  const note = validationErrors.length ? " Provider output was not evidence-safe, so this is synthesized from local refs." : "";
  if (reasoning.intent.language === "arabic") {
    return [
      "\u0627\u0644\u0631\u062f \u062f\u0647 \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0623\u062f\u0644\u0629 \u0627\u0644\u0640 workspace \u0627\u0644\u062d\u0627\u0644\u064a.",
      "",
      ...top.map((item) => `- ${summarizeEvidenceItem(item)} ${item.markdownLink}`),
      note ? "" : "",
      note ? "\u0627\u0633\u062a\u062e\u062f\u0645\u062a \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0645\u062d\u0644\u064a\u0629 \u0628\u062f\u0644 \u0631\u062f \u063A\u064A\u0631 \u0645\u062B\u0628\u062A." : ""
    ].filter(Boolean).join("\n");
  }
  return [
    `This is grounded in the current workspace evidence.${note}`,
    "",
    ...top.map((item) => `- ${summarizeEvidenceItem(item)} ${item.markdownLink}`)
  ].join("\n");
}

type AlgorithmFact = { name: string; summary: string; link: string; score: number; canonical: string };
type AlgorithmStep = { label: string; summary: string; link: string; score: number };

function detectSpecificAlgorithmFromIntent(topicPhrase: string) {
  const normalized = normalizeForIntent(topicPhrase);
  if (/\b(svm|svc|support vector)\b/.test(normalized)) return "svm";
  if (/\b(dbscan)\b/.test(normalized)) return "dbscan";
  if (/\b(fcm|cmeans|c means|fuzzy c)\b/.test(normalized)) return "fcm";
  if (/\b(shap)\b/.test(normalized)) return "shap";
  if (/\b(sarima|arima)\b/.test(normalized)) return "sarima";
  return "";
}

function createSpecificAlgorithmAnswer(reasoning: WorkspaceReasoning, algorithm: string, items: WorkspaceEvidenceLike[]) {
  const steps = extractAlgorithmImplementationSteps(items, algorithm);
  if (!steps.length) {
    const facts = extractAlgorithmFacts(items).filter((fact) => fact.canonical === algorithm);
    if (!facts.length) return createGenericInventoryAnswer(reasoning);
  }
  if (reasoning.intent.language === "arabic") {
    const name = algorithmDisplayName(algorithm);
    const lines = [
      `${name} \u0647\u0646\u0627 \u0645\u0634 \u0645\u062c\u0631\u062f \u0627\u0633\u0645 \u0641\u064a \u0627\u0644\u0643\u0648\u062f. \u062f\u0647 \u062c\u0632\u0621 \u0645\u0646 \u0641\u0644\u0648 model/pipeline \u0645\u062b\u0628\u062a \u0645\u0646 \u0627\u0644\u0645\u0644\u0641\u0627\u062a.`,
      "",
      "\u0627\u0644\u0641\u0643\u0631\u0629:",
      specificAlgorithmPlainSummary(algorithm),
      "",
      "\u0627\u0644\u0641\u0644\u0648 \u0645\u0646 \u0627\u0644\u0643\u0648\u062f:"
    ];
    for (const [index, step] of steps.entries()) {
      lines.push(`${index + 1}. ${step.summary} ${step.link}`);
    }
    lines.push(
      "",
      `\u064a\u0639\u0646\u064a \u0639\u0645\u0644\u064a\u0627: ${specificAlgorithmPracticalSummary(algorithm, steps)}`
    );
    return lines.join("\n");
  }
  const name = algorithmDisplayName(algorithm);
  return [
    `${name} is not just a raw file match here; it appears as part of the model/pipeline flow proven by the current files.`,
    "",
    "Core idea:",
    specificAlgorithmPlainSummary(algorithm),
    "",
    "Code flow:",
    ...steps.map((step, index) => `${index + 1}. ${step.summary} ${step.link}`),
    "",
    `Practically: ${specificAlgorithmPracticalSummary(algorithm, steps)}`
  ].join("\n");
}

function extractAlgorithmFacts(items: WorkspaceEvidenceLike[]): AlgorithmFact[] {
  const facts: AlgorithmFact[] = [];
  const add = (name: string, summary: string, item: WorkspaceEvidenceLike, score: number, canonical = name) => {
    const normalized = canonical.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!normalized) return;
    const existing = facts.find((fact) => fact.canonical.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalized);
    if (existing) {
      if (score > existing.score) {
        existing.summary = summary;
        existing.link = item.markdownLink;
        existing.score = score;
      }
      return;
    }
    facts.push({ name, summary, link: item.markdownLink, score, canonical });
  };
  for (const item of items) {
    const text = `${item.path}\n${item.snippet ?? ""}\n${item.reason}`;
    if (/\bSARIMAForecastingService|SARIMA|SARIMAX\b/i.test(text)) add("SARIMA forecasting", "time-series forecasting for trends or cluster/segment history.", item, 100, "sarima");
    if (/\bDBSCAN\b/i.test(text)) add("DBSCAN clustering", "density-based clustering; useful for grouping points and identifying noise before later modeling.", item, 98, "dbscan");
    if (/\bFuzzy\s*C[-\s]?Means\b|\bFCM\b|\bcmeans\b|skfuzzy|fuzzy c/i.test(text)) add("Fuzzy C-Means clustering", "soft clustering; records can have membership strength instead of one hard label.", item, 96, "fcm");
    if (/\bKMeans|MiniBatchKMeans|k-means\b/i.test(text)) add("KMeans clustering", "hard clustering; groups similar records into fixed clusters.", item, 92, "kmeans");
    if (/\bSVC|LinearSVC|SVM\b/i.test(text)) add("SVM classifier", "supervised classifier/state detector that learns from features and labels, then predicts a class for new records.", item, 95, "svm");
    if (/\bLogisticRegression\b/i.test(text)) add("Logistic Regression", "linear classification/regression model for probability-like decisions.", item, 90, "logisticregression");
    if (/\bRandomForest(Classifier|Regressor)?\b/i.test(text)) add("Random Forest", "tree ensemble model that combines many decision trees.", item, 90, "randomforest");
    if (/\bIsolationForest\b/i.test(text)) add("Isolation Forest", "anomaly detection model.", item, 85, "isolationforest");
    if (/\bshap\b/i.test(text)) add("SHAP explainability", "explains model predictions by estimating feature contributions.", item, 80, "shap");
    const classMatch = text.match(/\b(class|def|function)\s+([A-Za-z_][A-Za-z0-9_]*(?:Model|Classifier|Cluster|Forecast|Predict|Scor)[A-Za-z0-9_]*)/i);
    if (classMatch) {
      const name = text.match(/\b(class|def|function)\s+([A-Za-z_][A-Za-z0-9_]*(?:Model|Classifier|Cluster|Forecast|Predict|Scor)[A-Za-z0-9_]*)/i)?.[2];
      if (name && !/(service|manager|controller|runner|wrapper)$/i.test(name)) {
        add(humanizeName(name), "project-defined model or scoring function.", item, 60, name);
      }
    }
    if (/\bfit\(|predict\(|fit_predict|transform\(/i.test(text) && /model|cluster|forecast|classifier|pipeline/i.test(text)) {
      const basename = item.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "model pipeline";
      if (!/(service|manager|controller|routes?)$/i.test(basename)) {
        add(humanizeName(basename), "contains fit/predict style model execution.", item, 55, basename);
      }
    }
  }
  return facts.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).slice(0, 12);
}

function extractAlgorithmImplementationSteps(items: WorkspaceEvidenceLike[], algorithm: string): AlgorithmStep[] {
  const steps: AlgorithmStep[] = [];
  const add = (label: string, summary: string, item: WorkspaceEvidenceLike, score: number) => {
    const existing = steps.find((step) => step.label === label);
    if (existing) {
      if (score > existing.score) {
        existing.summary = summary;
        existing.link = item.markdownLink;
        existing.score = score;
      }
      return;
    }
    steps.push({ label, summary, link: item.markdownLink, score });
  };
  for (const item of items) {
    const text = evidenceText(item);
    if (algorithm === "svm") {
      if (/\bDBSCAN\b|\bFuzzy\s*C[-\s]?Means\b|\bFCM\b|\bcmeans\b|skfuzzy|FCM-generated labels|cluster/i.test(text)) {
        add("upstream-clustering", "\u0642\u0628\u0644 \u0627\u0644\u0640 SVM \u0641\u064a\u0647 clustering/labels \u0628\u062a\u062a\u062c\u0647\u0632\u060c \u0648\u062f\u0647 \u0628\u064a\u062f\u064a \u0627\u0644\u0645\u0648\u062f\u064a\u0644 targets \u0623\u0648 states \u064a\u062a\u0639\u0644\u0645 \u0645\u0646\u0647\u0627.", item, 90);
      }
      if (/\bSVC\b|\bLinearSVC\b|\bSVM\b/i.test(text) && /\bfit\(|trained|training|labels|features/i.test(text)) {
        add("training", "\u0627\u0644\u0640 SVM \u0628\u064a\u062a\u062f\u0631\u0628 \u0639\u0644\u0649 features \u0645\u0639 labels/states\u060c \u064a\u0639\u0646\u064a \u0628\u064a\u062a\u0639\u0644\u0645 \u064a\u0635\u0646\u0641 \u0627\u0644\u0639\u064a\u0646\u0629 \u0628\u062f\u0644 \u0645\u0627 \u064a\u062e\u062a\u0631\u0639 \u0642\u0631\u0627\u0631.", item, 100);
      }
      if (/\bpredict\(|decision_function|predict_proba/i.test(text)) {
        add("prediction", "\u0628\u0639\u062f \u0627\u0644\u062a\u062f\u0631\u064a\u0628 \u0628\u064a\u0633\u062a\u062e\u062f\u0645 predict/predict_proba \u0639\u0634\u0627\u0646 \u064a\u0637\u0644\u0639 state \u0623\u0648 class \u0644\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u062c\u062f\u064a\u062f\u0629.", item, 85);
      }
      if (/joblib|pickle|save|load|dump/i.test(text)) {
        add("persistence", "\u0641\u064a\u0647 \u0623\u062b\u0631 \u0644\u062a\u062e\u0632\u064a\u0646/\u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0645\u0648\u062f\u064a\u0644\u060c \u0641\u0627\u0644\u0640 SVM \u0645\u0634 \u0644\u0627\u0632\u0645 \u064a\u062a\u062f\u0631\u0628 \u0645\u0646 \u0627\u0644\u0635\u0641\u0631 \u0641\u064a \u0643\u0644 \u0645\u0631\u0629.", item, 70);
      }
      if (/shap/i.test(text)) {
        add("explainability", "SHAP \u0628\u064a\u062a\u0631\u0628\u0637 \u0628\u0627\u0644\u0640 prediction \u0639\u0634\u0627\u0646 \u064a\u0634\u0631\u062d \u0623\u0646\u0647\u064a features \u0623\u062b\u0631\u062a \u0639\u0644\u0649 \u0642\u0631\u0627\u0631 \u0627\u0644\u0640 SVM.", item, 75);
      }
      if (/routes?\.py|api|endpoint|model_context|process_customer|predict/i.test(text) && /svm|classifier|prediction|state|cluster/i.test(text)) {
        add("usage", "\u0627\u0644\u0646\u062a\u064a\u062c\u0629 \u0628\u062a\u062a\u0633\u062a\u062e\u062f\u0645 \u062f\u0627\u062e\u0644 API/service flow\u060c \u0645\u0634 \u0645\u062c\u0631\u062f \u062a\u062f\u0631\u064a\u0628 \u0645\u0639\u0632\u0648\u0644.", item, 65);
      }
    }
  }
  return steps.sort((left, right) => right.score - left.score).slice(0, 8);
}

function algorithmDisplayName(algorithm: string) {
  if (algorithm === "svm") return "SVM";
  if (algorithm === "dbscan") return "DBSCAN";
  if (algorithm === "fcm") return "Fuzzy C-Means";
  if (algorithm === "shap") return "SHAP";
  if (algorithm === "sarima") return "SARIMA";
  return humanizeName(algorithm);
}

function specificAlgorithmPlainSummary(algorithm: string) {
  if (algorithm === "svm") {
    return "\u0627\u0644\u0640 SVM \u0647\u0646\u0627 classifier/state detector: \u064a\u0627\u062e\u062f features\u060c \u064a\u062a\u0639\u0644\u0645 \u0645\u0646 labels \u0623\u0648 states \u0645\u062a\u062c\u0647\u0632\u0629\u060c \u0648\u0628\u0639\u062f\u064a\u0646 \u064a\u0637\u0644\u0639 classification \u0644\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u062c\u062f\u064a\u062f\u0629.";
  }
  return `\u0627\u0644\u0643\u0648\u062f \u0628\u064a\u0633\u062a\u062e\u062f ${algorithmDisplayName(algorithm)} \u0643\u062c\u0632\u0621 \u0645\u0646 \u0641\u0644\u0648 model \u0623\u0648 analysis \u0645\u062b\u0628\u062a \u0628\u0627\u0644\u0623\u062f\u0644\u0629.`;
}

function specificAlgorithmPracticalSummary(algorithm: string, steps: AlgorithmStep[]) {
  if (algorithm === "svm") {
    const hasClustering = steps.some((step) => step.label === "upstream-clustering");
    const hasPrediction = steps.some((step) => step.label === "prediction");
    if (hasClustering && hasPrediction) {
      return "\u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0628\u064a\u062c\u0647\u0632 labels/states \u0645\u0646 \u0641\u0644\u0648 \u0627\u0644\u0640 clustering\u060c \u0648\u0627\u0644\u0640 SVM \u0628\u064a\u062a\u0639\u0644\u0645\u0647\u0627 \u0639\u0634\u0627\u0646 \u064a\u0635\u0646\u0641 \u0623\u0633\u0631\u0639 \u0641\u064a \u0627\u0644\u062a\u0634\u063a\u064a\u0644.";
    }
    return "\u0627\u0644\u0640 SVM \u062f\u0648\u0631\u0647 \u064a\u062d\u0648\u0644 \u0627\u0644\u0640 features \u0644\u0640 class/state \u0645\u062b\u0628\u062a\u0629 \u0645\u0646 \u0627\u0644\u0643\u0648\u062f\u060c \u0648\u0623\u064a \u062c\u0632\u0621 \u0645\u0634 \u0638\u0627\u0647\u0631 \u0641\u064a \u0627\u0644\u0623\u062f\u0644\u0629 \u0645\u0634 \u0647\u0627\u0641\u062a\u0631\u0636\u0647.";
  }
  return `\u0627\u0644\u062f\u0648\u0631 \u0627\u0644\u0645\u0624\u0643\u062f \u0644\u0640 ${algorithmDisplayName(algorithm)} \u0647\u0648 \u0627\u0644\u0644\u064a \u0648\u0627\u0636\u062d \u0641\u064a \u0627\u0644\u062e\u0637\u0648\u0627\u062a \u0641\u0648\u0642 \u0641\u0642\u0637.`;
}

function extractNumericFacts(items: WorkspaceEvidenceLike[]) {
  const facts: Array<{ signal: string; value: string; condition: string; link: string; score: number }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const lines = `${item.snippet ?? ""}\n${item.reason}`.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim().replace(/\s+/g, " ");
      if (!line || line.length > 220 || !/-?\d+(?:\.\d+)?/.test(line)) continue;
      const comparison = line.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)/)
        ?? line.match(/(-?\d+(?:\.\d+)?)\s*(<=|>=|<|>|==)\s*([A-Za-z_][A-Za-z0-9_\.]*)/);
      const assignment = line.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*(-?\d+(?:\.\d+)?)/)
        ?? line.match(/["']?([A-Za-z_][A-Za-z0-9_ -]+)["']?\s*:\s*(-?\d+(?:\.\d+)?)/);
      let signal = "";
      let value = "";
      let condition = "";
      if (comparison) {
        const reverse = /^-?\d/.test(comparison[1] ?? "");
        signal = reverse ? comparison[3] ?? "value" : comparison[1] ?? "value";
        value = reverse ? comparison[1] ?? "" : comparison[3] ?? "";
        condition = reverse ? `${value} ${comparison[2]} ${signal}` : `${signal} ${comparison[2]} ${value}`;
      } else if (assignment) {
        signal = assignment[1] ?? "value";
        value = assignment[2] ?? "";
        condition = line;
      } else if (/[+\-*/()]|\bmax\b|\bmin\b|\*\*/.test(line)) {
        signal = line.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*=/)?.[1] ?? "formula";
        value = (line.match(/-?\d+(?:\.\d+)?/g) ?? []).join(", ");
        condition = line;
      }
      if (!signal || !value) continue;
      const key = `${item.ref}:${condition}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        signal: humanizeName(signal),
        value,
        condition,
        link: item.markdownLink,
        score: (/orchestrator|agents?|routes?|arima|model|service/i.test(item.path) ? 50 : 0) + (/[<>]=?|==/.test(condition) ? 30 : 10)
      });
    }
  }
  return facts.sort((left, right) => right.score - left.score);
}

function extractUiCandidates(items: WorkspaceEvidenceLike[]) {
  const candidates: Array<{ name: string; type: string; summary: string; link: string; score: number }> = [];
  const add = (name: string, type: string, summary: string, item: WorkspaceEvidenceLike, score: number) => {
    const cleanName = humanizeName(name).trim();
    if (!cleanName || cleanName.length < 2) return;
    const key = cleanName.toLowerCase();
    const existing = candidates.find((candidate) => candidate.name.toLowerCase() === key);
    if (existing) {
      if (score > existing.score) {
        existing.type = type;
        existing.summary = summary;
        existing.link = item.markdownLink;
        existing.score = score;
      }
      return;
    }
    candidates.push({ name: cleanName, type, summary, link: item.markdownLink, score });
  };
  for (const item of items) {
    if (/\.(css|scss|sass|less)$/i.test(item.path)) continue;
    const text = `${item.snippet ?? ""}\n${item.reason}`;
    for (const match of text.matchAll(/<Route[^>]*path=["']([^"']+)["'][^>]*element=\{?<([A-Za-z_][A-Za-z0-9_]*)/g)) {
      add(match[2] ?? match[1] ?? "route", "route", `renders route ${match[1]}`, item, 95);
    }
    for (const match of text.matchAll(/\{\s*id:\s*["']([^"']+)["'][^}]*title:\s*["']([^"']+)["'][^}]*?(?:description:\s*["']([^"']+)["'])?/g)) {
      add(match[2] ?? match[1] ?? "view", "tab/view", match[3] ?? `view id ${match[1]}`, item, 90);
    }
    for (const match of text.matchAll(/<section[^>]*(?:id|data-view|data-page)=["']([^"']+)["'][^>]*>([^<]{0,160})/g)) {
      add(match[1] ?? "section", "section", compact(match[2] ?? "page-like section"), item, 80);
    }
    for (const match of text.matchAll(/<(section|main|aside)[^>]*className=["']([^"']+)["'][^>]*>([^<]{0,160})/g)) {
      add(match[2] ?? match[1] ?? "section", match[1] ?? "section", compact(match[3] ?? "UI section"), item, 75);
    }
    for (const match of text.matchAll(/<a[^>]*href=["']#?([^"']+)["'][^>]*>([^<]{1,80})/g)) {
      add(match[2] ?? match[1] ?? "nav item", "navigation", `opens ${match[1]}`, item, 60);
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name)).slice(0, 20);
}

function hasFacet(reasoning: WorkspaceReasoning, facet: WorkspaceEvidenceFacet) {
  return reasoning.evidencePack.byFacet[facet].length > 0;
}

function mapFacetItems(input: Record<WorkspaceEvidenceFacet, WorkspaceEvidenceLike[]>) {
  return Object.fromEntries(ALL_FACETS.map((facet) => [facet, uniqueEvidenceItems(input[facet]).slice(0, 30)])) as Record<WorkspaceEvidenceFacet, WorkspaceEvidenceLike[]>;
}

function emptyFacetMap(): Record<WorkspaceEvidenceFacet, WorkspaceEvidenceLike[]> {
  return {
    ui_structure: [],
    code_symbols: [],
    algorithms_models: [],
    numeric_logic: [],
    data_flow: [],
    tests_docs: []
  };
}

function evidenceText(item: WorkspaceEvidenceLike) {
  return `${item.path}\n${item.title}\n${item.reason}\n${item.snippet ?? ""}`;
}

function summarizeEvidenceItem(item: WorkspaceEvidenceLike) {
  const snippet = compact(item.snippet ?? item.reason ?? item.title);
  return snippet.length > 140 ? `${snippet.slice(0, 137)}...` : snippet;
}

function formatEvidenceLinks(items: WorkspaceEvidenceLike[]) {
  return uniqueEvidenceItems(items).map((item) => item.markdownLink).join(", ");
}

function normalizeForIntent(value: string) {
  return value
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s/<>.=]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeFacet(facet: WorkspaceEvidenceFacet) {
  return facet.replace(/_/g, " ");
}

function humanizeName(value: string) {
  return value
    .replace(/^self\./, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function escapeTableCell(value: string) {
  return compact(value).replace(/\|/g, "\\|").slice(0, 180);
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueFacets(values: WorkspaceEvidenceFacet[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueEvidenceItems<T extends WorkspaceEvidenceLike>(items: T[]) {
  const byRef = new Map<string, T>();
  for (const item of items) {
    if (!byRef.has(item.ref)) byRef.set(item.ref, item);
  }
  return [...byRef.values()];
}
