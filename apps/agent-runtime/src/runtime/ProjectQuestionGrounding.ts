import type { ProjectExplainReport } from "@orchcode/protocol";

export type ProjectAnswerStyle = "child_simple" | "technical" | "concise" | "detailed" | "default";

export type RequestedConcept = {
  specific: boolean;
  label: string;
  displayLabel?: string;
  terms: string[];
  coreTerms: string[];
  aliases: string[];
  evidenceGroups?: RequestedConceptEvidenceGroup[];
  confidence: "high" | "medium" | "low" | "unknown";
};

export type RequestedConceptEvidenceGroup = {
  id: string;
  label: string;
  aliases: string[];
  coreTerms: string[];
};

export type ConceptEvidenceGroupCoverage = {
  id: string;
  label: string;
  found: boolean;
  refs: string[];
};

export type ProjectDomainGrounding = {
  label: string;
  confidence: "high" | "medium" | "low" | "unknown";
  aliases: string[];
  evidenceRefs: string[];
  sourceEvidenceRefs: string[];
  documentationEvidenceRefs: string[];
  evidence: GroundingEvidenceItem[];
};

export type ProjectUnderstanding = {
  projectContextRequired: boolean;
  projectMapperSummary: string;
  dataFlowSummary: string;
  projectDomain: ProjectDomainGrounding;
  domainEvidence: GroundingEvidenceItem[];
  dataFlowEvidence: GroundingEvidenceItem[];
  sourceEvidence: GroundingEvidenceItem[];
  validationEvidence: GroundingEvidenceItem[];
};

export type GroundingEvidenceItem = {
  ref: string;
  markdownLink: string;
  path: string;
  line: number;
  title: string;
  reason: string;
  snippet?: string;
};

export type ProjectQuestionGrounding = {
  language: "arabic" | "english";
  style: ProjectAnswerStyle;
  concept: RequestedConcept;
  projectContextRequired: boolean;
  projectDomain: ProjectDomainGrounding;
  understanding: ProjectUnderstanding;
  conceptFound: boolean;
  decision: "general_project_explanation" | "concept_found" | "concept_not_found";
  confidence: "high" | "medium" | "low";
  inspectedFiles: string[];
  inspectedFileSummaries: Array<{ path: string; summary: string }>;
  supportingRefs: string[];
  supportingEvidence: GroundingEvidenceItem[];
  evidenceGroupCoverage: ConceptEvidenceGroupCoverage[];
  foundInstead: string;
  unknowns: string[];
};

const QUESTION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "code", "codebase", "current",
  "describe", "do", "does", "explain", "for", "from", "give", "happen", "here",
  "how", "i", "in", "is", "it", "me", "of", "please", "project", "selected",
  "show", "system", "tell", "that", "the", "this", "to", "walk", "what", "where",
  "why", "with", "work", "works", "workspace", "you",
  "ط§ط´ط±ط­", "ط§ط´ط±ط­ظ„ظٹ", "ط´ط±ط­", "ط§ظ„ظ…ط´ط±ظˆط¹", "ظ…ط´ط±ظˆط¹", "ط¯ظ‡", "ط¯ط§", "ط¯ظٹ", "ط§ط²ط§ظٹ", "ط¥ط²ط§ظٹ", "ظƒظٹظپ", "ط§ظٹظ‡",
  "ط¥ظٹظ‡", "ظ…ظ†", "ظپظٹ", "ظ‡ظ†ط§", "ط¹ظ„ظ‰", "ظ‡ظˆ", "ظ‡ظٹ", "ط¨ظٹظ‚ط¯ط±", "ظٹظ‚ط¯ط±", "ظٹط¬ظٹط¨", "ظƒط£ظ†ظ‡ط§", "ظƒط§ظ†ظ‡ط§", "prompt",
  "ط§ط´ط±ط­", "ط´ط±ط­", "ط§ظ„ظ…ط´ط±ظˆط¹", "ظ…ط´ط±ظˆط¹", "ط¯ظ‡", "ط¯ط§", "ط¯ظٹ", "ط§ط²ط§ظٹ", "ظƒظٹظپ", "ط§ظٹظ‡",
  "ط¥ظٹظ‡", "ظ…ظ†", "ظپظٹ", "ط¹ظ„ظ‰", "ظ‡ظˆ", "ظ‡ظٹ",
  "ط·آ§ط·آ´ط·آ±ط·آ­", "ط·آ´ط·آ±ط·آ­", "ط·آ§ط¸â€‍ط¸â€¦ط·آ´ط·آ±ط¸ث†ط·آ¹", "ط¸â€¦ط·آ´ط·آ±ط¸ث†ط·آ¹", "ط·آ¯ط·آ§", "ط·آ¯ط¸â€،",
  "ط·آ¯ط¸ظ¹", "ط·آ§ط·آ²ط·آ§ط¸ظ¹", "ط¸ئ’ط¸ظ¹ط¸ظ¾", "ط·آ§ط¸ظ¹ط¸â€،", "ط·آ¥ط¸ظ¹ط¸â€،", "ط¸â€¦ط¸â€ ", "ط¸ظ¾ط¸ظ¹",
  "ط·آ¹ط¸â€‍ط¸â€°", "ط¸â€،ط¸ث†", "ط¸â€،ط¸ظ¹"
]);

const STYLE_STOP_WORDS = new Set([
  "basic", "brief", "child", "children", "concise", "detailed", "eli5", "jargon",
  "kid", "kids", "simple", "simply", "technical", "tiny",
  "ط·ظپظ„", "ط§ط·ظپط§ظ„", "ط£ط·ظپط§ظ„", "ظٹظپظ‡ظ…", "ظٹظپظ‡ظ…ظ‡ط§", "ظٹظ‚ط¯ط±", "ط¨ظٹظ‚ط¯ط±", "ط¨ط¨ط³ط§ط·ط©", "ط¨ط³ظٹط·", "ط¨ط³ظٹط·ط©",
  "ظ…ط¨ط³ط·", "ظ…ط¨ط³ط·ط©", "ظ„ظ„ظ…ط¨طھط¯ط¦", "ظ…ط¨طھط¯ط¦", "ظ…ط¨طھط¯ط¦ظٹظ†",
  "ط·ظپظ„", "ط§ط·ظپط§ظ„", "ط£ط·ظپط§ظ„", "ظٹظپظ‡ظ…", "ظٹظپظ‡ظ…ظ‡ط§", "ظٹظ‚ط¯ط±", "ط¨ظٹظ‚ط¯ط±", "ط¨ط¨ط³ط§ط·ط©",
  "ط¨ط³ظٹط·", "ط¨ط³ظٹط·ط©", "ظ…ط¨ط³ط·", "ظ…ط¨ط³ط·ط©", "ظ„ظ„ظ…ط¨طھط¯ط¦", "ظ…ط¨طھط¯ط¦", "ظ…ط¨طھط¯ط¦ظٹظ†"
]);

const GENERIC_CONCEPT_WORDS = new Set([
  "analysis", "architecture", "feature", "flow", "module", "overview", "pipeline",
  "process", "system"
]);

const EXTRA_ARABIC_QUESTION_STOP_WORDS = new Set([
  "ط§ط´ط±ط­", "ط§ط´ط±ط­ظ„ظٹ", "ط§ظ„ظ…ط´ط±ظˆط¹", "ظ…ط´ط±ظˆط¹", "ط¯ط§", "ط¯ظ‡", "ط¯ظٹ", "ط§ط²ط§ظٹ", "ظƒظٹظپ", "ط§ظٹظ‡",
  "ط¥ظٹظ‡", "ظ…ظ†", "ظپظٹ", "ظ‡ظ†ط§", "ط¹ظ„ظ‰", "ظ‡ظˆ", "ظ‡ظٹ", "ط¨ظٹظ‚ط¯ط±", "ظٹظ‚ط¯ط±", "ظٹط¬ظٹط¨",
  "ظƒط§ظ†ظ‡ط§", "ظƒط£ظ†ظ‡ط§", "prompt"
]);

const EXTRA_ARABIC_STYLE_STOP_WORDS = new Set([
  "ط·ظپظ„", "ط§ط·ظپط§ظ„", "ط£ط·ظپط§ظ„", "ظٹظپظ‡ظ…", "ظٹظپظ‡ظ…ظ‡ط§", "ظٹظ‚ط¯ط±", "ط¨ظٹظ‚ط¯ط±", "ط¨ط¨ط³ط§ط·ط©",
  "ط¨ط³ظٹط·", "ط¨ط³ظٹط·ط©", "ظ…ط¨ط³ط·", "ظ…ط¨ط³ط·ط©", "ظ„ظ„ظ…ط¨طھط¯ط¦", "ظ…ط¨طھط¯ط¦", "ظ…ط¨طھط¯ط¦ظٹظ†"
]);

const REAL_ARABIC_QUESTION_STOP_WORDS = new Set([
  "\u0627\u0634\u0631\u062d", "\u0627\u0634\u0631\u062d\u0644\u064a", "\u0634\u0631\u062d", "\u0627\u0644\u0645\u0634\u0631\u0648\u0639", "\u0645\u0634\u0631\u0648\u0639", "\u062f\u0647", "\u062f\u0627", "\u062f\u064a",
  "\u0627\u0632\u0627\u064a", "\u0625\u0632\u0627\u064a", "\u0643\u064a\u0641", "\u0627\u064a\u0647", "\u0625\u064a\u0647", "\u0645\u0646", "\u0641\u064a", "\u0647\u0646\u0627", "\u0639\u0644\u0649",
  "\u0647\u0648", "\u0647\u064a", "\u0628\u064a\u0642\u062f\u0631", "\u064a\u0642\u062f\u0631", "\u064a\u062c\u064a\u0628", "\u0643\u0623\u0646\u0647\u0627", "\u0643\u0627\u0646\u0647\u0627", "prompt"
]);

const REAL_ARABIC_STYLE_STOP_WORDS = new Set([
  "\u0637\u0641\u0644", "\u0627\u0637\u0641\u0627\u0644", "\u0623\u0637\u0641\u0627\u0644", "\u064a\u0641\u0647\u0645", "\u064a\u0641\u0647\u0645\u0647\u0627", "\u064a\u0642\u062f\u0631", "\u0628\u064a\u0642\u062f\u0631",
  "\u0628\u0628\u0633\u0627\u0637\u0629", "\u0628\u0633\u064a\u0637", "\u0628\u0633\u064a\u0637\u0629", "\u0645\u0628\u0633\u0637", "\u0645\u0628\u0633\u0637\u0629", "\u0644\u0644\u0645\u0628\u062a\u062f\u0626",
  "\u0645\u0628\u062a\u062f\u0626", "\u0645\u0628\u062a\u062f\u0626\u064a\u0646"
]);

const DATASET_SOURCE_ALIASES = [
  "dataset", "data set", "data", "records", "record", "csv", "rows", "row",
  "load data", "data source", "dataset source", "dataset loader", "normalize dataset row",
  "ط¯ط§طھط§", "ط§ظ„ط¯ط§طھط§", "ط¯ط§طھط§ ط³ظٹطھ", "ط§ظ„ط¯ط§طھط§ ط³ظٹطھ", "ط¨ظٹط§ظ†ط§طھ", "ط§ظ„ط¨ظٹط§ظ†ط§طھ",
  "ط¯ط§طھط§", "ط§ظ„ط¯ط§طھط§", "ط¯ط§طھط§ ط³ظٹطھ", "ط§ظ„ط¯ط§طھط§ ط³ظٹطھ", "ط¨ظٹط§ظ†ط§طھ", "ط§ظ„ط¨ظٹط§ظ†ط§طھ"
];

const REALTIME_UPDATE_ALIASES = [
  "realtime", "real time", "real-time", "near realtime", "near real time", "polling",
  "refresh", "repeated refresh", "update loop", "setinterval", "set interval", "stream",
  "socket", "websocket", "timer", "interval",
  "طھط­ط¯ظٹط«", "طھط­ط¯ظٹط« ظ…طھظƒط±ط±", "ظ„ط­ط¸ظٹ", "ظƒط£ظ†ظ‡ط§ realtime", "ظƒط§ظ†ظ‡ط§ realtime",
  "طھط­ط¯ظٹط«", "طھط­ط¯ظٹط« ظ…طھظƒط±ط±", "ظ„ط­ط¸ظٹ", "ظƒط£ظ†ظ‡ط§ realtime", "ظƒط§ظ†ظ‡ط§ realtime"
];

DATASET_SOURCE_ALIASES.push(
  "\u062f\u0627\u062a\u0627",
  "\u0627\u0644\u062f\u0627\u062a\u0627",
  "\u062f\u0627\u062a\u0627 \u0633\u064a\u062a",
  "\u0627\u0644\u062f\u0627\u062a\u0627 \u0633\u064a\u062a",
  "\u0628\u064a\u0627\u0646\u0627\u062a",
  "\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a"
);
REALTIME_UPDATE_ALIASES.push(
  "\u062a\u062d\u062f\u064a\u062b",
  "\u062a\u062d\u062f\u064a\u062b \u0645\u062a\u0643\u0631\u0631",
  "\u0644\u062d\u0638\u064a",
  "\u0643\u0623\u0646\u0647\u0627 realtime",
  "\u0643\u0627\u0646\u0647\u0627 realtime"
);

