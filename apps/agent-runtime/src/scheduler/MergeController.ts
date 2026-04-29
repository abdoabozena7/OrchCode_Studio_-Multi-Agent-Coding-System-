import type { PatchProposal, ReviewResult, WorkerOutput } from "@orchcode/protocol";
import { randomUUID } from "node:crypto";

export type MergeSummary = {
  compatiblePatches: PatchProposal[];
  conflicts: Array<{ path: string; patchIds: string[] }>;
};

export class MergeController {
  collectWorkerOutputs(outputs: WorkerOutput[]) {
    return outputs;
  }

  detectPatchConflicts(patches: PatchProposal[]): MergeSummary {
    const byPath = new Map<string, string[]>();
    for (const patch of patches) {
      for (const file of patch.filesChanged) {
        byPath.set(file.path, [...(byPath.get(file.path) ?? []), patch.id]);
      }
    }
    const conflicts = [...byPath.entries()]
      .filter(([, patchIds]) => patchIds.length > 1)
      .map(([path, patchIds]) => ({ path, patchIds }));
    const conflictIds = new Set(conflicts.flatMap((conflict) => conflict.patchIds));
    return {
      compatiblePatches: patches.filter((patch) => !conflictIds.has(patch.id)),
      conflicts
    };
  }

  createReviewerSummary(sessionId: string, patches: PatchProposal[], conflicts: MergeSummary["conflicts"]): ReviewResult {
    return {
      id: `review_${randomUUID()}`,
      sessionId,
      reviewer: "ReviewerAgent",
      targetIds: patches.map((patch) => patch.id),
      status: conflicts.length ? "needs_changes" : "passed",
      summary: conflicts.length
        ? "Patch proposals have overlapping file changes and need manual reconciliation."
        : "Patch proposals are reviewable and ready for user approval.",
      findings: conflicts.map((conflict) => `Conflict on ${conflict.path}: ${conflict.patchIds.join(", ")}`),
      createdAt: new Date().toISOString()
    };
  }
}
