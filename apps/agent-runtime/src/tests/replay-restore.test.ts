import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRun,
  AgentRuntimeSession,
  DecisionRecord,
  DurableRuntimeEvent,
  PatchProposal,
  ReconciliationReport,
  ReviewGateSummary,
  VerificationResult
} from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import { createDurableRuntimeEvent } from "../runtime/DurableRuntimeEvents.js";
import { replaySessionFromDurableEvents } from "../runtime/SessionReplay.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("replay rebuilds session telemetry, review gate, matched reconciliation, and passed verification from durable events", async () => {
  const fixture = await createSeedFixture();
  try {
    const agent = createAgentRun(fixture.session);
    const decision = createDecisionRecord(fixture.session, agent.id);
    const patch = createPatchProposal(fixture.session);
    const reviewGate = createReviewGate(agent, patch.id);
    const reconciliation = createReconciliationReport(patch.id, "matched");
    const verification = createVerification(fixture.session, "passed");

    const replayed = replaySessionFromDurableEvents([
      event(fixture.session.id, 1, "session.created", { session: fixture.session }),
      event(fixture.session.id, 2, "agent.updated", { agent }),
      event(fixture.session.id, 3, "decision.recorded", { decision }),
      event(fixture.session.id, 4, "evidence.recorded", {
        evidenceRef: {
          type: "file",
          path: "README.md",
          lineStart: 1,
          lineEnd: 2,
          linkedDecisionId: decision.id,
          linkedAgentId: agent.id
        }
      }),
      event(fixture.session.id, 5, "patch.proposed", { proposal: patch }),
      event(fixture.session.id, 6, "patch.approved", { patchId: patch.id, proposal: { ...patch, status: "approved" } }),
      event(fixture.session.id, 7, "patch.applied", { patchId: patch.id, proposal: { ...patch, status: "applied" } }),
      event(fixture.session.id, 8, "patch.reconciled", { reconciliation }),
      event(fixture.session.id, 9, "review_gate.updated", { reviewGate }),
      event(fixture.session.id, 10, "verification.completed", { verification })
    ]);

    assert.ok(replayed.session);
    assert.equal(replayed.restoreState.source, "event_replayed");
    assert.equal(replayed.restoreState.disposition, "terminal");
    assert.equal(replayed.session?.patchProposals[0]?.status, "applied");
    assert.equal(replayed.session?.reconciliationReport?.status, "matched");
    assert.equal(replayed.session?.verificationResult?.status, "passed");
    assert.equal(replayed.session?.reviewGate?.summary, reviewGate.summary);
    assert.equal(replayed.session?.orchestration?.agentRuns[0]?.workJournal?.length, 1);
    assert.equal(replayed.session?.decisionLedger[0]?.evidenceRefs.length, 1);
  } finally {
    await fixture.close();
  }
});

test("replay marks diverged reconciliation as manual-inspection-required instead of resumable", async () => {
  const fixture = await createSeedFixture();
  try {
    const patch = createPatchProposal(fixture.session);
    const replayed = replaySessionFromDurableEvents([
      event(fixture.session.id, 1, "session.created", { session: fixture.session }),
      event(fixture.session.id, 2, "patch.proposed", { proposal: patch }),
      event(fixture.session.id, 3, "patch.applied", { patchId: patch.id, proposal: { ...patch, status: "applied" } }),
      event(fixture.session.id, 4, "patch.reconciled", {
        reconciliation: createReconciliationReport(patch.id, "diverged")
      })
    ]);

    assert.ok(replayed.session);
    assert.equal(replayed.restoreState.disposition, "reconciliation_required");
    assert.equal(replayed.session?.status, "needs_approval");
    assert.equal(replayed.session?.reconciliationReport?.status, "diverged");
  } finally {
    await fixture.close();
  }
});