const DATASET_SOURCE_GROUP: RequestedConceptEvidenceGroup = {
  id: "dataset_source",
  label: "dataset/data source",
  aliases: DATASET_SOURCE_ALIASES,
  coreTerms: ["dataset", "data", "records", "csv", "ط¯ط§طھط§", "ط¨ظٹط§ظ†ط§طھ"]
};

const REALTIME_UPDATE_GROUP: RequestedConceptEvidenceGroup = {
  id: "realtime_update",
  label: "realtime/update behavior",
  aliases: REALTIME_UPDATE_ALIASES,
  coreTerms: ["realtime", "polling", "refresh", "setinterval", "stream", "socket", "طھط­ط¯ظٹط«", "ظ„ط­ط¸ظٹ"]
};

const THRESHOLD_FACT_ALIASES = [
  "threshold", "thresholds", "threshlod", "threshlods", "treshold", "tresholds",
  "cutoff", "cut off", "floor", "minimum", "maximum", "min", "max", "score", "scores",
  "weight", "weights", "compare", "compared", "comparison", "condition", "conditions",
  "guardrail", "guardrails", "formula", "formulas", "equation", "equations", "constant",
  "constants", "numeric", "numbers", "value", "values", "gap", "cosine", "membership",
  "severity", "trend", "drift", "accepted", "f1", "accuracy", "delta", "limit", "limits",
  "\u0639\u062a\u0628\u0629", "\u0639\u062a\u0628\u0627\u062a", "\u062d\u062f", "\u062d\u062f\u0648\u062f",
  "\u0623\u0631\u0642\u0627\u0645", "\u0627\u0631\u0642\u0627\u0645", "\u0628\u0642\u0627\u0631\u0646",
  "\u0628\u064a\u0642\u0627\u0631\u0646", "\u0643\u0627\u0645", "\u0645\u0639\u0627\u062f\u0644\u0629",
  "\u0645\u0639\u0627\u062f\u0644\u0627\u062a", "\u0634\u0631\u0637", "\u0634\u0631\u0648\u0637"
];

const FORECASTING_ALIASES = [
  "forecast", "forecasts", "forecasting", "arima", "sarima", "trend", "prediction",
  "predict", "predicted", "timeseries", "time series", "customer", "customers",
  "per customer", "customer one", "one customer", "single customer", "aggregate",
  "aggregated", "global", "scope", "series",
  "\u062a\u0648\u0642\u0639", "\u062a\u0648\u0642\u0639\u0627\u062a", "\u0646\u0648\u0639",
  "\u0627\u0644\u0641\u0648\u0631\u0643\u0627\u0633\u062a\u064a\u0646\u062c", "\u0639\u0645\u064a\u0644",
  "\u0644\u0639\u0645\u064a\u0644", "\u0639\u0645\u064a\u0644 \u0648\u0627\u062d\u062f",
  "\u0643\u0633\u062a\u0645\u0631", "\u0648\u0627\u062d\u062f"
];

const THRESHOLD_FACT_GROUP: RequestedConceptEvidenceGroup = {
  id: "threshold_fact",
  label: "numeric threshold/formula evidence",
  aliases: THRESHOLD_FACT_ALIASES,
  coreTerms: ["threshold", "score", "condition", "formula", "weight", "\u0639\u062a\u0628\u0629", "\u0628\u0642\u0627\u0631\u0646", "\u0643\u0627\u0645"]
};

const FORECASTING_FACT_GROUP: RequestedConceptEvidenceGroup = {
  id: "forecasting_fact",
  label: "forecasting type/scope evidence",
  aliases: FORECASTING_ALIASES,
  coreTerms: ["forecast", "forecasting", "arima", "sarima", "trend", "customer", "\u0639\u0645\u064a\u0644"]
};

const DATASET_REALTIME_CONCEPT_LABEL = "dataset realtime behavior";
const DATASET_REALTIME_DISPLAY_LABEL = "dataset realtime behavior / ط§ظ„ط¯ط§طھط§ ظ…ظ† ط§ظ„ط¯ط§طھط§ ط³ظٹطھ ظƒط£ظ†ظ‡ط§ realtime";
const THRESHOLD_INVENTORY_CONCEPT_LABEL = "threshold inventory";
const FORECASTING_SCOPE_CONCEPT_LABEL = "forecasting type and scope";
const ARABIC_CHILD_SIMPLE_PATTERN = /(?:ط§ط´ط±ط­.*ظ„\s*ط·ظپظ„|ط·ظپظ„.*ظٹظپظ‡ظ…|ظ„\s*ط·ظپظ„|ظ„ظ„ط·ظپظ„|ط¨ط¨ط³ط§ط·ط©|ط¨ط´ظƒظ„\s+ظ…ط¨ط³ط·|ظ…ط¨ط³ط·|ظ…ط¨ط³ط·ط©|ظ„ظ„ظ…ط¨طھط¯ط¦|ظ…ط¨طھط¯ط¦)/;

const DOMAIN_CLAIM_ALIASES: Record<string, string[]> = {
  "analytics": ["analytics", "analysis", "dashboard", "metrics"],
  "auth": ["auth", "authentication", "authorization", "login", "signin", "sign in", "oauth"],
  "cart": ["cart", "basket"],
  "checkout": ["checkout"],
  "dataset": DATASET_SOURCE_ALIASES,
  "e-commerce": ["e-commerce", "ecommerce", "shopping", "shop", "storefront", "commerce"],
  "payment": ["payment", "payments", "billing", "stripe", "invoice"],
  "realtime": REALTIME_UPDATE_ALIASES,
  "sentiment": ["sentiment", "sentiment analysis", "sentement", "sentement analysis", "classify sentiment", "analyze sentiment", "sentiment classifier", "sentiment pipeline", "sentiment model", "طھط­ظ„ظٹظ„ ط§ظ„ظ…ط´ط§ط¹ط±", "طھط­ظ„ظٹظ„ ظ…ط´ط§ط¹ط±", "ط§ظ„ظ…ط´ط§ط¹ط±", "ظ…ط´ط§ط¹ط±", "emotion", "emotions"],
  "thresholds": THRESHOLD_FACT_ALIASES,
  "forecasting": FORECASTING_ALIASES,
  "todo": ["todo", "to do", "task", "checklist"]
};
DOMAIN_CLAIM_ALIASES.sentiment?.push(
  "\u062a\u062d\u0644\u064a\u0644 \u0627\u0644\u0645\u0634\u0627\u0639\u0631",
  "\u062a\u062d\u0644\u064a\u0644 \u0645\u0634\u0627\u0639\u0631",
  "\u0627\u0644\u0645\u0634\u0627\u0639\u0631",
  "\u0645\u0634\u0627\u0639\u0631"
);

const PROJECT_DOMAIN_CANDIDATES: Array<{ label: string; aliases: string[]; sourceHints: RegExp }> = [
  {
    label: "sentiment analysis",
    aliases: DOMAIN_CLAIM_ALIASES.sentiment ?? [],
    sourceHints: /\b(sentiment|sentement|classifier|classification|model|pipeline|polarity)\b/i
  },
  {
    label: "todo app",
    aliases: DOMAIN_CLAIM_ALIASES.todo ?? [],
    sourceHints: /\b(todo|task|checklist|done)\b/i
  },
  {
    label: "analytics dashboard",
    aliases: DOMAIN_CLAIM_ALIASES.analytics ?? [],
    sourceHints: /\b(analytics|dashboard|metrics|snapshot|chart|series)\b/i
  },
  {
    label: "decision or orchestration system",
    aliases: ["orchestrator", "orchestration", "decision", "route", "agents", "threshold", "score", "policy", "recommendation"],
    sourceHints: /\b(orchestrator|decision|route|agents?|threshold|score|policy|recommendation|dispatch)\b/i
  },
  {
    label: "forecasting or trend model",
    aliases: FORECASTING_ALIASES,
    sourceHints: /\b(forecast|forecasting|arima|sarima|trend|prediction|timeseries|time series)\b/i
  },
  {
    label: "agent runtime or coding assistant",
    aliases: ["agent", "runtime", "orchestrat", "llm", "provider", "patch", "workspace"],
    sourceHints: /\b(agent|runtime|orchestrat|llm|provider|patch|workspace)\b/i
  },
  {
    label: "frontend app",
    aliases: ["react", "component", "vite", "frontend", "ui", "dashboard_ui"],
    sourceHints: /\b(react|component|vite|frontend|useEffect|jsx|tsx)\b/i
  },
  {
    label: "backend or API project",
    aliases: ["api", "server", "backend", "route", "endpoint", "fastapi"],
    sourceHints: /\b(api|server|backend|route|endpoint|FastAPI|router)\b/i
  }
];

const DATA_FLOW_DETAIL_RE = /\b(dataset|data set|records?|rows?|csv|ingest|ingestion|stream|consumer|producer|fetch|setinterval|set interval|poll|polling|refresh|socket|websocket|api\/|snapshot|timestamp|schema|message|pipeline|classifier|model|sentiment|forecast|forecasting|arima|sarima|trend|threshold|score|weight|orchestrator|decision|dispatch|guardrail)\b/i;
const SOURCE_FILE_RE = /\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|py|rs|ts|tsx)$/i;

const KNOWN_CONCEPTS: Array<{
  key: string;
  label: string;
  displayLabel?: string;
  aliases: string[];
  coreTerms: string[];
  evidenceGroups?: RequestedConceptEvidenceGroup[];
}> = [
  {
    key: "sentiment",
    label: "sentiment analysis",
    displayLabel: "sentiment analysis / طھط­ظ„ظٹظ„ ط§ظ„ظ…ط´ط§ط¹ط±",
    aliases: DOMAIN_CLAIM_ALIASES.sentiment ?? [],
    coreTerms: ["sentiment", "sentement", "ظ…ط´ط§ط¹ط±"]
  },
  {
    key: "dataset",
    label: "dataset/data source",
    displayLabel: "dataset/data source / ط§ظ„ط¯ط§طھط§ ظ…ظ† ط§ظ„ط¯ط§طھط§ ط³ظٹطھ",
    aliases: DATASET_SOURCE_ALIASES,
    coreTerms: DATASET_SOURCE_GROUP.coreTerms,
    evidenceGroups: [DATASET_SOURCE_GROUP]
  },
  {
    key: "auth",
    label: "auth",
    aliases: DOMAIN_CLAIM_ALIASES.auth ?? [],
    coreTerms: ["auth", "authentication", "login"]
  },
  {
    key: "payment",
    label: "payment flow",
    aliases: ["payment flow", ...(DOMAIN_CLAIM_ALIASES.payment ?? [])],
    coreTerms: ["payment", "payments", "billing", "stripe"]
  },
  {
    key: "realtime",
    label: "realtime behavior",
    aliases: DOMAIN_CLAIM_ALIASES.realtime ?? [],
    coreTerms: REALTIME_UPDATE_GROUP.coreTerms,
    evidenceGroups: [REALTIME_UPDATE_GROUP]
  },
  {
    key: "thresholds",
    label: THRESHOLD_INVENTORY_CONCEPT_LABEL,
    displayLabel: "threshold inventory / \u0643\u0644 \u0627\u0644\u0623\u0631\u0642\u0627\u0645 \u0648\u0627\u0644\u0634\u0631\u0648\u0637 \u0627\u0644\u0644\u064a \u0627\u0644\u0633\u064a\u0633\u062a\u0645 \u0628\u064a\u0642\u0627\u0631\u0646 \u0628\u064a\u0647\u0627",
    aliases: THRESHOLD_FACT_ALIASES,
    coreTerms: THRESHOLD_FACT_GROUP.coreTerms,
    evidenceGroups: [THRESHOLD_FACT_GROUP]
  },
  {
    key: "forecasting",
    label: FORECASTING_SCOPE_CONCEPT_LABEL,
    displayLabel: "forecasting type and scope / \u0646\u0648\u0639 \u0627\u0644\u0640 forecasting \u0648\u0647\u0644 \u0647\u0648 \u0644\u0640 customer \u0648\u0627\u062d\u062f",
    aliases: FORECASTING_ALIASES,
    coreTerms: FORECASTING_FACT_GROUP.coreTerms,
    evidenceGroups: [FORECASTING_FACT_GROUP]
  }
];

