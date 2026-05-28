import type { EvidenceFileTier, EvidenceTruthReport } from "@hivo/protocol";

export type EvidencePathDecision = {
  path: string;
  tier: EvidenceFileTier;
  excluded: boolean;
  reason?: string;
};

const GENERATED_SEGMENTS = new Set([
  "tmp",
  "dist",
  "build",
  "target",
  ".next",
  "node_modules",
  "coverage",
  ".coverage",
  "htmlcov",
  ".hivo-agent-runtime"
]);

const GENERATED_DIRECTORY_PATTERNS = [
  /(^|\/)\.agent_memory\/(swarm_runs|swarm_trials|trial-memory)(\/|$)/i,
  /(^|\/)(full-system-audit|root-cause-audit)(\/|$)/i,
  /(^|\/)(smoke-output|smoke-outputs|smoke-results|smoke-runs|inspect-provider-truth)(\/|$)/i,
  /(^|\/)(runtime-snapshots?|snapshots?)(\/|$)/i
];

const RUNTIME_STATE_PATTERNS = [
  /(^|\/)\.hivo-agent-runtime(\/|$)/i,
  /(^|\/)(sessions\.json|runtime_events|session_events)(\/|$)/i,
  /(^|\/)\.agent_memory\/(swarm_runs|swarm_trials|trial-memory)(\/|$)/i
];

const TEST_RE = /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[a-z0-9]+$/i;
const DOC_RE = /\.(md|mdx|rst|txt)$/i;
const CONFIG_RE = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|tsconfig\.json|vite\.config\.[tj]s|next\.config\.[tj]s|tauri\.conf\.json|dockerfile|compose\.ya?ml)$/i;

export function allowGeneratedEvidenceForPrompt(prompt: string) {
  return /\b(tmp|generated|artifact|artifacts|audit|audits|log|logs|runtime state|runtime_state|session state|sessions\.json|smoke output|full-system-audit|root-cause-audit|\.agent_memory|\.hivo-agent-runtime)\b/i.test(prompt)
    || /(?:لوج|لوجات|سجل|سجلات|تقرير|تقارير|اوديت|أوديت|توليد|مولد|حالة التشغيل)/i.test(prompt);
}

export function normalizeEvidencePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function classifyEvidencePath(filePath: string): EvidenceFileTier {
  const normalized = normalizeEvidencePath(filePath);
  if (RUNTIME_STATE_PATTERNS.some((pattern) => pattern.test(normalized))) return "runtime_state";
  if (isGeneratedPath(normalized)) return "generated";
  if (TEST_RE.test(normalized)) return "test";
  if (DOC_RE.test(normalized) || /(^|\/)docs?\//i.test(normalized)) return "docs";
  if (CONFIG_RE.test(normalized) || /\.(json|toml|ya?ml)$/i.test(normalized)) return "config";
  return "source_code";
}

export function evidencePathDecision(filePath: string, prompt: string): EvidencePathDecision {
  const normalized = normalizeEvidencePath(filePath);
  const tier = classifyEvidencePath(normalized);
  const generated = tier === "generated" || tier === "runtime_state";
  if (generated && !allowGeneratedEvidenceForPrompt(prompt)) {
    return {
      path: normalized,
      tier,
      excluded: true,
      reason: tier === "runtime_state"
        ? "runtime_state_excluded_by_default"
        : "generated_artifact_excluded_by_default"
    };
  }
  return { path: normalized, tier, excluded: false };
}

export function filterProjectEvidencePaths(filePaths: string[], prompt: string) {
  const included: string[] = [];
  const excluded: EvidencePathDecision[] = [];
  for (const filePath of filePaths) {
    const decision = evidencePathDecision(filePath, prompt);
    if (decision.excluded) excluded.push(decision);
    else included.push(decision.path);
  }
  return {
    included: uniqueStrings(included),
    excluded: dedupeDecisions(excluded),
    allowGeneratedEvidence: allowGeneratedEvidenceForPrompt(prompt)
  };
}

export function shouldIgnoreEvidenceDirectory(relativePath: string, prompt: string) {
  return evidencePathDecision(`${normalizeEvidencePath(relativePath)}/placeholder.txt`, prompt).excluded;
}

export function buildEvidenceTruthReport(input: {
  prompt: string;
  excluded: EvidencePathDecision[];
  candidateFiles: string[];
  openedFiles: string[];
  finalEvidenceRefs: string[];
}) {
  const finalFiles = uniqueStrings(input.finalEvidenceRefs.map(pathFromEvidenceRef).filter((file): file is string => Boolean(file)));
  const topEvidenceFiles = uniqueStrings([...finalFiles, ...input.openedFiles, ...input.candidateFiles]).slice(0, 20);
  const evidenceFilesByTier: EvidenceTruthReport["evidenceFilesByTier"] = {
    source_code: [],
    test: [],
    docs: [],
    generated: [],
    runtime_state: [],
    config: []
  };
  for (const file of uniqueStrings([...topEvidenceFiles, ...finalFiles])) {
    evidenceFilesByTier[classifyEvidencePath(file)].push(file);
  }
  for (const tier of Object.keys(evidenceFilesByTier) as EvidenceFileTier[]) {
    evidenceFilesByTier[tier] = uniqueStrings(evidenceFilesByTier[tier]).slice(0, 30);
  }
  const excluded = dedupeDecisions(input.excluded);
  const exclusionReasons = Object.fromEntries(excluded.map((decision) => [decision.path, decision.reason ?? "excluded"]));
  return {
    topEvidenceFiles,
    evidenceFilesByTier,
    excludedEvidenceCandidates: excluded.map((decision) => decision.path),
    exclusionReasons,
    finalEvidenceFilesActuallyUsed: finalFiles.slice(0, 40),
    generatedEvidenceExcludedCount: excluded.filter((decision) => decision.tier === "generated" || decision.tier === "runtime_state").length,
    generatedEvidenceIncludedCount: evidenceFilesByTier.generated.length + evidenceFilesByTier.runtime_state.length,
    generatedEvidenceIncluded: evidenceFilesByTier.generated.length > 0 || evidenceFilesByTier.runtime_state.length > 0,
    allowGeneratedEvidence: allowGeneratedEvidenceForPrompt(input.prompt),
    updatedAt: new Date().toISOString()
  } satisfies EvidenceTruthReport;
}

function isGeneratedPath(normalizedPath: string) {
  const parts = normalizedPath.split("/");
  if (parts.some((part) => GENERATED_SEGMENTS.has(part))) return true;
  return GENERATED_DIRECTORY_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function pathFromEvidenceRef(ref: string) {
  const normalized = normalizeEvidencePath(ref);
  const match = normalized.match(/^(.+):(\d+)$/);
  return match?.[1] ?? (normalized ? normalized : undefined);
}

function dedupeDecisions(decisions: EvidencePathDecision[]) {
  const seen = new Set<string>();
  const result: EvidencePathDecision[] = [];
  for (const decision of decisions) {
    if (seen.has(decision.path)) continue;
    seen.add(decision.path);
    result.push(decision);
  }
  return result;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
