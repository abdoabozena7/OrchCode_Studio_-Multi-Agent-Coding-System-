import type { ProjectExplainReport } from "@hivo/protocol";
import { prepareWorkspacePromptForUnderstanding } from "./IntentDecisionEngine.js";

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
  "hi", "hello", "hey", "yo", "how", "i", "in", "inside", "is", "it", "me", "many", "much", "of", "one", "please",
  "project", "selected", "show", "system", "tell", "that", "the", "this", "to", "what",
  "which", "with", "work", "works", "workspace", "you", "thanks", "thank"
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
  "\u0625\u0632\u0627\u064a",
  "\u0628\u064a\u062a\u0637\u0628\u0642",
  "\u0628\u062a\u062a\u0637\u0628\u0642",
  "\u0645\u062a\u0637\u0628\u0642",
  "\u0628\u064a\u0634\u062a\u063a\u0644",
  "\u0628\u062a\u0634\u062a\u063a\u0644",
  "\u0647\u0627\u064a",
  "\u0647\u0627\u0649",
  "\u0647\u0644\u0627",
  "\u0627\u0647\u0644\u0627",
  "\u0623\u0647\u0644\u0627",
  "\u0633\u0644\u0627\u0645",
  "\u0634\u0643\u0631\u0627"
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
  const prepared = prepareWorkspacePromptForUnderstanding(userPrompt);
  const workspacePrompt = prepared.workspaceMessage || userPrompt;
  const language = /[\u0600-\u06ff]/.test(userPrompt) ? "arabic" : "english";
  const normalized = normalizeForIntent(workspacePrompt);
  const raw = workspacePrompt.toLowerCase();
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
  const topicTerms = extractTopicTerms(workspacePrompt, requiredFacets);
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
  if (/\b(debug|error|failed|bug|crash|broken|break)\b/.test(normalized) || /(?:\u0628\u0627\u064a\u0638|\u0645\u0634\u0643\u0644\u0629|\u0627\u0631\u0648\u0631)/.test(raw)) return "debug";
  if (/\b(perform|run|do)\s+(?:a\s+)?(?:deep\s+)?(?:audit|review|critique)\b/.test(normalized)) return "debug";
  const asksWhatChanges = /\b(what|how|where|why)\b.{0,40}\b(changes?|affects?|impacts?|updates?)\b/.test(normalized)
    || /\b(changes?|affects?|impacts?|updates?)\b.{0,40}\b(what|where|how|which)\b/.test(normalized)
    || /(?:\u0628\u064a\u063a\u064a\u0631\s*(?:\u0627\u064a\u0647|\u0625\u064a\u0647)|\u0627\u064a\u0647\s+اللي\s+بي(?:ت)?غير|\u0625\u064a\u0647\s+اللي\s+بي(?:ت)?غير|\u0645\u0627\s+الذي\s+يتغير|\u0628\u064a\u0623\u062b\u0631\s+على\s+ا?يه|\u0628\u064a\u063a\u064a\u0631\s+في\s+ا?يه)/.test(raw);
  const explicitCodeChange = /\b(change|edit|fix|add|implement|update|write|create|make|build|modify|remove|replace|rename|delete|insert|overwrite|append|prepend|move|refactor)\b.{0,30}\b(code|file|implementation|function|component|module)\b/.test(normalized)
    || /(?:\u063a\u064a\u0631\s+الكود|\u063a\u064a\u0631\s+في\s+الكود|\u0639\u062f\u0644|\u0635\u0644\u062d|\u0627\u0636\u0641|\u0646\u0641\u0630|\u0627\u0643\u062a\u0628|\u0627\u0639\u0645\u0644|\u0627\u0628\u0646\u064a|\u0627\u0645\u0633\u062d|\u0627\u062d\u0630\u0641)/.test(raw);
  if (asksWhatChanges && !explicitCodeChange) return "answer_only";
  if (/\b(change|changing|edit|fix|add|implement|update|write|create|make|build|modify|remove|replace|rename|delete|insert|overwrite|append|prepend|move|refactor)\b/.test(normalized)
    || /(?:\u063a\u064a\u0631|\u0639\u062f\u0644|\u0635\u0644\u062d|\u0627\u0636\u0641|\u0646\u0641\u0630|\u0627\u0643\u062a\u0628|\u0627\u0639\u0645\u0644|\u0627\u0628\u0646\u064a|\u0627\u0645\u0633\u062d|\u0627\u062d\u0630\u0641)/.test(raw)) return "edit";
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
    .map(normalizeTopicToken)
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !ENGLISH_STOP_WORDS.has(token))
    .filter((token) => !ARABIC_STOP_WORDS.has(token))
    .filter((token) => !STYLE_WORDS.has(token));
  const facetTerms = facets.flatMap((facet) => FACET_TOPIC_TERMS[facet].map(normalizeForIntent));
  const preferred = tokens.filter((token) => facetTerms.some((term) => term.includes(token) || token.includes(term)));
  return uniqueStrings(preferred.length ? preferred : tokens).slice(0, 8);
}

function normalizeTopicToken(token: string) {
  return token.replace(/^\u0627\u0644(?=[a-z0-9_])/i, "");
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