export function detectProjectAnswerStyle(userPrompt: string): ProjectAnswerStyle {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const rawPrompt = userPrompt.toLowerCase();
  if (/(?:\u0627\u0634\u0631\u062d.*\u0644\s*\u0637\u0641\u0644|\u0637\u0641\u0644.*\u064a\u0641\u0647\u0645|\u0644\s*\u0637\u0641\u0644|\u0644\u0644\u0637\u0641\u0644|\u0628\u0628\u0633\u0627\u0637\u0629|\u0628\u0634\u0643\u0644\s+\u0645\u0628\u0633\u0637|\u0645\u0628\u0633\u0637|\u0645\u0628\u0633\u0637\u0629|\u0644\u0644\u0645\u0628\u062a\u062f\u0626|\u0645\u0628\u062a\u062f\u0626)/.test(rawPrompt)) return "child_simple";
  if (/\b(eli5|child|kid|kids|five year old|simple|simply)\b/.test(normalized)) return "child_simple";
  if (ARABIC_CHILD_SIMPLE_PATTERN.test(normalized)) return "child_simple";
  if (/(ط§ط´ط±ط­.*ظ„\s*ط·ظپظ„|ط·ظپظ„.*ظٹظپظ‡ظ…|ظ„\s*ط·ظپظ„|ظ„ظ„ط·ظپظ„|ط¨ط¨ط³ط§ط·ط©|ط¨ط´ظƒظ„\s+ظ…ط¨ط³ط·|ظ…ط¨ط³ط·|ظ…ط¨ط³ط·ط©|ظ„ظ„ظ…ط¨طھط¯ط¦|ظ…ط¨طھط¯ط¦)/.test(normalized)) return "child_simple";
  if (/(ط§ط´ط±ط­.*ظ„ط·ظپظ„|ط·ظپظ„.*ظٹظپظ‡ظ…|ظ„ط·ظپظ„|ظ„ظ„ط·ظپظ„|ط¨ط¨ط³ط§ط·ط©|ط¨ط´ظƒظ„ ظ…ط¨ط³ط·|ظ…ط¨ط³ط·|ظ…ط¨ط³ط·ط©|ظ„ظ„ظ…ط¨طھط¯ط¦|ظ…ط¨طھط¯ط¦)/.test(normalized)) return "child_simple";
  if (/\b(technical|architecture|internals|code level|deep dive)\b/.test(normalized)) return "technical";
  if (/\b(concise|brief|short|quick)\b/.test(normalized)) return "concise";
  if (/(ظ…ط®طھطµط±|ط¨ط§ط®طھطµط§ط±)/.test(normalized)) return "concise";
  if (/\b(detailed|thorough|step by step|full)\b/.test(normalized)) return "detailed";
  if (/(ط¨ط§ظ„طھظپطµظٹظ„|ط®ط·ظˆط© ط¨ط®ط·ظˆط©)/.test(normalized)) return "detailed";
  return "default";
}

export function extractRequestedConcept(userPrompt: string): RequestedConcept {
  const styleStripped = stripStylePhrases(userPrompt);
  const numericOrForecasting =
    detectThresholdInventoryConcept(styleStripped)
    ?? detectThresholdInventoryConcept(userPrompt)
    ?? detectForecastingScopeConcept(styleStripped)
    ?? detectForecastingScopeConcept(userPrompt);
  if (numericOrForecasting) return numericOrForecasting;
  const compound = detectCompoundDatasetRealtimeConcept(styleStripped) ?? detectCompoundDatasetRealtimeConcept(userPrompt);
  if (compound) return compound;
  const known = detectKnownConcept(styleStripped) ?? detectKnownConcept(userPrompt);
  if (known) return known;
  const normalized = normalizeForGroundingSearch(styleStripped);
  const focused = selectConceptPhrase(normalized);
  const terms = meaningfulConceptTerms(focused);
  if (!terms.length) {
    return { specific: false, label: "this project", terms: [], coreTerms: [], aliases: [], confidence: "unknown" };
  }
  const label = terms.slice(0, Math.min(3, terms.length)).join(" ");
  const aliases = expandConceptAliases(terms, label);
  const coreTerms = terms.filter((term) => !GENERIC_CONCEPT_WORDS.has(term));
  return {
    specific: true,
    label,
    terms: uniqueStrings([label, ...terms]),
    coreTerms: coreTerms.length ? coreTerms : terms,
    aliases,
    confidence: terms.length ? "medium" : "low"
  };
}

export function analyzeProjectQuestionGrounding(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: GroundingEvidenceItem[]
): ProjectQuestionGrounding {
  const language = /[\u0600-\u06ff]/.test(userPrompt) ? "arabic" : "english";
  const style = detectProjectAnswerStyle(userPrompt);
  const concept = extractRequestedConcept(userPrompt);
  const projectContextRequired = detectProjectContextRequired(userPrompt);
  const projectDomain = inferProjectDomain(report, evidenceItems);
  const understanding = createProjectUnderstanding(report, evidenceItems, projectContextRequired, projectDomain);
  const inspectedFileSummaries = createInspectedFileSummaries(report, evidenceItems);
  const inspectedFiles = inspectedFileSummaries.map((entry) => entry.path);
  const supportingEvidence = concept.specific
    ? evidenceItems.filter((item) => evidenceItemSupportsConcept(item, concept))
    : evidenceItems.slice(0, 8);
  const supportingRefs = supportingEvidence.map((item) => item.ref);
  const evidenceGroupCoverage = createConceptEvidenceGroupCoverage(concept, evidenceItems);
  const conceptFound = !concept.specific
    || (evidenceGroupCoverage.length ? evidenceGroupCoverage.every((group) => group.found) : supportingRefs.length > 0);
  const foundInstead = inferFoundInstead(report, evidenceItems, projectDomain);
  const confidence = concept.specific
    ? supportingRefs.length >= 2 ? "high" : supportingRefs.length === 1 ? "medium" : "high"
    : evidenceItems.length >= 2 ? "medium" : "low";
  return {
    language,
    style,
    concept,
    projectContextRequired,
    projectDomain,
    understanding,
    conceptFound,
    decision: concept.specific ? conceptFound ? "concept_found" : "concept_not_found" : "general_project_explanation",
    confidence,
    inspectedFiles,
    inspectedFileSummaries,
    supportingRefs,
    supportingEvidence,
    evidenceGroupCoverage,
    foundInstead,
    unknowns: createGroundingUnknowns(report, concept, conceptFound, evidenceGroupCoverage)
  };
}

export function createStyleInstruction(style: ProjectAnswerStyle) {
  if (style === "child_simple") {
    return "Use short sentences, simple words, and at most one small analogy. Avoid an architecture dump.";
  }
  if (style === "technical") {
    return "Use technical wording, but keep every code-behavior claim tied to cited evidence.";
  }
  if (style === "concise") {
    return "Keep the answer concise and focused.";
  }
  if (style === "detailed") {
    return "Give a detailed explanation, but do not add facts that are not proven by evidence.";
  }
  return "Use a clear, direct explanation.";
}

export function createGroundingPackText(grounding: ProjectQuestionGrounding) {
  return [
    `Project context required: ${grounding.projectContextRequired ? "yes" : "no"}`,
    `Project domain: ${grounding.projectDomain.label} (${grounding.projectDomain.confidence})`,
    grounding.projectDomain.evidenceRefs.length ? `Project domain refs: ${grounding.projectDomain.evidenceRefs.join(", ")}` : "",
    grounding.understanding.sourceEvidence.length ? `Source/entrypoint refs: ${grounding.understanding.sourceEvidence.slice(0, 8).map((item) => item.ref).join(", ")}` : "",
    grounding.understanding.dataFlowEvidence.length ? `Data-flow refs: ${grounding.understanding.dataFlowEvidence.slice(0, 10).map((item) => item.ref).join(", ")}` : "",
    `Project mapper summary: ${grounding.understanding.projectMapperSummary}`,
    `Data-flow mapper summary: ${grounding.understanding.dataFlowSummary}`,
    `Requested concept: ${grounding.concept.specific ? formatConceptLabel(grounding.concept) : "general project explanation"}`,
    `Requested concept confidence: ${grounding.concept.confidence}`,
    `Concept found in current workspace evidence: ${grounding.concept.specific ? grounding.conceptFound ? "yes" : "no" : "not concept-specific"}`,
    grounding.evidenceGroupCoverage.length ? `Evidence groups: ${formatEvidenceGroupCoverage(grounding.evidenceGroupCoverage)}` : "",
    `Answer style: ${grounding.style}`,
    `Style instruction: ${createStyleInstruction(grounding.style)}`,
    `Inspected files: ${grounding.inspectedFiles.slice(0, 12).join(", ") || "none"}`,
    grounding.concept.specific && grounding.conceptFound
      ? `Concept-supporting refs: ${grounding.supportingRefs.join(", ")}`
      : "",
    `Found instead: ${grounding.foundInstead}`,
    grounding.unknowns.length ? `Unknowns: ${grounding.unknowns.join(" | ")}` : ""
  ].filter(Boolean).join("\n");
}

export function createDeterministicNotFoundAnswer(grounding: ProjectQuestionGrounding) {
  const concept = formatConceptLabel(grounding.concept);
  const inspected = formatInspectedFiles(grounding);
  const missingGroups = formatMissingEvidenceGroups(grounding);
  const partialEvidence = grounding.evidenceGroupCoverage.some((group) => group.found) && grounding.evidenceGroupCoverage.some((group) => !group.found);
  if (grounding.style === "child_simple") {
    if (grounding.language === "arabic") {
      return [
        `\u0645\u0627\u0644\u0642\u064a\u062a\u0634 ${concept} \u0641\u064a \u0627\u0644\u0640 workspace \u0627\u0644\u0645\u0641\u062a\u0648\u062d \u062d\u0627\u0644\u064a\u0627.`,
        "",
        `\u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647 \u0628\u062f\u0644 \u0643\u062f\u0647: ${grounding.foundInstead}.`,
        simpleAnalogyForFoundInsteadArabic(grounding.foundInstead),
        "",
        `\u0631\u0627\u062c\u0639\u062a ${inspected}.`,
        partialEvidence && missingGroups
          ? `\u0644\u0642\u064a\u062a \u0634\u0648\u064a\u0629 \u062f\u0644\u0627\u0626\u0644 \u0642\u0631\u064a\u0628\u0629\u060c \u0628\u0633 \u0645\u0627\u0642\u062f\u0631\u062a\u0634 \u0623\u0623\u0643\u062f ${missingGroups}.`
          : `\u0645\u0627\u0644\u0642\u064a\u062a\u0634 \u0643\u0648\u062f \u0623\u0648 docs \u062a\u062b\u0628\u062a ${concept} \u0641\u064a \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u062f\u064a.`,
        "",
        "\u0644\u0648 \u062a\u0642\u0635\u062f \u0645\u0634\u0631\u0648\u0639 \u062a\u0627\u0646\u064a\u060c \u0627\u0641\u062a\u062d \u0627\u0644\u0640 workspace \u0627\u0644\u0635\u062d\u064a\u062d \u0623\u0648 \u0627\u0628\u0639\u062a\u0644\u064a \u0627\u0633\u0645 \u0627\u0644\u0645\u0644\u0641."
      ].join("\n");
    }
    return [
      `I could not find ${concept} in the currently selected workspace.`,
      "",
      `I looked at the files here and found ${grounding.foundInstead} instead.`,
      simpleAnalogyForFoundInstead(grounding.foundInstead),
      "",
      `I checked ${inspected}.`,
      partialEvidence && missingGroups
        ? `I found some related clues, but I could not confirm ${missingGroups}.`
        : `I did not find ${concept} code or docs in those files.`,
      "",
      "If you meant another project, make sure the correct workspace is open or point me to the file."
    ].join("\n");
  }
  if (grounding.language === "arabic") {
    return [
      `\u0645\u0627\u0644\u0642\u064a\u062a\u0634 ${concept} \u0641\u064a \u0627\u0644\u0640 workspace \u0627\u0644\u0645\u0641\u062a\u0648\u062d \u062d\u0627\u0644\u064a\u0627.`,
      "",
      `\u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647 \u0628\u062f\u0644 \u0643\u062f\u0647: ${grounding.foundInstead}.`,
      `\u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0644\u064a \u0631\u0627\u062c\u0639\u062a\u0647\u0627: ${inspected}.`,
      partialEvidence && missingGroups ? `\u0627\u0644\u062f\u0644\u064a\u0644 \u0627\u0644\u0646\u0627\u0642\u0635: ${missingGroups}.` : "",
      grounding.unknowns.length ? `\u0627\u0644\u062c\u0632\u0621 \u063a\u064a\u0631 \u0627\u0644\u0645\u0624\u0643\u062f: ${grounding.unknowns[0]}` : "\u062f\u0647 \u0645\u0628\u0646\u064a \u0628\u0633 \u0639\u0644\u0649 \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0644\u064a \u0627\u062a\u0642\u0631\u062a \u0645\u0646 \u0627\u0644\u0640 workspace \u0627\u0644\u062d\u0627\u0644\u064a.",
      "",
      "\u0627\u062a\u0623\u0643\u062f \u0625\u0646 \u0627\u0644\u0640 workspace \u0627\u0644\u0635\u062d\u064a\u062d \u0645\u0641\u062a\u0648\u062d\u060c \u0623\u0648 \u0648\u062c\u0647\u0646\u064a \u0644\u0644\u0645\u0644\u0641 \u0644\u0648 \u0645\u0648\u062c\u0648\u062f \u0641\u064a \u062d\u062a\u0629 \u062a\u0627\u0646\u064a\u0629."
    ].filter(Boolean).join("\n");
  }
  return [
    `I could not find ${concept} in the currently selected workspace.`,
    "",
    `What I found instead: ${grounding.foundInstead}.`,
    `Inspected files: ${inspected}.`,
    partialEvidence && missingGroups ? `Missing evidence: ${missingGroups}.` : "",
    grounding.unknowns.length ? `Uncertainty: ${grounding.unknowns[0]}` : "Uncertainty: this is based only on the files sampled from the current workspace.",
    "",
    "Make sure the correct workspace is open, or point me to the file/module if it exists elsewhere."
  ].join("\n");
}