test("replay keeps incomplete patch or command lifecycles out of resumable state", async () => {
  const fixture = await createSeedFixture();
  try {
    const patch = createPatchProposal(fixture.session);
    const applyStarted = replaySessionFromDurableEvents([
      event(fixture.session.id, 1, "session.created", { session: fixture.session }),
      event(fixture.session.id, 2, "patch.proposed", { proposal: patch }),
      event(fixture.session.id, 3, "patch.apply_started", { patchId: patch.id })
    ]);
    assert.equal(applyStarted.restoreState.disposition, "reconciliation_required");

    const commandStarted = replaySessionFromDurableEvents([
      event(fixture.session.id, 1, "session.created", { session: fixture.session }),
      event(fixture.session.id, 2, "command.requested", {
        commandRequest: {
          id: "cmd_1",
          sessionId: fixture.session.id,
          command: "npm test",
          cwd: fixture.session.workspacePath,
          risk: "safe",
          reason: "verify",
          status: "requested",
          createdAt: fixture.session.createdAt
        }
      }),
      event(fixture.session.id, 3, "command.started", {
        execution: {
          id: "exec_1",
          sessionId: fixture.session.id,
          requestId: "cmd_1",
          autoRun: false,
          command: "npm test",
          cwd: fixture.session.workspacePath,
          risk: "safe",
          status: "executing",
          stdout: "",
          stderr: "",
          createdAt: fixture.session.createdAt
        }
      })
    ]);
    assert.equal(commandStarted.restoreState.disposition, "reconciliation_required");

    const backgroundStarted = replaySessionFromDurableEvents([
      event(fixture.session.id, 1, "session.created", { session: fixture.session }),
      event(fixture.session.id, 2, "command.requested", {
        commandRequest: {
          id: "cmd_bg",
          sessionId: fixture.session.id,
          command: "npm run dev",
          cwd: fixture.session.workspacePath,
          risk: "safe",
          reason: "preview",
          provenance: {
            source: "agent",
            trigger: "manual",
            requestedBy: "agent",
            approvalSource: "none",
            policyDecision: "allow",
            background: true,
            backgroundDetected: true,
            detectionSource: "heuristic",
            backgroundDetectionSource: "heuristic"
          },
          status: "requested",
          createdAt: fixture.session.createdAt
        }
      }),
      event(fixture.session.id, 3, "command.started", {
        requestId: "cmd_bg",
        result: {
          command: "npm run dev",
          cwd: fixture.session.workspacePath,
          risk: "safe",
          status: "running",
          stdout: "",
          stderr: "",
          provenance: {
            source: "agent",
            trigger: "auto_approved",
            requestedBy: "agent",
            approvalSource: "auto",
            policyDecision: "allow",
            background: true,
            backgroundDetected: true,
            detectionSource: "heuristic",
            backgroundDetectionSource: "heuristic"
          },
          backgroundJob: {
            jobId: "job_bg",
            sessionId: fixture.session.id,
            requestId: "cmd_bg",
            command: "npm run dev",
            cwd: fixture.session.workspacePath,
            processId: 4242,
            startedAt: fixture.session.createdAt,
            status: "running",
            lastKnownAt: fixture.session.updatedAt,
            detectionSource: "heuristic"
          }
        }
      })
    ]);
    assert.equal(backgroundStarted.restoreState.disposition, "reconciliation_required");
    assert.equal(backgroundStarted.session?.backgroundJobs[0]?.status, "orphaned");
  } finally {
    await fixture.close();
  }
});

test("session manager distinguishes event replay from snapshot fallback during load", async () => {
  const fixture = await createSeedFixture();
  try {
    const persisted = new SessionManager(fixture.storageDir, new EventBus());
    await persisted.load();
    await persisted.createSession({
      workspacePath: fixture.session.workspacePath,
      mode: "demo_mock",
      userPrompt: fixture.session.userPrompt
    });

    const replayedManager = new SessionManager(fixture.storageDir, new EventBus(), {
      runtimeEventLoader: async () => [event(fixture.session.id, 1, "session.created", { session: fixture.session })]
    });
    await replayedManager.load();
    const replayed = replayedManager.getSession(fixture.session.id);
    assert.equal(replayed?.taskState.restoreState?.source, "event_replayed");

    const snapshotManager = new SessionManager(fixture.storageDir, new EventBus(), {
      runtimeEventLoader: async () => []
    });
    await snapshotManager.load();
    const snapshot = snapshotManager.listSessions().at(-1);
    assert.equal(snapshot?.taskState.restoreState?.source, "snapshot_restored");
    assert.equal(snapshot?.taskState.restoreState?.disposition, "resumable");
  } finally {
    await fixture.close();
  }
});

test("replay keeps unknown diff totals unknown and restores verification failures conservatively", async () => {
  const fixture = await createSeedFixture();
  try {
    const patch = {
      ...createPatchProposal(fixture.session),
      unifiedDiff: ""
    };
    const reviewGate: ReviewGateSummary = {
      totalFilesChanged: 1,
      changesByAgent: [{
        agentName: "Coordinator",
        fileCount: 1,
        files: ["README.md"],
        lineTotalsKnown: false
      }],
      riskyAreas: [],
      verificationChecks: [],
      unresolvedBlockers: ["Verification failed."],
      recommendation: "do_not_apply",
      summary: "Review is blocked until verification passes."
    };
    const verification = createVerification(fixture.session, "failed");

    const replayed = replaySessionFromDurableEvents([
      event(fixture.session.id, 1, "session.created", { session: fixture.session }),
      event(fixture.session.id, 2, "patch.proposed", { proposal: patch }),
      event(fixture.session.id, 3, "review_gate.updated", { reviewGate }),
      event(fixture.session.id, 4, "verification.completed", { verification })
    ]);

    assert.ok(replayed.session);
    assert.equal(replayed.restoreState.disposition, "terminal");
    assert.equal(replayed.session?.reviewGate?.changesByAgent[0]?.additions, undefined);
    assert.equal(replayed.session?.reviewGate?.changesByAgent[0]?.deletions, undefined);
    assert.equal(replayed.session?.verificationResult?.status, "failed");
  } finally {
    await fixture.close();
  }
});

