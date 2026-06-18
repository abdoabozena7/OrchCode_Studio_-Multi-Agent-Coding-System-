import { createHash, randomUUID } from "node:crypto";
import type { ReasoningEvidenceRef } from "@hivo/protocol";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

export class EvidenceStore {
  private readonly entries = new Map<string, ReasoningEvidenceRef>();

  add(input: Omit<ReasoningEvidenceRef, "id" | "createdAt"> & { id?: string; createdAt?: string }) {
    const entry: ReasoningEvidenceRef = {
      ...input,
      id: input.id ?? `evidence_${randomUUID()}`,
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  addFile(input: {
    path: string;
    content: string;
    summary: string;
    startLine?: number;
    endLine?: number;
    sourceType?: ReasoningEvidenceRef["sourceType"];
  }) {
    const lines = input.content.split(/\r?\n/);
    const startLine = Math.max(1, input.startLine ?? 1);
    const endLine = Math.min(lines.length, input.endLine ?? lines.length);
    const excerpt = lines.slice(startLine - 1, endLine).join("\n");
    return this.add({
      sourceType: input.sourceType ?? "workspace_file",
      summary: input.summary,
      path: input.path.replaceAll("\\", "/"),
      startLine,
      endLine,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
      excerpt
    });
  }

  all() {
    return [...this.entries.values()];
  }

  ids() {
    return [...this.entries.keys()];
  }

  get(id: string) {
    return this.entries.get(id);
  }

  verifyWorkspaceFiles(tools: ToolRegistry) {
    const errors: string[] = [];
    for (const entry of this.all()) {
      if (!entry.path || !entry.contentHash || !["workspace_file", "manifest"].includes(entry.sourceType)) continue;
      try {
        const content = tools.workspace.readWholeFile(entry.path);
        const contentHash = createHash("sha256").update(content).digest("hex");
        if (contentHash !== entry.contentHash) errors.push(`Evidence ${entry.id} content hash no longer matches ${entry.path}.`);
        const lineCount = content.split(/\r?\n/).length;
        if (entry.startLine && (entry.startLine < 1 || entry.startLine > lineCount)) errors.push(`Evidence ${entry.id} start line is outside ${entry.path}.`);
        if (entry.endLine && (entry.endLine < (entry.startLine ?? 1) || entry.endLine > lineCount)) errors.push(`Evidence ${entry.id} end line is outside ${entry.path}.`);
      } catch (error) {
        errors.push(`Evidence ${entry.id} could not be re-read from ${entry.path}: ${formatError(error)}`);
      }
    }
    return errors;
  }

  context(maxChars = 22_000, preferredEvidenceIds: string[] = []) {
    const selected: ReasoningEvidenceRef[] = [];
    let used = 0;
    const omittedEvidenceIds: string[] = [];
    const preferred = new Set(preferredEvidenceIds);
    const ordered = [
      ...preferredEvidenceIds.flatMap((id) => this.entries.get(id) ? [this.entries.get(id)!] : []),
      ...this.all().filter((entry) => !preferred.has(entry.id))
    ];
    for (const entry of ordered) {
      const remaining = maxChars - used;
      const contextEntry = fitEvidenceEntry(entry, remaining);
      if (!contextEntry) {
        omittedEvidenceIds.push(entry.id);
        continue;
      }
      const size = JSON.stringify(contextEntry).length;
      if (used + size > maxChars) {
        omittedEvidenceIds.push(entry.id);
        continue;
      }
      selected.push(contextEntry);
      used += size;
    }
    return {
      selected,
      omitted: omittedEvidenceIds.length,
      omittedEvidenceIds,
      selectedEvidenceIds: selected.map((entry) => entry.id),
      usedChars: used,
      maxChars
    };
  }
}

function fitEvidenceEntry(entry: ReasoningEvidenceRef, maxChars: number) {
  if (maxChars <= 0) return null;
  const size = JSON.stringify(entry).length;
  if (size <= maxChars) return entry;
  if (!entry.excerpt || maxChars < 500) return null;
  const emptyExcerpt = { ...entry, excerpt: "" };
  const overhead = JSON.stringify(emptyExcerpt).length;
  const availableExcerptChars = maxChars - overhead - 80;
  if (availableExcerptChars < 120) return null;
  return {
    ...entry,
    excerpt: `${entry.excerpt.slice(0, availableExcerptChars)}\n[excerpt truncated for context budget]`
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