export function createDeterministicGroundedFallbackAnswer(
  grounding: ProjectQuestionGrounding,
  validationErrors: string[]
) {
  const inspected = formatInspectedFiles(grounding);
  const support = grounding.supportingEvidence.length
    ? grounding.supportingEvidence.slice(0, 3)
    : [];
  if (isThresholdInventoryConcept(grounding) && grounding.conceptFound) {
    return createThresholdInventoryFallback(grounding, validationErrors);
  }
  if (isForecastingScopeConcept(grounding) && grounding.conceptFound) {
    return createForecastingScopeFallback(grounding, validationErrors);
  }
  if (grounding.style === "child_simple") {
    if (grounding.language === "arabic" && isDatasetRealtimeConcept(grounding) && grounding.conceptFound) {
      return createArabicDatasetRealtimeFallback(grounding, validationErrors);
    }
    if (grounding.language === "arabic") {
      const lines = [
        grounding.concept.specific
          ? `\u0644\u0642\u064a\u062a ${grounding.concept.label} \u0641\u064a \u0627\u0644\u0640 workspace\u060c \u0641\u0634\u0631\u062d\u062a\u0647 \u0645\u0646 \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0644\u064a \u0642\u062f\u0627\u0645\u064a.`
          : "\u0634\u0631\u062d\u062a \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0645\u0646 \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0644\u064a \u0642\u062f\u0627\u0645\u064a.",
        "",
        `\u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0634\u0643\u0644\u0647 ${grounding.foundInstead}.`,
        simpleAnalogyForFoundInsteadArabic(grounding.foundInstead),
        "",
        `\u0631\u0627\u062c\u0639\u062a ${inspected}.`
      ];
      if (support.length) {
        lines.push("", "\u0623\u0642\u0648\u0649 \u062f\u0644\u0627\u0626\u0644 \u0644\u0642\u064a\u062a\u0647\u0627:");
        lines.push(...support.map((item) => `- ${item.markdownLink}: ${shortReason(item)}`));
      }
      lines.push("", "\u0645\u0634 \u0647\u0632\u0648\u062f \u062d\u0627\u062c\u0629 \u062e\u0627\u0631\u062c \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u062f\u064a.");
      return lines.join("\n");
    }
    const lines = [
      grounding.concept.specific
        ? `I found ${grounding.concept.label} in this workspace, so I built the answer from the local evidence.`
        : "I built this answer from the current workspace evidence.",
      "",
      `The project looks like ${grounding.foundInstead}.`,
      simpleAnalogyForFoundInstead(grounding.foundInstead),
      "",
      `I checked ${inspected}.`
    ];
    if (support.length) {
      lines.push("", "The strongest clues were:");
      lines.push(...support.map((item) => `- ${item.markdownLink}: ${shortReason(item)}`));
    }
    lines.push("", "I will not guess beyond those files.");
    return lines.join("\n");
  }

  if (grounding.language === "arabic") {
    const lines = [
      grounding.concept.specific
        ? `\u0644\u0642\u064a\u062a ${grounding.concept.label} \u0641\u064a \u0623\u062f\u0644\u0629 \u0627\u0644\u0640 workspace \u0627\u0644\u062d\u0627\u0644\u064a\u060c \u0641\u0627\u0644\u0631\u062f \u0647\u0646\u0627 \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0627\u0644\u0645\u0644\u0641\u0627\u062a.`
        : "\u0627\u0644\u0631\u062f \u0647\u0646\u0627 \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0623\u062f\u0644\u0629 \u0627\u0644\u0640 workspace \u0627\u0644\u062d\u0627\u0644\u064a.",
      "",
      `\u0627\u0644\u0623\u062f\u0644\u0629 \u062a\u0634\u064a\u0631 \u0625\u0644\u0649: ${grounding.foundInstead}.`,
      `\u0631\u0627\u062c\u0639\u062a: ${inspected}.`
    ];
    if (support.length) {
      lines.push("", "\u0623\u062f\u0644\u0629 \u0645\u0628\u0627\u0634\u0631\u0629:");
      lines.push(...support.map((item) => `- ${item.markdownLink}: ${shortReason(item)}`));
    }
    return lines.join("\n");
  }

  const lines = [
    grounding.concept.specific
      ? `I found ${grounding.concept.label} in the current workspace evidence, so I built a grounded answer from the files.`
      : "I built this answer from the current workspace evidence.",
    "",
    `Current-workspace evidence indicates: ${grounding.foundInstead}.`,
    `Inspected files: ${inspected}.`
  ];
  if (support.length) {
    lines.push("", "Grounded evidence:");
    lines.push(...support.map((item) => `- ${item.markdownLink}: ${shortReason(item)}`));
  }
  return lines.join("\n");
}

export function selectGroundingEvidenceRefs(grounding: ProjectQuestionGrounding, evidenceItems: GroundingEvidenceItem[]) {
  const refs = [
    ...grounding.projectDomain.sourceEvidenceRefs,
    ...grounding.projectDomain.documentationEvidenceRefs,
    ...grounding.supportingRefs,
    ...grounding.understanding.dataFlowEvidence.map((item) => item.ref),
    ...evidenceItems.slice(0, 5).map((item) => item.ref)
  ];
  return uniqueStrings(refs).slice(0, 8);
}

export function evidenceItemSupportsConcept(item: GroundingEvidenceItem, concept: RequestedConcept) {
  if (concept.evidenceGroups?.some((group) => group.id === "threshold_fact")) {
    return evidenceItemSupportsThresholdFact(item);
  }
  const contentHaystack = evidenceItemContentText(item);
  if (concept.evidenceGroups?.length) {
    if (matchingConceptEvidenceGroups(contentHaystack, concept).length) return true;
    return matchingConceptEvidenceGroups(item.path, concept).length > 0;
  }
  return textSupportsRequestedConcept(contentHaystack, concept) || textSupportsRequestedConcept(item.path, concept);
}

export function textSupportsRequestedConcept(text: string, concept: RequestedConcept) {
  if (!concept.specific) return true;
  const normalized = normalizeForGroundingSearch(text);
  const coreMatches = concept.coreTerms.some((term) => textContainsConceptTerm(normalized, term));
  if (coreMatches) return true;
  return concept.aliases.some((term) => textContainsConceptTerm(normalized, term));
}

export function matchingConceptEvidenceGroups(text: string, concept: RequestedConcept) {
  if (!concept.evidenceGroups?.length) return [];
  const normalized = normalizeForGroundingSearch(text);
  return concept.evidenceGroups
    .filter((group) => {
      const terms = uniqueStrings([...group.coreTerms, ...group.aliases]);
      return terms.some((term) => textContainsConceptTerm(normalized, term));
    })
    .map((group) => group.id);
}

export function createConceptEvidenceGroupCoverage(
  concept: RequestedConcept,
  evidenceItems: GroundingEvidenceItem[]
): ConceptEvidenceGroupCoverage[] {
  if (!concept.evidenceGroups?.length) return [];
  return concept.evidenceGroups.map((group) => {
    const refs = evidenceItems
      .filter((item) => group.id === "threshold_fact"
        ? evidenceItemSupportsThresholdFact(item)
        : matchingConceptEvidenceGroups(evidenceItemContentText(item), { ...concept, evidenceGroups: [group] }).length)
      .map((item) => item.ref);
    return {
      id: group.id,
      label: group.label,
      found: refs.length > 0,
      refs: uniqueStrings(refs).slice(0, 8)
    };
  });
}

function evidenceItemSupportsThresholdFact(item: GroundingEvidenceItem) {
  const text = [item.path, item.title, item.snippet ?? ""].join("\n");
  if (!/-?\d+(?:\.\d+)?/.test(text)) return false;
  return /\b(threshold|threshlod|cutoff|floor|min|max|minimum|maximum|borderline|direct|dispatch|high|low|score|weight|gap|cosine|membership|severity|trend|drift|accepted|f1|accuracy|delta|deviation|multiplier|guardrail|forecast|arima|sarima|orchestrator|condition|rule)\b/i.test(text.replace(/[_\.]+/g, " "))
    || /[A-Za-z_][A-Za-z0-9_\.]*\s*(<=|>=|<|>|==)\s*-?\d+(?:\.\d+)?/.test(text);
}

export function findUnsupportedDomainClaims(answer: string, evidenceItems: GroundingEvidenceItem[], concept: RequestedConcept) {
  const normalizedAnswer = normalizeForGroundingSearch(answer);
  const evidenceText = normalizeForGroundingSearch(evidenceItems.map((item) => [item.path, item.title, item.reason, item.snippet ?? ""].join(" ")).join(" "));
  const unsupported: string[] = [];
  for (const [claim, aliases] of Object.entries(DOMAIN_CLAIM_ALIASES)) {
    const answerMentions = aliases.some((alias) => textContainsConceptTerm(normalizedAnswer, alias));
    if (!answerMentions) continue;
    const evidenceMentions = aliases.some((alias) => textContainsConceptTerm(evidenceText, alias));
    const requested = concept.specific && [concept.label, ...concept.terms, ...concept.aliases].some((term) => textContainsConceptTerm(normalizedForTerm(term), claim) || textContainsConceptTerm(normalizedForTerm(claim), term));
    if (!evidenceMentions && !requested) unsupported.push(claim);
  }
  return unsupported;
}

export function answerSatisfiesRequestedStyle(answer: string, style: ProjectAnswerStyle) {
  if (style !== "child_simple") return true;
  const normalized = normalizeForGroundingSearch(answer);
  const jargonHits = [...normalized.matchAll(/\b(architecture|orchestration|abstraction|dependency graph|interface contract|retrieval|vector|middleware)\b/g)].length;
  const sentences = answer.split(/[.!?\n]+/).map((part) => part.trim()).filter(Boolean);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const averageSentenceLength = sentences.length ? wordCount / sentences.length : wordCount;
  return answer.length <= 1800 && averageSentenceLength <= 28 && jargonHits <= 3;
}