function event(
  sessionId: string,
  sequence: number,
  type: DurableRuntimeEvent["type"],
  payload: Record<string, unknown>
) {
  return createDurableRuntimeEvent({
    sessionId,
    sequence,
    type,
    actor: "runtime",
    authority: "runtime",
    payload,
    createdAt: new Date().toISOString()
  });
}

async function createSeedFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-replay-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-replay-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const created = await manager.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "restore replay fixture"
  });
  const session = manager.getSession(created.id);
  assert.ok(session);
  return {
    session,
    storageDir,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

function createAgentRun(session: AgentRuntimeSession): AgentRun {
  return {
    id: "agent_runtime",
    sessionId: session.id,
    agentName: "Coordinator",
    displayName: "Coordinator",
    role: "Senior Coding Agent",
    currentAction: "Reviewing durable restore state.",
    ownedPaths: ["README.md"],
    forbiddenPaths: ["tauri://rust-authority"],
    allowedActions: ["inspect_assigned_paths"],
    stopConditions: ["Stop after review gate is prepared."],
    integrationNotes: ["Do not claim exact diff totals when the data is missing."],
    changedFiles: ["README.md"],
    commandsRun: ["npm test"],
    testsRun: ["npm test"],
    decisionsMade: ["decision_restore_1"],
    evidenceRefs: [],
    riskRefs: [],
    workJournal: [{
      id: "journal_1",
      agentId: "agent_runtime",
      timestamp: session.createdAt,
      kind: "planning",
      title: "Replay",
      summary: "Prepared replay-aware review state.",
      status: "completed"
    }],
    status: "completed",
    startedAt: session.createdAt,
    completedAt: session.updatedAt
  };
}

function createDecisionRecord(session: AgentRuntimeSession, agentId: string): DecisionRecord {
  return {
    id: "decision_restore_1",
    sessionId: session.id,
    category: "decision",
    finding: "The patch touches README.md only.",
    decision: "Preserve the README telemetry in replay.",
    rationaleSummary: "This keeps restore evidence inspectable.",
    evidenceRefs: [],
    linkedFiles: ["README.md"],
    createdByAgent: "Coordinator",
    createdByAgentId: agentId,
    linkedAgentIds: [agentId],
    createdAt: session.createdAt
  };
}

function createPatchProposal(session: AgentRuntimeSession): PatchProposal {
  return {
    id: "patch_restore_1",
    sessionId: session.id,
    title: "Update README",
    summary: "Add replay note",
    riskLevel: "low",
    filesChanged: [{ path: "README.md", changeType: "modify", explanation: "Adds a replay note." }],
    unifiedDiff: [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      "-fixture",
      "+fixture",
      "+replay note"
    ].join("\n"),
    requiresApproval: true,
    status: "proposed",
    createdAt: session.createdAt
  };
}

function createReviewGate(agent: AgentRun, patchId: string): ReviewGateSummary {
  return {
    totalFilesChanged: 1,
    totalAdditions: 1,
    totalDeletions: 1,
    changesByAgent: [{
      agentId: agent.id,
      agentName: agent.displayName ?? agent.agentName,
      confidence: "reported",
      fileCount: 1,
      additions: 1,
      deletions: 1,
      files: ["README.md"],
      lineTotalsKnown: true
    }],
    riskyAreas: [],
    verificationChecks: [{
      id: "patch_proposal",
      name: "Patch proposal",
      label: "Patch proposal",
      status: "passed",
      detail: "Patch proposal recorded.",
      linkedPatchId: patchId
    } as ReviewGateSummary["verificationChecks"][number]],
    unresolvedBlockers: [],
    recommendation: "ready",
    summary: "Replay restored a reviewable patch history."
  };
}

function createReconciliationReport(
  patchId: string,
  status: ReconciliationReport["status"]
): ReconciliationReport {
  return {
    status,
    patchId,
    sourceDiffId: patchId,
    checkedAt: new Date().toISOString(),
    checkedBy: "runtime",
    confidence: status === "matched" ? "high" : "partial",
    reason: status === "matched" ? "Proposed and actual files matched." : "Extra files appeared after apply.",
    retryable: status !== "matched",
    matchedFiles: status === "matched" ? ["README.md"] : [],
    missingFiles: [],
    extraFiles: status === "matched" ? [] : ["EXTRA.md"],
    changedFilesWithDifferentStats: [],
    sharedOrAmbiguousFiles: [],
    unknowns: []
  };
}

function createVerification(
  session: AgentRuntimeSession,
  status: VerificationResult["status"]
): VerificationResult {
  return {
    id: "verification_restore_1",
    sessionId: session.id,
    status,
    checks: [{
      id: "post_verify",
      name: "Post-verify",
      label: "Post-verify",
      status,
      detail: status === "passed" ? "Verification command succeeded." : "Verification command failed."
    }],
    summary: status === "passed" ? "Verification passed." : "Verification failed.",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  };
}
