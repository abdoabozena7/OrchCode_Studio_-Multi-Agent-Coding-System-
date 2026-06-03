import { createEvidenceProvenance, isProductionEvidence } from "./EvidenceHygiene.js";
import type {
  AgenticEvidenceGraph,
  AgenticEvidenceItem,
  AgenticEvidenceType,
  AgenticOpenedFile,
  AgenticRelationship,
  AgenticTaskIntent
} from "./AgenticTaskModels.js";

export function buildAgenticEvidenceGraph(input: {
  prompt: string;
  intent: AgenticTaskIntent;
  openedFiles: AgenticOpenedFile[];
  relationships: AgenticRelationship[];
  fileExists: (relativePath: string) => boolean;
  maxEvidenceItems: number;
}): AgenticEvidenceGraph {
  const items: AgenticEvidenceItem[] = [];
  for (const file of input.openedFiles) {
    if (items.length >= input.maxEvidenceItems) break;
    const snippets = evidenceSnippets(file.content, input.intent);
    for (const snippet of snippets) {
      if (items.length >= input.maxEvidenceItems) break;
      const provenance = createEvidenceProvenance({
        sourceFile: file.path,
        citedPath: file.path,
        line: snippet.lineStart,
        snippet: snippet.text,
        prompt: input.prompt,
        fileExists: input.fileExists
      });
      const evidenceType = evidenceTypeForSource(provenance.sourceType, file.path);
      const canSupportProductionBehavior = isProductionEvidence(provenance);
      const provenanceStatus = canSupportProductionBehavior
        ? "accepted"
        : input.intent.requiresProductionEvidence
          ? provenance.sourceType === "test_source" || provenance.sourceType === "documentation"
            ? "downgraded"
            : "rejected"
          : provenance.confidence === "low"
            ? "downgraded"
            : "accepted";
      items.push({
        id: `ev_${items.length + 1}`,
        path: file.path,
        lineStart: snippet.lineStart,
        lineEnd: snippet.lineEnd,
        symbol: snippet.symbol,
        evidenceType,
        sourceType: provenance.sourceType,
        provenanceStatus,
        provenance,
        relevanceReason: snippet.reason,
        readMode: file.readMode,
        supportedClaimIds: [],
        canSupportProductionBehavior,
        confidence: lowerConfidence(snippet.confidence, provenance.confidence),
        freshness: provenance.pathVerification.existsOnDisk ? "current_workspace" : "stale_or_unknown",
        snippet: snippet.text
      });
    }
  }
  const accepted = items.filter((item) => item.provenanceStatus === "accepted");
  const downgraded = items.filter((item) => item.provenanceStatus === "downgraded");
  const rejected = items.filter((item) => item.provenanceStatus === "rejected");
  const byPath: Record<string, AgenticEvidenceItem[]> = {};
  for (const item of items) {
    byPath[item.path] ??= [];
    byPath[item.path].push(item);
  }
  return {
    items,
    relationships: input.relationships,
    accepted,
    downgraded,
    rejected,
    byPath,
    summary: {
      productionEvidenceCount: accepted.filter((item) => item.canSupportProductionBehavior).length,
      supportEvidenceCount: accepted.length + downgraded.length,
      rejectedEvidenceCount: rejected.length,
      confidence: accepted.length >= 3 ? "high" : accepted.length ? "medium" : "low"
    }
  };
}

function evidenceSnippets(content: string, intent: AgenticTaskIntent) {
  const lines = content.split(/\r?\n/);
  const terms = uniqueStrings([...intent.terms, ...intent.aliases]).map((term) => term.toLowerCase()).filter((term) => term.length > 1);
  const snippets: Array<{ lineStart: number; lineEnd: number; text: string; symbol?: string; reason: string; confidence: "high" | "medium" | "low" }> = [];
  const addWindow = (index: number, reason: string, confidence: "high" | "medium" | "low") => {
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 3);
    snippets.push({
      lineStart: start + 1,
      lineEnd: end,
      text: lines.slice(start, end).join("\n").slice(0, 1_200),
      symbol: symbolNear(lines, index),
      reason,
      confidence
    });
  };
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (terms.some((term) => lower.includes(term))) addWindow(index, "Line matched task term or alias.", "high");
    else if (modeKeywordMatch(lower, intent.mode)) addWindow(index, `Line matched ${intent.mode} reading cue.`, "medium");
  });
  if (!snippets.length) {
    const firstUseful = lines.findIndex((line) => /\S/.test(line));
    if (firstUseful >= 0) addWindow(firstUseful, "Opened as part of the adaptive read plan.", "low");
  }
  return dedupeSnippets(snippets).slice(0, 5);
}

function modeKeywordMatch(line: string, mode: AgenticTaskIntent["mode"]) {
  if (mode === "architecture_explain") return /\b(import|export|router|runtime|orchestrator|provider|manager|service|entry)\b/i.test(line);
  if (mode === "data_flow") return /\b(fetch|load|ingest|pipeline|dataset|storage|repository|api|route|stream)\b/i.test(line);
  if (mode === "ui_flow") return /\b(route|button|click|component|screen|page|handler|state|props)\b/i.test(line);
  if (mode === "debugging_analysis") return /\b(error|throw|catch|fail|validation|warning|timeout)\b/i.test(line);
  if (mode === "repair_planning") return /\b(failed|validation|sandbox|review|repair|rollback|conflict)\b/i.test(line);
  return /\b(class|function|def|const|export|import|route|service|config)\b/i.test(line);
}

function symbolNear(lines: string[], index: number) {
  for (let cursor = index; cursor >= Math.max(0, index - 12); cursor--) {
    const match = lines[cursor]?.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function evidenceTypeForSource(sourceType: AgenticEvidenceItem["sourceType"], filePath: string): AgenticEvidenceType {
  if (sourceType === "production_source") return "production_source";
  if (sourceType === "test_source") return "test";
  if (sourceType === "fixture_generated_path") return "fixture";
  if (sourceType === "tmp_artifact") return "tmp";
  if (sourceType === "memory_artifact") return "memory";
  if (sourceType === "generated_report") return "generated";
  if (sourceType === "documentation") return "docs";
  if (sourceType === "config") return "config";
  if (/smoke/i.test(filePath)) return "smoke";
  if (sourceType === "runtime_state") return "artifact";
  return "unknown";
}

function lowerConfidence(left: "high" | "medium" | "low", right: "high" | "medium" | "low") {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[left] < rank[right] ? left : right;
}

function dedupeSnippets<T extends { lineStart: number; text: string }>(snippets: T[]) {
  const seen = new Set<string>();
  return snippets.filter((snippet) => {
    const key = `${snippet.lineStart}:${snippet.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
