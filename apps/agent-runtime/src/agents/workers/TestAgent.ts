import type { TaskNode } from "@hivo/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class TestAgent extends BaseWorker {
  readonly agentName = "TestAgent";

  protected execute(_task: TaskNode, context: WorkerContext) {
    const command = context.projectMap.testCommands[0] ?? "git diff --check";
    const commandRequest = context.tools.command.requestRun(context.sessionId, command, "Run the safest available validation for this workspace.");
    return {
      summary: "Created test strategy and command request.",
      details: [`Primary validation: ${command}`, "Review test output before applying patches."],
      risks: ["Tests may require dependencies unavailable on this machine."],
      commandRequest
    };
  }
}
