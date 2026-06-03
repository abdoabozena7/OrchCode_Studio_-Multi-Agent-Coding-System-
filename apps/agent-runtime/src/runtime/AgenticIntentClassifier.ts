import type { AgenticTaskIntent, AgenticTaskMode } from "./AgenticTaskModels.js";
import { prepareWorkspacePromptForUnderstanding } from "./IntentDecisionEngine.js";

const ENGLISH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "code", "codebase", "current", "do", "does",
  "explain", "for", "from", "give", "have", "here", "how", "i", "in", "inside", "is", "it", "me",
  "of", "on", "please", "project", "show", "system", "tell", "that", "the", "this", "to", "what",
  "where", "which", "with", "work", "works", "workspace"
]);

const ARABIC_STOP_WORDS = new Set([
  "\u0627\u0634\u0631\u062d",
  "\u0627\u0634\u0631\u062d\u0644\u064a",
  "\u0627\u064a\u0647",
  "\u0625\u064a\u0647",
  "\u0627\u0632\u0627\u064a",
  "\u0625\u0632\u0627\u064a",
  "\u0628\u064a\u062a\u0637\u0628\u0642",
  "\u0628\u062a\u062a\u0637\u0628\u0642",
  "\u0645\u062a\u0637\u0628\u0642",
  "\u0628\u064a\u0634\u062a\u063a\u0644",
  "\u0628\u062a\u0634\u062a\u063a\u0644",
  "\u0627\u0644\u0645\u0634\u0631\u0648\u0639",
  "\u0645\u0634\u0631\u0648\u0639",
  "\u0627\u0644\u0633\u064a\u0633\u062a\u0645",
  "\u0633\u064a\u0633\u062a\u0645",
  "\u062f\u0627",
  "\u062f\u0647",
  "\u0647\u0646\u0627",
  "\u0641\u064a",
  "\u0645\u0646",
  "\u0639\u0644\u0649"
]);

const MODE_PATTERNS: Array<{ mode: AgenticTaskMode; patterns: RegExp[] }> = [
  { mode: "repair_planning", patterns: [/\b(repair|fix plan|repair plan|failed stage|rollback|apply conflict)\b/i] },
  { mode: "debugging_analysis", patterns: [/\b(debug|bug|error|failure|failed|exception|stack trace|root cause|why.*break)\b/i, /(?:\u0628\u0627\u0638|\u0627\u064a\u0631\u0648\u0631|\u062e\u0637\u0623|\u063a\u0644\u0637|\u0645\u0634\u0643\u0644\u0629|\u0633\u0628\u0628)/u] },
  { mode: "validation_planning", patterns: [/\b(validate|validation|test strategy|verify|verification plan|checks?)\b/i] },
  { mode: "review_reasoning", patterns: [/\b(review|assess|risks?|correctness|safety|regression)\b/i, /(?:\u0631\u0627\u062c\u0639|\u062a\u0642\u064a\u064a\u0645|\u0645\u0646\u0637\u0642\u064a)/u] },
  { mode: "patch_preparation", patterns: [/\b(patch prepare|prepare patch|patch proposal|change set|write contract)\b/i] },
  { mode: "refactor_planning", patterns: [/\b(refactor|restructure|cleanup|split module|migration plan)\b/i] },
  { mode: "coding_planning", patterns: [/\b(plan.*(implement|build|add)|implementation plan|coding plan|how should we implement)\b/i] },
  { mode: "docs_generation", patterns: [/\b(document|docs|readme|onboarding|project map)\b/i] },
  { mode: "design_assessment", patterns: [/\b(design|architecture quality|assessment|is this good|is this logical|tradeoff|production-grade)\b/i, /(?:\u062a\u0635\u0645\u064a\u0645|\u0645\u0646\u0637\u0642\u064a|\u0635\u062d|\u063a\u0644\u0637|\u064a\u0646\u0641\u0639)/u] },
  { mode: "architecture_explain", patterns: [/\b(architecture|architectural|modules?|components?|entrypoints?|system design|how.*structured)\b/i, /(?:\u0627\u0644\u0645\u0639\u0645\u0627\u0631\u064a\u0629|\u0627\u0644\u0647\u064a\u0643\u0644|\u0627\u0644\u0645\u0648\u062f\u064a\u0648\u0644\u0627\u062a)/u] },
  { mode: "data_flow", patterns: [/\b(data flow|flow|pipeline|ingest|dataset|realtime|from.*to|how.*data)\b/i, /(?:\u0627\u0644\u062f\u0627\u062a\u0627|\u062f\u0627\u062a\u0627|\u0628\u064a\u0627\u0646\u0627\u062a|\u0641\u0644\u0648)/u] },
  { mode: "ui_flow", patterns: [/\b(ui flow|screen|page|route|button|frontend|navigation|browser)\b/i, /(?:\u0635\u0641\u062d\u0629|\u0634\u0627\u0634\u0629|\u0632\u0631|\u0648\u0627\u062c\u0647\u0629)/u] },
  { mode: "backend_flow", patterns: [/\b(api|backend|endpoint|route|controller|service flow|request flow)\b/i] },
  { mode: "config_explain", patterns: [/\b(config|configuration|settings|env|package|tsconfig|vite|docker)\b/i] },
  { mode: "feature_existence", patterns: [/\b(is there|do we have|exists?|implemented|support(s|ed)?|feature present)\b/i, /(?:\u0647\u0644\s+\u0641\u064a|\u0645\u0648\u062c\u0648\u062f|\u0645\u062a\u0637\u0628\u0642)/u] },
  { mode: "feature_explain", patterns: [/\b(feature|capability|how.*implemented|how.*works)\b/i, /(?:\u0627\u0632\u0627\u064a|\u0625\u0632\u0627\u064a).*(?:\u0628\u064a\u062a\u0637\u0628\u0642|\u0645\u062a\u0637\u0628\u0642|\u0628\u064a\u0634\u062a\u063a\u0644|\u0628\u062a\u0634\u062a\u063a\u0644)/u] }
];

