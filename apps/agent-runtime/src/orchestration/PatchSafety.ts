import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { CodePatchProposal } from "./StructuredOutputs.js";

export type PatchOperation = "modify" | "add" | "delete" | "rename" | "binary" | "mode_change";

export type PatchManifest = {
  files: string[];
  operations: Array<{ path: string; operation: PatchOperation }>;
  warnings: string[];
};

export type PatchSafetyResult = {
  accepted: boolean;
  changed_files: string[];
  fingerprint: string;
  patch_bytes: number;
  scope_violations: string[];
  forbidden_violations: string[];
  warnings: string[];
  reasons: string[];
  manifest: PatchManifest;
};

export type FileSnapshot = {
  path: string;
  absolute_path: string;
  existed: boolean;
  content?: string;
};

export function validatePatchProposalScope(input: {
  workspacePath: string;
  task: Task;
  proposal: CodePatchProposal;
  config: Pick<OrchestrationSafetyConfig, "max_files_per_task" | "max_patch_bytes">;
}): PatchSafetyResult {
  const manifest = parsePatchManifest(input.proposal.patch_or_diff);
  const changedFiles = uniqueStrings([
    ...input.proposal.files_to_modify,
    ...manifest.files
  ]).map((file) => normalizeRepoPath(input.workspacePath, file)).filter(Boolean);
  const patchBytes = Buffer.byteLength(input.proposal.patch_or_diff, "utf8");
  const scopeViolations = changedFiles.filter((file) => !isAllowedByScopes(file, input.task.allowed_files_to_edit));
  const forbiddenViolations = changedFiles.filter((file) => isForbiddenByScopes(file, input.task.forbidden_files));
  const warnings = [...manifest.warnings];
  const reasons: string[] = [];
  if (changedFiles.length > input.config.max_files_per_task) reasons.push(`Patch touches ${changedFiles.length} files; limit is ${input.config.max_files_per_task}.`);
  if (patchBytes > input.config.max_patch_bytes) reasons.push(`Patch is ${patchBytes} bytes; limit is ${input.config.max_patch_bytes}.`);
  if (scopeViolations.length) reasons.push(`Patch touches files outside allowed scope: ${scopeViolations.join(", ")}.`);
  if (forbiddenViolations.length) reasons.push(`Patch touches forbidden files: ${forbiddenViolations.join(", ")}.`);
  const fingerprint = computePatchFingerprint({
    task_id: input.proposal.task_id,
    files: changedFiles,
    patch_or_diff: input.proposal.patch_or_diff
  });
  return {
    accepted: reasons.length === 0,
    changed_files: changedFiles,
    fingerprint,
    patch_bytes: patchBytes,
    scope_violations: scopeViolations,
    forbidden_violations: forbiddenViolations,
    warnings,
    reasons,
    manifest
  };
}

export function parsePatchManifest(diff: string): PatchManifest {
  const files = new Set<string>();
  const operations: Array<{ path: string; operation: PatchOperation }> = [];
  const warnings: string[] = [];
  let currentOldPath: string | undefined;
  let currentNewPath: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitMatch) {
      currentOldPath = cleanDiffPath(gitMatch[1]);
      currentNewPath = cleanDiffPath(gitMatch[2]);
      addPath(files, currentOldPath);
      addPath(files, currentNewPath);
      operations.push({ path: currentNewPath ?? currentOldPath ?? "", operation: "modify" });
      continue;
    }
    const oldMatch = line.match(/^---\s+(?:a\/)?(.+)$/);
    if (oldMatch) {
      currentOldPath = cleanDiffPath(oldMatch[1]);
      addPath(files, currentOldPath);
      continue;
    }
    const newMatch = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (newMatch) {
      currentNewPath = cleanDiffPath(newMatch[1]);
      addPath(files, currentNewPath);
      continue;
    }
    const renameFrom = line.match(/^rename from\s+(.+)$/);
    if (renameFrom) {
      const file = cleanDiffPath(renameFrom[1]);
      addPath(files, file);
      operations.push({ path: file ?? "", operation: "rename" });
      continue;
    }
    const renameTo = line.match(/^rename to\s+(.+)$/);
    if (renameTo) {
      const file = cleanDiffPath(renameTo[1]);
      addPath(files, file);
      operations.push({ path: file ?? "", operation: "rename" });
      continue;
    }
    if (/^new file mode /.test(line) && currentNewPath) operations.push({ path: currentNewPath, operation: "add" });
    if (/^deleted file mode /.test(line) && currentOldPath) operations.push({ path: currentOldPath, operation: "delete" });
    if (/^(old mode|new mode) /.test(line) && (currentNewPath ?? currentOldPath)) {
      operations.push({ path: currentNewPath ?? currentOldPath ?? "", operation: "mode_change" });
      warnings.push("Patch includes file mode changes; future phases should require explicit approval.");
    }
    if (/^Binary files /.test(line) || /^GIT binary patch/.test(line)) {
      operations.push({ path: currentNewPath ?? currentOldPath ?? "", operation: "binary" });
      warnings.push("Patch includes binary data; future phases should require explicit approval.");
    }
  }
  return {
    files: [...files].sort(),
    operations: operations.filter((operation) => operation.path).map((operation) => ({ ...operation, path: cleanDiffPath(operation.path) ?? operation.path })),
    warnings
  };
}

