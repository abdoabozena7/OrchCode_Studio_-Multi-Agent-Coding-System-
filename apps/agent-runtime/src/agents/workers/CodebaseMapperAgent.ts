import type { TaskNode } from "@hivo/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class CodebaseMapperAgent extends BaseWorker {
  readonly agentName = "CodebaseMapperAgent";

  protected execute(_task: TaskNode, context: WorkerContext) {
    return {
      summary: "Mapped project stack, package managers, entry points, and test commands.",
      details: [
        `Stack: ${context.projectMap.stack.join(", ") || "unknown"}`,
        `Package managers: ${context.projectMap.packageManagers.join(", ") || "none detected"}`,
        `Important files: ${context.projectMap.importantFiles.slice(0, 6).join(", ") || "none detected"}`
      ],
      risks: []
    };
  }
}
