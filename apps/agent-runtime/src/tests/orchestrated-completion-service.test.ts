import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { QualityGateResult, ReviewResult, TaskGraph, WorkerOutput } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { OrchestratedCompletionService } from "../runtime/OrchestratedCompletionService.js";
import { SessionManager } from "../runtime/SessionManager.js";
import type { OrchestratedReviewOutcome } from "../runtime/OrchestratedReviewService.js";

test("orchestrated completion service records passed review at approval boundary", async () => {
  const fixture = await createFixture("passed");
  try {
    const service = new OrchestratedCompletionService(fixture.manager, undefined, {
      reviewService: {
        review: async () => reviewOutcome(fixture.sessionId, true)
      }
    });

    const result = await service.complete({
      sessionId: fixture.sessionId,
      session: fixture.session,
      prompt: "Build a small feature",
      taskGraph: taskGraph(fixture.sessionId, "completed"),
      taskExecution: { completed: 1, failed: 0, bankruptcyErrors: [] },
      canonicalGraphStatus: "awaiting_approval",
      canonicalBlockingReasons: [],
      outputs: [workerOutput(fixture.sessionId, "completed")],
      lockedFiles: {}
    });

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(result.gatesPassed, true);
    assert.equal(session.status, "needs_approval");
    assert.equal(session.lifecycleStage, "APPROVAL");
    assert.equal(session.runSummary?.status, "completed");
    assert.equal(session.messages.at(-1)?.role, "system");
    assert.ok(session.orchestration?.orchestrationEvents.some((event) => event.type === "validation.completed"));
    assert.ok(session.orchestration?.orchestrationEvents.some((event) => event.type === "orchestration.completed"));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("orchestrated completion service records blocked review without approval", async () => {
  const fixture = await createFixture("blocked");
  let observedCanonicalBlockingReasons: string[] | undefined;
  try {
    const service = new OrchestratedCompletionService(fixture.manager, undefined, {
      reviewService: {
        review: async (input) => {
          observedCanonicalBlockingReasons = input.canonicalBlockingReasons;
          return reviewOutcome(fixture.sessionId, false);
        }
      }
    });

    const result = await service.complete({
      sessionId: fixture.sessionId,
      session: fixture.session,
      prompt: "Build a small feature",
      taskGraph: taskGraph(fixture.sessionId, "failed"),
      taskExecution: { completed: 0, failed: 1, bankruptcyErrors: [] },
      canonicalGraphStatus: "blocked",
      canonicalBlockingReasons: ["Task graph blocked before execution."],
      outputs: [workerOutput(fixture.sessionId, "failed")],
      lockedFiles: {}
    });

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(result.gatesPassed, false);
    assert.equal(session.status, "failed");
    assert.equal(session.lifecycleStage, "BLOCKED");
    assert.equal(session.runSummary?.status, "blocked");
    assert.equal(session.orchestration?.retryCount, 1);
    assert.deepEqual(observedCanonicalBlockingReasons, ["Task graph blocked before execution."]);
    assert.ok(session.progressEvents.some((event) => event.stage === "blocked" && event.taskTitle === "Run blocked"));
    assert.ok(session.orchestration?.orchestrationEvents.some((event) => event.type === "orchestration.failed"));
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-completion-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode: "orchestrated_mode",
    userPrompt: "Build a small feature"
  });
  return { workspace, manager, sessionId: session.id, session };
}

function reviewOutcome(sessionId: string, passed: boolean): OrchestratedReviewOutcome {
  const securityReview = review(sessionId, "SecurityAgent", passed ? "passed" : "blocked");
  const reviewerSummary = review(sessionId, "ReviewerAgent", passed ? "passed" : "blocked");
  const qualityGates = [
    gate(sessionId, "ReviewerGate", passed ? "passed" : "failed", passed ? [] : ["blocking issue"]),
    gate(sessionId, "SecurityGate", passed ? "passed" : "failed", passed ? [] : ["security issue"]),
    gate(sessionId, "TestGate", passed ? "passed" : "failed", passed ? [] : ["test issue"])
  ];
  return {
    securityReview,
    reviewerSummary,
    qualityGates,
    gatesPassed: passed
  };
}

function review(sessionId: string, reviewer: ReviewResult["reviewer"], status: ReviewResult["status"]): ReviewResult {
  return {
    id: `review-${reviewer}`,
    sessionId,
    reviewer,
    targetIds: [],
    status,
    summary: `${reviewer} ${status}`,
    findings: status === "passed" ? [] : ["blocking issue"],
    createdAt: new Date().toISOString()
  };
}

function gate(
  sessionId: string,
  gateName: QualityGateResult["gateName"],
  status: QualityGateResult["status"],
  blockingReasons: string[]
): QualityGateResult {
  return {
    id: `gate-${gateName}`,
    sessionId,
    gateName,
    status,
    blockingReasons,
    reviewerNotes: status === "passed" ? ["passed"] : [],
    createdAt: new Date().toISOString()
  };
}

function taskGraph(sessionId: string, status: TaskGraph["nodes"][number]["status"]): TaskGraph {
  return {
    sessionId,
    nodes: [{
      id: "task-a",
      title: "Task A",
      description: "Run task A",
      assignedAgent: "ImplementationAgent",
      status,
      dependsOn: [],
      fileLocks: ["src/app.ts"],
      expectedOutput: "WorkerOutput",
      riskLevel: "low"
    }],
    edges: []
  };
}

function workerOutput(sessionId: string, status: WorkerOutput["status"]): WorkerOutput {
  return {
    id: `output-${status}`,
    sessionId,
    taskId: "task-a",
    agentName: "ImplementationAgent",
    summary: `${status} output`,
    details: [],
    patchProposalIds: [],
    commandRequestIds: [],
    risks: status === "completed" ? [] : ["fixture failure"],
    status,
    createdAt: new Date().toISOString()
  };
}
