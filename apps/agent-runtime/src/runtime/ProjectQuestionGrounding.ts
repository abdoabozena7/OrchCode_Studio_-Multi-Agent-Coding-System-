import type { ProjectExplainReport } from "@hivo/protocol";

import {
  analyzeWorkspaceReasoning,
  createEvidenceBasedAnswerFallback,
  type WorkspaceReasoning
} from "./WorkspaceReasoningPipeline.js";
import { resolveInvestigationConcept } from "./ProjectIntelligenceKernel.js";

export type ProjectAnswerStyle = "child_simple" | "technical" | "concise" | "detailed" | "default";
export type ProjectAnswerShape = "inventory_table" | "concise_explanation" | "detailed_walkthrough";
export type ProjectQuestionKind =
  | "threshold_inventory"
  | "forecasting_scope"
  | "dataset_realtime"
  | "page_inventory"
  | "decision_policy"
  | "general_project";

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
  answerShape: ProjectAnswerShape;
  questionKind: ProjectQuestionKind;
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
  workspaceReasoning: WorkspaceReasoning;
};

const QUESTION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "code", "codebase", "current",
  "describe", "do", "does", "explain", "for", "from", "give", "happen", "here",
  "how", "i", "in", "is", "it", "me", "of", "please", "project", "selected",
  "show", "system", "tell", "that", "the", "this", "to", "walk", "what", "where",
  "why", "with", "work", "works", "workspace", "you",
  "chain", "flow", "path", "stage", "stages", "step", "steps",
  "اشرح", "اشرحلي", "شرح", "المشروع", "مشروع", "ده", "دا", "دي", "ازاي", "إزاي", "كيف", "ايه",
  "إيه", "من", "في", "هنا", "على", "هو", "هي", "بيقدر", "يقدر", "يجيب", "كأنها", "كانها", "prompt",
  "اشرح", "شرح", "المشروع", "مشروع", "ده", "دا", "دي", "ازاي", "كيف", "ايه",
  "إيه", "من", "في", "على", "هو", "هي",
  "ط§ط´ط±ط­", "ط´ط±ط­", "ط§ظ„ظ…ط´ط±ظˆط¹", "ظ…ط´ط±ظˆط¹", "ط¯ط§", "ط¯ظ‡",
  "ط¯ظٹ", "ط§ط²ط§ظٹ", "ظƒظٹظپ", "ط§ظٹظ‡", "ط¥ظٹظ‡", "ظ…ظ†", "ظپظٹ",
  "ط¹ظ„ظ‰", "ظ‡ظˆ", "ظ‡ظٹ"
]);

const STYLE_STOP_WORDS = new Set([
  "basic", "brief", "child", "children", "concise", "detailed", "eli5", "jargon",
  "kid", "kids", "simple", "simply", "technical", "tiny",
  "طفل", "اطفال", "أطفال", "يفهم", "يفهمها", "يقدر", "بيقدر", "ببساطة", "بسيط", "بسيطة",
  "مبسط", "مبسطة", "للمبتدئ", "مبتدئ", "مبتدئين",
  "طفل", "اطفال", "أطفال", "يفهم", "يفهمها", "يقدر", "بيقدر", "ببساطة",
  "بسيط", "بسيطة", "مبسط", "مبسطة", "للمبتدئ", "مبتدئ", "مبتدئين"
]);

const GENERIC_CONCEPT_WORDS = new Set([
  "analysis", "architecture", "chain", "feature", "flow", "module", "overview", "path", "pipeline",
  "process", "stage", "stages", "step", "steps", "system"
]);

const EXTRA_ARABIC_QUESTION_STOP_WORDS = new Set([
  "اشرح", "اشرحلي", "المشروع", "مشروع", "دا", "ده", "دي", "ازاي", "كيف", "ايه",
  "إيه", "من", "في", "هنا", "على", "هو", "هي", "بيقدر", "يقدر", "يجيب",
  "كانها", "كأنها", "prompt"
]);

