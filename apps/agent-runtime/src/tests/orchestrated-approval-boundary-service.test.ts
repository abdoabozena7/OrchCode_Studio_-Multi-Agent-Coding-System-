import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { QualityGateResult, ReviewResult, TaskGraph, WorkerOutput } from "@hivo/protocol";
import { OrchestratedApprovalBoundaryService } from "../runtime/OrchestratedApprovalBoundaryService.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("orchestrated approval boundary records passed review as needs approval", async () => {
  const fixture = await createSessionFixture("passed");
  try {
    await new OrchestratedApprovalBoundaryService(fixture.manager).record({
      sessionId: fixture.sessionId,
      taskGraph: taskGraph(fixture.sessionId, "completed"),
      workerOutputs: [workerOutput(fixture.sessionId, "completed")],
      securityReview: review(fixture.sessionId, "SecurityAgent", "passed"),
      reviewerSummary: review(fixture.sessionId, "ReviewerAgent", "passed"),
      qualityGates: [gate(fixture.sessionId, "passed")],
      gatesPassed: true,
      lockedFiles: { "src/app.ts": "ImplementationAgent" },
      canonicalGraphStatus: "awaiting_approval"
    });

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.status, "needs_approval");
    assert.equal(session.lifecycleStage, "APPROVAL");
    assert.equal(session.tasks[0]?.status, "done");
    assert.equal(session.orchestration?.retryCount, 0);
    assert.deepEqual(session.orchestration?.lockedFiles, { "src/app.ts": "ImplementationAgent" });
    assert.match(session.reasoningSummaries.at(-1) ?? "", /Rust-mediated patch approval/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("orchestrated approval boundary records blocked review without approval", async () => {
  const fixture = await createSessionFixture("blocked");
  try {
    await new OrchestratedApprovalBoundaryService(fixture.manager).record({
      sessionId: fixture.sessionId,
      taskGraph: taskGraph(fixture.sessionId, "failed"),
      workerOutputs: [workerOutput(fixture.sessionId, "blocked")],
      securityReview: review(fixture.sessionId, "SecurityAgent", "blocked"),
      reviewerSummary: review(fixture.sessionId, "ReviewerAgent", "blocked"),
      qualityGates: [gate(fixture.sessionId, "failed", ["blocking issue"])],
      gatesPassed: false,
      lockedFiles: {},
      canonicalGraphStatus: "blocked"
    });

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.status, "failed");
    assert.equal(session.lifecycleStage, "BLOCKED");
    assert.equal(session.tasks[0]?.status, "blocked");
    assert.equal(session.orchestration?.retryCount, 1);
    assert.equal(session.orchestration?.qualityGateResults[0]?.status, "failed");
    assert.match(session.reasoningSummaries.at(-1) ?? "", /before any files were applied/);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createSessionFixture(name: string) {
  const workspace = path.join(os.tmpdir(), `hivo-approval-boundary-${name}-${Date.now()}`);
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
  return { workspace, manager, sessionId: session.id };
}

function taskGraph(sessionId: string, status: TaskGraph["nodes"][number]["status"]): TaskGraph {
  return {
    sessionId,
    nodes: [{
      id: "task-a",
      title: "Implement",
      description: "Implement",
      assignedAgent: "ImplementationAgent",
      status,
      dependsOn: [],
      fileLocks: ["src/app.ts"],
      expectedOutput: "Patch proposal",
      riskLevel: "low"
    }],
    edges: []
  };
}

function workerOutput(sessionId: string, status: WorkerOutput["status"]): WorkerOutput {
  return {
    id: "output-a",
    sessionId,
    taskId: "task-a",
    agentName: "ImplementationAgent",
    summary: "Output summary",
    details: [],
    patchProposalIds: [],
    commandRequestIds: [],
    risks: [],
    status,
    createdAt: new Date().toISOString()
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

function gate(sessionId: string, status: QualityGateResult["status"], blockingReasons: string[] = []): QualityGateResult {
  return {
    id: "gate-reviewer",
    sessionId,
    gateName: "ReviewerGate",
    status,
    blockingReasons,
    reviewerNotes: status === "passed" ? ["passed"] : [],
    createdAt: new Date().toISOString()
  };
}
