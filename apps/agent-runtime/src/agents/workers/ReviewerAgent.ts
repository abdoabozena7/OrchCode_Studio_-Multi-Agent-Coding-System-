import type { PatchProposal, ReviewResult, TaskNode, WorkerOutput } from "@orchcode/protocol";
import { randomUUID } from "node:crypto";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class ReviewerAgent extends BaseWorker {
  readonly agentName = "ReviewerAgent";

  review(sessionId: string, patches: PatchProposal[], outputs: WorkerOutput[], conflictFindings: string[]): ReviewResult {
    return {
      id: `reviewer_${randomUUID()}`,
      sessionId,
      reviewer: "ReviewerAgent",
      targetIds: [...patches.map((patch) => patch.id), ...outputs.map((output) => output.id)],
      status: conflictFindings.length ? "needs_changes" : "passed",
      summary: conflictFindings.length
        ? "Reviewer found merge conflicts that need manual resolution."
        : "Reviewer found the mock orchestrated output coherent and ready for user approval.",
      findings: conflictFindings,
      createdAt: new Date().toISOString()
    };
  }

  protected execute(_task: TaskNode, _context: WorkerContext) {
    return {
      summary: "Final review prepared.",
      details: ["Checks consistency, maintainability, and merge readiness."],
      risks: []
    };
  }
}