const EXTRA_ARABIC_STYLE_STOP_WORDS = new Set([
  "طفل", "اطفال", "أطفال", "يفهم", "يفهمها", "يقدر", "بيقدر", "ببساطة",
  "بسيط", "بسيطة", "مبسط", "مبسطة", "للمبتدئ", "مبتدئ", "مبتدئين"
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
  "داتا", "الداتا", "داتا سيت", "الداتا سيت", "بيانات", "البيانات",
  "داتا", "الداتا", "داتا سيت", "الداتا سيت", "بيانات", "البيانات"
];

const REALTIME_UPDATE_ALIASES = [
  "realtime", "real time", "real-time", "near realtime", "near real time", "polling",
  "refresh", "repeated refresh", "update loop", "setinterval", "set interval", "stream",
  "socket", "websocket", "timer", "interval",
  "تحديث", "تحديث متكرر", "لحظي", "كأنها realtime", "كانها realtime",
  "تحديث", "تحديث متكرر", "لحظي", "كأنها realtime", "كانها realtime"
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
  coreTerms: ["dataset", "data", "records", "csv", "داتا", "بيانات"]
};

const REALTIME_UPDATE_GROUP: RequestedConceptEvidenceGroup = {
  id: "realtime_update",
  label: "realtime/update behavior",
  aliases: REALTIME_UPDATE_ALIASES,
  coreTerms: ["realtime", "polling", "refresh", "setinterval", "stream", "socket", "تحديث", "لحظي"]
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
  "aggregated", "global", "scope", "series", "cluster", "clusters", "segment",
  "segments", "cluster-level", "per-cluster", "cluster_forecasts", "cluster_series",
  "fit_cluster_models", "get_cluster_state", "predicted_cluster", "train_offline_artifacts",
  "retrain", "retraining", "auto_retrain",
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
  coreTerms: ["forecast", "forecasting", "arima", "sarima", "trend", "customer", "cluster", "\u0639\u0645\u064a\u0644"]
};

const DECISION_POLICY_ALIASES = [
  "decision", "decide", "decides", "route", "rules", "rule", "policy", "orchestrator",
  "choose_route", "selected_action_name", "recommended_action_name", "agent_recommendations",
  "agent_consensus", "weighted_votes", "weighted_winner", "dispatch", "review", "offer",
  "strong offer", "retention offer", "re-cluster", "recluster", "re cluster", "cluster drift",
  "drift detection", "drift_detected", "membership", "membership_strength", "fcm membership",
  "\u064a\u0642\u0631\u0631", "\u064a\u0628\u0639\u062a", "\u0642\u0648\u0627\u0639\u062f", "\u0642\u0631\u0627\u0631",
  "\u0628\u062f\u0644", "\u0634\u0631\u0648\u0637", "\u0627\u0644\u0642\u0631\u0627\u0631"
];

const DECISION_POLICY_GROUP: RequestedConceptEvidenceGroup = {
  id: "decision_policy",
  label: "decision policy/routing evidence",
  aliases: DECISION_POLICY_ALIASES,
  coreTerms: ["decision", "orchestrator", "rule", "offer", "re-cluster", "drift", "membership", "\u064a\u0642\u0631\u0631"]
};

const PAGE_STRUCTURE_ALIASES = [
  "page", "pages", "screen", "screens", "view", "views", "route", "routes", "router",
  "navigation", "nav", "sidebar", "menu", "tab", "tabs", "section", "sections",
  "chapter", "chapters", "CHAPTERS", "PAGES", "ROUTES", "VIEWS", "TABS",
  "\u0635\u0641\u062d\u0629", "\u0635\u0641\u062d\u0647", "\u0635\u0641\u062d\u0627\u062a",
  "\u0634\u0627\u0634\u0629", "\u0634\u0627\u0634\u0647", "\u0634\u0627\u0634\u0627\u062a",
  "\u0648\u0627\u062c\u0647\u0629", "\u0648\u0627\u062c\u0647\u0627\u062a"
];

const PAGE_STRUCTURE_GROUP: RequestedConceptEvidenceGroup = {
  id: "page_structure",
  label: "page/screen/route evidence",
  aliases: PAGE_STRUCTURE_ALIASES,
  coreTerms: ["page", "screen", "view", "route", "section", "\u0635\u0641\u062d\u0629", "\u0634\u0627\u0634\u0629"]
};

const ALGORITHM_MODEL_ALIASES = [
  "algorithm", "algorithms", "algo", "model", "models", "classifier", "classifiers",
  "classification", "regression", "cluster", "clustering", "forecast", "forecasting",
  "arima", "sarima", "svm", "svc", "kmeans", "k-means", "randomforest",
  "logisticregression", "isolationforest", "shap", "fuzzy", "cmeans", "fit",
  "predict", "fit_predict", "transform", "train", "training", "sklearn", "scikit",
  "statsmodels", "scipy", "\u0627\u0644\u062c\u0648\u0631\u064a\u062b\u0645",
  "\u0627\u0644\u062c\u0648\u0631\u064a\u0632\u0645", "\u0627\u0644\u062c\u0648\u0631\u064a\u062a\u0645",
  "\u062e\u0648\u0627\u0631\u0632\u0645\u064a\u0629", "\u062e\u0648\u0627\u0631\u0632\u0645\u064a\u0627\u062a",
  "\u0645\u0648\u062f\u064a\u0644", "\u0645\u0648\u062f\u064a\u0644\u0627\u062a"
];

const ALGORITHM_MODEL_GROUP: RequestedConceptEvidenceGroup = {
  id: "algorithms_models",
  label: "algorithm/model evidence",
  aliases: ALGORITHM_MODEL_ALIASES,
  coreTerms: ["algorithm", "model", "classifier", "cluster", "forecast", "fit", "predict", "\u062e\u0648\u0627\u0631\u0632\u0645\u064a\u0629"]
};
const PAGE_STRUCTURE_SOURCE_EXT_RE = /\.(html|jsx|tsx|js|ts|mjs)$/i;
const PAGE_STYLESHEET_EXT_RE = /\.(css|scss|sass|less)$/i;
const PAGE_STRUCTURE_CONTENT_RE = /\b(BrowserRouter|createBrowserRouter|Routes|Route|router|path\s*:|href=|data-view|data-page|CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b|<\s*(nav|section|aside|main|a|button)\b/i;
const STRONG_PAGE_STRUCTURE_CONTENT_RE = PAGE_STRUCTURE_CONTENT_RE;
const GENERATED_PAGE_ANCHOR_RE = /\b(Requested concept evidence|Requested concept match|screen inventory|page\/screen inventory)\b/i;

const DATASET_REALTIME_CONCEPT_LABEL = "dataset realtime behavior";
const DATASET_REALTIME_DISPLAY_LABEL = "dataset realtime behavior / الداتا من الداتا سيت كأنها realtime";
const THRESHOLD_INVENTORY_CONCEPT_LABEL = "threshold inventory";
const FORECASTING_SCOPE_CONCEPT_LABEL = "forecasting type and scope";
const PAGE_INVENTORY_CONCEPT_LABEL = "page/screen inventory";
const ARABIC_CHILD_SIMPLE_PATTERN = /(?:اشرح.*ل\s*طفل|طفل.*يفهم|ل\s*طفل|للطفل|ببساطة|بشكل\s+مبسط|مبسط|مبسطة|للمبتدئ|مبتدئ)/;

const DOMAIN_CLAIM_ALIASES: Record<string, string[]> = {
  "analytics": ["analytics", "analysis", "dashboard", "metrics"],
  "auth": ["auth", "authentication", "authorization", "login", "signin", "sign in", "oauth"],
  "cart": ["cart", "basket"],
  "checkout": ["checkout"],
  "dataset": DATASET_SOURCE_ALIASES,
  "e-commerce": ["e-commerce", "ecommerce", "shopping", "shop", "storefront", "commerce"],
  "payment": ["payment", "payments", "billing", "stripe", "invoice"],
  "realtime": REALTIME_UPDATE_ALIASES,
  "sentiment": ["sentiment", "sentiment analysis", "sentement", "sentement analysis", "classify sentiment", "analyze sentiment", "sentiment classifier", "sentiment pipeline", "sentiment model", "تحليل المشاعر", "تحليل مشاعر", "المشاعر", "مشاعر", "emotion", "emotions"],
  "thresholds": THRESHOLD_FACT_ALIASES,
  "forecasting": FORECASTING_ALIASES,
  "algorithms": ALGORITHM_MODEL_ALIASES,
  "pages": PAGE_STRUCTURE_ALIASES,
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
    displayLabel: "sentiment analysis / تحليل المشاعر",
    aliases: DOMAIN_CLAIM_ALIASES.sentiment ?? [],
    coreTerms: ["sentiment", "sentement", "مشاعر"]
  },
  {
    key: "dataset",
    label: "dataset/data source",
    displayLabel: "dataset/data source / الداتا من الداتا سيت",
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
  },
  {
    key: "algorithms",
    label: "algorithms/models inventory",
    displayLabel: "algorithms/models inventory / \u0627\u0644\u062e\u0648\u0627\u0631\u0632\u0645\u064a\u0627\u062a \u0648\u0627\u0644\u0645\u0648\u062f\u064a\u0644\u0627\u062a",
    aliases: ALGORITHM_MODEL_ALIASES,
    coreTerms: ALGORITHM_MODEL_GROUP.coreTerms,
    evidenceGroups: [ALGORITHM_MODEL_GROUP]
  }
];

export function detectProjectAnswerStyle(userPrompt: string): ProjectAnswerStyle {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const rawPrompt = userPrompt.toLowerCase();
  if (/(?:\u0627\u0634\u0631\u062d.*\u0644\s*\u0637\u0641\u0644|\u0637\u0641\u0644.*\u064a\u0641\u0647\u0645|\u0644\s*\u0637\u0641\u0644|\u0644\u0644\u0637\u0641\u0644|\u0628\u0628\u0633\u0627\u0637\u0629|\u0628\u0634\u0643\u0644\s+\u0645\u0628\u0633\u0637|\u0645\u0628\u0633\u0637|\u0645\u0628\u0633\u0637\u0629|\u0644\u0644\u0645\u0628\u062a\u062f\u0626|\u0645\u0628\u062a\u062f\u0626)/.test(rawPrompt)) return "child_simple";
  if (/\b(eli5|child|kid|kids|five year old|simple|simply)\b/.test(normalized)) return "child_simple";
  if (ARABIC_CHILD_SIMPLE_PATTERN.test(normalized)) return "child_simple";
  if (/(اشرح.*ل\s*طفل|طفل.*يفهم|ل\s*طفل|للطفل|ببساطة|بشكل\s+مبسط|مبسط|مبسطة|للمبتدئ|مبتدئ)/.test(normalized)) return "child_simple";
  if (/(اشرح.*لطفل|طفل.*يفهم|لطفل|للطفل|ببساطة|بشكل مبسط|مبسط|مبسطة|للمبتدئ|مبتدئ)/.test(normalized)) return "child_simple";
  if (/\b(technical|architecture|internals|code level|deep dive)\b/.test(normalized)) return "technical";
  if (/\b(concise|brief|short|quick)\b/.test(normalized)) return "concise";
  if (/(مختصر|باختصار)/.test(normalized)) return "concise";
  if (/\b(detailed|thorough|step by step|full)\b/.test(normalized)) return "detailed";
  if (/(?:\u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644|\u062e\u0637\u0648\u0629\s+\u0628\u062e\u0637\u0648\u0629|\u0628\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644)/.test(rawPrompt)) return "detailed";
  if (/(بالتفصيل|خطوة بخطوة)/.test(normalized)) return "detailed";
  return "default";
}

export function detectProjectAnswerShape(userPrompt: string): ProjectAnswerShape {
  if (detectPageInventoryConcept(userPrompt)) return "concise_explanation";
  const normalized = normalizeForGroundingSearch(userPrompt);
  const rawPrompt = userPrompt.toLowerCase();
  const asksForInventory =
    /\b(all|every|list|inventory|table|values?|numbers?|thresholds?|formulas?|comparisons?|cutoffs?|conditions?)\b/.test(normalized)
    || /(?:\u0643\u0644|\u0647\u0627\u062a\u0644\u064a|\u062c\u062f\u0648\u0644|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644\u0627\u062a|\u0628\u0642\u0627\u0631\u0646|\u0628\u064a\u0642\u0627\u0631\u0646|\u0643\u0627\u0645)/.test(rawPrompt);
  const asksForNumericSweep =
    /\b(threshold|thresholds|threshlod|threshlods|score|weight|compare|comparison|formula|formulas|condition|conditions)\b/.test(normalized)
    || /(?:threshold|threshlod|\u0639\u062a\u0628\u0629|\u0628\u0642\u0627\u0631\u0646|\u0628\u064a\u0642\u0627\u0631\u0646|\u0645\u0639\u0627\u062f\u0644\u0629|\u0645\u0639\u0627\u062f\u0644\u0627\u062a)|(?:^|\s)\u062d\u062f(?:\s|$)/.test(rawPrompt);
  if (asksForInventory && asksForNumericSweep) return "inventory_table";
  if (/\b(detailed|thorough|step by step|walkthrough|full flow|architecture|deep dive)\b/.test(normalized)
    || /(?:\u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644|\u062e\u0637\u0648\u0629|\u0643\u0644\s+\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644|\u0641\u0644\u0648|\u0627\u0644\u0641\u0644\u0648)/.test(rawPrompt)) {
    return "detailed_walkthrough";
  }
  return "concise_explanation";
}

export function extractRequestedConcept(userPrompt: string): RequestedConcept {
  const styleStripped = stripStylePhrases(userPrompt);
  if (isStructuralFileContextQuestion(styleStripped) || isStructuralFileContextQuestion(userPrompt)) {
    return { specific: false, label: "this project", terms: [], coreTerms: [], aliases: [], confidence: "unknown" };
  }
  const pageInventory = detectPageInventoryConcept(styleStripped) ?? detectPageInventoryConcept(userPrompt);
  if (pageInventory) return pageInventory;
  const decisionPolicy = detectDecisionPolicyConcept(styleStripped) ?? detectDecisionPolicyConcept(userPrompt);
  if (decisionPolicy) return decisionPolicy;
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
  const investigationConcept = conceptFromInvestigationResolution(styleStripped) ?? conceptFromInvestigationResolution(userPrompt);
  if (investigationConcept) return investigationConcept;
  if (looksLikeRelationshipExplorationQuestion(styleStripped)) {
    return { specific: false, label: "this project", terms: [], coreTerms: [], aliases: [], confidence: "unknown" };
  }
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

function isStructuralFileContextQuestion(userPrompt: string) {
  return isEntrypointInventoryQuestion(userPrompt) || isSourceFlowFileQuestion(userPrompt) || /\b(?:tech|technology)\s+stack\b/i.test(userPrompt);
}

function isEntrypointInventoryQuestion(userPrompt: string) {
  const normalized = normalizeForGroundingSearch(userPrompt);
  return /\b(?:main\s+)?entry\s*points?\b|\bentrypoints?\b|\bentry\s+files?\b/.test(normalized)
    || /\bwhat\s+are\s+the\s+main\s+files\b/.test(normalized)
    || /\buse\s+the\s+detected\s+candidates\b/.test(normalized) && /\bmain\b|\bentry\b|\bbackend\/main\b|\bapp\.(?:js|ts|tsx|jsx)\b/.test(normalized);
}

function isSourceFlowFileQuestion(userPrompt: string) {
  const normalized = normalizeForGroundingSearch(userPrompt);
  return /\bdetected\s+source\s+files\b/.test(normalized) && /\bconnect\b/.test(normalized) && /\bflow\b/.test(normalized)
    || /\bbackend\b/.test(normalized) && /\bfrontend\b/.test(normalized) && /\b(connect|wire|flow|source\s+files)\b/.test(normalized)
    || /\buse\s+only\s+project\s+files\s+such\s+as\b/.test(normalized) && /\b(connect|flow|backend|frontend)\b/.test(normalized);
}

function conceptFromInvestigationResolution(userPrompt: string): RequestedConcept | undefined {
  const resolved = resolveInvestigationConcept(userPrompt);
  if (!resolved.isTargeted || resolved.targetConcept === "general") return undefined;
  const normalizedTarget = normalizeForGroundingSearch(resolved.targetConcept);
  if (isQuestionStopWord(normalizedTarget) || GENERIC_CONCEPT_WORDS.has(normalizedTarget)) return undefined;
  return {
    specific: true,
    label: resolved.targetConcept,
    displayLabel: resolved.resolvedName ?? resolved.inferredPatternName ?? resolved.requestedConceptText,
    terms: uniqueStrings([
      resolved.targetConcept,
      resolved.requestedConceptText,
      ...(resolved.resolvedName ? [resolved.resolvedName] : []),
      ...(resolved.inferredPatternName ? [resolved.inferredPatternName] : []),
      ...resolved.literalTerms,
      ...resolved.aliasTerms,
      ...resolved.behavioralTerms,
      ...resolved.architecturalTerms
    ]),
    coreTerms: uniqueStrings([
      resolved.targetConcept,
      resolved.requestedConceptText,
      ...resolved.literalTerms,
      ...resolved.aliasTerms.slice(0, 8)
    ]),
    aliases: uniqueStrings([
      resolved.requestedConceptText,
      ...(resolved.resolvedName ? [resolved.resolvedName] : []),
      ...(resolved.inferredPatternName ? [resolved.inferredPatternName] : []),
      ...resolved.aliasTerms,
      ...resolved.behavioralTerms,
      ...resolved.architecturalTerms
    ]),
    confidence: resolved.confidence
  };
}

function looksLikeRelationshipExplorationQuestion(userPrompt: string) {
  const normalized = normalizeForGroundingSearch(userPrompt);
  return /\b(chain|flow|path|pipeline|stage|stages|step|steps|from|into|through|between|connect|link|follow|trace|relationship|handoff)\b/i.test(normalized)
    || /\bwhat does each stage prove\b/i.test(userPrompt);
}

export function detectProjectQuestionKind(userPrompt: string): ProjectQuestionKind {
  const concept = extractRequestedConcept(userPrompt);
  if (isPageInventoryConcept(concept)) return "page_inventory";
  if (isDecisionPolicyConcept(concept)) return "decision_policy";
  if (isThresholdInventoryConcept(concept)) return "threshold_inventory";
  if (isForecastingScopeConcept(concept)) return "forecasting_scope";
  if (concept.label === DATASET_REALTIME_CONCEPT_LABEL
    || concept.evidenceGroups?.some((group) => group.id === "dataset_source")
      && concept.evidenceGroups?.some((group) => group.id === "realtime_update")) {
    return "dataset_realtime";
  }
  return "general_project";
}

export function analyzeProjectQuestionGrounding(
  userPrompt: string,
  report: ProjectExplainReport,
  evidenceItems: GroundingEvidenceItem[]
): ProjectQuestionGrounding {
  const language = /[\u0600-\u06ff]/.test(userPrompt) ? "arabic" : "english";
  const style = detectProjectAnswerStyle(userPrompt);
  const answerShape = detectProjectAnswerShape(userPrompt);
  const concept = extractRequestedConcept(userPrompt);
  const questionKind = detectProjectQuestionKind(userPrompt);
  const projectContextRequired = detectProjectContextRequired(userPrompt);
  const projectDomain = inferProjectDomain(report, evidenceItems);
  const understanding = createProjectUnderstanding(report, evidenceItems, projectContextRequired, projectDomain);
  const workspaceReasoning = analyzeWorkspaceReasoning({ userPrompt, report, evidenceItems, actionModeHint: "answer_only" });
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
    answerShape,
    questionKind,
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
    unknowns: createGroundingUnknowns(report, concept, conceptFound, evidenceGroupCoverage),
    workspaceReasoning
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
    return "Give a detailed multi-section explanation with a summary, step-by-step flow, concrete files/functions/endpoints, and explicit uncertainty. Do not add facts that are not proven by evidence.";
  }
  return "Use a clear, direct explanation.";
}

export function createGroundingPackText(grounding: ProjectQuestionGrounding) {
  return [
    `Question kind: ${grounding.questionKind}`,
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
    `Unified intent: actionMode=${grounding.workspaceReasoning.intent.actionMode}; answerGoal=${grounding.workspaceReasoning.intent.answerGoal}; topicPhrase=${grounding.workspaceReasoning.intent.topicPhrase}; facets=${grounding.workspaceReasoning.intent.requiredFacets.join(", ") || "none"}`,
    grounding.workspaceReasoning.evidencePack.missingRequiredFacets.length
      ? `Missing unified evidence facets: ${grounding.workspaceReasoning.evidencePack.missingRequiredFacets.join(", ")}`
      : "",
    `Answer style: ${grounding.style}`,
    `Answer shape: ${grounding.answerShape}`,
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
  if (shouldUseUnifiedFallback(grounding)) {
    const genericAnswer = createEvidenceBasedAnswerFallback(grounding.workspaceReasoning, ["Requested evidence was not found in the current workspace."]);
    if (genericAnswer) return genericAnswer;
  }
  if (isPageInventoryConcept(grounding)) {
    return createPageInventoryFallback(grounding, ["No frontend page/screen evidence was found in the current workspace evidence."]);
  }
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
  if (shouldUseUnifiedFallback(grounding)) {
    const genericAnswer = createEvidenceBasedAnswerFallback(grounding.workspaceReasoning, validationErrors);
    if (genericAnswer) return genericAnswer;
  }
  const inspected = formatInspectedFiles(grounding);
  const support = grounding.supportingEvidence.length
    ? grounding.supportingEvidence.slice(0, 3)
    : [];
  if (isPageInventoryConcept(grounding)) {
    return createPageInventoryFallback(grounding, validationErrors);
  }
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

function shouldUseUnifiedFallback(grounding: ProjectQuestionGrounding) {
  return grounding.concept.evidenceGroups?.some((group) => group.id === "algorithms_models") === true
    || grounding.concept.label === "algorithms/models inventory";
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
  if (concept.evidenceGroups?.some((group) => group.id === "page_structure")) {
    return evidenceItemSupportsPageInventory(item);
  }
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
      .filter((item) => group.id === "page_structure"
        ? evidenceItemSupportsPageInventory(item)
        : group.id === "threshold_fact"
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

export function evidenceItemSupportsPageInventory(item: GroundingEvidenceItem) {
  const text = [item.path, item.title, item.reason, item.snippet ?? ""].join("\n");
  const authoredText = [item.path, item.snippet ?? ""].join("\n");
  const normalizedPath = item.path.replaceAll("\\", "/").toLowerCase();
  if (!isPageInventorySourcePath(normalizedPath)) {
    return false;
  }
  if (GENERATED_PAGE_ANCHOR_RE.test(text) && !STRONG_PAGE_STRUCTURE_CONTENT_RE.test(authoredText)) {
    return false;
  }
  if (/((^|\/)(pages|screens|views|routes)\/|(^|\/)(frontend|src|dashboard_ui)\/|app\.(jsx|tsx|js|ts)$|index\.html$)/i.test(normalizedPath)
    && STRONG_PAGE_STRUCTURE_CONTENT_RE.test(authoredText)) {
    return true;
  }
  return STRONG_PAGE_STRUCTURE_CONTENT_RE.test(authoredText);
}

export function findUnsupportedDomainClaims(answer: string, evidenceItems: GroundingEvidenceItem[], concept: RequestedConcept) {
  const normalizedAnswer = normalizeForGroundingSearch(answer);
  const evidenceText = normalizeForGroundingSearch(evidenceItems.map((item) => [item.path, item.title, item.reason, item.snippet ?? ""].join(" ")).join(" "));
  const unsupported: string[] = [];
  for (const [claim, aliases] of Object.entries(DOMAIN_CLAIM_ALIASES)) {
    if (claim === "pages" && !concept.evidenceGroups?.some((group) => group.id === "page_structure")) continue;
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
    .replace(/\bexplain\s+it\s+like\s+i(?:'|’)?m\s+(?:a\s+)?(?:child|kid|five year old)\b/gi, " ")
    .replace(/\bexplain\s+like\s+i(?:'|’)?m\s+(?:a\s+)?(?:child|kid|five year old)\b/gi, " ")
    .replace(/\bexplain\s+(?:it\s+)?(?:simply|in simple terms|for a child|to a child)\b/gi, " ")
    .replace(/\bkeep\s+it\s+(?:brief|short|concise|technical|detailed)\b/gi, " ")
    .replace(/(?:\u0627\u0634\u0631\u062d(?:\u0647|\u0647\u0627|\u0644\u064a)?\s*)?(?:\u0644\s*\u0637\u0641\u0644|\u0644\u0644\u0637\u0641\u0644|\u0637\u0641\u0644\s+\u064a\u0642\u062f\u0631\s+\u064a\u0641\u0647\u0645|\u0637\u0641\u0644\s+\u064a\u0641\u0647\u0645|\u0628\u0634\u0643\u0644\s+\u0645\u0628\u0633\u0637|\u0628\u0628\u0633\u0627\u0637\u0629|\u0644\u0644\u0645\u0628\u062a\u062f\u0626(?:\u064a\u0646)?|\u0628\u0633\u064a\u0637(?:\u0629)?|\u0645\u0628\u0633\u0637(?:\u0629)?)/g, " ")
    .replace(/(?:اشرح(?:ه|ها|لي)?\s*)?(?:ل\s*طفل|للطفل|طفل\s+يقدر\s+يفهم|طفل\s+يفهم|بشكل\s+مبسط|ببساطة|للمبتدئ(?:ين)?|بسيط(?:ة)?|مبسط(?:ة)?)/g, " ")
    .replace(/(?:اشرح(?:ه|ها|لي)?\s*)?(?:ل\s*طفل|للطفل|طفل\s+يقدر\s+يفهم|طفل\s+يفهم|بشكل\s+مبسط|ببساطة|للمبتدئ(?:ين)?|بسيط(?:ة)?|مبسط(?:ة)?)/g, " ")
    .replace(/(?:اشرح(?:ه|ها|لي)?\s*)?(?:لطفل|للطفل|ل طفل|طفل\s+يقدر\s+يفهم|طفل\s+يفهم|بشكل\s+مبسط|ببساطة|للمبتدئ|للمبتدئين|بسيط|بسيطة|مبسط|مبسطة)/g, " ");
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

function detectDecisionPolicyConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const asksDecision =
    /\b(when|why|how|decide|decides|decision|rule|rules|policy|route|orchestrator|choose|instead|versus|vs)\b/.test(normalized)
    || /(?:\u0627\u0645\u062a\u0649|\u064a\u0642\u0631\u0631|\u0644\u064a\u0647|\u0627\u0632\u0627\u064a|\u0642\u0648\u0627\u0639\u062f|\u0628\u062f\u0644|\u064a\u0628\u0639\u062a)/.test(normalized);
  const hasActionChoice = /\b(re\s*cluster|recluster|offer|strong offer|human review|no action|dispatch|selected action|recommended action)\b/.test(normalized);
  const hasRoutingTerms = /\b(orchestrator|choose_route|route_result|routing|weighted votes|weighted winner|agent consensus|agent recommendations|selected action|recommended action|dispatch)\b/.test(normalized);
  const hasDecisionEvidenceTerms = /\b(drift|drift detected|membership|membership strength|fcm|orchestrator|agent recommendations|weighted votes|agent consensus)\b/.test(normalized);
  if (!asksDecision || !(hasActionChoice || (hasRoutingTerms && hasDecisionEvidenceTerms))) return undefined;
  return {
    specific: true,
    label: "decision policy",
    displayLabel: "decision policy: re-cluster vs offer",
    terms: uniqueStrings(["decision policy", "re-cluster", "offer", "drift", "membership", "fcm", "orchestrator"]),
    coreTerms: DECISION_POLICY_GROUP.coreTerms,
    aliases: DECISION_POLICY_ALIASES,
    evidenceGroups: [DECISION_POLICY_GROUP],
    confidence: "high"
  };
}

function detectPageInventoryConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const rawPrompt = userPrompt.toLowerCase();
  const hasEnglishPageIntent =
    /\b(?:how many|what|which|list|show|explain)\b.{0,40}\b(?:pages?|screens?|views?|routes?)\b/.test(normalized)
    || /\b(?:pages?|screens?|views?|routes?)\b.{0,80}\b(?:do|does|for|purpose|work|works|mean|each)\b/.test(normalized)
    || /\b(?:each|every)\b.{0,30}\b(?:page|screen|view|route)\b/.test(normalized);
  const hasArabicPageIntent =
    /(?:\u0643\u0627\u0645\s+(?:\u0635\u0641\u062d\u0629|\u0635\u0641\u062d\u0647|\u0635\u0641\u062d\u0627\u062a|\u0634\u0627\u0634\u0629|\u0634\u0627\u0634\u0647|\u0634\u0627\u0634\u0627\u062a))/.test(rawPrompt)
    || /(?:(?:\u0635\u0641\u062d\u0629|\u0635\u0641\u062d\u0647|\u0635\u0641\u062d\u0627\u062a|\u0634\u0627\u0634\u0629|\u0634\u0627\u0634\u0647|\u0634\u0627\u0634\u0627\u062a).{0,80}(?:\u0628\u062a\u0639\u0645\u0644|\u062a\u0639\u0645\u0644|\u0648\u0638\u064a\u0641|\u0627\u064a\u0647|\u0625\u064a\u0647|\u0627\u064a\u0647))/.test(rawPrompt)
    || /(?:\u0627\u0644\u0633\u064a\u0633\u062a\u0645|\u0633\u064a\u0633\u062a\u0645).{0,80}(?:\u0643\u0627\u0645).{0,80}(?:\u0635\u0641\u062d\u0629|\u0635\u0641\u062d\u0647|\u0635\u0641\u062d\u0627\u062a|\u0634\u0627\u0634\u0629|\u0634\u0627\u0634\u0647|\u0634\u0627\u0634\u0627\u062a)/.test(rawPrompt)
    || /(?:\u0643\u0644\s+\u0648\u0627\u062d\u062f\u0629|\u0643\u0644\s+\u0648\u0627\u062d\u062f\u0647).{0,80}(?:\u0628\u062a\u0639\u0645\u0644|\u062a\u0639\u0645\u0644|\u0627\u064a\u0647|\u0625\u064a\u0647)/.test(rawPrompt);
  if (!hasEnglishPageIntent && !hasArabicPageIntent) return undefined;
  return {
    specific: true,
    label: PAGE_INVENTORY_CONCEPT_LABEL,
    displayLabel: "page/screen inventory / \u0635\u0641\u062d\u0627\u062a \u0648\u0634\u0627\u0634\u0627\u062a \u0627\u0644\u0633\u064a\u0633\u062a\u0645",
    terms: uniqueStrings([
      PAGE_INVENTORY_CONCEPT_LABEL,
      "pages",
      "screens",
      "views",
      "routes",
      ...PAGE_STRUCTURE_GROUP.coreTerms
    ]),
    coreTerms: PAGE_STRUCTURE_GROUP.coreTerms,
    aliases: uniqueStrings([
      PAGE_INVENTORY_CONCEPT_LABEL,
      "page inventory",
      "screen inventory",
      "route inventory",
      "pages and screens",
      "what each page does",
      ...PAGE_STRUCTURE_ALIASES
    ]),
    evidenceGroups: [PAGE_STRUCTURE_GROUP],
    confidence: "high"
  };
}

function detectThresholdInventoryConcept(userPrompt: string): RequestedConcept | undefined {
  const normalized = normalizeForGroundingSearch(userPrompt);
  const thresholdTopicAliases = THRESHOLD_FACT_ALIASES.filter((alias) => !/^(?:kam|\u0643\u0627\u0645|numbers?|values?)$/i.test(alias));
  const hasThresholdIntent = thresholdTopicAliases.some((alias) => textContainsConceptTerm(normalized, alias));
  const hasArabicCompareIntent = /(?:\u0628\u0642\u0627\u0631\u0646|\u0628\u064a\u0642\u0627\u0631\u0646|\u0639\u062a\u0628\u0629|\u0639\u062a\u0628\u0627\u062a|\u062d\u062f\u0648\u062f|\u0623\u0631\u0642\u0627\u0645|\u0627\u0631\u0642\u0627\u0645|\u0645\u0639\u0627\u062f\u0644\u0629|\u0645\u0639\u0627\u062f\u0644\u0627\u062a|\u0634\u0631\u0637|\u0634\u0631\u0648\u0637)|(?:^|\s)\u062d\u062f(?:\s|$)/.test(userPrompt);
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
  const forecastTopicAliases = FORECASTING_ALIASES.filter((alias) => !/^(?:customer|customers|per customer|customer one|one customer|single customer|aggregate|aggregated|global|scope|cluster|clusters|segment|segments|\u0639\u0645\u064a\u0644|\u0644\u0639\u0645\u064a\u0644|\u0639\u0645\u064a\u0644 \u0648\u0627\u062d\u062f|\u0643\u0633\u062a\u0645\u0631|\u0648\u0627\u062d\u062f|\u0646\u0648\u0639)$/i.test(alias));
  const hasForecastIntent = forecastTopicAliases.some((alias) => textContainsConceptTerm(normalized, alias));
  const hasTypeOrScopeIntent = /\b(type|kind|scope|customer|per customer|global|aggregate|one customer|single customer)\b/.test(normalized)
    || /(?:\u0646\u0648\u0639|\u0639\u0645\u064a\u0644|\u0648\u0627\u062d\u062f|\u064a\u062a\u0637\u0628\u0642|\u064a\u062a\u0637\u0628\u0642\s+\u0639\u0644\u0649)/.test(userPrompt);
  if (!hasForecastIntent || !hasPrimaryForecastIntent(normalized)) return undefined;
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
  if (best.concept.key === "forecasting" && !hasPrimaryForecastIntent(normalized)) return undefined;
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

function hasPrimaryForecastIntent(normalizedPrompt: string) {
  return /\b(forecast|forecasts|forecasting|arima|sarima|sarimax|timeseries|time series|trend|trend_multiplier)\b/i.test(normalizedPrompt)
    || /(?:\u062a\u0648\u0642\u0639|\u062a\u0648\u0642\u0639\u0627\u062a|\u0627\u0644\u0641\u0648\u0631\u0643\u0627\u0633\u062a\u064a\u0646\u062c)/u.test(normalizedPrompt);
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
  return /(المشروع|مشروع|هنا|دا|ده|دي|داخل|في المشروع)/.test(userPrompt);
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

function formatPageInventoryInspectedFiles(grounding: ProjectQuestionGrounding) {
  const files = uniqueStrings([
    ...grounding.supportingEvidence.map((item) => item.path),
    ...grounding.inspectedFiles
  ]).slice(0, 8);
  return files.length ? files.join(", ") : "the sampled workspace files";
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
  if ("questionKind" in grounding && grounding.questionKind !== "threshold_inventory") return false;
  const concept = "concept" in grounding ? grounding.concept : grounding;
  return concept.label === THRESHOLD_INVENTORY_CONCEPT_LABEL
    || concept.evidenceGroups?.some((group) => group.id === "threshold_fact") === true;
}

export function isForecastingScopeConcept(grounding: ProjectQuestionGrounding | RequestedConcept) {
  if ("questionKind" in grounding && grounding.questionKind !== "forecasting_scope") return false;
  const concept = "concept" in grounding ? grounding.concept : grounding;
  return concept.label === FORECASTING_SCOPE_CONCEPT_LABEL
    || concept.evidenceGroups?.some((group) => group.id === "forecasting_fact") === true;
}

export function isDecisionPolicyConcept(grounding: ProjectQuestionGrounding | RequestedConcept) {
  if ("questionKind" in grounding && grounding.questionKind === "decision_policy") return true;
  const concept = "concept" in grounding ? grounding.concept : grounding;
  return concept.label === "decision policy"
    || concept.evidenceGroups?.some((group) => group.id === "decision_policy") === true;
}

export function isPageInventoryConcept(grounding: ProjectQuestionGrounding | RequestedConcept) {
  if ("questionKind" in grounding && grounding.questionKind === "page_inventory") return true;
  const concept = "concept" in grounding ? grounding.concept : grounding;
  return concept.label === PAGE_INVENTORY_CONCEPT_LABEL
    || concept.evidenceGroups?.some((group) => group.id === "page_structure") === true;
}

function shortReason(item: GroundingEvidenceItem) {
  return sanitizeAnswerFragment(item.reason || item.title || item.snippet || "current-workspace evidence").replace(/\s+/g, " ").slice(0, 180);
}

function formatConceptLabel(concept: RequestedConcept) {
  return concept.displayLabel ?? concept.label;
}

type PageEvidenceFact = {
  name: string;
  type: "route" | "html_page" | "section" | "tab" | "component" | "api_endpoint" | "stylesheet_support";
  functionSummary: string;
  links: string[];
  path: string;
  raw: string;
  confidence: "high" | "medium" | "low";
};

function createPageInventoryFallback(grounding: ProjectQuestionGrounding, validationErrors: string[]) {
  void validationErrors;
  const items = collectGroundingEvidenceForSynthesis(grounding);
  const candidates = extractPageEvidenceFacts(items);
  const pageFacts = candidates.filter((fact) => isCountablePageCandidate(fact)).slice(0, 30);
  const endpointFacts = candidates.filter((fact) => fact.type === "api_endpoint").slice(0, 12);
  const stylesheetFacts = candidates.filter((fact) => fact.type === "stylesheet_support");
  const hasRealRoutes = pageFacts.some((fact) => fact.type === "route");
  const hasSectionsOrTabs = pageFacts.some((fact) => fact.type === "section" || fact.type === "tab" || fact.type === "html_page");
  const arabic = grounding.language === "arabic";

  if (arabic) {
    const lines: string[] = [];
    if (pageFacts.length) {
      if (hasRealRoutes) {
        lines.push(`\u0644\u0642\u064a\u062a ${pageFacts.length} route/page \u0645\u0624\u0643\u062f\u0629 \u0645\u0646 \u0643\u0648\u062f \u0627\u0644\u0648\u0627\u062c\u0647\u0629.`);
      } else if (hasSectionsOrTabs) {
        lines.push(`\u0648\u0627\u0636\u062d \u0625\u0646 \u0627\u0644\u0648\u0627\u062c\u0647\u0629 \u0623\u0642\u0631\u0628 \u0644\u0640 single-page app\u060c \u0648\u0644\u0642\u064a\u062a ${pageFacts.length} section/tab \u0623\u0648 view \u062c\u0648\u0647\u0647\u0627.`);
      } else {
        lines.push(`\u0644\u0642\u064a\u062a ${pageFacts.length} candidate \u0645\u0646 \u0643\u0648\u062f \u0627\u0644\u0648\u0627\u062c\u0647\u0629\u060c \u0628\u0633 \u0646\u0648\u0639\u0647\u0645 \u0645\u062d\u062a\u0627\u062c \u062a\u0623\u0643\u064a\u062f.`);
      }
      lines.push("");
      lines.push("| \u0627\u0644\u0627\u0633\u0645 | \u0627\u0644\u0646\u0648\u0639 | \u0628\u062a\u0639\u0645\u0644 \u0625\u064a\u0647 | \u0627\u0644\u062f\u0644\u064a\u0644 | \u0627\u0644\u062b\u0642\u0629 |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const fact of pageFacts) {
        lines.push(`| ${escapeTableCell(fact.name)} | ${formatArabicPageFactType(fact)} | ${escapeTableCell(formatArabicPageFactDescription(fact))} | ${formatPageFactLinks(fact)} | ${formatArabicConfidence(fact.confidence)} |`);
      }
      if (stylesheetFacts.length) lines.push("\n\u0645\u0644\u0641\u0627\u062a CSS \u0644\u0648 \u0638\u0647\u0631\u062a \u0641\u064a \u0627\u0644\u0623\u062f\u0644\u0629 \u0641\u0647\u064a \u0645\u062d\u0633\u0648\u0628\u0629 \u0643\u0633\u062a\u0627\u064a\u0644 \u0641\u0642\u0637\u060c \u0645\u0634 \u0643\u0635\u0641\u062d\u0627\u062a.");
    } else {
      lines.push("\u0644\u0627 \u0623\u0642\u062f\u0631 \u0623\u0624\u0643\u062f \u0639\u062f\u062f \u0635\u0641\u062d\u0627\u062a frontend \u0645\u0646 \u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u062d\u0627\u0644\u064a\u0629.");
      if (stylesheetFacts.length) {
        lines.push("\u0644\u0642\u064a\u062a CSS \u0623\u0648 styling\u060c \u0644\u0643\u0646\u0647 \u0644\u0627 \u064a\u0643\u0641\u064a \u064a\u062a\u0639\u062f \u0643\u0635\u0641\u062d\u0629 \u0623\u0648 screen.");
      }
      if (endpointFacts.length) {
        lines.push("\u0627\u0644\u0644\u064a \u0638\u0647\u0631 \u0628\u062f\u0644 \u0643\u062f\u0647 backend/API endpoints\u060c \u0648\u062f\u064a \u0645\u0634 \u0635\u0641\u062d\u0627\u062a \u0648\u0627\u062c\u0647\u0629 \u0645\u0624\u0643\u062f\u0629:");
        for (const fact of endpointFacts) {
          lines.push(`- ${fact.name}: ${formatArabicPageFactDescription(fact)} ${formatPageFactLinks(fact)}`);
        }
      } else {
        lines.push(`\u0631\u0627\u062c\u0639\u062a: ${formatPageInventoryInspectedFiles(grounding)}.`);
      }
    }
    return lines.join("\n");
  }

  const lines: string[] = [];
  if (pageFacts.length) {
    if (hasRealRoutes) {
      lines.push(`I found ${pageFacts.length} confirmed route/page item(s) in the frontend code.`);
    } else if (hasSectionsOrTabs) {
      lines.push(`This looks like a single-page frontend with ${pageFacts.length} section/tab or view item(s).`);
    } else {
      lines.push(`I found ${pageFacts.length} frontend candidate item(s), but their page type is low-confidence.`);
    }
    lines.push("");
    lines.push("| Name | Type | What it does | Evidence | Confidence |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const fact of pageFacts) {
      lines.push(`| ${escapeTableCell(fact.name)} | ${fact.type} | ${escapeTableCell(formatEnglishPageFactDescription(fact))} | ${formatPageFactLinks(fact)} | ${fact.confidence} |`);
    }
    if (stylesheetFacts.length) lines.push("\nCSS evidence was treated as styling support only, not counted as pages.");
  } else {
    lines.push("I could not confirm frontend pages from the inspected current-workspace files.");
    if (stylesheetFacts.length) {
      lines.push("I found CSS/styling evidence, but CSS is not enough to count a page or screen.");
    }
    if (endpointFacts.length) {
      lines.push("I found backend/API endpoints instead:");
      for (const fact of endpointFacts) {
        lines.push(`- ${fact.name}: ${formatEnglishPageFactDescription(fact)} ${formatPageFactLinks(fact)}`);
      }
    } else {
      lines.push(`Inspected files: ${formatPageInventoryInspectedFiles(grounding)}.`);
    }
  }
  return lines.join("\n");
}

function extractPageEvidenceFacts(items: GroundingEvidenceItem[]) {
  const facts: PageEvidenceFact[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = [item.title, item.reason, item.snippet ?? ""].join("\n");
    if (!evidenceItemSupportsPageInventory(item) && !/\bAPI route\b/i.test(text) && !PAGE_STYLESHEET_EXT_RE.test(item.path)) continue;
    for (const fact of parsePageFactsFromEvidence(item)) {
      const key = canonicalPageCandidateKey(fact);
      const existingIndex = facts.findIndex((candidate) => canonicalPageCandidateKey(candidate) === key);
      if (existingIndex >= 0) {
        facts[existingIndex] = mergePageCandidates(facts[existingIndex]!, fact);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
      if (facts.length >= 60) return sortPageFacts(facts);
    }
  }
  return sortPageFacts(facts);
}

function parsePageFactsFromEvidence(item: GroundingEvidenceItem): PageEvidenceFact[] {
  const facts: PageEvidenceFact[] = [];
  const normalizedPath = item.path.replaceAll("\\", "/").toLowerCase();
  if (PAGE_STYLESHEET_EXT_RE.test(normalizedPath)) {
    return [{
      name: item.path.split(/[\\/]/).pop() ?? item.path,
      type: "stylesheet_support",
      functionSummary: "Stylesheet evidence only; not a page or screen.",
      links: [item.markdownLink],
      path: item.path,
      raw: item.snippet ?? item.reason,
      confidence: "low"
    }];
  }
  if (!isPageInventorySourcePath(normalizedPath) && !/\bAPI route\b/i.test(item.title)) return facts;
  const source = item.snippet ?? "";
  if (!source || GENERATED_PAGE_ANCHOR_RE.test(source) && !STRONG_PAGE_STRUCTURE_CONTENT_RE.test(source)) return facts;
  const lines = source.split(/\r?\n/);
  const add = (name: string, type: PageEvidenceFact["type"], raw: string, description?: string, confidence?: PageEvidenceFact["confidence"]) => {
    const cleanedName = cleanPageName(name);
    if (!cleanedName || cleanedName.length > 80) return;
    facts.push({
      name: cleanedName,
      type,
      functionSummary: description ?? inferPageDescription(raw, type),
      links: [item.markdownLink],
      path: item.path,
      raw: raw.trim(),
      confidence: confidence ?? inferPageCandidateConfidence(type, raw, item.path)
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const jsxRoute = trimmed.match(/<Route\b[^>]*\bpath=["']([^"']+)["'][^>]*(?:element=\{?\s*<([A-Z][A-Za-z0-9_]*))?/);
    if (jsxRoute) add(jsxRoute[2] ? `${jsxRoute[2]} (${jsxRoute[1]})` : jsxRoute[1] ?? "route", "route", trimmed, describeRoute(trimmed, jsxRoute[2], jsxRoute[1]), "high");
    const objectRoute = trimmed.match(/\bpath\s*:\s*["']([^"']+)["']/);
    if (objectRoute && /\b(route|router|createBrowserRouter|routes?)\b/i.test(source)) add(objectRoute[1] ?? "route", "route", trimmed, undefined, "high");
    const htmlSection = trimmed.match(/<(section|main|div)\b[^>]*(?:id|data-view|data-page)=["']([^"']+)["'][^>]*>([^<]{0,140})/i);
    if (htmlSection) add(htmlSection[2] ?? "section", htmlSection[1]?.toLowerCase() === "section" ? "section" : "html_page", trimmed, htmlSection[3], "high");
    const jsxNamedSection = trimmed.match(/<(section|main|aside)\b[^>]*(?:className=\{?["']([^"'}]+)["']\}?|aria-label=["']([^"']+)["'])/i);
    if (jsxNamedSection) {
      const sectionName = nameFromJsxClassOrAria(jsxNamedSection[3] ?? jsxNamedSection[2] ?? "");
      if (sectionName) add(sectionName, jsxNamedSection[1]?.toLowerCase() === "main" ? "html_page" : "section", trimmed, undefined, "medium");
    }
    const navLink = trimmed.match(/<a\b[^>]*href=["']?([^"'\s>]*)["']?[^>]*>([^<]{1,90})<\/a>/i);
    if (navLink) add(navLink[2] ?? navLink[1] ?? "navigation", "tab", trimmed, undefined, "medium");
    const dataViewButton = trimmed.match(/<(button|a)\b[^>]*(?:data-view|data-page)=["']([^"']+)["'][^>]*>([^<]{0,90})/i);
    if (dataViewButton) add(dataViewButton[3] || dataViewButton[2] || "view", "tab", trimmed, undefined, "medium");
    const apiRoute = trimmed.match(/^@(app|router)\.(get|post|put|delete|patch)\(["']([^"']+)["']/);
    if (apiRoute) add(`${apiRoute[2]?.toUpperCase()} ${apiRoute[3]}`, "api_endpoint", trimmed, undefined, "high");
    const objectView = trimmed.match(/^\{.*\b(?:id|key|name|label|title|path)\s*:\s*["'][^"']+["'].*\}/);
    if (objectView && /\b(CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b/.test(source)) {
      const fields = parseStringFieldsFromObject(trimmed);
      const name = fields.title ?? fields.label ?? fields.name ?? fields.id ?? fields.key ?? fields.path;
      const description = fields.description ?? fields.summary ?? fields.subtitle ?? fields.body;
      if (name) add(name, "tab", trimmed, description, description ? "high" : "medium");
    }
  }

  if (/\b(CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b/.test(source)) {
    const collectionName = source.match(/\b(CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b/)?.[1] ?? "views";
    for (const match of source.matchAll(/\b(?:id|key|name|label|title|path)\s*[:=]\s*["']([^"']{2,80})["']/g)) {
      add(match[1] ?? collectionName, "tab", match[0] ?? source, undefined, "low");
    }
    const quoted = [...source.matchAll(/["']([A-Za-z][A-Za-z0-9 _/-]{2,60})["']/g)]
      .map((match) => match[1] ?? "")
      .filter((value) => !/\.(js|jsx|ts|tsx|css|html)$|^\/api\//i.test(value))
      .slice(0, 12);
    for (const value of quoted) add(value, "tab", source, undefined, "low");
  }
  return facts;
}

function sortPageFacts(facts: PageEvidenceFact[]) {
  const rank: Record<PageEvidenceFact["type"], number> = {
    route: 0,
    html_page: 1,
    section: 2,
    tab: 3,
    component: 4,
    api_endpoint: 5,
    stylesheet_support: 6
  };
  const confidenceRank = { high: 0, medium: 1, low: 2 };
  return facts.sort((left, right) => rank[left.type] - rank[right.type] || confidenceRank[left.confidence] - confidenceRank[right.confidence] || left.name.localeCompare(right.name));
}

function cleanPageName(value: string) {
  return sanitizeAnswerFragment(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^#/, "")
    .trim();
}

function inferPageDescription(raw: string, type: PageEvidenceFact["type"]) {
  const text = sanitizeAnswerFragment(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > 20 && !/^\w+$/.test(text)) return text.slice(0, 160);
  if (type === "route") return "A frontend route/view defined in the UI routing code.";
  if (type === "tab") return "A navigation/tab item users can click to reach a view or section.";
  if (type === "api_endpoint") return "A backend API endpoint, not a confirmed frontend page.";
  if (type === "component") return "A UI component; it only counts as a screen when rendered by a route or view.";
  if (type === "stylesheet_support") return "Stylesheet evidence only; not a page or screen.";
  return "A page-like UI section or screen found in frontend markup.";
}

function formatArabicPageFactDescription(fact: PageEvidenceFact) {
  const summary = sanitizeAnswerFragment(fact.functionSummary).replace(/\s+/g, " ").trim();
  if (summary.length > 8 && !/^(A frontend route|A navigation|A page-like|An item|Stylesheet)/i.test(summary)) return summary.slice(0, 160);
  if (fact.type === "route") return `route \u0628\u064a\u0639\u0631\u0636 \u0634\u0627\u0634\u0629 ${fact.name}`;
  if (fact.type === "tab") return `tab/navigation \u0628\u064a\u0641\u062a\u062d \u062c\u0632\u0621 ${fact.name}`;
  if (fact.type === "api_endpoint") return "backend endpoint\u060c \u0645\u0634 \u0635\u0641\u062d\u0629 frontend \u0645\u0624\u0643\u062f\u0629";
  if (fact.type === "component") return "component \u0641\u064a \u0627\u0644\u0648\u0627\u062c\u0647\u0629\u060c \u0648\u0638\u064a\u0641\u062a\u0647 \u0627\u0644\u062f\u0642\u064a\u0642\u0629 \u0645\u062d\u062a\u0627\u062c\u0629 \u0633\u064a\u0627\u0642 render";
  if (fact.type === "stylesheet_support") return "\u0633\u062a\u0627\u064a\u0644 \u0641\u0642\u0637\u060c \u0645\u0634 \u0635\u0641\u062d\u0629";
  return `section \u0623\u0648 view \u0628\u0627\u0633\u0645 ${fact.name}`;
}

function formatEnglishPageFactDescription(fact: PageEvidenceFact) {
  return sanitizeAnswerFragment(fact.functionSummary).replace(/\s+/g, " ").slice(0, 160);
}

function isPageInventorySourcePath(filePath: string) {
  const normalizedPath = filePath.replaceAll("\\", "/").toLowerCase();
  if (PAGE_STYLESHEET_EXT_RE.test(normalizedPath)) return false;
  if (/package\.json|requirements\.txt|pyproject\.toml|cargo\.toml|readme\.md$/i.test(normalizedPath)) return false;
  if (!PAGE_STRUCTURE_SOURCE_EXT_RE.test(normalizedPath)) return false;
  return /(^|\/)(frontend|dashboard_ui|ui|web|client|pages|screens|views|routes|components)\//i.test(normalizedPath)
    || /(^|\/)src\/app\//i.test(normalizedPath)
    || /(^|\/)(app|main|index)\.(jsx|tsx|js|ts|mjs)$/i.test(normalizedPath)
    || /(^|\/)index\.html$/i.test(normalizedPath);
}

function isCountablePageCandidate(fact: PageEvidenceFact) {
  return fact.type !== "api_endpoint" && fact.type !== "stylesheet_support" && fact.type !== "component";
}

function formatArabicPageFactType(fact: PageEvidenceFact) {
  if (fact.type === "route") return "route/page";
  if (fact.type === "html_page") return "HTML section";
  if (fact.type === "section") return "section";
  if (fact.type === "tab") return "tab/view";
  if (fact.type === "component") return "component";
  if (fact.type === "api_endpoint") return "API endpoint";
  return "CSS support";
}

function formatArabicConfidence(confidence: PageEvidenceFact["confidence"]) {
  if (confidence === "high") return "\u0639\u0627\u0644\u064a\u0629";
  if (confidence === "medium") return "\u0645\u062a\u0648\u0633\u0637\u0629";
  return "\u0645\u0646\u062e\u0641\u0636\u0629";
}

function formatPageFactLinks(fact: PageEvidenceFact) {
  return uniqueStrings(fact.links).slice(0, 3).join(", ");
}

function canonicalPageCandidateKey(fact: PageEvidenceFact) {
  if (fact.type === "api_endpoint" || fact.type === "stylesheet_support") {
    return `${fact.type}:${fact.path.toLowerCase()}:${normalizeForGroundingSearch(fact.name)}`;
  }
  const normalizedName = normalizeForGroundingSearch(fact.name)
    .replace(/\b(route|page|screen|view|section|tab|component)\b/g, " ")
    .replace(/\bhtml\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const routeLike = fact.raw.match(/\bpath=["']([^"']+)["']/)?.[1]
    ?? fact.raw.match(/\bpath\s*:\s*["']([^"']+)["']/)?.[1]
    ?? fact.raw.match(/\bhref=["']#?([^"'\s>]+)["']?/)?.[1]
    ?? fact.raw.match(/\b(?:id|data-view|data-page)=["']([^"']+)["']/)?.[1];
  const normalizedRoute = routeLike
    ? normalizeForGroundingSearch(routeLike.replace(/^#/, "").replace(/^\//, "") || "home")
    : "";
  return normalizedRoute || normalizedName || normalizeForGroundingSearch(fact.path);
}

function mergePageCandidates(left: PageEvidenceFact, right: PageEvidenceFact): PageEvidenceFact {
  const rank: Record<PageEvidenceFact["type"], number> = {
    route: 6,
    html_page: 5,
    section: 4,
    tab: 3,
    component: 2,
    api_endpoint: 1,
    stylesheet_support: 0
  };
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  const winner = rank[right.type] > rank[left.type] || confidenceRank[right.confidence] > confidenceRank[left.confidence]
    ? right
    : left;
  const loser = winner === right ? left : right;
  return {
    ...winner,
    functionSummary: chooseBetterPageSummary(winner.functionSummary, loser.functionSummary),
    links: uniqueStrings([...winner.links, ...loser.links]),
    raw: [winner.raw, loser.raw].filter(Boolean).join("\n")
  };
}

function chooseBetterPageSummary(left: string, right: string) {
  const cleanLeft = sanitizeAnswerFragment(left).trim();
  const cleanRight = sanitizeAnswerFragment(right).trim();
  if (!cleanLeft) return cleanRight;
  if (!cleanRight) return cleanLeft;
  return scorePageSummary(cleanRight) > scorePageSummary(cleanLeft) ? cleanRight : cleanLeft;
}

function scorePageSummary(value: string) {
  let score = 0;
  const text = value.trim();
  if (/\b(shows|lists|explains|renders|opens|displays|handles|summary|details|recommendations|decisions)\b/i.test(text)) score += 50;
  if (/^(A frontend route|A navigation|A page-like|An item|Stylesheet|route \u0628\u064a\u0639\u0631\u0636|tab\/navigation|section \u0623\u0648 view)/i.test(text)) score -= 25;
  if (/\b(export const|const |let |var |function|return |CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b|[{}<>;]/.test(text)) score -= 45;
  if (text.length >= 20 && text.length <= 150) score += 20;
  if (text.length > 220) score -= 30;
  return score;
}

function describeRoute(raw: string, component?: string, routePath?: string) {
  if (component) return `Route renders the ${component} screen${routePath ? ` for ${routePath}` : ""}.`;
  const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || "A frontend route/view defined in the UI routing code.";
}

function inferPageCandidateConfidence(type: PageEvidenceFact["type"], raw: string, filePath: string): PageEvidenceFact["confidence"] {
  if (type === "route" || type === "api_endpoint") return "high";
  if (type === "section" && /<(section|main)\b/i.test(raw)) return "high";
  if (type === "html_page" && /data-view|data-page|id=|<main\b/i.test(raw)) return "medium";
  if (type === "tab" && /\b(description|title|label|data-view|data-page)\b/i.test(raw)) return "medium";
  if (/\/(pages|screens|views|routes)\//i.test(filePath)) return "medium";
  return "low";
}

function parseStringFieldsFromObject(value: string) {
  const fields: Record<string, string> = {};
  for (const match of value.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["']([^"']+)["']/g)) {
    if (match[1] && match[2]) fields[match[1]] = match[2];
  }
  return fields;
}

function nameFromJsxClassOrAria(value: string) {
  const cleaned = value
    .split(/\s+/)
    .find((part) => /\b(page|screen|view|drawer|panel|sidebar|workspace|session|activity|settings|explorer|hero|canvas)\b/i.test(part))
    ?? value;
  const normalized = cleaned
    .replace(/\{.*$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b(open|active|collapsed|hidden|visible|current|primary|secondary)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length < 3) return undefined;
  if (/^(run card|thread callout|timeline card|summary card)$/i.test(normalized)) return undefined;
  return normalized;
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
      lines.push("\u0645\u064a\u0646 \u0628\u064a\u062d\u0633\u0645 \u0627\u0644\u0642\u0631\u0627\u0631\u061f");
      if (orchestratorEvidence.length) {
        lines.push(`\u0627\u0644\u062f\u0644\u064a\u0644 \u0627\u0644\u0623\u0642\u0648\u0649 \u0639\u0644\u0649 \u0642\u0648\u0627\u0639\u062f \u0627\u0644\u0642\u0631\u0627\u0631 \u062c\u0627\u064a \u0645\u0646 ${formatEvidenceLinks(orchestratorEvidence)}.`);
      }
      if (agentEvidence.length) {
        lines.push(`\u0648\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0640 agents \u0628\u0627\u064a\u0646 \u0641\u064a\u0647\u0627 weights \u0623\u0648 branches \u0645\u0633\u0627\u0639\u062f\u0629 \u0645\u0646 ${formatEvidenceLinks(agentEvidence)}.`);
      }
      lines.push("");
    }
    if (thresholdFacts.length) {
      lines.push("\u062c\u062f\u0648\u0644 \u0627\u0644\u0640 thresholds / \u0627\u0644\u0623\u0631\u0642\u0627\u0645");
      lines.push("| Signal | \u0627\u0644\u0631\u0642\u0645 | \u0628\u064a\u062a\u0642\u0627\u0631\u0646 \u0625\u0632\u0627\u064a | \u0627\u0644\u0645\u0639\u0646\u0649/\u0627\u0644\u0623\u0643\u0634\u0646 | Evidence |");
      lines.push("| --- | ---: | --- | --- | --- |");
      for (const fact of thresholdFacts) {
        lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison)} | ${escapeTableCell(fact.action)} | ${fact.link} |`);
      }
      lines.push("");
    }
    if (formulaFacts.length) {
      lines.push("\u0627\u0644\u0645\u0639\u0627\u062f\u0644\u0627\u062a \u0627\u0644\u0644\u064a \u0644\u0642\u064a\u062a\u0647\u0627");
      for (const fact of formulaFacts) {
        lines.push(`- \`${fact.raw}\` (${fact.link})`);
      }
      lines.push("");
    }
    if (arimaEvidence.length) {
      lines.push(`\u062c\u0632\u0621 forecasting/drift: \u0641\u064a\u0647 \u0623\u062f\u0644\u0629 \u0645\u0631\u062a\u0628\u0637\u0629 \u0628\u0640 trend/forecast \u0641\u064a ${formatEvidenceLinks(arimaEvidence)}.`);
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
    lines.push("Decision Owner");
    if (orchestratorEvidence.length) lines.push(`Decision rules appear in ${formatEvidenceLinks(orchestratorEvidence)}.`);
    if (agentEvidence.length) lines.push(`Agent weights or branches appear in ${formatEvidenceLinks(agentEvidence)}.`);
    lines.push("");
  }
  if (thresholdFacts.length) {
    lines.push("Thresholds And Numeric Comparisons");
    lines.push("| Signal | Value | Compared how | Result/action | Evidence |");
    lines.push("| --- | ---: | --- | --- | --- |");
    for (const fact of thresholdFacts) {
      lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison)} | ${escapeTableCell(fact.action)} | ${fact.link} |`);
    }
    lines.push("");
  }
  if (formulaFacts.length) {
    lines.push("Formulas");
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
  const scopeEvidence = items
    .filter((item) => /\b(forecast_customer_risk|customer_history|customer_series|per customer|cluster_forecasts|cluster_series|cluster_label|cluster_id|fit_cluster_models|get_cluster_state|predicted_cluster|per-cluster|cluster-level|global_history|all customers|aggregate|overall)\b/i.test(evidenceItemContentText(item)))
    .slice(0, 5);
  const scope = inferForecastingScope(items);
  const arabic = grounding.language === "arabic";
  const cadence = summarizeForecastingCadence(items, arabic);
  const shouldUseTable = grounding.answerShape === "inventory_table";
  const highSignalForecastEvidence = items
    .filter((item) => {
      const content = evidenceItemContentText(item);
      return /arima_model|routes\.py/i.test(item.path)
        && /\b(SARIMA|cluster_forecasts|cluster_series|fit_cluster_models|get_cluster_state|predicted_cluster|train_offline_artifacts|retrain_with_rollback|AUTO_RETRAIN_CUSTOMER_INTERVAL|auto_retrain_every_customers|customer interactions?)\b/i.test(content);
    })
    .slice(0, 6);
  const mainEvidence = uniqueEvidenceItems([
    ...highSignalForecastEvidence,
    ...(cadence?.evidence ?? []),
    ...forecastEvidence.filter((item) => /arima|sarima|forecast/i.test(item.path)),
    ...scopeEvidence,
    ...forecastEvidence
  ]).slice(0, 5);
  const scoreEvidence = items
    .filter((item) => /\b(normalized_trend|trend_multiplier|intelligent_score|calculate_intelligent_score|_compute_intelligent_score|\/\s*1\.25)\b/i.test(evidenceItemContentText(item)))
    .slice(0, 5);
  const runtimeEvidence = items
    .filter((item) => /\b(get_cluster_state|predicted_cluster|forecast_state)\b/i.test(evidenceItemContentText(item)))
    .slice(0, 5);
  const dataValidityEvidence = items
    .filter((item) => /\b(behavior_period|stable_period|drift_period|period_date|month|synthetic|random|data_generator|churn_label)\b/i.test(evidenceItemContentText(item)))
    .slice(0, 5);
  const hasTrendNormalizationIssue = /\bnormalized_trend\b[\s\S]{0,160}\/\s*1\.25|\/\s*1\.25[\s\S]{0,160}\bnormalized_trend\b/i.test(items.map(evidenceItemContentText).join("\n"));
  const hasSyntheticTimeSignals = dataValidityEvidence.length > 0;
  const scoreLinks = formatNonShallowForecastLinks(scoreEvidence);
  const runtimeLinks = formatNonShallowForecastLinks(runtimeEvidence);
  const dataLinks = formatNonShallowForecastLinks(dataValidityEvidence);
  const mainLinks = formatNonShallowForecastLinks(mainEvidence);

  if (arabic) {
    const lines = [
      "## \u0627\u0644\u062e\u0644\u0627\u0635\u0629",
      `\u0627\u0644\u0640 forecasting \u0647\u0646\u0627 \u0646\u0648\u0639\u0647 \`${type}\`\u060c \u0648\u0623\u0642\u0631\u0628 \u0648\u0635\u0641 \u0644\u0647 \u0625\u0646\u0647 \u0060cluster-level / per-cluster churn trend signal\u0060 \u0645\u0634 forecast \u0645\u0633\u062a\u0642\u0644 \u0644\u0643\u0644 customer.`,
      "\u0627\u0644\u062d\u0643\u0645: \u0645\u0642\u0628\u0648\u0644 \u0643\u0640 demo/academic signal \u0644\u0648 \u0627\u0644\u0647\u062f\u0641 \u0645\u062a\u0627\u0628\u0639\u0629 trend \u0639\u0644\u0649 \u0645\u0633\u062a\u0648\u0649 cluster\u060c \u0644\u0643\u0646\u0647 \u0636\u0639\u064a\u0641 \u0643\u0640 production customer-level forecasting \u0644\u0648 \u0645\u0641\u064a\u0634 time-series \u062d\u0642\u064a\u0642\u064a \u0644\u0643\u0644 customer.",
      "",
      "## \u0628\u064a\u062a\u0637\u0628\u0642 \u0639\u0644\u0649 \u0645\u064a\u0646\u061f",
      scope.arabicExplanation,
      "",
      "## \u0628\u064a\u062a\u062c\u062f\u062f \u0625\u0645\u062a\u0649\u061f",
      cadence?.sentence ?? "\u0645\u0627\u0644\u0642\u064a\u062a\u0634 \u062f\u0644\u064a\u0644 \u0648\u0627\u0636\u062d \u064a\u0642\u0648\u0644 \u0625\u0645\u062a\u0649 \u0627\u0644\u0640 forecast \u0628\u064a\u062a\u062d\u0633\u0628 \u0623\u0648 \u0628\u064a\u062a\u062c\u062f\u062f.",
      ""
    ];
    lines.push("## \u0645\u0633\u0627\u0631 \u0627\u0644\u062a\u0634\u063a\u064a\u0644");
    lines.push(`- \u0627\u0644\u0640 training/state \u0628\u0627\u064a\u0646 \u062d\u0648\u0644 \u0060fit_cluster_models\u0060 \u0648\u0060save_state\u0060${mainLinks ? `: ${mainLinks}.` : "."}`);
    lines.push(`- \u0648\u0642\u062a runtime \u0627\u0644\u0646\u0638\u0627\u0645 \u0628\u064a\u0631\u0628\u0637 \u0627\u0644\u0640 customer \u0628\u0640 \u0060predicted_cluster\u0060 \u0648\u064a\u0633\u062a\u0631\u062c\u0639 \u0060get_cluster_state\u0060${runtimeLinks ? `: ${runtimeLinks}.` : "."}`);
    lines.push(`- \u0627\u0644\u0623\u062b\u0631 \u0639\u0644\u0649 \u0627\u0644\u0642\u0631\u0627\u0631 \u062c\u0627\u064a \u0645\u0646 \u0060trend_multiplier\u0060 \u062f\u0627\u062e\u0644 score/intelligent score${scoreLinks ? `: ${scoreLinks}.` : "."}`);
    lines.push("");
    lines.push("## \u0647\u0644 \u062f\u0647 \u0645\u0646\u0637\u0642\u064a\u061f");
    lines.push("- \u0627\u0644\u0645\u0646\u0637\u0642\u064a: \u064a\u0646\u0641\u0639 \u0643\u0625\u0634\u0627\u0631\u0629 trend \u0645\u0633\u0627\u0639\u062f\u0629 \u0644\u0644\u0640 agent \u0639\u0644\u0649 \u0645\u0633\u062a\u0648\u0649 cluster.");
    lines.push(hasSyntheticTimeSignals
      ? `- \u0627\u0644\u0645\u062d\u062f\u0648\u062f/\u0627\u0644\u063a\u0644\u0637 \u0644\u0648 \u0627\u062a\u0639\u0627\u0645\u0644 \u0643\u0640 production: \u0641\u064a\u0647 \u0625\u0634\u0627\u0631\u0627\u062a \u0644\u0640 \u0060behavior_period\u0060/\u0060month\u0060/\u0060churn_label\u0060 \u0623\u0648 data synthetic\u060c \u0641\u062f\u0647 \u0645\u0634 history \u0632\u0645\u0646\u064a \u0642\u0648\u064a \u0644\u0643\u0644 customer${dataLinks ? `: ${dataLinks}.` : "."}`
      : "- \u062c\u0648\u062f\u0629 \u0627\u0644\u062f\u0627\u062a\u0627 \u0645\u0634 \u0645\u062b\u0628\u062a\u0629 \u0643\u0641\u0627\u064a\u0629\u060c \u0641\u0645\u0634 \u0647\u0623\u0639\u0627\u0645\u0644\u0647 \u0643\u0640 production-grade forecast \u0628\u062b\u0642\u0629.");
    lines.push(hasTrendNormalizationIssue
      ? "- \u062e\u0644\u0644 \u0627\u0644\u0640 score \u0627\u0644\u0648\u0627\u0636\u062d: \u0060normalized_trend = ... / 1.25\u0060 \u0645\u0639\u0646\u0627\u0647 \u0625\u0646 \u0060trend_multiplier\u0060 \u0645\u0634 multiplier \u062d\u0642\u064a\u0642\u064a. \u00601.15\u0060 \u062a\u062a\u062d\u0648\u0644 \u0644\u062d\u0648\u0627\u0644\u064a \u00600.92\u0060\u060c \u0641\u0632\u064a\u0627\u062f\u0629 \u0627\u0644\u062e\u0637\u0631 \u0645\u0634 \u0628\u062a\u0632\u0648\u062f \u0627\u0644\u0633\u0643\u0648\u0631 \u0641\u0639\u0644\u064a\u064b\u0627\u061b \u0628\u0633 \u0628\u062a\u0642\u0644\u0644 \u0627\u0644\u0639\u0642\u0648\u0628\u0629."
      : "- \u0645\u0634 \u0647\u0623\u062f\u0639\u064a \u0645\u0634\u0643\u0644\u0629 \u0060/ 1.25\u0060 \u0644\u0648 \u0627\u0644\u0633\u0637\u0631 \u062f\u0647 \u0645\u0634 \u0645\u0648\u062c\u0648\u062f \u0641\u064a \u0627\u0644\u0623\u062f\u0644\u0629.");
    lines.push("");
    if (scope.kind === "unknown") {
      lines.push("\u0645\u0634 \u0647\u0623\u0643\u062f \u0625\u0646\u0647 \u0644\u0640 customer \u0648\u0627\u062d\u062f \u063a\u064a\u0631 \u0644\u0648 \u0627\u0644\u0643\u0648\u062f \u0642\u0627\u064a\u0644 \u0643\u062f\u0647 \u0628\u0648\u0636\u0648\u062d.", "");
    }
    if (mainEvidence.length) {
      lines.push("## \u0627\u0644\u0623\u062f\u0644\u0629");
      lines.push(...uniqueEvidenceItems([...mainEvidence, ...runtimeEvidence, ...scoreEvidence, ...dataValidityEvidence]).slice(0, 8).map((item) => `- ${forecastEvidenceLinkOrPath(item)}`));
      lines.push("");
    } else {
      lines.push("\u0645\u0641\u064a\u0634 \u0645\u0644\u0641 \u0648\u0627\u0636\u062d \u0643\u0641\u0627\u064a\u0629 \u064a\u062b\u0628\u062a \u0627\u0644\u0646\u0648\u0639.", "");
    }
    if (shouldUseTable && facts.length) {
      lines.push("\u0623\u0631\u0642\u0627\u0645/\u0634\u0631\u0648\u0637 \u0645\u0631\u062a\u0628\u0637\u0629 \u0628\u0627\u0644\u0640 forecasting");
      lines.push("| Signal | \u0627\u0644\u0631\u0642\u0645 | \u0627\u0644\u0645\u0639\u0627\u062f\u0644\u0629/\u0627\u0644\u0634\u0631\u0637 | Evidence |");
      lines.push("| --- | ---: | --- | --- |");
      for (const fact of facts) {
        lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison || fact.raw)} | ${fact.link} |`);
      }
      lines.push("");
    }
    return lines.filter(Boolean).join("\n");
  }

  const lines = [
    "### Short Answer",
    `The forecasting type here is \`${type}\`, and the strongest scope is a cluster-level / per-cluster churn trend signal rather than a customer-level forecast.`,
    "",
    "### Scope",
    scope.englishExplanation,
    "",
    "### Refresh",
    cadence?.sentence ?? "I did not find enough evidence to say when the forecast is recomputed or refreshed.",
    ""
  ];
  if (mainEvidence.length) {
    lines.push("### Evidence");
    lines.push(...uniqueEvidenceItems([...mainEvidence, ...runtimeEvidence, ...scoreEvidence, ...dataValidityEvidence]).slice(0, 8).map((item) => `- ${forecastEvidenceLinkOrPath(item)}`));
  } else {
    lines.push("I did not find enough evidence to name the exact forecasting type.");
  }
  lines.push("");
  lines.push("### Logic Assessment");
  lines.push("This is reasonable as a demo/academic cluster trend signal, but weak as production customer-level forecasting without real per-customer time-series history.");
  if (hasTrendNormalizationIssue) {
    lines.push("The score logic also has a likely issue: `normalized_trend = ... / 1.25` means `trend_multiplier` is not used as a true multiplier; an increasing-risk `1.15` becomes about `0.92`.");
  }
  if (hasSyntheticTimeSignals) {
    lines.push("The evidence includes derived/synthetic time signals such as `behavior_period`, `month`, `period_date`, or `churn_label`, so data validity is limited.");
  }
  if (shouldUseTable && facts.length) {
    lines.push("Forecasting Facts");
    lines.push("| Signal | Value | Condition/formula | Evidence |");
    lines.push("| --- | ---: | --- | --- |");
    for (const fact of facts) lines.push(`| ${escapeTableCell(fact.signal)} | ${fact.value} | ${escapeTableCell(fact.comparison || fact.raw)} | ${fact.link} |`);
  }
  return lines.join("\n");
}

function inferForecastingScope(items: GroundingEvidenceItem[]) {
  const text = items.map(evidenceItemContentText).join("\n");
  const clusterScoped = /\b(cluster_forecasts|cluster_series|cluster_drifts|cluster_trend_multipliers|cluster_label|cluster_id|fit_cluster_models|get_cluster_state|predicted_cluster|per-cluster|cluster-level)\b/i.test(text);
  const perCustomer = /\b(forecast_customer_risk|customer_history|customer_series|per customer|customer-specific forecast|for customer)\b/i.test(text);
  const aggregate = /\b(global_history|get_global_history_series|global training history|aggregate|aggregated|all customers|overall|portfolio|cohort)\b/i.test(text);
  if (clusterScoped) {
    return {
      kind: "cluster" as const,
      label: "cluster-level / per-segment, not one SARIMA model per customer",
      arabicExplanation: "\u0645\u0634 \u0645\u0648\u062f\u064a\u0644 \u0060SARIMA\u0060 \u062c\u062f\u064a\u062f \u0644\u0643\u0644 \u0060customer\u0060. \u0627\u0644\u0643\u0648\u062f \u0628\u064a\u0628\u0646\u064a \u0060forecast\u0060 \u0644\u0643\u0644 \u0060cluster/segment\u0060. \u0648\u0644\u0645\u0627 \u0060customer\u0060 \u062c\u062f\u064a\u062f \u064a\u062a\u0639\u0627\u0644\u062c\u060c \u0628\u064a\u0633\u062a\u062e\u062f\u0645 \u0060predicted_cluster\u0060 \u0639\u0634\u0627\u0646 \u064a\u062c\u064a\u0628 \u0060forecast\u0060 \u0627\u0644\u0640 cluster \u0628\u062a\u0627\u0639\u0647. \u064a\u0639\u0646\u064a \u0060cluster-level / per-segment\u0060.",
      englishExplanation: "It is not a fresh SARIMA model for every customer. The code builds forecasts per cluster/segment, then each processed customer uses the forecast for its predicted_cluster."
    };
  }
  if (perCustomer && !aggregate) {
    return {
      kind: "per_customer" as const,
      label: "per-customer",
      arabicExplanation: "\u0627\u0644\u0623\u062f\u0644\u0629 \u0628\u062a\u0648\u0636\u062d \u0625\u0646 \u0627\u0644\u0640 \u0060forecast\u0060 \u0645\u0631\u062a\u0628\u0637 \u0628\u0640 \u0060customer\u0060 \u0623\u0648 \u0060customer_history\u0060 \u0646\u0641\u0633\u0647.",
      englishExplanation: "The evidence ties the forecast to a specific customer or customer_history."
    };
  }
  if (aggregate && !perCustomer) {
    return {
      kind: "aggregate" as const,
      label: "aggregate/global",
      arabicExplanation: "\u0627\u0644\u0623\u062f\u0644\u0629 \u0628\u062a\u0648\u0636\u062d \u0625\u0646 \u0627\u0644\u0640 \u0060forecast\u0060 \u0645\u0628\u0646\u064a \u0639\u0644\u0649 \u0060history\u0060 \u0645\u062c\u0645\u0639\u0629 \u0623\u0648 \u0060global\u0060\u060c \u0645\u0634 \u0060customer\u0060 \u0648\u0627\u062d\u062f.",
      englishExplanation: "The evidence points to aggregate/global history rather than one customer."
    };
  }
  if (perCustomer && aggregate) {
    return {
      kind: "mixed" as const,
      label: "mixed: customer-specific and aggregate signals",
      arabicExplanation: "\u0627\u0644\u0623\u062f\u0644\u0629 \u0641\u064a\u0647\u0627 \u0625\u0634\u0627\u0631\u0627\u062a \u0644\u0640 \u0060customer\u0060 \u0648\u0625\u0634\u0627\u0631\u0627\u062a \u0644\u0640 \u0060aggregate history\u0060\u060c \u0641\u0645\u0634 \u0647\u062e\u062a\u0632\u0644\u0647\u0627 \u0641\u064a \u0648\u0627\u062d\u062f \u0628\u0633.",
      englishExplanation: "The evidence contains both customer-specific and aggregate-history signals."
    };
  }
  return {
    kind: "unknown" as const,
    label: "not proven from the current evidence",
    arabicExplanation: "\u0627\u0644\u0645\u0644\u0641\u0627\u062a \u0627\u0644\u0644\u064a \u0627\u062a\u0642\u0631\u062a \u0645\u0627\u0642\u0627\u0644\u062a\u0634 \u0628\u0648\u0636\u0648\u062d \u0627\u0644\u0640 scope.",
    englishExplanation: "The sampled files did not clearly prove the forecasting scope."
  };
}

function summarizeForecastingCadence(items: GroundingEvidenceItem[], arabic: boolean): { sentence: string; evidence: GroundingEvidenceItem[] } | undefined {
  const cadenceEvidence = items
    .filter((item) => {
      const text = evidenceItemContentText(item);
      const trainingOrCadence = /\b(train|training|retrain|retraining|fit_cluster_models|save_state|auto_retrain|auto_retrain_every_customers|AUTO_RETRAIN_CUSTOMER_INTERVAL|processed|customer|customers|interactions?)\b/i.test(text);
      const forecastOrCadence = /\b(forecast|forecasting|arima|sarima|trend|train|retrain|fit_cluster_models|save_state|auto_retrain|AUTO_RETRAIN_CUSTOMER_INTERVAL|customer interactions?)\b/i.test(text);
      return trainingOrCadence && forecastOrCadence;
    })
    .slice(0, 4);
  if (!cadenceEvidence.length) return undefined;
  const text = cadenceEvidence.map(evidenceItemContentText).join("\n");
  const hasTraining = /\b(train_offline_artifacts|fit_cluster_models|save_state|training|retrain|retraining)\b/i.test(text);
  const hasFiftyCustomerCadence = /\b50\b/.test(text) && /\b(customer|customers|processed|auto_retrain|retrain)\b/i.test(text);
  if (arabic) {
    if (hasTraining && hasFiftyCustomerCadence) {
      return {
        sentence: "\u0628\u064a\u062a\u062d\u0633\u0628 \u0645\u0639 \u0627\u0644\u0640 \u0060training/retraining\u0060. \u0648\u0627\u0644\u0640 \u0060auto retrain\u0060 \u0628\u0627\u064a\u0646 \u0625\u0646\u0647 \u0643\u0644 \u006050 customer\u0060.",
        evidence: cadenceEvidence
      };
    }
    if (hasTraining) {
      return {
        sentence: "\u0628\u0627\u064a\u0646 \u0625\u0646\u0647 \u0645\u0631\u062a\u0628\u0637 \u0628\u0627\u0644\u0640 \u0060training\u0060 \u0623\u0648 \u0060retraining\u0060\u060c \u0628\u0633 \u0645\u0627\u0644\u0642\u064a\u062a\u0634 \u0631\u0642\u0645 \u0648\u0627\u0636\u062d \u064a\u0642\u0648\u0644 \u0643\u0644 \u0642\u062f \u0625\u064a\u0647.",
        evidence: cadenceEvidence
      };
    }
    if (hasFiftyCustomerCadence) {
      return {
        sentence: "\u0641\u064a\u0647 \u062f\u0644\u064a\u0644 \u0639\u0644\u0649 \u006050 customer\u0060 \u0643\u0640 cadence\u060c \u0628\u0633 \u0631\u0628\u0637\u0647 \u0628\u0627\u0644\u0640 \u0060forecast\u0060 \u0646\u0641\u0633\u0647 \u0645\u062d\u062a\u0627\u062c \u062f\u0644\u064a\u0644 \u0623\u0648\u0636\u062d.",
        evidence: cadenceEvidence
      };
    }
  }
  if (hasTraining && hasFiftyCustomerCadence) {
    return {
      sentence: "The forecast appears to be recomputed with training/retraining, with evidence for a 50-customer cadence.",
      evidence: cadenceEvidence
    };
  }
  if (hasTraining) {
    return {
      sentence: "The forecast appears tied to training or retraining, but I did not find a proven numeric cadence.",
      evidence: cadenceEvidence
    };
  }
  if (hasFiftyCustomerCadence) {
    return {
      sentence: "I found evidence of a 50-customer cadence, but not enough to tie it directly to forecast recomputation.",
      evidence: cadenceEvidence
    };
  }
  return undefined;
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
  const limit = isThresholdInventoryConcept(grounding)
    ? 300
    : isForecastingScopeConcept(grounding) || isPageInventoryConcept(grounding) ? 120 : 40;
  return uniqueEvidenceItems([
    ...grounding.supportingEvidence,
    ...grounding.projectDomain.evidence,
    ...grounding.understanding.sourceEvidence,
    ...grounding.understanding.dataFlowEvidence,
    ...grounding.understanding.validationEvidence,
    ...grounding.workspaceReasoning.evidencePack.items,
    ...grounding.workspaceReasoning.evidencePack.topicItems,
    ...grounding.workspaceReasoning.evidencePack.byFacet.algorithms_models,
    ...grounding.workspaceReasoning.evidencePack.byFacet.code_symbols,
    ...grounding.workspaceReasoning.evidencePack.byFacet.data_flow,
    ...grounding.workspaceReasoning.evidencePack.byFacet.numeric_logic
  ]).slice(0, limit);
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
      if (!line || line.length > 1000) continue;
      const fact = parseNumericFactLine(line, item);
      if (!fact) continue;
      const key = `${fact.path}:${fact.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
      if (facts.length >= 120) return facts;
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

function formatNonShallowForecastLinks(items: GroundingEvidenceItem[]) {
  return uniqueEvidenceItems(items)
    .map(forecastEvidenceLinkOrPath)
    .filter(Boolean)
    .join(", ");
}

function forecastEvidenceLinkOrPath(item: GroundingEvidenceItem) {
  if (item.line <= 1 && /\bbackend\/(?:routes|services\/arima_model)\.py$/i.test(item.path.replaceAll("\\", "/"))) {
    return `\`${item.path}\``;
  }
  return item.markdownLink;
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
  return /(?:\uFFFD|\u0637\u00a7\u0638|\u0638\u067e\u0638|\u0637\u00a8\u0637|\u0638\u2026\u0637|\u0637\u00a7\u0637|\u0638\u201e\u0638)/.test(value)
    ? "current-workspace evidence"
    : value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
