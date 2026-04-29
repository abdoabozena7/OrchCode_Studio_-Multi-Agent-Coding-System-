import type { TaskNode } from "@orchcode/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class ArchitectAgent extends BaseWorker {
  readonly agentName = "ArchitectAgent";

  protected execute(_task: TaskNode, context: WorkerContext) {
    return {
      summary: "Proposed a minimal implementation design with reviewable seams.",
      details: [
        `Request: ${context.userPrompt}`,
        "Prefer additive changes and keep patch surface small.",
        "Use existing package and app boundaries."
      ],
      risks: ["Mock design may need refinement with real file-level context."]
    };
  }
}
