import type {
  EvidenceDirectness,
  EvidenceFileTier,
  EvidencePathVerification,
  EvidenceProvenance,
  EvidenceSourceType,
  EvidenceTruthReport,
  GroundedEvidenceItem,
  RejectedEvidenceItem
} from "@hivo/protocol";

export type EvidencePathDecision = {
  path: string;
  tier: EvidenceFileTier;
  excluded: boolean;
  reason?: string;
};

export type EvidenceProvenanceInput = {
  sourceFile: string;
  citedPath?: string;
  line?: number;
  snippet?: string;
  prompt: string;
  fileExists?: (relativePath: string) => boolean;
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
  ".hivo-agent-runtime",
  ".orchcode-agent-runtime"
]);

const GENERATED_DIRECTORY_PATTERNS = [
  /(^|\/)\.agent_memory\/(swarm_runs|swarm_trials|trial-memory)(\/|$)/i,
  /(^|\/)(full-system-audit|root-cause-audit)(\/|$)/i,
  /(^|\/)(smoke-output|smoke-outputs|smoke-results|smoke-runs|inspect-provider-truth)(\/|$)/i,
  /(^|\/)(runtime-snapshots?|snapshots?)(\/|$)/i
];

const RUNTIME_STATE_PATTERNS = [
  /(^|\/)\.hivo-agent-runtime(\/|$)/i,
  /(^|\/)\.orchcode-agent-runtime(\/|$)/i,
  /(^|\/)(sessions\.json|runtime_events|session_events)(\/|$)/i,
  /(^|\/)\.agent_memory\/(swarm_runs|swarm_trials|trial-memory)(\/|$)/i
];