export function normalizeForGroundingSearch(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripStylePhrases(value: string) {
  return value
    .replace(/\bexplain\s+it\s+like\s+i(?:'|â€™)?m\s+(?:a\s+)?(?:child|kid|five year old)\b/gi, " ")
    .replace(/\bexplain\s+like\s+i(?:'|â€™)?m\s+(?:a\s+)?(?:child|kid|five year old)\b/gi, " ")
    .replace(/\bexplain\s+(?:it\s+)?(?:simply|in simple terms|for a child|to a child)\b/gi, " ")
    .replace(/\bkeep\s+it\s+(?:brief|short|concise|technical|detailed)\b/gi, " ")
    .replace(/(?:\u0627\u0634\u0631\u062d(?:\u0647|\u0647\u0627|\u0644\u064a)?\s*)?(?:\u0644\s*\u0637\u0641\u0644|\u0644\u0644\u0637\u0641\u0644|\u0637\u0641\u0644\s+\u064a\u0642\u062f\u0631\s+\u064a\u0641\u0647\u0645|\u0637\u0641\u0644\s+\u064a\u0641\u0647\u0645|\u0628\u0634\u0643\u0644\s+\u0645\u0628\u0633\u0637|\u0628\u0628\u0633\u0627\u0637\u0629|\u0644\u0644\u0645\u0628\u062a\u062f\u0626(?:\u064a\u0646)?|\u0628\u0633\u064a\u0637(?:\u0629)?|\u0645\u0628\u0633\u0637(?:\u0629)?)/g, " ")
    .replace(/(?:ط§ط´ط±ط­(?:ظ‡|ظ‡ط§|ظ„ظٹ)?\s*)?(?:ظ„\s*ط·ظپظ„|ظ„ظ„ط·ظپظ„|ط·ظپظ„\s+ظٹظ‚ط¯ط±\s+ظٹظپظ‡ظ…|ط·ظپظ„\s+ظٹظپظ‡ظ…|ط¨ط´ظƒظ„\s+ظ…ط¨ط³ط·|ط¨ط¨ط³ط§ط·ط©|ظ„ظ„ظ…ط¨طھط¯ط¦(?:ظٹظ†)?|ط¨ط³ظٹط·(?:ط©)?|ظ…ط¨ط³ط·(?:ط©)?)/g, " ")
    .replace(/(?:ط§ط´ط±ط­(?:ظ‡|ظ‡ط§|ظ„ظٹ)?\s*)?(?:ظ„\s*ط·ظپظ„|ظ„ظ„ط·ظپظ„|ط·ظپظ„\s+ظٹظ‚ط¯ط±\s+ظٹظپظ‡ظ…|ط·ظپظ„\s+ظٹظپظ‡ظ…|ط¨ط´ظƒظ„\s+ظ…ط¨ط³ط·|ط¨ط¨ط³ط§ط·ط©|ظ„ظ„ظ…ط¨طھط¯ط¦(?:ظٹظ†)?|ط¨ط³ظٹط·(?:ط©)?|ظ…ط¨ط³ط·(?:ط©)?)/g, " ")
    .replace(/(?:ط§ط´ط±ط­(?:ظ‡|ظ‡ط§|ظ„ظٹ)?\s*)?(?:ظ„ط·ظپظ„|ظ„ظ„ط·ظپظ„|ظ„ ط·ظپظ„|ط·ظپظ„\s+ظٹظ‚ط¯ط±\s+ظٹظپظ‡ظ…|ط·ظپظ„\s+ظٹظپظ‡ظ…|ط¨ط´ظƒظ„\s+ظ…ط¨ط³ط·|ط¨ط¨ط³ط§ط·ط©|ظ„ظ„ظ…ط¨طھط¯ط¦|ظ„ظ„ظ…ط¨طھط¯ط¦ظٹظ†|ط¨ط³ظٹط·|ط¨ط³ظٹط·ط©|ظ…ط¨ط³ط·|ظ…ط¨ط³ط·ط©)/g, " ");
}

function detectCompoundDatasetRealtimeConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const datasetMatches = DATASET_SOURCE_ALIASES.filter((alias) => textContainsConceptTerm(normalized, alias));
  const realtimeMatches = REALTIME_UPDATE_ALIASES.filter((alias) => textContainsConceptTerm(normalized, alias));
  if (!datasetMatches.length || !realtimeMatches.length) return undefined;
  return {
    specific: true,
    label: DATASET_REALTIME_CONCEPT_LABEL,
    displayLabel: DATASET_REALTIME_DISPLAY_LABEL,
    terms: uniqueStrings([
      DATASET_REALTIME_CONCEPT_LABEL,
      "dataset realtime",
      "realtime dataset",
      ...datasetMatches,
      ...realtimeMatches,
      ...DATASET_SOURCE_GROUP.coreTerms,
      ...REALTIME_UPDATE_GROUP.coreTerms
    ]),
    coreTerms: uniqueStrings([...DATASET_SOURCE_GROUP.coreTerms, ...REALTIME_UPDATE_GROUP.coreTerms]),
    aliases: uniqueStrings([
      DATASET_REALTIME_CONCEPT_LABEL,
      DATASET_REALTIME_DISPLAY_LABEL,
      "dataset realtime",
      "realtime dataset",
      "dataset looks realtime",
      "dataset near realtime",
      ...DATASET_SOURCE_ALIASES,
      ...REALTIME_UPDATE_ALIASES
    ]),
    evidenceGroups: [DATASET_SOURCE_GROUP, REALTIME_UPDATE_GROUP],
    confidence: datasetMatches.some((alias) => normalizedForTerm(alias).includes(" "))
      || realtimeMatches.some((alias) => normalizedForTerm(alias).includes(" "))
      ? "high"
      : "medium"
  };
}

function detectThresholdInventoryConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const hasThresholdIntent = THRESHOLD_FACT_ALIASES.some((alias) => textContainsConceptTerm(normalized, alias));
  const hasArabicCompareIntent = /(?:\u0628\u0642\u0627\u0631\u0646|\u0628\u064a\u0642\u0627\u0631\u0646|\u0643\u0627\u0645|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644\u0629|\u0645\u0639\u0627\u062f\u0644\u0627\u062a)/.test(userPrompt);
  const hasDecisionContext = /\b(agent|agents|page|system|orchestrator|route|decision|rule|rules|formula|formulas|score|scores)\b/.test(normalized)
    || /(?:\u0627\u0644\u0633\u064a\u0633\u062a\u0645|\u0627\u0644\u0633\u064a\u0633\u062a\u0645\u0643|\u0635\u0641\u062d\u0629|\u0627\u0644\u0640?\s*agents|\u0627\u0644 agents)/.test(userPrompt);
  if (!hasThresholdIntent && !hasArabicCompareIntent) return undefined;
  return {
    specific: true,
    label: THRESHOLD_INVENTORY_CONCEPT_LABEL,
    displayLabel: "threshold inventory / \u0643\u0644 \u0627\u0644\u0623\u0631\u0642\u0627\u0645 \u0648\u0627\u0644\u0634\u0631\u0648\u0637 \u0627\u0644\u0644\u064a \u0627\u0644\u0633\u064a\u0633\u062a\u0645 \u0628\u064a\u0642\u0627\u0631\u0646 \u0628\u064a\u0647\u0627",
    terms: uniqueStrings([
      THRESHOLD_INVENTORY_CONCEPT_LABEL,
      "agents page decision thresholds",
      "thresholds",
      "formulas",
      "numeric comparisons",
      ...THRESHOLD_FACT_GROUP.coreTerms
    ]),
    coreTerms: THRESHOLD_FACT_GROUP.coreTerms,
    aliases: uniqueStrings([
      THRESHOLD_INVENTORY_CONCEPT_LABEL,
      "agents page decision thresholds",
      "decision thresholds",
      "threshold values",
      "numeric comparisons",
      ...THRESHOLD_FACT_ALIASES
    ]),
    evidenceGroups: [THRESHOLD_FACT_GROUP],
    confidence: hasDecisionContext ? "high" : "medium"
  };
}

function detectForecastingScopeConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const hasForecastIntent = FORECASTING_ALIASES.some((alias) => textContainsConceptTerm(normalized, alias));
  const hasTypeOrScopeIntent = /\b(type|kind|scope|customer|per customer|global|aggregate|one customer|single customer)\b/.test(normalized)
    || /(?:\u0646\u0648\u0639|\u0639\u0645\u064a\u0644|\u0648\u0627\u062d\u062f|\u064a\u062a\u0637\u0628\u0642|\u064a\u062a\u0637\u0628\u0642\s+\u0639\u0644\u0649)/.test(userPrompt);
  if (!hasForecastIntent) return undefined;
  return {
    specific: true,
    label: FORECASTING_SCOPE_CONCEPT_LABEL,
    displayLabel: "forecasting type and scope / \u0646\u0648\u0639 \u0627\u0644\u0640 forecasting \u0648\u0647\u0644 \u0647\u0648 \u0644\u0640 customer \u0648\u0627\u062d\u062f",
    terms: uniqueStrings([
      FORECASTING_SCOPE_CONCEPT_LABEL,
      "forecasting",
      "forecast type",
      "forecast scope",
      "per customer forecasting",
      ...FORECASTING_FACT_GROUP.coreTerms
    ]),
    coreTerms: FORECASTING_FACT_GROUP.coreTerms,
    aliases: uniqueStrings([
      FORECASTING_SCOPE_CONCEPT_LABEL,
      "forecast type",
      "forecasting scope",
      "per customer forecasting",
      ...FORECASTING_ALIASES
    ]),
    evidenceGroups: [FORECASTING_FACT_GROUP],
    confidence: hasTypeOrScopeIntent ? "high" : "medium"
  };
}

function detectKnownConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const matches = KNOWN_CONCEPTS
    .map((concept) => {
      const matchedAliases = concept.aliases.filter((alias) => textContainsConceptTerm(normalized, alias));
      return { concept, matchedAliases };
    })
    .filter((entry) => entry.matchedAliases.length)
    .sort((left, right) => {
      const leftScore = Math.max(...left.matchedAliases.map((alias) => normalizedForTerm(alias).length));
      const rightScore = Math.max(...right.matchedAliases.map((alias) => normalizedForTerm(alias).length));
      return rightScore - leftScore;
    });
  const best = matches[0];
  if (!best) return undefined;
  return {
    specific: true,
    label: best.concept.label,
    displayLabel: best.concept.displayLabel,
    terms: uniqueStrings([best.concept.label, ...best.matchedAliases, ...best.concept.coreTerms]),
    coreTerms: best.concept.coreTerms,
    aliases: uniqueStrings([best.concept.label, ...(best.concept.displayLabel ? [best.concept.displayLabel] : []), ...best.concept.aliases]),
    evidenceGroups: best.concept.evidenceGroups,
    confidence: best.matchedAliases.some((alias) => normalizedForTerm(alias).includes(" ")) ? "high" : "medium"
  };
}

function selectConceptPhrase(normalizedPrompt: string) {
  const patterns = [
    /\bhow\s+(?:does|do|is|are)\s+(.+?)\s+(?:work|works|happen|run|operate)\b/,
    /\bhow\s+(?:does|do)\s+this\s+(?:project|workspace|codebase|app|application)\s+(?:solve|handle|handles)\s+(.+?)(?:$|\bhere\b|\bin\b)/,
    /\bexplain\s+(?:the\s+)?(.+?)(?:$|\bhere\b|\bin\s+this\b|\blike\b|\bto\s+a\b|\bfor\s+a\b)/,
    /\b(?:what|where)\s+is\s+(?:the\s+)?(.+?)(?:$|\bhere\b|\bin\s+this\b)/
  ];
  for (const pattern of patterns) {
    const match = normalizedPrompt.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) return candidate;
  }
  return normalizedPrompt;
}

function meaningfulConceptTerms(value: string) {
  const terms = uniqueStrings(
    value
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1)
      .filter((term) => !isQuestionStopWord(term))
      .filter((term) => !isStyleStopWord(term))
      .filter((term) => !/^\d+$/.test(term))
  ).slice(0, 5);
  const asciiTerms = terms.filter((term) => /[a-z0-9]/i.test(term));
  return (asciiTerms.length ? asciiTerms : terms).slice(0, 5);
}

function expandConceptAliases(terms: string[], label: string) {
  const aliases = new Set<string>();
  aliases.add(label);
  for (const term of terms) {
    aliases.add(term);
    for (const [key, values] of Object.entries(DOMAIN_CLAIM_ALIASES)) {
      if (term === key || values.includes(term)) {
        for (const value of values) aliases.add(value);
      }
    }
  }
  if (terms.includes("auth")) {
    for (const value of DOMAIN_CLAIM_ALIASES.auth ?? []) aliases.add(value);
  }
  return [...aliases];
}

function isQuestionStopWord(term: string) {
  return QUESTION_STOP_WORDS.has(term) || EXTRA_ARABIC_QUESTION_STOP_WORDS.has(term) || REAL_ARABIC_QUESTION_STOP_WORDS.has(term);
}

function isStyleStopWord(term: string) {
  return STYLE_STOP_WORDS.has(term) || EXTRA_ARABIC_STYLE_STOP_WORDS.has(term) || REAL_ARABIC_STYLE_STOP_WORDS.has(term);
}

function textContainsConceptTerm(normalizedText: string, term: string) {
  const normalizedTerm = normalizedForTerm(term);
  if (!normalizedTerm) return false;
  const words = normalizedTerm.split(/\s+/).filter((word) => word && !GENERIC_CONCEPT_WORDS.has(word));
  const required = words.length ? words : normalizedTerm.split(/\s+/).filter(Boolean);
  return required.every((word) => {
    if (/[^\x00-\x7F]/.test(word)) {
      if (word.length <= 2) return normalizedText.split(/\s+/).includes(word);
      return normalizedText.includes(word);
    }
    return new RegExp(`\\b${escapeRegExp(word)}\\b`).test(normalizedText);
  });
}

function normalizedForTerm(term: string) {
  return normalizeForGroundingSearch(term);
}

