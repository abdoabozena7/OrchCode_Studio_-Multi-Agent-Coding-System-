import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import type { PatchProposal, PatchProposalFileChange } from "./PatchProposalModels.js";
import {
  createPatchDryApplyConflict,
  createPatchFailedHunk,
  createPatchUnsafeFinding,
  type PatchApplySandboxResult,
  type PatchDryApplyConflict,
  type PatchFailedHunk,
  type PatchUnsafeFinding
} from "./PatchApplySandboxModels.js";

export type PatchDryApplyCheckerInput = {
  workspacePath: string;
  sandboxRoot: string;
  resultId: string;
  validationCandidateId: string;
  proposal: OneWriterDryRunProposal | PatchProposal;
  allowedFiles: string[];
  forbiddenFiles: string[];
};

export type PatchDryApplyCheckerResult = {
  changed_files: string[];
  conflicts: PatchDryApplyConflict[];
  failed_hunks: PatchFailedHunk[];
  unsafe_findings: PatchUnsafeFinding[];
};

export type MainRepoSnapshot = {
  files: Array<{
    path: string;
    exists: boolean;
    size?: number;
    mtimeMs?: number;
    sha256?: string;
  }>;
};

export class PatchDryApplyChecker {
  check(input: PatchDryApplyCheckerInput): PatchDryApplyCheckerResult {
    const proposalId = proposalIdOf(input.proposal);
    const fileChanges = fileChangesOf(input.proposal);
    const changedFiles = uniqueStrings([
      ...changedFilesOf(input.proposal),
      ...fileChanges.map((change) => change.path)
    ]);
    const conflicts: PatchDryApplyConflict[] = [];
    const failedHunks: PatchFailedHunk[] = [];
    const unsafeFindings: PatchUnsafeFinding[] = [];

    if (!fileChanges.length && !changedFiles.length) {
      unsafeFindings.push(unsafe(input, proposalId, "unsupported_patch_format", "Patch artifact does not contain structured file changes.", undefined, []));
      return { changed_files: [], conflicts, failed_hunks: failedHunks, unsafe_findings: unsafeFindings };
    }

    for (const change of fileChanges) {
      const normalized = normalizeRelativePath(change.path);
      if (!normalized || path.isAbsolute(change.path) || normalized.startsWith("../") || normalized === "..") {
        conflicts.push(conflict(input, proposalId, change.path, "path_traversal", `Patch path escapes the sandbox: ${change.path}.`));
        unsafeFindings.push(unsafe(input, proposalId, "path_traversal", `Patch path escapes the sandbox: ${change.path}.`, change.path, []));
        continue;
      }
      const resolved = path.resolve(input.sandboxRoot, normalized);
      if (!isInside(input.sandboxRoot, resolved)) {
        conflicts.push(conflict(input, proposalId, change.path, "path_traversal", `Resolved path escapes the sandbox: ${change.path}.`));
        unsafeFindings.push(unsafe(input, proposalId, "sandbox_escape", `Resolved path escapes the sandbox: ${change.path}.`, change.path, []));
        continue;
      }
      if (matchesAny(normalized, input.forbiddenFiles)) {
        conflicts.push(conflict(input, proposalId, normalized, "forbidden_path", `Patch touches forbidden path: ${normalized}.`));
        unsafeFindings.push(unsafe(input, proposalId, "forbidden_path", `Patch touches forbidden path: ${normalized}.`, normalized, []));
        continue;
      }
      if (!change.within_allowed_scope || (input.allowedFiles.length > 0 && !matchesAny(normalized, input.allowedFiles))) {
        conflicts.push(conflict(input, proposalId, normalized, "out_of_scope", `Patch path is outside allowed scope: ${normalized}.`));
        unsafeFindings.push(unsafe(input, proposalId, "out_of_scope", `Patch path is outside allowed scope: ${normalized}.`, normalized, []));
        continue;
      }

      const exists = existsSync(resolved);
      if (change.change_type === "create" && exists) {
        conflicts.push(conflict(input, proposalId, normalized, "target_exists", `Create target already exists: ${normalized}.`));
        continue;
      }
      if ((change.change_type === "modify" || change.change_type === "delete" || change.change_type === "rename") && !exists) {
        conflicts.push(conflict(input, proposalId, normalized, "missing_target", `${change.change_type} target does not exist: ${normalized}.`));
        continue;
      }
      if (change.change_type === "delete" && !approved(change, "delete")) {
        conflicts.push(conflict(input, proposalId, normalized, "delete_without_approval", `Delete requires explicit approval: ${normalized}.`));
        continue;
      }
      if (change.change_type === "rename") {
        if (!approved(change, "rename")) {
          conflicts.push(conflict(input, proposalId, normalized, "rename_without_approval", `Rename requires explicit approval: ${normalized}.`));
          continue;
        }
        const target = renameTarget(change);
        const normalizedTarget = target ? normalizeRelativePath(target) : undefined;
        if (!normalizedTarget || path.isAbsolute(target ?? "") || normalizedTarget.startsWith("../") || normalizedTarget === "..") {
          conflicts.push(conflict(input, proposalId, normalized, "path_traversal", `Rename target escapes the sandbox: ${target ?? "missing"}.`));
          continue;
        }
        if (existsSync(path.resolve(input.sandboxRoot, normalizedTarget))) {
          conflicts.push(conflict(input, proposalId, normalizedTarget, "rename_target_exists", `Rename target already exists: ${normalizedTarget}.`));
          continue;
        }
      }
      if (!["create", "modify", "delete", "rename"].includes(change.change_type)) {
        conflicts.push(conflict(input, proposalId, normalized, "unsupported_change", `Unsupported change type: ${String(change.change_type)}.`));
        continue;
      }
      if (change.proposed_diff && (change.change_type === "modify" || change.change_type === "delete")) {
        const failed = checkUnifiedDiff(input, proposalId, normalized, resolved, change.proposed_diff);
        failedHunks.push(...failed);
      }
    }

    return { changed_files: changedFiles, conflicts, failed_hunks: failedHunks, unsafe_findings: unsafeFindings };
  }

