import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkOrder } from "@hivo/protocol";
import { QueueDrivenTaskEventType } from "../orchestration/QueueDrivenTaskScheduler.js";
import { EventBus } from "../runtime/EventBus.js";
import { OrchestratedSessionRecorder } from "../runtime/OrchestratedSessionRecorder.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("orchestrated session recorder writes lifecycle facts through one session boundary", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-recorder-${Date.now()}`);
  try {
    const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
      runtimeEventLoader: async () => []
    });
    await manager.load();
    const session = await manager.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      executionMode: "orchestrated_mode",
      userPrompt: "Build the thing"
    });
    const recorder = new OrchestratedSessionRecorder(manager);

    await recorder.progress(session.id, {
      stage: "planning",
      status: "running",
      agentName: "Product Orchestrator",
      role: "Product",
      taskTitle: "Plan",
      summary: "Planning",
      targetFiles: []
    });
    await recorder.emit(session.id, "orchestration.started", "Started");
    await recorder.recordAgent(session.id, "Product Orchestrator", "Product Orchestrator", "Create product brief");
    await recorder.recordQueuedWorkOrder(session.id, workOrder(session.id));
    await recorder.replayQueueEvents(session.id, [
      queueEvent(QueueDrivenTaskEventType.TASK_ENQUEUED, "Queued"),
      queueEvent(QueueDrivenTaskEventType.TASK_DEQUEUED, "Started"),
      queueEvent(QueueDrivenTaskEventType.TASK_COMPLETED, "Completed"),
      queueEvent(QueueDrivenTaskEventType.PHASE_COMPLETED, "Ignored")
    ]);

    const updated = manager.getSession(session.id)!;
    assert.equal(updated.progressEvents.length, 2);
    assert.equal(updated.agentWorkStatuses[0]?.status, "queued");
    assert.equal(updated.orchestration?.agentRuns.length, 1);
    assert.deepEqual(updated.orchestration?.orchestrationEvents.map((event) => event.type), [
      "orchestration.started",
      "agent.completed",
      "task.created",
      "task.started",
      "task.completed"
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function workOrder(sessionId: string): WorkOrder {
  return {
    id: "work-task-a",
    sessionId,
    agentName: "ImplementationAgent",
    dynamicRole: "Implementation",
    objective: "Implement the requested change",
    acceptanceCriteria: ["Change is implemented"],
    requiredArtifacts: ["src/app.ts"],
    allowedTools: ["read", "patch"],
    dependsOn: []
  };
}

function queueEvent(type: QueueDrivenTaskEventType, message: string) {
  return {
    type,
    taskId: "task-a",
    agentName: "ImplementationAgent",
    message,
    timestamp: new Date().toISOString()
  };
}