export function classifyAgenticTaskIntent(prompt: string, modeHint?: AgenticTaskMode): AgenticTaskIntent {
  const prepared = prepareWorkspacePromptForUnderstanding(prompt);
  const workspacePrompt = prepared.workspaceMessage || prompt;
  const language = /[\u0600-\u06ff]/.test(prompt) ? "arabic" : "english";
  const mode = modeHint ?? detectMode(workspacePrompt);
  const terms = extractTerms(workspacePrompt, language);
  const aliases = expandAliases(terms, mode);
  const targetPaths = Array.from(workspacePrompt.matchAll(/\b(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\b/g)).map((match) => match[0]);
  const requiresProductionEvidence = mode === "feature_existence"
    || mode === "patch_preparation"
    || mode === "coding_planning"
    || mode === "review_reasoning"
    || mode === "design_assessment";
  const complexity = isComplex(workspacePrompt, mode) ? "complex" : "simple";
  return {
    mode,
    language,
    topic: terms.slice(0, 5).join(" ") || "current project",
    terms,
    aliases,
    targetPaths,
    requiresProductionEvidence,
    complexity,
    confidence: mode === "unknown" ? "low" : terms.length ? "high" : "medium"
  };
}

function detectMode(prompt: string): AgenticTaskMode {
  for (const candidate of MODE_PATTERNS) {
    if (candidate.patterns.some((pattern) => pattern.test(prompt))) return candidate.mode;
  }
  if (/\b(explain|what is|how does|summarize)\b/i.test(prompt) || /(?:\u0627\u0634\u0631\u062d|\u0627\u064a\u0647|\u0625\u064a\u0647)/u.test(prompt)) {
    return "project_explain";
  }
  return "unknown";
}

function extractTerms(prompt: string, language: AgenticTaskIntent["language"]) {
  const words = prompt
    .replace(/[^\p{L}\p{N}_./-]+/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length > 1)
    .filter((word) => !ENGLISH_STOP_WORDS.has(word.toLowerCase()))
    .filter((word) => language !== "arabic" || !ARABIC_STOP_WORDS.has(word));
  return uniqueStrings(words).slice(0, 24);
}

function expandAliases(terms: string[], mode: AgenticTaskMode) {
  const aliases = new Set<string>();
  for (const term of terms) {
    aliases.add(term);
    aliases.add(term.replaceAll("-", "_"));
    aliases.add(term.replaceAll("_", "-"));
  }
  if (mode === "architecture_explain") ["entrypoint", "router", "orchestrator", "runtime", "protocol", "types", "config"].forEach((term) => aliases.add(term));
  if (mode === "data_flow") ["ingest", "pipeline", "loader", "service", "api", "storage", "repository"].forEach((term) => aliases.add(term));
  if (mode === "ui_flow") ["route", "router", "component", "button", "screen", "page", "handler"].forEach((term) => aliases.add(term));
  if (mode === "debugging_analysis") ["error", "throw", "catch", "fail", "validation", "log"].forEach((term) => aliases.add(term));
  return uniqueStrings([...aliases]).slice(0, 48);
}

function isComplex(prompt: string, mode: AgenticTaskMode) {
  if (["architecture_explain", "data_flow", "ui_flow", "backend_flow", "design_assessment", "debugging_analysis", "refactor_planning", "coding_planning", "patch_preparation", "review_reasoning", "validation_planning", "repair_planning"].includes(mode)) {
    return true;
  }
  return prompt.length > 120 || /\b(detailed|deep|step by step|architecture|flow|why|how)\b/i.test(prompt);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
