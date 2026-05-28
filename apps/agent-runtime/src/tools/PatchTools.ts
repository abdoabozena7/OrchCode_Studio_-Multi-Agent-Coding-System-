import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PatchProposal, PatchValidationResult, WorkerCapabilityGrant } from "@hivo/protocol";
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
    return {
      applied: false,
      changedPaths: [],
      message: `Runtime patch apply is disabled for ${proposal.id}; Rust patch authority must apply it.`
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