export function computePatchFingerprint(input: { task_id: string; files: string[]; patch_or_diff: string }) {
  const normalized = JSON.stringify({
    task_id: input.task_id,
    files: [...input.files].sort(),
    patch_or_diff: input.patch_or_diff.replace(/\r\n/g, "\n").trim()
  });
  return createHash("sha256").update(normalized).digest("hex");
}

export async function captureFileSnapshots(workspacePath: string, files: string[]): Promise<FileSnapshot[]> {
  const uniqueFiles = uniqueStrings(files).map((file) => normalizeRepoPath(workspacePath, file));
  const snapshots: FileSnapshot[] = [];
  for (const file of uniqueFiles) {
    const absolutePath = resolveRepoPath(workspacePath, file);
    snapshots.push({
      path: file,
      absolute_path: absolutePath,
      existed: existsSync(absolutePath),
      content: existsSync(absolutePath) ? await readFile(absolutePath, "utf8") : undefined
    });
  }
  return snapshots;
}

export async function restoreFileSnapshots(snapshots: FileSnapshot[]) {
  for (const snapshot of snapshots) {
    if (snapshot.existed) {
      await mkdir(path.dirname(snapshot.absolute_path), { recursive: true });
      await writeFile(snapshot.absolute_path, snapshot.content ?? "", "utf8");
    } else {
      await rm(snapshot.absolute_path, { force: true });
    }
  }
}

export async function diffFileSnapshots(workspacePath: string, snapshots: FileSnapshot[]) {
  const changedFiles: string[] = [];
  const chunks: string[] = [];
  for (const snapshot of snapshots) {
    const currentExists = existsSync(snapshot.absolute_path);
    const currentContent = currentExists ? await readFile(snapshot.absolute_path, "utf8") : undefined;
    if (snapshot.existed === currentExists && snapshot.content === currentContent) continue;
    changedFiles.push(snapshot.path);
    chunks.push(simpleDiffChunk(snapshot.path, snapshot.content, currentContent));
  }
  return {
    changed_files: changedFiles,
    patch_or_diff: chunks.join("\n")
  };
}

export function resolveRepoPath(workspacePath: string, repoPath: string) {
  const workspace = path.resolve(workspacePath);
  const absolute = path.isAbsolute(repoPath) ? path.resolve(repoPath) : path.resolve(workspace, repoPath);
  const relative = path.relative(workspace, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside workspace: ${repoPath}`);
  }
  return absolute;
}

export function normalizeRepoPath(workspacePath: string, repoPath: string) {
  const cleaned = repoPath.replace(/\\/g, "/").replace(/^["']|["']$/g, "").replace(/^[ab]\//, "");
  if (!cleaned || cleaned === "/dev/null") return "";
  const absolute = resolveRepoPath(workspacePath, cleaned);
  return path.relative(path.resolve(workspacePath), absolute).replace(/\\/g, "/");
}

export function isAllowedByScopes(repoPath: string, allowedScopes: string[]) {
  if (!repoPath) return true;
  if (!allowedScopes.length) return false;
  return allowedScopes.some((scope) => scopeMatches(repoPath, scope));
}

export function isForbiddenByScopes(repoPath: string, forbiddenScopes: string[]) {
  return forbiddenScopes.some((scope) => scopeMatches(repoPath, scope));
}

function scopeMatches(repoPath: string, scope: string) {
  const normalizedScope = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  const scopePath = normalizedScope.endsWith("/") ? normalizedScope.slice(0, -1) : normalizedScope;
  if (!scopePath) return false;
  return repoPath === scopePath || repoPath.startsWith(`${scopePath}/`);
}

function cleanDiffPath(value: string | undefined) {
  if (!value) return undefined;
  const cleaned = value.trim().split(/\t/)[0]?.replace(/^["']|["']$/g, "");
  if (!cleaned || cleaned === "/dev/null") return undefined;
  return cleaned.replace(/\\/g, "/").replace(/^[ab]\//, "");
}

function addPath(files: Set<string>, file: string | undefined) {
  if (file) files.add(file);
}

function simpleDiffChunk(file: string, before: string | undefined, after: string | undefined) {
  const beforeLines = (before ?? "").split(/\r?\n/);
  const afterLines = (after ?? "").split(/\r?\n/);
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join("\n");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
