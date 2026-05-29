import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson } from "../memory/ProjectMemory.js";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import type { PatchProposal, PatchProposalFileChange } from "./PatchProposalModels.js";
import {
  createControlledApplyAdapterResult,
  createControlledApplyBlocker,
  type ControlledApplyAdapter,
  type ControlledApplyAdapterInput,
  type ControlledApplyAdapterResult,
  type ControlledApplyBlocker,
  type ControlledApplyFileResult
} from "./ControlledIntegrationApplyModels.js";

export class StructuredPatchControlledApplyAdapter implements ControlledApplyAdapter {
  readonly adapter_name = "structured_patch_controlled_apply_adapter";

  async apply(input: ControlledApplyAdapterInput): Promise<ControlledApplyAdapterResult> {
    const blockers: ControlledApplyBlocker[] = [];
    const fileResults: ControlledApplyFileResult[] = [];
    const proposal = await loadStructuredProposal(input.patch_artifact_ref).catch(() => undefined);
    const changes = proposal ? fileChangesOf(proposal) : [];
    if (!proposal || !changes.length) {
      blockers.push(blocker(input, "apply_failed", "Patch artifact does not contain structured patch proposal file changes.", [input.patch_artifact_ref]));
      return createControlledApplyAdapterResult({
        adapter_name: this.adapter_name,
        status: "blocked",
        applied_files: [],
        failed_files: [],
        file_results: [],
        blockers,
        warnings: []
      });
    }

    for (const change of changes) {
      const normalized = normalizeRelativePath(change.path);
      const validation = validatePath(input, normalized, change);
      if (validation) {
        blockers.push(validation);
        fileResults.push({ path: change.path, status: "blocked", change_type: change.change_type, message: validation.reason });
        continue;
      }
      try {
        const result = await applyChange(input.workspacePath, normalized, change, input);
        fileResults.push(result);
        if (result.status !== "applied") {
          blockers.push(blocker(input, "apply_failed", result.message ?? `Patch change failed for ${normalized}.`, [normalized]));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blockers.push(blocker(input, "apply_failed", message, [normalized]));
        fileResults.push({ path: normalized, status: "failed", change_type: change.change_type, message });
      }
    }

    return createControlledApplyAdapterResult({
      adapter_name: this.adapter_name,
      status: blockers.length ? "failed" : "applied",
      applied_files: fileResults.filter((result) => result.status === "applied").map((result) => result.path),
      failed_files: fileResults.filter((result) => result.status === "failed" || result.status === "blocked").map((result) => result.path),
      file_results: fileResults,
      blockers,
      warnings: []
    });
  }
}

async function loadStructuredProposal(ref: string): Promise<OneWriterDryRunProposal | PatchProposal> {
  return readJson<OneWriterDryRunProposal | PatchProposal>(ref);
}

function fileChangesOf(proposal: OneWriterDryRunProposal | PatchProposal): PatchProposalFileChange[] {
  if ("file_changes" in proposal) return proposal.file_changes;
  return proposal.patch_proposal?.file_changes ?? [];
}

function validatePath(input: ControlledApplyAdapterInput, normalized: string, change: PatchProposalFileChange) {
  if (!normalized || path.isAbsolute(change.path) || normalized === ".." || normalized.startsWith("../")) {
    return blocker(input, "path_traversal", `Patch path escapes the workspace: ${change.path}.`, [change.path]);
  }
  const resolved = path.resolve(input.workspacePath, normalized);
  if (!isInside(input.workspacePath, resolved)) {
    return blocker(input, "path_traversal", `Resolved patch path escapes the workspace: ${change.path}.`, [change.path]);
  }
  if (!matchesAny(normalized, input.changed_files) || (input.allowed_files.length && !matchesAny(normalized, input.allowed_files))) {
    return blocker(input, "approval_scope_invalid", `Patch path is outside approved changed files: ${normalized}.`, [normalized]);
  }
  if (matchesAny(normalized, input.forbidden_files)) {
    return blocker(input, "path_forbidden", `Patch touches forbidden path: ${normalized}.`, [normalized]);
  }
  if (change.change_type === "delete" && !input.allow_delete && !approved(change, "delete")) {
    return blocker(input, "approval_scope_invalid", `Delete requires explicit approval: ${normalized}.`, [normalized]);
  }
  if (change.change_type === "rename" && !input.allow_rename && !approved(change, "rename")) {
    return blocker(input, "approval_scope_invalid", `Rename requires explicit approval: ${normalized}.`, [normalized]);
  }
  return undefined;
}

async function applyChange(workspacePath: string, normalized: string, change: PatchProposalFileChange, input: ControlledApplyAdapterInput): Promise<ControlledApplyFileResult> {
  const target = path.resolve(workspacePath, normalized);
  if (change.change_type === "create") {
    if (existsSync(target)) return { path: normalized, status: "failed", change_type: "create", message: "Create target already exists." };
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contentForCreate(change.proposed_diff), "utf8");
    return { path: normalized, status: "applied", change_type: "create" };
  }
  if (change.change_type === "modify") {
    if (!existsSync(target)) return { path: normalized, status: "failed", change_type: "modify", message: "Modify target does not exist." };
    if (!change.proposed_diff) return { path: normalized, status: "failed", change_type: "modify", message: "Modify change is missing proposed_diff." };
    const content = await readFile(target, "utf8");
    const patched = applyUnifiedDiff(content, change.proposed_diff);
    if (patched === undefined) return { path: normalized, status: "failed", change_type: "modify", message: "Unified diff did not match target content." };
    await writeFile(target, patched, "utf8");
    return { path: normalized, status: "applied", change_type: "modify" };
  }
  if (change.change_type === "delete") {
    if (!existsSync(target)) return { path: normalized, status: "failed", change_type: "delete", message: "Delete target does not exist." };
    await rm(target, { force: false });
    return { path: normalized, status: "applied", change_type: "delete" };
  }
  if (change.change_type === "rename") {
    const next = renameTarget(change);
    const normalizedNext = next ? normalizeRelativePath(next) : "";
    if (!normalizedNext || normalizedNext.startsWith("../") || path.isAbsolute(next ?? "")) {
      return { path: normalized, status: "failed", change_type: "rename", message: "Rename target escapes workspace." };
    }
    if (!matchesAny(normalizedNext, input.changed_files) || (input.allowed_files.length && !matchesAny(normalizedNext, input.allowed_files)) || matchesAny(normalizedNext, input.forbidden_files)) {
      return { path: normalized, status: "failed", change_type: "rename", message: "Rename target is outside approved scope." };
    }
    const nextTarget = path.resolve(workspacePath, normalizedNext);
    if (!isInside(workspacePath, nextTarget)) return { path: normalized, status: "failed", change_type: "rename", message: "Rename target escapes workspace." };
    if (!existsSync(target)) return { path: normalized, status: "failed", change_type: "rename", message: "Rename source does not exist." };
    if (existsSync(nextTarget)) return { path: normalized, status: "failed", change_type: "rename", message: "Rename target already exists." };
    await mkdir(path.dirname(nextTarget), { recursive: true });
    await rename(target, nextTarget);
    return { path: normalizedNext, status: "applied", change_type: "rename" };
  }
  return { path: normalized, status: "failed", change_type: String(change.change_type), message: "Unsupported change type." };
}