function evidenceItemContentText(item: GroundingEvidenceItem) {
  return [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
}

function createInspectedFileSummaries(report: ProjectExplainReport, evidenceItems: GroundingEvidenceItem[]) {
  const summaries = new Map<string, string>();
  for (const sample of report.contextPack.sampledFiles) {
    summaries.set(sample.path, sample.summary);
  }
  for (const item of evidenceItems) {
    if (!summaries.has(item.path)) summaries.set(item.path, item.reason);
  }
  return [...summaries.entries()].slice(0, 12).map(([path, summary]) => ({ path, summary }));
}

function inferFoundInstead(
  report: ProjectExplainReport,
  evidenceItems: GroundingEvidenceItem[],
  projectDomain?: ProjectDomainGrounding
) {
  if (projectDomain && projectDomain.confidence !== "unknown" && projectDomain.label !== "unknown") {
    return projectDomain.label;
  }
  const text = normalizeForGroundingSearch([
    report.overview,
    report.architecture,
    ...report.contextPack.sampledFiles.map((file) => `${file.path} ${file.summary}`),
    ...evidenceItems.map((item) => `${item.path} ${item.title} ${item.reason} ${item.snippet ?? ""}`)
  ].join(" "));
  if (/\b(todo|to do|checklist|task)\b/.test(text)) return "a todo app";
  if (/\b(sentiment|dataset|analytics|dashboard|metrics)\b/.test(text)) return "an analytics or dashboard project";
  if (/\b(agent|runtime|orchestrat|llm|provider)\b/.test(text)) return "an agent runtime or coding assistant project";
  if (/\b(react|component|vite|frontend|ui)\b/.test(text)) return "a frontend app";
  if (/\b(api|server|backend|route)\b/.test(text)) return "a backend or API project";
  return report.overview;
}

function detectProjectContextRequired(userPrompt: string) {
  const normalized = normalizeForGroundingSearch(userPrompt);
  if (/\b(project|workspace|codebase|app|application|here|this|current)\b/.test(normalized)) return true;
  if (/(\u0627\u0644\u0645\u0634\u0631\u0648\u0639|\u0645\u0634\u0631\u0648\u0639|\u0647\u0646\u0627|\u062f\u0627|\u062f\u0647|\u062f\u064a|\u062f\u0627\u062e\u0644|\u0641\u064a \u0627\u0644\u0645\u0634\u0631\u0648\u0639)/.test(userPrompt)) return true;
  return /(ط§ظ„ظ…ط´ط±ظˆط¹|ظ…ط´ط±ظˆط¹|ظ‡ظ†ط§|ط¯ط§|ط¯ظ‡|ط¯ظٹ|ط¯ط§ط®ظ„|ظپظٹ ط§ظ„ظ…ط´ط±ظˆط¹)/.test(userPrompt);
}

function inferProjectDomain(
  report: ProjectExplainReport,
  evidenceItems: GroundingEvidenceItem[]
): ProjectDomainGrounding {
  const scored = PROJECT_DOMAIN_CANDIDATES.map((candidate) => {
    let score = 0;
    const matchedItems: GroundingEvidenceItem[] = [];
    for (const item of evidenceItems) {
      const rawText = [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
      const normalized = normalizeForGroundingSearch(rawText);
      const aliasHits = candidate.aliases.filter((alias) => textContainsConceptTerm(normalized, alias));
      const sourceHit = isSourceEvidencePath(item.path) && candidate.sourceHints.test(rawText);
      if (!aliasHits.length && !sourceHit) continue;
      let itemScore = aliasHits.reduce((total, alias) => total + Math.max(8, normalizedForTerm(alias).length), 0);
      if (sourceHit) itemScore += 70;
      if (isSourceEvidencePath(item.path)) itemScore += 35;
      if (isDocEvidencePath(item.path)) itemScore += 15;
      if (item.path.toLowerCase().includes(candidate.label.split(" ")[0] ?? "")) itemScore += 20;
      score += itemScore;
      matchedItems.push(item);
    }
    const reportText = normalizeForGroundingSearch([
      report.overview,
      report.architecture,
      ...report.contextPack.sampledFiles.map((file) => `${file.path} ${file.summary}`)
    ].join(" "));
    if (candidate.aliases.some((alias) => textContainsConceptTerm(reportText, alias))) score += 25;
    return { candidate, score, matchedItems: uniqueEvidenceItems(matchedItems) };
  }).sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best || best.score < 45 || !best.matchedItems.length) {
    return {
      label: "unknown",
      confidence: "unknown",
      aliases: [],
      evidenceRefs: [],
      sourceEvidenceRefs: [],
      documentationEvidenceRefs: [],
      evidence: []
    };
  }
  const sourceEvidence = best.matchedItems.filter((item) => isSourceEvidencePath(item.path));
  const documentationEvidence = best.matchedItems.filter((item) => isDocEvidencePath(item.path) || isManifestEvidencePath(item.path));
  const confidence = sourceEvidence.length && best.score >= 120
    ? "high"
    : best.score >= 80
      ? "medium"
      : "low";
  return {
    label: best.candidate.label,
    confidence,
    aliases: best.candidate.aliases,
    evidenceRefs: best.matchedItems.map((item) => item.ref).slice(0, 10),
    sourceEvidenceRefs: sourceEvidence.map((item) => item.ref).slice(0, 8),
    documentationEvidenceRefs: documentationEvidence.map((item) => item.ref).slice(0, 8),
    evidence: best.matchedItems.slice(0, 10)
  };
}

function createProjectUnderstanding(
  report: ProjectExplainReport,
  evidenceItems: GroundingEvidenceItem[],
  projectContextRequired: boolean,
  projectDomain: ProjectDomainGrounding
): ProjectUnderstanding {
  const domainEvidence = projectDomain.evidence;
  const dataFlowEvidence = uniqueEvidenceItems(evidenceItems.filter(evidenceItemLooksDataFlow)).slice(0, 14);
  const sourceEvidence = uniqueEvidenceItems([
    ...projectDomain.evidence.filter((item) => isSourceEvidencePath(item.path)),
    ...evidenceItems.filter((item) => isSourceEvidencePath(item.path) && evidenceItemLooksHighSignalSource(item))
  ]).slice(0, 14);
  const validationEvidence = uniqueEvidenceItems([
    ...sourceEvidence,
    ...dataFlowEvidence,
    ...domainEvidence
  ]).slice(0, 18);
  return {
    projectContextRequired,
    projectMapperSummary: createProjectMapperSummary(report, projectDomain, sourceEvidence),
    dataFlowSummary: createDataFlowMapperSummary(dataFlowEvidence),
    projectDomain,
    domainEvidence,
    dataFlowEvidence,
    sourceEvidence,
    validationEvidence
  };
}

function createProjectMapperSummary(
  report: ProjectExplainReport,
  projectDomain: ProjectDomainGrounding,
  sourceEvidence: GroundingEvidenceItem[]
) {
  const moduleRoots = report.moduleMap.slice(0, 5).map((module) => module.root).join(", ") || "no clear module roots";
  const sourceRefs = sourceEvidence.slice(0, 4).map((item) => item.ref).join(", ") || "no source refs selected";
  const domain = projectDomain.confidence === "unknown" ? "unknown project domain" : projectDomain.label;
  return `Domain=${domain}; modules=${moduleRoots}; source refs=${sourceRefs}.`;
}

function createDataFlowMapperSummary(dataFlowEvidence: GroundingEvidenceItem[]) {
  if (!dataFlowEvidence.length) return "No concrete ingestion, processing, API, refresh, stream, or output refs were selected.";
  return dataFlowEvidence
    .slice(0, 8)
    .map((item) => `${item.ref} (${dataFlowRoleForItem(item)})`)
    .join(" -> ");
}

function evidenceItemLooksDataFlow(item: GroundingEvidenceItem) {
  return DATA_FLOW_DETAIL_RE.test([item.path, item.title, item.reason, item.snippet ?? ""].join("\n"));
}

function evidenceItemLooksHighSignalSource(item: GroundingEvidenceItem) {
  const text = [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
  return /(entrypoint|service|function|class|pipeline|model|classifier|ingest|stream|fetch|setInterval|api|route|schema|dataset|records|sentiment)/i.test(text);
}

function dataFlowRoleForItem(item: GroundingEvidenceItem) {
  const text = [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
  if (/\b(fetch|setInterval|poll|refresh)\b/i.test(text)) return "UI refresh/API request";
  if (/\b(stream|ingest|consumer|producer)\b/i.test(text)) return "ingestion/stream";
  if (/\b(dataset|records|rows|csv)\b/i.test(text)) return "dataset/source";
  if (/\b(sentiment|classifier|model|pipeline)\b/i.test(text)) return "model/processing";
  if (/\b(schema|timestamp|message)\b/i.test(text)) return "message/schema";
  return "supporting flow evidence";
}

function createGroundingUnknowns(
  report: ProjectExplainReport,
  concept: RequestedConcept,
  conceptFound: boolean,
  evidenceGroupCoverage: ConceptEvidenceGroupCoverage[]
) {
  const unknowns = [...report.risksAndUnknowns.slice(0, 2)];
  if (concept.specific && !conceptFound) {
    const missingGroups = evidenceGroupCoverage.filter((group) => !group.found).map((group) => group.label);
    unknowns.unshift(
      missingGroups.length
        ? `Current-workspace evidence is missing: ${missingGroups.join(", ")}.`
        : `No current-workspace evidence matched "${concept.label}".`
    );
  }
  return uniqueStrings(unknowns).slice(0, 4);
}

function formatInspectedFiles(grounding: ProjectQuestionGrounding) {
  const summariesByPath = new Map(grounding.inspectedFileSummaries.map((entry) => [entry.path, entry.summary]));
  const entries = grounding.supportingEvidence.length
    ? grounding.supportingEvidence.slice(0, 4).map((item) => item.markdownLink)
    : grounding.inspectedFiles.slice(0, 5).map((file) => {
        const summary = summariesByPath.get(file);
        return summary ? `${file} (${summary.slice(0, 80)})` : file;
      });
  return entries.length ? entries.join(", ") : "the sampled workspace files";
}

function simpleAnalogyForFoundInstead(foundInstead: string) {
  if (/todo|checklist/i.test(foundInstead)) {
    return "A todo app is like a checklist: you add jobs, mark them done, and keep track of what is left.";
  }
  if (/analytics|dashboard/i.test(foundInstead)) {
    return "Think of it like a scoreboard: it reads data and shows useful numbers.";
  }
  if (/frontend|app/i.test(foundInstead)) {
    return "Think of it like a screen with buttons and pages that people can use.";
  }
  return "Think of the project like a labeled box of parts; I can only describe the parts I can see.";
}

function simpleAnalogyForFoundInsteadArabic(foundInstead: string) {
  if (/todo|checklist/i.test(foundInstead)) {
    return "\u0627\u0644\u0640 todo app \u0632\u064a \u0642\u0627\u064a\u0645\u0629 \u0635\u063a\u064a\u0631\u0629: \u062a\u0632\u0648\u062f \u062d\u0627\u062c\u0627\u062a\u060c \u062a\u0639\u0644\u0645 \u0639\u0644\u064a\u0647\u0627 \u0644\u0645\u0627 \u062a\u062e\u0644\u0635\u060c \u0648\u062a\u0634\u0648\u0641 \u0641\u0627\u0636\u0644 \u0625\u064a\u0647.";
  }
  if (/analytics|dashboard/i.test(foundInstead)) {
    return "\u0627\u062a\u062e\u064a\u0644\u0647 \u0632\u064a \u0644\u0648\u062d\u0629 \u0646\u062a\u0627\u064a\u062c: \u0628\u062a\u0642\u0631\u0623 \u062f\u0627\u062a\u0627 \u0648\u062a\u0639\u0631\u0636 \u0623\u0631\u0642\u0627\u0645 \u0645\u0647\u0645\u0629.";
  }
  if (/frontend|app/i.test(foundInstead)) {
    return "\u0627\u062a\u062e\u064a\u0644\u0647 \u0634\u0627\u0634\u0629 \u0641\u064a\u0647\u0627 \u0623\u0632\u0631\u0627\u0631 \u0648\u0635\u0641\u062d\u0627\u062a \u0627\u0644\u0646\u0627\u0633 \u0628\u062a\u0633\u062a\u062e\u062f\u0645\u0647\u0627.";
  }
  return "\u0627\u062a\u062e\u064a\u0644 \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0635\u0646\u062f\u0648\u0642 \u0623\u062c\u0632\u0627\u0621\u060c \u0648\u0623\u0646\u0627 \u0647\u0627\u0634\u0631\u062d \u0628\u0633 \u0627\u0644\u0623\u062c\u0632\u0627\u0621 \u0627\u0644\u0644\u064a \u0634\u0627\u064a\u0641\u0647\u0627.";
}

function formatEvidenceGroupCoverage(coverage: ConceptEvidenceGroupCoverage[]) {
  return coverage
    .map((group) => `${group.id}: ${group.found ? `found (${group.refs.slice(0, 4).join(", ")})` : "missing"}`)
    .join(" | ");
}

function formatMissingEvidenceGroups(grounding: ProjectQuestionGrounding) {
  return grounding.evidenceGroupCoverage
    .filter((group) => !group.found)
    .map((group) => group.label)
    .join(", ");
}

function isDatasetRealtimeConcept(grounding: ProjectQuestionGrounding) {
  return grounding.concept.label === DATASET_REALTIME_CONCEPT_LABEL
    || grounding.concept.evidenceGroups?.some((group) => group.id === "dataset_source")
      && grounding.concept.evidenceGroups?.some((group) => group.id === "realtime_update");
}

export function isThresholdInventoryConcept(grounding: ProjectQuestionGrounding | RequestedConcept) {
  const concept = "concept" in grounding ? grounding.concept : grounding;
  return concept.label === THRESHOLD_INVENTORY_CONCEPT_LABEL
    || concept.evidenceGroups?.some((group) => group.id === "threshold_fact") === true;
}

export function isForecastingScopeConcept(grounding: ProjectQuestionGrounding | RequestedConcept) {
  const concept = "concept" in grounding ? grounding.concept : grounding;
  return concept.label === FORECASTING_SCOPE_CONCEPT_LABEL
    || concept.evidenceGroups?.some((group) => group.id === "forecasting_fact") === true;
}

function shortReason(item: GroundingEvidenceItem) {
  return sanitizeAnswerFragment(item.reason || item.title || item.snippet || "current-workspace evidence").replace(/\s+/g, " ").slice(0, 180);
}

function formatConceptLabel(concept: RequestedConcept) {
  return concept.displayLabel ?? concept.label;
}

type NumericEvidenceFact = {
  signal: string;
  value: string;
  comparison: string;
  action: string;
  link: string;
  path: string;
  raw: string;
  kind: "threshold" | "formula" | "weight" | "constant";
};

function createThresholdInventoryFallback(grounding: ProjectQuestionGrounding, validationErrors: string[]) {
  const facts = extractNumericEvidenceFacts(collectGroundingEvidenceForSynthesis(grounding));
  const formulaFacts = facts.filter((fact) => fact.kind === "formula").slice(0, 8);
  const thresholdFacts = facts.filter((fact) => fact.kind !== "formula").slice(0, 40);
  const orchestratorEvidence = findEvidenceByPath(grounding, /orchestrator|route|routes/i).slice(0, 4);
  const agentEvidence = findEvidenceByPath(grounding, /agents?/i).slice(0, 4);
  const arimaEvidence = findEvidenceByPath(grounding, /arima|forecast|trend/i).slice(0, 4);
  const arabic = grounding.language === "arabic";

  if (arabic) {
    const lines = [
      "\u0623\u064a\u0648\u0647\u060c \u062f\u064a \u0627\u0644\u0623\u0631\u0642\u0627\u0645 \u0648\u0627\u0644\u0634\u0631\u0648\u0637 \u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647\u0627 \u0641\u064a \u0627\u0644\u0643\u0648\u062f \u0627\u0644\u062d\u0627\u0644\u064a.",
      facts.length
        ? "\u0645\u0634 \u0647\u0642\u0648\u0644 \u0631\u0642\u0645 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f \u0641\u064a \u0627\u0644\u0645\u0644\u0641\u0627\u062a."
        : "\u0644\u0642\u064a\u062a \u0623\u062f\u0644\u0629 \u0642\u0631\u064a\u0628\u0629\u060c \u0628\u0633 \u0645\u0627\u0644\u0642\u064a\u062a\u0634 \u0623\u0631\u0642\u0627\u0645 \u0643\u0641\u0627\u064a\u0629 \u0623\u0637\u0644\u0639 \u0645\u0646\u0647\u0627 inventory \u0643\u0627\u0645\u0644.",
      ""
    ];
    if (orchestratorEvidence.length || agentEvidence.length) {
      lines.push("**\u0645\u064a\u0646 \u0628\u064a\u062d\u0633\u0645 \u0627\u0644\u0642\u0631\u0627\u0631\u061f**");
      if (orchestratorEvidence.length) {
        lines.push(`\u0627\u0644\u062f\u0644\u064a\u0644 \u0627\u0644\u0623\u0642\u0648\u0649 \u0639\u0644\u0649 \u0642\u0648\u0627\u0639\u062f \u0627\u0644\u0642\u0631\u0627\u0631 \u062c\u0627\u064a \u0645\u0646 ${formatEvidenceLinks(orchestratorEvidence)}.`);
      }
      if (agentEvidence.length) {
        lines.push(`\u0648\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0640 agents \u0628\u0627\u064a\u0646 \u0641\u064a\u0647\u0627 weights \u0623\u0648 branches \u0645\u0633\u0627\u0639\u062f\u0629 \u0645\u0646 ${formatEvidenceLinks(agentEvidence)}.`);
      }
      lines.push("");
    }
    if (thresholdFacts.length) {
      lines.push("**\u062c\u062f\u0648\u0644 \u0627\u0644\u0640 thresholds / \u0627\u0644\u0623\u0631\u0642\u0627\u0645**");
      lines.push("| Signal | \u0627\u0644\u0631\u0642\u0645 | \u0628\u064a\u062a\u0642\u0627\u0631\u0646 \u0625\u0632\u0627\u064a | \u0627\u0644\u0645\u0639\u0646\u0649/\u0627\u0644\u0623\u0643\u0634\u0646 | Evidence |");
      lines.push("| --- | ---: | --- | --- | --- |");
      for (const fact of thresholdFacts) {
        lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison)} | ${escapeTableCell(fact.action)} | ${fact.link} |`);
      }
      lines.push("");
    }
    if (formulaFacts.length) {
      lines.push("**\u0627\u0644\u0645\u0639\u0627\u062f\u0644\u0627\u062a \u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647\u0627**");
      for (const fact of formulaFacts) {
        lines.push(`- \`${fact.raw}\` (${fact.link})`);
      }
      lines.push("");
    }
    if (arimaEvidence.length) {
      lines.push(`**\u062c\u0632\u0621 forecasting/drift**: \u0641\u064a\u0647 \u0623\u062f\u0644\u0629 \u0645\u0631\u062a\u0628\u0637\u0629 \u0628\u0640 trend/forecast \u0641\u064a ${formatEvidenceLinks(arimaEvidence)}.`);
      lines.push("");
    }
    if (validationErrors.length) {
      lines.push("\u0644\u0648 \u0627\u0644\u0645\u0632\u0648\u062f \u0627\u062f\u0649 \u0631\u062f \u063a\u064a\u0631 \u0645\u062b\u0628\u062a\u060c \u0627\u0633\u062a\u062e\u062f\u0645\u062a \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0645\u062d\u0644\u064a\u0629 \u062f\u064a \u0628\u062f\u0644 \u0645\u0627 \u0623\u0639\u0631\u0636 \u0631\u062f \u0636\u0639\u064a\u0641.");
    }
    return lines.filter(Boolean).join("\n");
  }

  const lines = [
    "I found these threshold, formula, and numeric comparison facts in the current workspace.",
    facts.length ? "I am only listing values backed by file evidence." : "I found related evidence, but not enough numeric facts for a full inventory.",
    ""
  ];
  if (orchestratorEvidence.length || agentEvidence.length) {
    lines.push("**Decision Owner**");
    if (orchestratorEvidence.length) lines.push(`Decision rules appear in ${formatEvidenceLinks(orchestratorEvidence)}.`);
    if (agentEvidence.length) lines.push(`Agent weights or branches appear in ${formatEvidenceLinks(agentEvidence)}.`);
    lines.push("");
  }
  if (thresholdFacts.length) {
    lines.push("**Thresholds And Numeric Comparisons**");
    lines.push("| Signal | Value | Compared how | Result/action | Evidence |");
    lines.push("| --- | ---: | --- | --- | --- |");
    for (const fact of thresholdFacts) {
      lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison)} | ${escapeTableCell(fact.action)} | ${fact.link} |`);
    }
    lines.push("");
  }
  if (formulaFacts.length) {
    lines.push("**Formulas**");
    for (const fact of formulaFacts) lines.push(`- \`${fact.raw}\` (${fact.link})`);
  }
  return lines.join("\n");
}

