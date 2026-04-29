import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PatchProposal, PatchValidationResult } from "@orchcode/protocol";
import { resolveInsideWorkspace } from "./security.js";

export class PatchTools {
  constructor(private readonly workspacePath: string) {}

  propose(proposal: Omit<PatchProposal, "id" | "sessionId" | "createdAt">, sessionId: string): PatchProposal {
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
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const file of proposal.filesChanged) {
      try {
        const resolved = resolveInsideWorkspace(this.workspacePath, file.path);
        if (path.basename(resolved).toLowerCase() === ".env") {
          errors.push(`${file.path} looks like a secret file`);
        }
      } catch (error) {
        errors.push(`${file.path}: ${String(error)}`);
      }
    }
    if (!proposal.unifiedDiff.includes("diff --git")) {
      warnings.push("Patch proposal does not look like a standard git unified diff");
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  applyProposal(proposal: PatchProposal): { applied: boolean; changedPaths: string[]; message: string } {
    const validation = this.validate(proposal);
    if (!validation.valid) {
      return {
        applied: false,
        changedPaths: [],
        message: validation.errors.join("; ")
      };
    }

    const artifacts = new Map(proposal.artifacts?.map((artifact) => [artifact.path, artifact.content]) ?? []);
    const changedPaths: string[] = [];

    for (const change of proposal.filesChanged) {
      const resolved = resolveInsideWorkspace(this.workspacePath, change.path);
      if (change.changeType === "delete") {
        if (fs.existsSync(resolved)) {
          fs.rmSync(resolved, { force: true });
        }
        changedPaths.push(change.path);
        continue;
      }

      const content = artifacts.get(change.path) ?? extractContentFromDiff(proposal.unifiedDiff, change.path);
      if (content === undefined) {
        return {
          applied: false,
          changedPaths,
          message: `Patch content is missing for ${change.path}`
        };
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
      changedPaths.push(change.path);
    }

    return {
      applied: true,
      changedPaths,
      message: changedPaths.length ? `Applied ${changedPaths.length} file change(s).` : "Patch contained no file changes."
    };
  }
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
