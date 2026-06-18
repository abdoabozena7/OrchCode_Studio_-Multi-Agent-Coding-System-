import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { PatchProposal, PatchValidationErrorCode, PatchValidationResult, WorkerCapabilityGrant } from "@hivo/protocol";
import { assertGrantAllowsTool, resolveInsideWorkspace } from "./security.js";

export class PatchTools {
  constructor(private readonly workspacePath: string, private readonly grant?: WorkerCapabilityGrant) {}

  propose(proposal: Omit<PatchProposal, "id" | "sessionId" | "createdAt">, sessionId: string): PatchProposal {
    assertGrantAllowsTool(this.grant, "patch.propose");
    if (this.grant) {
      if (!this.grant.canProposePatches) throw new Error("Capability grant does not allow patch proposals");
    }
    return {
      ...proposal,
      id: `patch_${randomUUID()}`,
      sessionId,
      requiresApproval: true,
      status: "proposed",
      createdAt: new Date().toISOString()
    };
  }

  validate(proposal: Pick<PatchProposal, "filesChanged" | "unifiedDiff">): PatchValidationResult {
    const codes: PatchValidationErrorCode[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const addError = (code: PatchValidationErrorCode, message: string) => {
      if (!codes.includes(code)) codes.push(code);
      errors.push(`${code}: ${message}`);
    };
    const diff = proposal.unifiedDiff?.trim() ?? "";
    if (!diff) {
      addError("patch_invalid_missing_diff", "Patch proposal must include a non-empty unifiedDiff.");
    }
    if (!proposal.filesChanged.length) {
      addError("patch_invalid_paths", "Patch proposal must include at least one filesChanged entry.");
    }
    for (const file of proposal.filesChanged) {
      try {
        const resolved = resolveInsideWorkspace(this.workspacePath, file.path);
        if (isSecretFile(file.path, resolved)) {
          addError("patch_invalid_secret_file", `${file.path} looks like a secret file.`);
        }
      } catch (error) {
        addError("patch_invalid_paths", `${file.path}: ${String(error)}`);
      }
    }
    const diffPaths = diff ? extractDiffPaths(diff) : { paths: [], malformed: false };
    if (diffPaths.malformed) {
      addError("patch_invalid_paths", "Patch contains malformed or incomplete diff headers.");
    }
    const declaredPaths = [...new Set(proposal.filesChanged.map((file) => normalizePatchPath(file.path)))].sort();
    const headerPaths = [...new Set(diffPaths.paths.map(normalizePatchPath))].sort();
    if (diff && (!headerPaths.length || declaredPaths.join("\n") !== headerPaths.join("\n"))) {
      addError("patch_invalid_paths", `filesChanged paths do not match diff headers (declared: ${declaredPaths.join(", ") || "none"}; diff: ${headerPaths.join(", ") || "none"}).`);
    }
    if (diff && !codes.includes("patch_invalid_paths") && !codes.includes("patch_invalid_secret_file")) {
      const checked = spawnSync("git", ["apply", "--check", "-"], {
        cwd: this.workspacePath,
        input: `${proposal.unifiedDiff.trimEnd()}\n`,
        encoding: "utf8",
        windowsHide: true
      });
      if (checked.error && (checked.error as NodeJS.ErrnoException).code === "ENOENT") {
        warnings.push("git apply --check was unavailable; Rust apply remains authoritative.");
      } else if (checked.error || checked.status !== 0) {
        addError("patch_invalid_apply_check_failed", checked.stderr?.trim() || checked.error?.message || "git apply --check failed.");
      }
    }
    return { valid: errors.length === 0, codes, errors, warnings };
  }

  applyProposal(proposal: PatchProposal): { applied: boolean; changedPaths: string[]; message: string } {
    return {
      applied: false,
      changedPaths: [],
      message: `Runtime patch apply is disabled for ${proposal.id}; Rust patch authority must apply it.`
    };
  }
}

function normalizePatchPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSecretFile(relativePath: string, resolvedPath: string) {
  const normalized = normalizePatchPath(relativePath).toLowerCase();
  const basename = path.basename(resolvedPath).toLowerCase();
  return basename === ".env"
    || basename.startsWith(".env.")
    || /(^|\/)(secrets?|credentials?)(\.|\/|$)/i.test(normalized)
    || /\.(pem|key|p12|pfx)$/i.test(basename);
}

function extractDiffPaths(diff: string) {
  const paths: string[] = [];
  let malformed = false;
  const lines = diff.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    const oldHeader = lines.slice(index + 1, index + 8).find((candidate) => candidate.startsWith("--- "));
    const newHeader = lines.slice(index + 1, index + 8).find((candidate) => candidate.startsWith("+++ "));
    if (!match || !oldHeader || !newHeader) {
      malformed = true;
      continue;
    }
    const oldPath = oldHeader === "--- /dev/null" ? undefined : oldHeader.match(/^--- a\/(.+)$/)?.[1];
    const newPath = newHeader === "+++ /dev/null" ? undefined : newHeader.match(/^\+\+\+ b\/(.+)$/)?.[1];
    if ((!oldPath && !newPath) || (oldPath && oldPath !== match[1]) || (newPath && newPath !== match[2])) {
      malformed = true;
      continue;
    }
    paths.push(newPath ?? oldPath!);
  }
  if (!lines.some((line) => line.startsWith("diff --git "))) malformed = true;
  return { paths, malformed };
}

function extractContentFromDiff(unifiedDiff: string, targetPath: string) {
  const fileMarker = `+++ b/${targetPath}`;
  if (!unifiedDiff.includes(fileMarker)) return undefined;
  const lines = unifiedDiff.split(/\r?\n/);
  const start = lines.findIndex((line) => line === fileMarker);
  if (start === -1) return undefined;
  const content: string[] = [];
  let inHunk = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("diff --git ")) break;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      content.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      content.push(line.slice(1));
      continue;
    }
  }
  return content.length ? `${content.join("\n")}\n` : undefined;
}