const TEST_RE = /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[a-z0-9]+$/i;
const DOC_RE = /\.(md|mdx|rst|txt)$/i;
const CONFIG_RE = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|tsconfig\.json|vite\.config\.[tj]s|next\.config\.[tj]s|tauri\.conf\.json|dockerfile|compose\.ya?ml)$/i;
const GENERATED_REPORT_RE = /(^|\/)(full-system-audit|root-cause-audit|audit|audits?|reports?|smoke-output|smoke-outputs|smoke-results|inspect-provider-truth)(\/|$)|(?:audit|report|results?)\.(json|md|txt)$/i;
const MEMORY_ARTIFACT_RE = /(^|\/)\.agent_memory\/|(^|\/)(swarm_runs|swarm_trials|trial-memory)(\/|$)/i;
const TMP_ARTIFACT_RE = /(^|\/)(tmp|\.tmp-run)(\/|$)/i;
const SMOKE_FIXTURE_SCRIPT_RE = /(^|\/)scripts\/.*(?:smoke|fixture|inspect-provider-truth).*\.ts$/i;
const FIXTURE_RE = /(?:writeFile\s*\(\s*path\.join\s*\(\s*workspace|createWorkspace|fixtureWorkspace|create.*Fixture|fixture\.workspace|mock workspace|mock repo|fixture repo|path\.join\s*\(\s*workspace)/i;
const PATH_LIKE_RE = /\b(?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+\b/g;

export function allowGeneratedEvidenceForPrompt(prompt: string) {
  return /\b(tmp|generated|artifact|artifacts|audit|audits|log|logs|runtime state|runtime_state|session state|sessions\.json|smoke output|full-system-audit|root-cause-audit|\.agent_memory|\.hivo-agent-runtime|\.orchcode-agent-runtime)\b/i.test(prompt)
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

export function classifyEvidenceSource(filePath: string, snippet = "", prompt = ""): EvidenceSourceType {
  const normalized = normalizeEvidencePath(filePath);
  const haystack = `${normalized}\n${snippet}`;
  if (MEMORY_ARTIFACT_RE.test(normalized)) return "memory_artifact";
  if (RUNTIME_STATE_PATTERNS.some((pattern) => pattern.test(normalized))) return "runtime_state";
  if (TMP_ARTIFACT_RE.test(normalized)) return GENERATED_REPORT_RE.test(normalized) ? "generated_report" : "tmp_artifact";
  if (GENERATED_REPORT_RE.test(normalized)) return "generated_report";
  if (SMOKE_FIXTURE_SCRIPT_RE.test(normalized)) return "fixture_generated_path";
  if (fixtureMentionedPath(haystack)) return "fixture_generated_path";
  if (TEST_RE.test(normalized)) return fixtureMentionedPath(haystack) ? "fixture_generated_path" : "test_source";
  if (DOC_RE.test(normalized) || /(^|\/)docs?\//i.test(normalized)) return "documentation";
  if (CONFIG_RE.test(normalized) || /\.(json|toml|ya?ml)$/i.test(normalized)) return "config";
  if (isGeneratedPath(normalized)) return allowGeneratedEvidenceForPrompt(prompt) ? "generated_report" : "tmp_artifact";
  if (/\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|py|rs|ts|tsx)$/i.test(normalized)) return "production_source";
  return "unknown";
}

export function evidenceSourceTypeToTier(sourceType: EvidenceSourceType): EvidenceFileTier {
  if (sourceType === "test_source" || sourceType === "fixture_generated_path") return "test";
  if (sourceType === "documentation") return "docs";
  if (sourceType === "tmp_artifact" || sourceType === "generated_report" || sourceType === "memory_artifact") return "generated";
  if (sourceType === "runtime_state") return "runtime_state";
  if (sourceType === "config") return "config";
  return "source_code";
}

export function createEvidenceProvenance(input: EvidenceProvenanceInput): EvidenceProvenance {
  const sourceFile = normalizeEvidencePath(input.sourceFile);
  const citedPath = normalizeEvidencePath(input.citedPath ?? sourceFile);
  const mentionedPaths = extractMentionedPaths(input.snippet ?? "");
  const pathVerification = verifyEvidencePath({
    sourceFile,
    citedPath,
    mentionedPaths,
    fileExists: input.fileExists
  });
  const sourceType = classifyEvidenceSource(sourceFile, input.snippet, input.prompt);
  const directness = directnessForSource(sourceType, pathVerification);
  const confidence = confidenceForProvenance(sourceType, pathVerification);
  const reason = reasonForProvenance(sourceType, pathVerification);
  return {
    sourceFile,
    citedPath,
    mentionedPaths,
    sourceType,
    pathVerification,
    directness,
    confidence,
    reason
  };
}

export function isProductionEvidence(provenance?: EvidenceProvenance) {
  return Boolean(provenance
    && (provenance.sourceType === "production_source" || provenance.sourceType === "config")
    && provenance.pathVerification.existsOnDisk
    && provenance.pathVerification.safePath
    && !provenance.pathVerification.mentionedOnly);
}

export function canProveImplementation(provenance?: EvidenceProvenance) {
  return isProductionEvidence(provenance) && provenance?.directness === "direct_implementation";
}

export function evidenceItemForReport(input: {
  ref: string;
  provenance: EvidenceProvenance;
}): GroundedEvidenceItem | RejectedEvidenceItem {
  const common = {
    ref: input.ref,
    sourceFile: input.provenance.sourceFile,
    citedPath: input.provenance.citedPath,
    sourceType: input.provenance.sourceType,
    reason: input.provenance.reason
  };
  if (isProductionEvidence(input.provenance) || input.provenance.sourceType === "test_source" || input.provenance.sourceType === "documentation") {
    return {
      ...common,
      existsOnDisk: input.provenance.pathVerification.existsOnDisk,
      directness: input.provenance.directness,
      confidence: input.provenance.confidence
    };
  }
  return common;
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
  groundedEvidence?: GroundedEvidenceItem[];
  rejectedEvidence?: RejectedEvidenceItem[];
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
    groundedEvidence: input.groundedEvidence?.slice(0, 80),
    rejectedEvidence: input.rejectedEvidence?.slice(0, 80),
    generatedEvidenceExcludedCount: excluded.filter((decision) => decision.tier === "generated" || decision.tier === "runtime_state").length,
    generatedEvidenceIncludedCount: evidenceFilesByTier.generated.length + evidenceFilesByTier.runtime_state.length,
    generatedEvidenceIncluded: evidenceFilesByTier.generated.length > 0 || evidenceFilesByTier.runtime_state.length > 0,
    allowGeneratedEvidence: allowGeneratedEvidenceForPrompt(input.prompt),
    updatedAt: new Date().toISOString()
  } satisfies EvidenceTruthReport;
}

function verifyEvidencePath(input: {
  sourceFile: string;
  citedPath: string;
  mentionedPaths: string[];
  fileExists?: (relativePath: string) => boolean;
}): EvidencePathVerification {
  const safePath = isSafeRelativePath(input.citedPath);
  const pathTraversalRejected = !safePath;
  const existsOnDisk = safePath ? Boolean(input.fileExists?.(input.citedPath)) : false;
  const mentionedOnly = input.citedPath !== input.sourceFile
    || (!existsOnDisk && input.mentionedPaths.includes(input.citedPath));
  return {
    sourceFile: input.sourceFile,
    citedPath: input.citedPath,
    existsOnDisk,
    safePath,
    pathTraversalRejected,
    mentionedOnly
  };
}

function isSafeRelativePath(filePath: string) {
  if (!filePath || filePath.startsWith("/") || /^[A-Za-z]:\//.test(filePath)) return false;
  return !filePath.split("/").some((part) => part === "..");
}

function directnessForSource(sourceType: EvidenceSourceType, verification: EvidencePathVerification): EvidenceDirectness {
  if (!verification.safePath || !verification.existsOnDisk || verification.mentionedOnly) return "unknown";
  if (sourceType === "production_source" || sourceType === "config") return "direct_implementation";
  if (sourceType === "test_source" || sourceType === "fixture_generated_path") return "indirect_test_or_fixture";
  if (sourceType === "documentation") return "documentation_only";
  if (sourceType === "tmp_artifact" || sourceType === "memory_artifact" || sourceType === "generated_report" || sourceType === "runtime_state") return "generated_artifact";
  return "unknown";
}

function confidenceForProvenance(sourceType: EvidenceSourceType, verification: EvidencePathVerification): "high" | "medium" | "low" {
  if (!verification.safePath || !verification.existsOnDisk || verification.mentionedOnly) return "low";
  if (sourceType === "production_source" || sourceType === "config") return "high";
  if (sourceType === "test_source" || sourceType === "documentation") return "medium";
  return "low";
}

function reasonForProvenance(sourceType: EvidenceSourceType, verification: EvidencePathVerification) {
  if (!verification.safePath) return "Rejected unsafe or path-traversal citation.";
  if (!verification.existsOnDisk) return "Cited path does not exist in the current workspace.";
  if (verification.mentionedOnly) return "Cited path is only mentioned from another source file.";
  if (sourceType === "fixture_generated_path") return "Evidence appears inside a test fixture or mock workspace.";
  if (sourceType === "test_source") return "Evidence is from tests; it proves expectations, not production implementation.";
  if (sourceType === "documentation") return "Evidence is documentation; it explains intent, not direct implementation.";
  if (sourceType === "tmp_artifact" || sourceType === "memory_artifact" || sourceType === "generated_report") return "Evidence is generated/runtime artifact context.";
  return "Evidence path exists and is usable with its classified source type.";
}

function extractMentionedPaths(snippet: string) {
  return uniqueStrings(Array.from(snippet.matchAll(PATH_LIKE_RE)).map((match) => normalizeEvidencePath(match[0] ?? "")));
}

function fixtureMentionedPath(text: string) {
  return FIXTURE_RE.test(text) && extractMentionedPaths(text).length > 0;
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
