import type { TaskNode } from "@hivo/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class FrontendAgent extends BaseWorker {
  readonly agentName = "FrontendAgent";

  protected execute(task: TaskNode, context: WorkerContext) {
    return {
      summary: "Legacy local FrontendAgent execution is disabled.",
      details: [
        "Frontend implementation must be produced by an injected provider-backed worker executor or the canonical orchestration queue.",
        `Blocked stale local worker request for ${context.workOrder?.agentName ?? task.assignedAgent}.`
      ],
      risks: ["No patch, command, preview, or local semantic output was produced."],
      selfCheck: {
        workOrderId: context.workOrder?.id ?? task.id,
        passedCriteria: [],
        failedCriteria: ["legacy_local_worker_disabled"],
        missingItems: ["provider_backed_worker_executor"],
        confidence: 0
      }
    };
  }
}
