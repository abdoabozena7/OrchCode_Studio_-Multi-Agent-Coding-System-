import type {
  CommandRequest,
  PatchProposal,
  PreviewRecommendation,
  ProjectMap,
  TaskNode,
  WorkOrder,
  WorkerOutput
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../../tools/ToolRegistry.js";

export type WorkerContext = {
  sessionId: string;
  userPrompt: string;
  workspacePath: string;
  projectMap: ProjectMap;
  tools: ToolRegistry;
  workOrder?: WorkOrder;
  previousOutputs: WorkerOutput[];
};

export abstract class BaseWorker {
  abstract readonly agentName: string;

  run(task: TaskNode, context: WorkerContext): {
    output: WorkerOutput;
    patch?: PatchProposal;
    commandRequest?: CommandRequest;
    previewRecommendation?: PreviewRecommendation;
  } {
    const result = this.execute(task, context);
    const output: WorkerOutput = {
      id: `worker_${randomUUID()}`,
      sessionId: context.sessionId,
      taskId: task.id,
      agentName: context.workOrder?.agentName ?? this.agentName,
      summary: result.summary,
      details: result.details,
      patchProposalIds: result.patch ? [result.patch.id] : [],
      commandRequestIds: result.commandRequest ? [result.commandRequest.id] : [],
      risks: result.risks,
      selfCheck: result.selfCheck,
      status: "completed",
      createdAt: new Date().toISOString()
    };
    return {
      output,
      patch: result.patch,
      commandRequest: result.commandRequest,
      previewRecommendation: result.previewRecommendation
    };
  }

  protected abstract execute(
    task: TaskNode,
    context: WorkerContext
  ): {
    summary: string;
    details: string[];
    risks: string[];
    selfCheck?: WorkerOutput["selfCheck"];
    patch?: PatchProposal;
    commandRequest?: CommandRequest;
    previewRecommendation?: PreviewRecommendation;
  };
}
