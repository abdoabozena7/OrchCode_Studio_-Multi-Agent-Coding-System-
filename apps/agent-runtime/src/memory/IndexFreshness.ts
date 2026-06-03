import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureMemoryLayout, readJson, writeJson } from "./ProjectMemory.js";
import { rebuildRepoIndex, type RebuildRepoIndexOptions } from "./RepoIndexer.js";
import { MEMORY_SCHEMA_VERSION, type FileManifestEntry, type IndexFreshnessReport, type IndexState } from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".agent_memory",
  ".git",
  ".hivo-agent-runtime",
  ".orchcode-agent-runtime",
  ".playwright-mcp",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "gen",
  "generated",
  "tmp",
  "test-results"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".ps1",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

export async function assessIndexFreshness(workspacePath: string, memoryDir?: string): Promise<IndexFreshnessReport> {
  const workspaceRoot = path.resolve(workspacePath);
  const paths = await ensureMemoryLayout(workspaceRoot, memoryDir);
  const checkedAt = new Date().toISOString();
  if (!existsSync(paths.fileManifest) || !existsSync(paths.repoIndex)) {
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      status: "missing",
      checkedAt,
      indexedFiles: 0,
      changedFiles: [],
      newFiles: [],
      deletedFiles: [],
      warnings: ["Repository memory index is missing. Run index refresh before building context."]
    };
  }

  const manifest = await readJson<FileManifestEntry[]>(paths.fileManifest);
  const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));
  const currentFiles = await collectCurrentTextFiles(workspaceRoot);
  const changedFiles: string[] = [];
  const newFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const current of currentFiles) {
    const previous = manifestByPath.get(current.path);
    if (!previous) {
      newFiles.push(current.path);
      continue;
    }
    if (previous.sizeBytes !== current.sizeBytes || previous.hashSha256 !== current.hashSha256) {
      changedFiles.push(current.path);
    }
  }

  const currentPathSet = new Set(currentFiles.map((entry) => entry.path));
  for (const previous of manifest) {
    if (!currentPathSet.has(previous.path)) deletedFiles.push(previous.path);
  }

  const state = existsSync(paths.indexState) ? await readJson<IndexState>(paths.indexState) : undefined;
  const stale = changedFiles.length > 0 || newFiles.length > 0 || deletedFiles.length > 0;
  const report: IndexFreshnessReport = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    status: stale ? "stale" : "fresh",
    generatedAt: state?.generatedAt,
    checkedAt,
    indexVersion: state?.indexVersion,
    commandInventoryVersion: state?.commandInventoryVersion,
    indexedFiles: manifest.length,
    changedFiles: changedFiles.sort(),
    newFiles: newFiles.sort(),
    deletedFiles: deletedFiles.sort(),
    warnings: stale ? ["Repository files changed after the last index. Refresh before relying on context packs."] : []
  };
  await writeJson(paths.indexState, {
    ...(state ?? {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      indexVersion: MEMORY_SCHEMA_VERSION,
      generatedAt: report.generatedAt ?? checkedAt,
      commandInventoryVersion: MEMORY_SCHEMA_VERSION,
      fileCount: manifest.length,
      hash: manifestHash(manifest)
    }),
    lastFreshnessCheck: report
  });
  return report;
}

export async function refreshRepoIndex(
  workspacePath: string,
  options: RebuildRepoIndexOptions & { changedOnly?: boolean } = {}
) {
  const before = await assessIndexFreshness(workspacePath, options.memoryDir);
  const snapshot = await rebuildRepoIndex(workspacePath, options);
  const after = await assessIndexFreshness(workspacePath, options.memoryDir);
  return {
    mode: options.changedOnly ? "changed-only-report-full-refresh" : "full-refresh",
    before,
    after,
    snapshot,
    note: options.changedOnly
      ? "Phase 4 reports changed files first, then performs a full refresh for correctness."
      : "Full repository memory refresh completed."
  };
}

export function manifestHash(manifest: FileManifestEntry[]) {
  const stable = manifest
    .map((entry) => `${entry.path}:${entry.sizeBytes}:${entry.hashSha256 ?? ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}

async function collectCurrentTextFiles(workspaceRoot: string): Promise<Array<{ path: string; sizeBytes: number; hashSha256?: string }>> {
  const files: Array<{ path: string; sizeBytes: number; hashSha256?: string }> = [];
  async function walk(currentDir: string, relativeDir: string) {
    const entries = (await readdir(currentDir, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeDir, entry.name));
      const fullPath = path.join(workspaceRoot, relativePath);
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(entry.name, relativePath)) continue;
        await walk(fullPath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isFile() || !isTextLike(relativePath)) continue;
      const info = await lstat(fullPath);
      if (info.size > 1_000_000) continue;
      try {
        const text = await readFile(fullPath, "utf8");
        files.push({
          path: relativePath,
          sizeBytes: info.size,
          hashSha256: createHash("sha256").update(text).digest("hex")
        });
      } catch {
        // If the current file cannot be read as text, leave it out of freshness comparisons.
      }
    }
  }
  await walk(workspaceRoot, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function shouldIgnoreDirectory(name: string, relativePath: string) {
  return IGNORED_DIRECTORIES.has(name) || relativePath.split("/").some((part) => IGNORED_DIRECTORIES.has(part));
}

function isTextLike(filePath: string) {
  const basename = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  if (/\.log$/i.test(filePath)) return false;
  if ([".gitignore", ".gitattributes", "Cargo.lock", "Makefile", "package-lock.json"].includes(basename)) return true;
  return TEXT_EXTENSIONS.has(extension);
}

function normalizePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.$/, "");
  return normalized || ".";
}
