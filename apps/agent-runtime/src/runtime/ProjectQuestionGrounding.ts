import type { ProjectExplainReport } from "@hivo/protocol";

import {
  analyzeWorkspaceReasoning,
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
}function formatEvidenceGroupCoverage(coverage: ConceptEvidenceGroupCoverage[]) {
  return coverage
    .map((group) => `${group.id}: ${group.found ? `found (${group.refs.slice(0, 4).join(", ")})` : "missing"}`)
    .join(" | ");
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

function formatConceptLabel(concept: RequestedConcept) {
  return concept.displayLabel ?? concept.label;
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
