import type { ReasoningEvidenceRef } from "@hivo/protocol";

const MAX_APPENDED_EVIDENCE_LINKS = 12;

export function appendProviderEvidenceLinks(
  answerMarkdown: string,
  citedEvidenceIds: string[] | undefined,
  evidenceRefs: ReasoningEvidenceRef[] | undefined,
  language: "arabic" | "english" | string | undefined
) {
  const citedIds = citedEvidenceIds?.filter(Boolean) ?? [];
  if (!answerMarkdown.trim() || !citedIds.length || !evidenceRefs?.length) return answerMarkdown;

  const evidenceById = new Map(evidenceRefs.map((ref) => [ref.id, ref]));
  const linkedRows: string[] = [];
  const seenTargets = new Set<string>();

  for (const evidenceId of citedIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence?.path) continue;
    const line = normalizeEvidenceLine(evidence.startLine);
    const lineEnd = normalizeEvidenceEndLine(evidence.endLine, line);
    const normalizedPath = normalizeEvidencePath(evidence.path);
    const targetKey = `${normalizedPath}:${line}${lineEnd ? `-${lineEnd}` : ""}`;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    if (answerAlreadyLinksEvidence(answerMarkdown, normalizedPath, line)) continue;

    const label = `${normalizedPath}:${line}${lineEnd ? `-${lineEnd}` : ""}`;
    const href = `hivo-file:${encodeURIComponent(normalizedPath)}:${line}${lineEnd ? `-${lineEnd}` : ""}`;
    const summary = summarizeEvidence(evidence.summary);
    linkedRows.push(`- [${label}](${href})${summary ? ` - ${summary}` : ""}`);
    if (linkedRows.length >= MAX_APPENDED_EVIDENCE_LINKS) break;
  }

  if (!linkedRows.length) return answerMarkdown;
  const heading = language === "arabic" ? "### الأدلة" : "### Evidence";
  return `${answerMarkdown.trimEnd()}\n\n${heading}\n${linkedRows.join("\n")}`;
}

function normalizeEvidencePath(targetPath: string) {
  return targetPath.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function normalizeEvidenceLine(line: number | undefined) {
  return Number.isFinite(line) && line && line > 0 ? Math.floor(line) : 1;
}

function normalizeEvidenceEndLine(lineEnd: number | undefined, line: number) {
  if (!Number.isFinite(lineEnd) || !lineEnd || lineEnd <= line) return undefined;
  return Math.floor(lineEnd);
}

function answerAlreadyLinksEvidence(answerMarkdown: string, targetPath: string, line: number) {
  const encoded = encodeURIComponent(targetPath);
  return answerMarkdown.includes(`hivo-file:${encoded}:`)
    || answerMarkdown.includes(`hivo-file:${targetPath}:`)
    || answerMarkdown.includes(`${targetPath}:${line}`);
}

function summarizeEvidence(summary: string | undefined) {
  const compact = (summary ?? "").replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137).trimEnd()}...` : compact;
}