  snapshotMainRepo(workspacePath: string, files: string[]): MainRepoSnapshot {
    return {
      files: uniqueStrings(files.map(normalizeRelativePath).filter((file): file is string => Boolean(file))).map((file) => {
        const resolved = path.resolve(workspacePath, file);
        if (!isInside(workspacePath, resolved) || !existsSync(resolved)) return { path: file, exists: false };
        const stat = statSync(resolved);
        if (!stat.isFile()) return { path: file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
        const content = readFileSync(resolved);
        return {
          path: file,
          exists: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: createHash("sha256").update(content).digest("hex")
        };
      })
    };
  }

  compareMainRepoSnapshot(before: MainRepoSnapshot, after: MainRepoSnapshot) {
    const afterByPath = new Map(after.files.map((entry) => [entry.path, entry]));
    const modified: string[] = [];
    for (const entry of before.files) {
      const current = afterByPath.get(entry.path);
      if (!current || current.exists !== entry.exists || current.sha256 !== entry.sha256 || current.size !== entry.size) {
        modified.push(entry.path);
      }
    }
    return { ok: modified.length === 0, modified };
  }
}

function checkUnifiedDiff(input: PatchDryApplyCheckerInput, proposalId: string, file: string, resolved: string, diff: string) {
  const content = existsSync(resolved) ? readFileSync(resolved, "utf8") : "";
  const failed: PatchFailedHunk[] = [];
  for (const hunk of parseHunks(diff)) {
    const removed = hunk.lines
      .filter((line) => line.startsWith("-") && !line.startsWith("---"))
      .map((line) => line.slice(1));
    if (!removed.length) continue;
    if (!containsLines(content, removed)) {
      failed.push(createPatchFailedHunk({
        sandbox_result_id: input.resultId,
        validation_candidate_id: input.validationCandidateId,
        proposal_id: proposalId,
        path: file,
        hunk_header: hunk.header,
        reason: "Expected removed/context lines were not found in target file.",
        expected_lines: removed
      }));
    }
  }
  return failed;
}

function parseHunks(diff: string) {
  const hunks: Array<{ header: string; lines: string[] }> = [];
  let current: { header: string; lines: string[] } | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current && (line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }
  return hunks;
}

function containsLines(content: string, lines: string[]) {
  const haystack = content.split(/\r?\n/);
  for (let start = 0; start <= haystack.length - lines.length; start += 1) {
    if (lines.every((line, index) => haystack[start + index] === line)) return true;
  }
  return false;
}

function conflict(input: PatchDryApplyCheckerInput, proposalId: string, file: string, conflictType: PatchDryApplyConflict["conflict_type"], message: string) {
  return createPatchDryApplyConflict({
    sandbox_result_id: input.resultId,
    validation_candidate_id: input.validationCandidateId,
    proposal_id: proposalId,
    path: file,
    conflict_type: conflictType,
    severity: "blocking",
    message,
    refs: [file]
  });
}

function unsafe(input: PatchDryApplyCheckerInput, proposalId: string, findingType: PatchUnsafeFinding["finding_type"], message: string, file: string | undefined, refs: string[]) {
  return createPatchUnsafeFinding({
    sandbox_result_id: input.resultId,
    validation_candidate_id: input.validationCandidateId,
    proposal_id: proposalId,
    finding_type: findingType,
    severity: findingType === "main_repo_modified" ? "critical" : "blocking",
    message,
    path: file,
    refs
  });
}

function proposalIdOf(proposal: OneWriterDryRunProposal | PatchProposal) {
  return "proposal_id" in proposal ? proposal.proposal_id : "";
}

function fileChangesOf(proposal: OneWriterDryRunProposal | PatchProposal): PatchProposalFileChange[] {
  if ("file_changes" in proposal) return proposal.file_changes;
  return proposal.patch_proposal?.file_changes ?? [];
}

function changedFilesOf(proposal: OneWriterDryRunProposal | PatchProposal): string[] {
  return Array.isArray(proposal.changed_files) ? proposal.changed_files : [];
}

function approved(change: PatchProposalFileChange, key: "delete" | "rename") {
  return change.metadata_json[`${key}_approved`] === true || change.metadata_json[`${key}_explicitly_approved`] === true;
}

function renameTarget(change: PatchProposalFileChange) {
  const metadata = change.metadata_json;
  return typeof metadata.target_path === "string" ? metadata.target_path
    : typeof metadata.new_path === "string" ? metadata.new_path
      : undefined;
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function matchesAny(file: string, patterns: string[]) {
  const normalized = normalizeRelativePath(file);
  return patterns.map(normalizeRelativePath).some((pattern) => normalized === pattern || normalized.startsWith(`${pattern.replace(/\/+$/, "")}/`));
}

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