function applyUnifiedDiff(content: string, diff: string) {
  let next = content;
  let changed = false;
  for (const hunk of parseHunks(diff)) {
    const removed = hunk.lines
      .filter((line) => line.startsWith("-") && !line.startsWith("---"))
      .map((line) => line.slice(1));
    const added = hunk.lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    if (!removed.length && !added.length) continue;
    const before = removed.join("\n");
    const after = added.join("\n");
    const beforeWithNewline = `${before}\n`;
    if (before && next.includes(beforeWithNewline)) {
      next = next.replace(beforeWithNewline, after ? `${after}\n` : "");
      changed = true;
    } else if (before && next.includes(before)) {
      next = next.replace(before, after);
      changed = true;
    } else if (!before) {
      next = `${next}${next.endsWith("\n") ? "" : "\n"}${after}${after.endsWith("\n") ? "" : "\n"}`;
      changed = true;
    } else {
      return undefined;
    }
  }
  return changed ? next : undefined;
}

function parseHunks(diff: string) {
  const hunks: Array<{ header: string; lines: string[] }> = [];
  let current: { header: string; lines: string[] } | undefined;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current && (line.startsWith("-") || line.startsWith("+") || line.startsWith(" "))) {
      current.lines.push(line);
    }
  }
  return hunks;
}

function contentForCreate(diff?: string) {
  if (!diff) return "";
  return parseHunks(diff)
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")
    .concat("\n");
}

function blocker(input: ControlledApplyAdapterInput, blockerType: ControlledApplyBlocker["blocker_type"], reason: string, refs: string[]) {
  return createControlledApplyBlocker({
    controlled_apply_id: input.controlled_apply_id,
    run_id: input.run_id,
    integration_candidate_id: input.integration_candidate_id,
    blocker_type: blockerType,
    severity: blockerType === "path_traversal" ? "critical" : "blocking",
    reason,
    refs
  });
}

function approved(change: PatchProposalFileChange, key: "delete" | "rename") {
  return change.metadata_json[`${key}_approved`] === true || change.metadata_json[`${key}_explicitly_approved`] === true;
}

function renameTarget(change: PatchProposalFileChange) {
  return typeof change.metadata_json.target_path === "string" ? change.metadata_json.target_path
    : typeof change.metadata_json.new_path === "string" ? change.metadata_json.new_path
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