function createForecastingScopeFallback(grounding: ProjectQuestionGrounding, validationErrors: string[]) {
  const items = collectGroundingEvidenceForSynthesis(grounding);
  const text = normalizeForGroundingSearch(items.map(evidenceItemContentText).join("\n"));
  const facts = extractNumericEvidenceFacts(items).filter((fact) => /forecast|arima|sarima|trend|delta|drift|deviation|multiplier|customer|series/i.test(`${fact.path} ${fact.raw} ${fact.signal}`)).slice(0, 12);
  const forecastEvidence = items.filter((item) => /\b(forecast|forecasting|arima|sarima|trend|prediction|delta|deviation)\b/i.test(evidenceItemContentText(item))).slice(0, 6);
  const type = text.includes("sarima")
    ? "SARIMA"
    : text.includes("arima")
      ? "ARIMA"
      : text.includes("forecast")
        ? "forecasting/trend logic"
        : "forecasting type not fully named";
  const perCustomer = /\b(customer_id|customer id|customer_history|per customer|customer_series|customer series|for customer)\b/i.test(items.map(evidenceItemContentText).join("\n"));
  const aggregate = /\b(global|aggregate|aggregated|all customers|overall|portfolio|cohort)\b/i.test(items.map(evidenceItemContentText).join("\n"));
  const scope = perCustomer && !aggregate
    ? "per-customer"
    : aggregate && !perCustomer
      ? "aggregate/global"
      : perCustomer && aggregate
        ? "mixed: it has customer-specific and aggregate signals"
        : "not proven from the current evidence";
  const arabic = grounding.language === "arabic";

  if (arabic) {
    const lines = [
      `\u0627\u0644\u0640 forecasting \u0627\u0644\u0644\u064a \u0628\u0627\u064a\u0646 \u0641\u064a \u0627\u0644\u0645\u0644\u0641\u0627\u062a: **${type}**.`,
      `\u0627\u0644\u0640 scope: **${scope}**.`,
      forecastEvidence.length
        ? `\u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0623\u0633\u0627\u0633\u064a\u0629: ${formatEvidenceLinks(forecastEvidence)}.`
        : "\u0645\u0641\u064a\u0634 \u0645\u0644\u0641 \u0648\u0627\u0636\u062d \u0643\u0641\u0627\u064a\u0629 \u064a\u062b\u0628\u062a \u0627\u0644\u0646\u0648\u0639.",
      ""
    ];
    if (facts.length) {
      lines.push("**\u0623\u0631\u0642\u0627\u0645/\u0634\u0631\u0648\u0637 \u0645\u0631\u062a\u0628\u0637\u0629 \u0628\u0627\u0644\u0640 forecasting**");
      lines.push("| Signal | \u0627\u0644\u0631\u0642\u0645 | \u0627\u0644\u0645\u0639\u0627\u062f\u0644\u0629/\u0627\u0644\u0634\u0631\u0637 | Evidence |");
      lines.push("| --- | ---: | --- | --- |");
      for (const fact of facts) {
        lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison || fact.raw)} | ${fact.link} |`);
      }
      lines.push("");
    }
    if (!perCustomer && !aggregate) {
      lines.push("\u0645\u0634 \u0647\u0623\u0643\u062f \u0625\u0646\u0647 \u0644\u0640 customer \u0648\u0627\u062d\u062f \u063a\u064a\u0631 \u0644\u0648 \u0627\u0644\u0643\u0648\u062f \u0642\u0627\u064a\u0644 \u0643\u062f\u0647 \u0628\u0648\u0636\u0648\u062d.");
    }
    if (validationErrors.length) {
      lines.push("\u0627\u0644\u0631\u062f \u062f\u0647 \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0627\u0644\u0623\u062f\u0644\u0629 \u0628\u062f\u0644 \u0631\u062f \u063a\u064a\u0631 \u0645\u062b\u0628\u062a.");
    }
    return lines.filter(Boolean).join("\n");
  }

  const lines = [
    `The forecasting type supported by current files is **${type}**.`,
    `The scope is **${scope}**.`,
    forecastEvidence.length ? `Main evidence: ${formatEvidenceLinks(forecastEvidence)}.` : "I did not find enough evidence to name the exact forecasting type.",
    ""
  ];
  if (facts.length) {
    lines.push("**Forecasting Facts**");
    lines.push("| Signal | Value | Condition/formula | Evidence |");
    lines.push("| --- | ---: | --- | --- |");
    for (const fact of facts) lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison || fact.raw)} | ${fact.link} |`);
  }
  return lines.join("\n");
}

