import type {
  AgentRun,
  AgentRuntimeSession,
  AgentWorkStatus,
  OrchestrationEventType,
  PatchChangeStats,
  RuntimeProgressStage,
  RuntimeProgressStatus,
  WorkOrder
} from "@hivo/protocol";
import { QueueDrivenTaskEventType, type QueueDrivenTaskEvent } from "../orchestration/QueueDrivenTaskScheduler.js";
import { createAgentRun } from "./OrchestratedWorkerExecutionContracts.js";
import { randomId, SessionManager } from "./SessionManager.js";

export type OrchestratedProgressInput = {
  stage: RuntimeProgressStage;
  status: RuntimeProgressStatus;
  agentName?: string;
  role?: string;
  taskTitle?: string;
  summary: string;
  targetFiles: string[];
  patchStats?: PatchChangeStats[];
};

export class OrchestratedSessionRecorder {
  constructor(private readonly sessionManager: SessionManager) {}

  async progress(sessionId: string, input: OrchestratedProgressInput) {
    await this.sessionManager.addProgressEvent(sessionId, {
      id: randomId("progress"),
      sessionId,
      createdAt: new Date().toISOString(),
      ...input
    });
  }

  async updateWorkStatus(sessionId: string, status: AgentWorkStatus) {
    await this.sessionManager.updateAgentWorkStatus(sessionId, status);
  }

  async emit(sessionId: string, type: OrchestrationEventType, message: string, agentName?: string, taskId?: string) {
    await this.sessionManager.addOrchestrationEvent(sessionId, {
      id: randomId("event"),
      sessionId,
      type,
      message,
      agentName,
      taskId,
      createdAt: new Date().toISOString()
    });
  }

  async recordAgent(sessionId: string, agentName: string, role: AgentRun["role"], task: string) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.agentRuns.push(createAgentRun(sessionId, agentName, task, "completed", role));
    });
    await this.emit(sessionId, "agent.completed", task, agentName);
  }

  async recordQueuedWorkOrder(sessionId: string, order: WorkOrder) {
    await this.updateWorkStatus(sessionId, {
      agentName: order.agentName,
      role: order.dynamicRole,
      taskTitle: order.objective,
      objective: order.objective,
      status: "queued",
      targetFiles: order.requiredArtifacts,
      summary: "Waiting for dependencies and file locks.",
      updatedAt: new Date().toISOString()
    });
    await this.progress(sessionId, {
      stage: "assigning",
      status: "queued",
      agentName: order.agentName,
      role: order.dynamicRole,
      taskTitle: order.objective,
      summary: `Assigned work order: ${order.objective}`,
      targetFiles: order.requiredArtifacts
    });
  }

  async replayQueueEvents(sessionId: string, events: QueueDrivenTaskEvent[]) {
    for (const event of events) {
      const orchestrationType = queueEventTypeToOrchestrationEvent(event.type);
      if (!orchestrationType) continue;
      await this.emit(sessionId, orchestrationType, event.message, event.agentName, event.taskId);
    }
  }

  async replayPatchAndCommandRequests(sessionId: string, session: AgentRuntimeSession) {
    for (const patch of session.patchProposals) {
      await this.emit(sessionId, "patch.proposed", patch.title, patch.filesChanged[0]?.path, patch.id);
    }
    for (const command of session.commandRequests) {
      await this.emit(sessionId, "command.requested", command.command, command.risk, command.id);
    }
  }
}

function queueEventTypeToOrchestrationEvent(type: QueueDrivenTaskEventType): OrchestrationEventType | undefined {
  if (type === QueueDrivenTaskEventType.TASK_ENQUEUED) return "task.created";
  if (type === QueueDrivenTaskEventType.TASK_DEQUEUED) return "task.started";
  if (type === QueueDrivenTaskEventType.TASK_COMPLETED) return "task.completed";
  if (type === QueueDrivenTaskEventType.TASK_BANKRUPT) return "task.failed";
  if (type === QueueDrivenTaskEventType.TASK_FAILED) return "task.failed";
  return undefined;
}
