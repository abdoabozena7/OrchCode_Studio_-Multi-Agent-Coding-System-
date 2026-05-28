import type { PatchProposal, ReviewResult, TaskNode, WorkerOutput } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";
import { validateThreeJsSnakeProposal } from "../../mock/threeJsSnake.js";

export class ReviewerAgent extends BaseWorker {
  readonly agentName = "ReviewerAgent";

  review(sessionId: string, patches: PatchProposal[], outputs: WorkerOutput[], conflictFindings: string[]): ReviewResult {
    const qualityFindings = [
      ...patches.flatMap((patch) => {
        const text = (patch.artifacts ?? []).map((artifact) => artifact.content).join("\n").toLowerCase();
        const findings = /mock_orchestrated|representative patch|todo|placeholder/.test(text)
          ? [`${patch.title} contains placeholder or representative-only content.`]
          : [];
        if (patch.filesChanged.some((file) => file.path === "main.js") && text.includes("snake")) {
          findings.push(...validateThreeJsSnakeProposal(patch).blockingReasons);
        }
        return findings;
      }),
      ...outputs.flatMap((output) => [
        ...(output.selfCheck?.failedCriteria ?? []).map((criterion) => `${output.agentName} failed criterion: ${criterion}`),
        ...(output.selfCheck?.missingItems ?? []).map((item) => `${output.agentName} missing item: ${item}`)
      ])
    ];
    const findings = [...conflictFindings, ...qualityFindings];
    return {
      id: `reviewer_${randomUUID()}`,
      sessionId,
      reviewer: "ReviewerAgent",
      targetIds: [...patches.map((patch) => patch.id), ...outputs.map((output) => output.id)],
      status: findings.length ? "needs_changes" : "passed",
      summary: findings.length
        ? "Reviewer found blocking quality issues that need another worker pass."
        : "Reviewer found the mock orchestrated output coherent and ready for user approval.",
      findings,
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