function createArabicDatasetRealtimeFallback(grounding: ProjectQuestionGrounding, validationErrors: string[]) {
  const domain = grounding.projectDomain.confidence === "unknown" ? "" : grounding.projectDomain.label;
  const domainEvidence = grounding.projectDomain.evidence.slice(0, 3);
  const datasetEvidence = evidenceForGroup(grounding, "dataset_source").slice(0, 3);
  const realtimeEvidence = evidenceForGroup(grounding, "realtime_update").slice(0, 3);
  const processingEvidence = uniqueEvidenceItems([
    ...domainEvidence,
    ...grounding.understanding.dataFlowEvidence.filter((item) => /\b(sentiment|classifier|model|pipeline)\b/i.test(evidenceItemContentText(item)))
  ]).slice(0, 3);
  const lines = [
    "\u0641\u0647\u0645\u062a \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0645\u0646 \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0644\u064a \u0642\u062f\u0627\u0645\u064a.",
    ""
  ];
  if (domain) {
    lines.push(`\u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0638\u0627\u0647\u0631 \u0625\u0646\u0647 ${domain}.`);
  } else {
    lines.push("\u0645\u0634 \u0642\u0627\u062f\u0631 \u0623\u062b\u0628\u062a \u0627\u0633\u0645 \u0627\u0644\u062f\u0648\u0645\u064a\u0646 \u0628\u062b\u0642\u0629 \u0645\u0646 \u0627\u0644\u0645\u0644\u0641\u0627\u062a\u060c \u0641\u0647\u0634\u0631\u062d \u0627\u0644\u0644\u064a \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0645\u062b\u0628\u062a\u0627\u0647 \u0628\u0633.");
  }
  if (processingEvidence.length) {
    lines.push(`\u062c\u0632\u0621 \u0627\u0644\u0645\u0639\u0627\u0644\u062c\u0629/\u0627\u0644\u0645\u0648\u062f\u064a\u0644 \u0628\u0627\u064a\u0646 \u0641\u064a ${formatEvidenceLinks(processingEvidence)}.`);
  }
  if (datasetEvidence.length) {
    lines.push(`\u0645\u0635\u062f\u0631 \u0627\u0644\u062f\u0627\u062a\u0627 \u0623\u0648 \u0634\u0643\u0644 \u0627\u0644\u0631\u0633\u0627\u064a\u0644 \u0628\u0627\u064a\u0646 \u0641\u064a ${formatEvidenceLinks(datasetEvidence)}.`);
  }
  if (realtimeEvidence.length) {
    lines.push(`\u062c\u0632\u0621 \u0627\u0644\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u0644\u064a \u0628\u064a\u062e\u0644\u064a\u0647\u0627 \u062a\u0628\u0627\u0646 realtime \u0628\u0627\u064a\u0646 \u0641\u064a ${formatEvidenceLinks(realtimeEvidence)}.`);
    lines.push(realtimeModeSentence(realtimeEvidence));
  }
  lines.push("");
  lines.push("\u0628\u0628\u0633\u0627\u0637\u0629: \u0627\u0644\u062f\u0627\u062a\u0627 \u0628\u062a\u062f\u062e\u0644\u060c \u0628\u062a\u062a\u062c\u0647\u0632\u060c \u0648\u0628\u062a\u0639\u062f\u064a \u0639\u0644\u0649 \u062c\u0632\u0621 \u0627\u0644\u062a\u062d\u0644\u064a\u0644. \u0628\u0639\u062f \u0643\u062f\u0647 \u0627\u0644\u0634\u0627\u0634\u0629 \u0623\u0648 \u0627\u0644\u0640 API \u0628\u064a\u0639\u0631\u0636\u0648\u0627 \u0646\u062a\u064a\u062c\u0629 \u0645\u062d\u062f\u062b\u0629 \u062d\u0633\u0628 \u0627\u0644\u0644\u064a \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0645\u062b\u0628\u062a\u0627\u0647.");
  if (validationErrors.length) {
    lines.push("");
    lines.push("\u0627\u0644\u0631\u062f \u0647\u0646\u0627 \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0645\u062d\u0644\u064a\u0629 \u0628\u062f\u0644 \u0623\u064a \u062a\u062e\u0645\u064a\u0646.");
  }
  lines.push("");
  lines.push("\u0645\u0634 \u0647\u0632\u0648\u062f \u0642\u0635\u0629 \u0639\u0627\u0645\u0629 \u0639\u0646 dataset \u0623\u0648 realtime \u063a\u064a\u0631 \u0627\u0644\u0644\u064a \u0638\u0627\u0647\u0631 \u0641\u064a \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u062f\u064a.");
  return lines.join("\n");
}

function evidenceForGroup(grounding: ProjectQuestionGrounding, groupId: string) {
  const refs = new Set(grounding.evidenceGroupCoverage.find((group) => group.id === groupId)?.refs ?? []);
  return grounding.supportingEvidence.filter((item) => refs.has(item.ref));
}

function collectGroundingEvidenceForSynthesis(grounding: ProjectQuestionGrounding) {
  return uniqueEvidenceItems([
    ...grounding.supportingEvidence,
    ...grounding.projectDomain.evidence,
    ...grounding.understanding.sourceEvidence,
    ...grounding.understanding.dataFlowEvidence,
    ...grounding.understanding.validationEvidence
  ]).slice(0, 40);
}

function findEvidenceByPath(grounding: ProjectQuestionGrounding, pattern: RegExp) {
  return collectGroundingEvidenceForSynthesis(grounding).filter((item) => pattern.test(item.path));
}

function extractNumericEvidenceFacts(items: GroundingEvidenceItem[]) {
  const facts: NumericEvidenceFact[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const lines = (item.snippet || item.reason || item.title || "").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.length > 260) continue;
      const fact = parseNumericFactLine(line, item);
      if (!fact) continue;
      const key = `${fact.path}:${fact.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
      if (facts.length >= 60) return facts;
    }
  }
  return facts.sort((left, right) => scoreNumericFact(right) - scoreNumericFact(left) || left.path.localeCompare(right.path));
}

function parseNumericFactLine(line: string, item: GroundingEvidenceItem): NumericEvidenceFact | undefined {
  const normalizedLine = line.replace(/\s+/g, " ");
  if (!/[<>]=?|==|=|:/.test(normalizedLine)) return undefined;
  if (!/-?\d+(?:\.\d+)?/.test(normalizedLine)) return undefined;
  const searchableLine = normalizedLine.replace(/[_\.]+/g, " ");
  const relevant = /\b(threshold|threshlod|cutoff|floor|min|max|minimum|maximum|borderline|direct|dispatch|high|low|score|weight|gap|cosine|membership|severity|trend|drift|accepted|f1|accuracy|delta|deviation|multiplier|forecast|arima|sarima|if|elif|return|class|baseline|movement|centroid)\b/i.test(searchableLine)
    || /[<>]=?|==/.test(normalizedLine);
  if (!relevant) return undefined;

  const comparison = normalizedLine.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*(<=|>=|<|>|==)\s*(-?\d+(?:\.\d+)?)/)
    ?? normalizedLine.match(/(-?\d+(?:\.\d+)?)\s*(<=|>=|<|>|==)\s*([A-Za-z_][A-Za-z0-9_\.]*)/);
  if (comparison) {
    const reverse = /^-?\d/.test(comparison[1] ?? "");
    const signal = reverse ? comparison[3] ?? "value" : comparison[1] ?? "value";
    const operator = comparison[2] ?? "";
    const value = reverse ? comparison[1] ?? "" : comparison[3] ?? "";
    return {
      signal: humanizeSignal(signal),
      value,
      comparison: reverse ? `${value} ${operator} ${signal}` : `${signal} ${operator} ${value}`,
      action: inferActionFromLine(normalizedLine),
      link: item.markdownLink,
      path: item.path,
      raw: normalizedLine,
      kind: "threshold"
    };
  }

  const assignment = normalizedLine.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*(-?\d+(?:\.\d+)?)/)
    ?? normalizedLine.match(/["']?([A-Za-z_][A-Za-z0-9_ -]+)["']?\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (assignment) {
    const signal = assignment[1] ?? "value";
    const value = assignment[2] ?? "";
    return {
      signal: humanizeSignal(signal),
      value,
      comparison: normalizedLine.includes(":") ? `${signal}: ${value}` : `${signal} = ${value}`,
      action: inferActionFromLine(normalizedLine),
      link: item.markdownLink,
      path: item.path,
      raw: normalizedLine,
      kind: /\b(weight|weights)\b/i.test(`${signal} ${item.path}`) ? "weight" : "constant"
    };
  }

  const formula = normalizedLine.match(/([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*(.+)/);
  if (formula && /[+\-*/()]|\bmax\b|\bmin\b|\*\*/.test(formula[2] ?? "")) {
    const numbers = normalizedLine.match(/-?\d+(?:\.\d+)?/g) ?? [];
    return {
      signal: humanizeSignal(formula[1] ?? "formula"),
      value: numbers.join(", ") || "formula",
      comparison: normalizedLine,
      action: "formula",
      link: item.markdownLink,
      path: item.path,
      raw: normalizedLine,
      kind: "formula"
    };
  }
  return undefined;
}

function scoreNumericFact(fact: NumericEvidenceFact) {
  let score = 0;
  if (/orchestrator|route|routes|agents|arima|forecast|model|services/i.test(fact.path)) score += 80;
  if (fact.kind === "formula") score += 45;
  if (fact.kind === "threshold") score += 40;
  if (fact.kind === "weight") score += 30;
  if (/\b(score|gap|cosine|membership|trend|drift|delta|f1|severity|direct|minimum|borderline)\b/i.test(`${fact.signal} ${fact.raw}`)) score += 30;
  if (/package\.json|index\.html/i.test(fact.path)) score -= 60;
  return score;
}

function inferActionFromLine(line: string) {
  const returned = line.match(/\breturn\s+["']?([^"',})\]]+)/i)?.[1]?.trim();
  if (returned) return `return ${returned}`;
  if (/\bhuman review\b/i.test(line)) return "Human Review";
  if (/\bre-cluster|recluster\b/i.test(line)) return "Re-cluster";
  if (/\bdirect dispatch\b/i.test(line)) return "Direct Dispatch";
  if (/\bstrong offer\b/i.test(line)) return "Strong Offer";
  if (/\boffer\b/i.test(line)) return "Offer";
  if (/\bdo nothing\b/i.test(line)) return "Do Nothing";
  if (/\baccepted\b/i.test(line)) return "accept/reject guardrail";
  if (/\btrend_multiplier\b/i.test(line)) return "trend multiplier";
  if (/^\s*(if|elif|else if)\b/i.test(line)) return "condition branch";
  return "stored numeric value";
}

function humanizeSignal(value: string) {
  return value.replace(/^self\./, "").replace(/[_\.]+/g, " ").trim() || "value";
}

function escapeTableCell(value: string) {
  return sanitizeAnswerFragment(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 180);
}

function realtimeModeSentence(items: GroundingEvidenceItem[]) {
  const text = items.map(evidenceItemContentText).join("\n");
  if (/\b(setInterval|poll|polling|refresh|fetch)\b/i.test(text)) {
    return "\u0627\u0644\u0623\u062f\u0644\u0629 \u0647\u0646\u0627 \u0628\u062a\u0642\u0648\u0644 polling/refresh. \u064a\u0639\u0646\u064a \u0627\u0644\u0634\u0627\u0634\u0629 \u0628\u062a\u0637\u0644\u0628 \u062a\u062d\u062f\u064a\u062b \u0643\u0644 \u0634\u0648\u064a\u0629\u060c \u0645\u0634 socket \u062d\u0642\u064a\u0642\u064a \u0645\u062b\u0628\u062a.";
  }
  if (/\b(socket|websocket)\b/i.test(text)) {
    return "\u0627\u0644\u0623\u062f\u0644\u0629 \u0647\u0646\u0627 \u0628\u062a\u062b\u0628\u062a socket/websocket\u060c \u0641\u062f\u0647 \u0623\u0642\u0631\u0628 \u0644\u0640 realtime \u062d\u0642\u064a\u0642\u064a.";
  }
  if (/\b(stream|ingest|consumer|producer)\b/i.test(text)) {
    return "\u0627\u0644\u0623\u062f\u0644\u0629 \u062a\u062b\u0628\u062a ingestion/stream \u0641\u064a \u0627\u0644\u062f\u0627\u062a\u0627. \u0644\u0648 \u0645\u0641\u064a\u0634 socket \u0623\u0648 polling \u0648\u0627\u0636\u062d\u060c \u0647\u0642\u0648\u0644 \u0625\u0646 realtime \u0627\u0644\u062d\u0642\u064a\u0642\u064a \u0645\u0634 \u0645\u0624\u0643\u062f.";
  }
  return "\u0627\u0644\u0623\u062f\u0644\u0629 \u062a\u062b\u0628\u062a \u062a\u062d\u062f\u064a\u062b \u0642\u0631\u064a\u0628 \u0645\u0646 realtime\u060c \u0628\u0633 \u0646\u0648\u0639\u0647 \u0628\u0627\u0644\u0636\u0628\u0637 \u0645\u0634 \u0645\u0624\u0643\u062f \u0645\u0646 \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u062f\u064a.";
}

function formatEvidenceLinks(items: GroundingEvidenceItem[]) {
  return uniqueEvidenceItems(items).map((item) => item.markdownLink).join(", ");
}

function isSourceEvidencePath(filePath: string) {
  return SOURCE_FILE_RE.test(filePath);
}

function isDocEvidencePath(filePath: string) {
  return /\.md$/i.test(filePath) || /(^|\/)(README|docs\/)/i.test(filePath);
}

function isManifestEvidencePath(filePath: string) {
  return /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|pom\.xml|build\.gradle|tsconfig\.json)$/i.test(filePath);
}

function uniqueEvidenceItems(items: GroundingEvidenceItem[]) {
  const byRef = new Map<string, GroundingEvidenceItem>();
  for (const item of items) {
    if (!byRef.has(item.ref)) byRef.set(item.ref, item);
  }
  return [...byRef.values()];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeAnswerFragment(value: string) {
  return /(?:ط§ظ|ظپظ|ط¨ط|ظ…ط|ط§ط|ظ„ظ)/.test(value)
    ? "current-workspace evidence"
    : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
