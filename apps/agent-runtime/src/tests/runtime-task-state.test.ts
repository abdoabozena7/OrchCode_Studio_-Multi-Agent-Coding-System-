import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { EventBus } from "../runtime/EventBus.js";
import { buildAttributedReviewGate } from "../runtime/AgentTelemetry.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("patch proposal lifecycle is recorded in canonical runtime task state", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.ok(session);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.patchProposals[0]?.status, "proposed");
    assert.equal(session?.taskState.phase, "verification_pending");
    assert.equal(session?.runMode, "normal_run");
    assert.equal(session?.runPhases.some((phase) => phase.id === "inspect_workspace" && phase.status === "completed"), true);
    assert.equal((session?.decisionLedger.length ?? 0) >= 2, true);
    assert.equal(session?.reviewGate?.recommendation, "caution");
    assert.equal(session?.reviewGate?.totalAdditions === undefined || typeof session?.reviewGate?.totalAdditions === "number", true);
    assert.equal(session?.reviewGate?.totalDeletions === undefined || typeof session?.reviewGate?.totalDeletions === "number", true);
    assert.equal((session?.reviewGate?.changesByAgent.length ?? 0) >= 1, true);
    assert.equal(session?.reviewGate?.changesByAgent[0]?.confidence, "reported");
    assert.equal((session?.reviewGate?.risksByAgent?.length ?? 0) >= 1, true);
    assert.equal((session?.reviewGate?.decisionsByAgent?.length ?? 0) >= 1, true);
    assert.equal((session?.reviewGate?.sharedFiles?.length ?? 0), 0);
    assert.equal((session?.reviewGate?.unattributedFiles?.length ?? 0), 0);
    assert.equal(session?.taskState.pendingPatchId, session?.patchProposals[0]?.id);
    assert.equal(session?.taskState.transitions.some((entry) => entry.type === "patch.proposed"), true);
    assert.equal(session?.taskState.transitions.some((entry) => entry.type === "verification.pending"), true);
    assert.equal((session?.taskState as { reconciliationStatus?: string }).reconciliationStatus, "pending");
  } finally {
    await fixture.close();
  }
});

test("deep audit runs record extended inspection metadata and coordinator evidence", async () => {
  const fixture = await createPatchFixture("perform a deep audit of the fixture README flow");
  try {
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.runMode, "deep_audit");
    assert.equal(session?.runPhases.length, 8);
    assert.equal(session?.runPhases.some((phase) => phase.id === "inspect_workspace" && phase.status === "completed"), true);
    assert.equal(session?.runPhases.some((phase) => phase.id === "build_repo_map" && phase.status === "completed"), true);
    assert.equal(session?.decisionLedger.some((record) => record.category === "finding"), true);
    assert.equal(session?.decisionLedger.some((record) => record.category === "decision"), true);

    const coordinator = session?.orchestration?.agentRuns.find((agent) => agent.id === "agent_local_codex");
    assert.ok(coordinator);
    const plannedWorker = session?.orchestration?.agentRuns.find((agent) => agent.id === "agent_task_1");
    assert.ok(plannedWorker);
    assert.equal(coordinator?.roleTitle, "Coordinator");
    assert.equal((coordinator?.ownedPaths ?? []).includes("workspace://current"), true);
    assert.equal((coordinator?.forbiddenPaths ?? []).includes("tauri://rust-authority"), true);
    assert.equal((plannedWorker?.allowedActions ?? []).includes("inspect_assigned_paths"), true);
    assert.equal((plannedWorker?.stopConditions ?? []).length >= 1, true);
    assert.equal((plannedWorker?.workJournal?.length ?? 0) >= 1, true);
    assert.equal((session?.decisionLedger.some((record) => Boolean(record.createdByAgentId) && (record.linkedAgentIds?.length ?? 0) >= 1)), true);
    const fileEvidenceRefs = session?.decisionLedger.flatMap((record) => record.evidenceRefs).filter((ref) => ref.type === "file") ?? [];
    assert.equal(fileEvidenceRefs.length >= 1, true);
    assert.equal(
      fileEvidenceRefs.every((ref) => ref.lineStart === undefined || typeof ref.lineStart === "number"),
      true
    );
  } finally {
    await fixture.close();
  }
});

test("paranoid mode is reflected in review-oriented run state", async () => {
  const fixture = await createPatchFixture("paranoid review twice before changing the README note");
  try {
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.runMode, "paranoid_mode");
    assert.equal(session?.runPhases.some((phase) => phase.id === "split_agents" && phase.status === "completed"), true);
    assert.equal(session?.runPhases.some((phase) => phase.id === "review_final_diff" && phase.status === "active"), true);
    assert.equal(session?.reviewGate?.recommendation, "caution");
    assert.equal((session?.reviewGate?.unresolvedBlockers.length ?? 0) >= 1, true);
    assert.equal((session?.decisionLedger.length ?? 0) >= 2, true);
  } finally {
    await fixture.close();
  }
});

test("patch approval lifecycle is recorded in canonical runtime task state", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.patchProposals[0]?.status, "approved");
    assert.equal(session?.lifecycleStage, "APPLY");
    assert.equal(session?.taskState.phase, "awaiting_patch_apply");
    assert.equal(session?.taskState.transitions.some((entry) => entry.type === "patch.approved"), true);
  } finally {
    await fixture.close();
  }
});

test("patch apply success is recorded and moves the runtime into command verification", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        before: {
          available: true,
          source: "rust_git_snapshot",
          isGitRepo: true,
          changedFiles: [],
          diffText: "",
          dirty: false,
          checkedAt: new Date().toISOString()
        },
        after: {
          available: true,
          source: "rust_git_snapshot",
          isGitRepo: true,
          changedFiles: ["AGENT_PROPOSAL.md"],
          diffText: fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.unifiedDiff ?? "",
          dirty: true,
          checkedAt: new Date().toISOString()
        }
      }
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.patchProposals[0]?.status, "applied");
    assert.equal(session?.status, "needs_approval");
    assert.equal(session?.nextAction?.kind, "approve_commands");
    assert.equal(session?.taskState.phase, "verification_pending");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Rust apply")?.status, "passed");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Reconciliation")?.status, "passed");
    assert.equal(session?.runSummary?.status, "pending");
    assert.equal(session?.reviewGate?.totalAdditions === undefined || typeof session?.reviewGate?.totalAdditions === "number", true);
    assert.equal(session?.reviewGate?.totalDeletions === undefined || typeof session?.reviewGate?.totalDeletions === "number", true);
    assert.equal((session?.reviewGate?.changesByAgent[0]?.fileCount ?? 0) >= 1, true);
    assert.equal(session?.reviewGate?.changesByAgent[0]?.additions === undefined || typeof session?.reviewGate?.changesByAgent[0]?.additions === "number", true);
    assert.equal(session?.reviewGate?.changesByAgent[0]?.deletions === undefined || typeof session?.reviewGate?.changesByAgent[0]?.deletions === "number", true);
    assert.equal((session?.taskState as { patchState?: { authority?: string } }).patchState?.authority, "rust");
    assert.equal((session?.orchestration?.agentRuns.find((agent) => agent.id === "agent_task_1")?.workJournal?.length ?? 0) >= 2, true);
    assert.equal(session?.reconciliationReport?.status, "matched");
    assert.equal(session?.reconciliationReport?.checkedBy, "rust");
    assert.equal(session?.reconciliationReport?.evidenceSource, "rust_git_snapshot");
  } finally {
    await fixture.close();
  }
});

test("patch apply failure is recorded as runtime failure", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "failed",
      message: "Patch failed to apply"
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.patchProposals[0]?.status, "apply_failed");
    assert.equal(session?.status, "failed");
    assert.equal(session?.lifecycleStage, "FAILED");
    assert.equal(session?.taskState.phase, "failed");
    assert.equal(session?.verificationResult?.status, "failed");
  } finally {
    await fixture.close();
  }
});

test("command results are recorded in runtime state and finalize the session", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        after: {
          available: true,
          isGitRepo: true,
          changedFiles: ["AGENT_PROPOSAL.md"],
          diffText: fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.unifiedDiff ?? "",
          dirty: true,
          checkedAt: new Date().toISOString()
        }
      }
    });
    const request = fixture.runtime.getSession(fixture.sessionId)?.commandRequests[0];
    assert.ok(request);
    await fixture.runtime.reportCommandResult(fixture.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "executed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      message: "Command executed through Rust"
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.commandExecutions.length, 1);
    assert.equal(session?.commandRequests[0]?.status, "executed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.verificationResult?.status, "passed");
    assert.equal(session?.runSummary?.status, "completed");
    assert.equal(session?.reviewGate?.recommendation, "ready");
    assert.equal(session?.runPhases.some((phase) => phase.id === "final_report" && phase.status === "completed"), true);
    assert.equal(session?.taskState.completedCommandIds.includes(request.id), true);
    assert.equal(session?.taskState.phase, "completed");
    assert.equal((session?.taskState as { reconciliationStatus?: string }).reconciliationStatus, "reconciled");
  } finally {
    await fixture.close();
  }
});

test("background command starts stay pending and preserve heuristic provenance instead of looking completed", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        after: {
          available: true,
          source: "rust_git_snapshot",
          isGitRepo: true,
          changedFiles: ["AGENT_PROPOSAL.md"],
          diffText: fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.unifiedDiff ?? "",
          dirty: true,
          checkedAt: new Date().toISOString()
        }
      }
    });
    const request = fixture.runtime.getSession(fixture.sessionId)?.commandRequests[0];
    assert.ok(request);
    await fixture.runtime.reportCommandResult(fixture.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "running",
      stdout: "",
      stderr: "",
      message: "Background process started with limited tracking.",
      provenance: {
        source: "agent",
        trigger: "auto_approved",
        requestedBy: "agent",
        approvalSource: "auto",
        policyDecision: "allow",
        policyReason: "Policy heuristics allowed the command, but background detection is heuristic.",
        executionAuthority: "rust",
        background: true,
        backgroundDetected: true,
        detectionSource: "heuristic",
        backgroundDetectionSource: "heuristic",
        backgroundTrackingLimited: true,
        processId: 4242,
        jobId: "job_4242"
      },
      backgroundJob: {
        jobId: "job_4242",
        sessionId: fixture.sessionId,
        requestId: request.id,
        command: request.command,
        cwd: request.cwd,
        processId: 4242,
        startedAt: new Date().toISOString(),
        status: "running",
        lastKnownAt: new Date().toISOString(),
        detectionSource: "heuristic",
        outputSummary: "Background process started."
      }
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.commandExecutions.at(-1)?.status, "running");
    assert.equal(session?.commandRequests[0]?.status, "executing");
    assert.equal(session?.backgroundJobs[0]?.status, "running");
    assert.equal(session?.commandExecutions.at(-1)?.provenance?.approvalSource, "auto");
    assert.equal(session?.commandExecutions.at(-1)?.provenance?.backgroundDetectionSource, "heuristic");
    assert.equal(session?.status, "needs_approval");
    assert.equal(session?.verificationResult?.status, "pending");
  } finally {
    await fixture.close();
  }
});

test("command execution emits an explicit runtime completion event instead of replaying a request event", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-events-${Date.now()}`);
  const eventBus = new EventBus();
  const manager = new SessionManager(storageDir, eventBus);
  const events: string[] = [];
  eventBus.subscribe((event) => {
    events.push(event.type);
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: storageDir,
    mode: "demo_mock",
    userPrompt: "test event emission"
  });

  await manager.addCommandRequest(session.id, {
    id: "cmd_request_1",
    sessionId: session.id,
    command: "npm test",
    cwd: storageDir,
    risk: "safe",
    reason: "Verify behavior",
    status: "requested",
    createdAt: new Date().toISOString()
  });
  await manager.addCommandExecution(session.id, {
    id: "cmd_exec_1",
    sessionId: session.id,
    requestId: "cmd_request_1",
    autoRun: false,
    command: "npm test",
    cwd: storageDir,
    risk: "safe",
    status: "executed",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    message: "done",
    createdAt: new Date().toISOString()
  });

  const updated = manager.getSession(session.id);
  assert.equal(events.some((type) => type === "runtime.command.completed"), true);
  assert.equal(events.filter((type) => type === "runtime.command.requested").length, 1);
  assert.equal(updated?.taskState.transitions.some((entry) => entry.type === "command.started"), true);
  assert.equal(updated?.taskState.transitions.some((entry) => entry.type === "command.completed"), true);
  await rm(storageDir, { recursive: true, force: true });
});

test("session persistence stores compact snapshots instead of unbounded runtime payloads", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-compact-storage-${Date.now()}`);
  const manager = new SessionManager(storageDir, new EventBus());
  await manager.load();
  const session = await manager.createSession({
    workspacePath: storageDir,
    mode: "demo_mock",
    userPrompt: "compact persistence"
  });
  const hugeText = "x".repeat(250_000);

  await manager.updateSession(session.id, (draft) => {
    for (let index = 0; index < 60; index += 1) {
      draft.messages.push({
        id: `msg_${index}`,
        role: "assistant",
        content: hugeText,
        createdAt: new Date().toISOString()
      });
    }
    draft.artifacts.push({
      id: "artifact_large_payload",
      sessionId: session.id,
      type: "summary",
      title: "Large runtime payload",
      summary: hugeText,
      payload: {
        hugeText,
        largeArray: Array.from({ length: 200 }, (_, index) => ({ index, hugeText }))
      },
      createdAt: new Date().toISOString()
    });
  });

  const persisted = await readFile(path.join(storageDir, "sessions.json"), "utf8");
  assert.equal(persisted.length < 2_000_000, true);
  assert.match(persisted, /truncated/);
  const parsed = JSON.parse(persisted) as { sessions: Array<{ messages: unknown[] }> };
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0]?.messages.length, 40);
  await rm(storageDir, { recursive: true, force: true });
});

test("expired session tokens mark the runtime task state as expired for reconciliation-aware recovery", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-expired-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-expired-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const manager = new SessionManager(storageDir, new EventBus());
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "expired token",
    sessionToken: "expired-token",
    sessionTokenExpiresAt: new Date(Date.now() - 5_000).toISOString()
  });

  assert.equal(manager.validateSessionToken(session.id, "expired-token"), false);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const updated = manager.getSession(session.id);
  assert.equal((updated?.taskState as { restoreStatus?: string }).restoreStatus, "expired");
  assert.equal(updated?.taskState.restoreState?.disposition, "expired");
  assert.equal(updated?.lifecycleStage, "BLOCKED");

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("runtime task state restores with explicit restored markers after runtime restart", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-state-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-state-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "persist runtime state\n", "utf8");

  const first = await buildServer({ ...loadConfig(), storageDir });
  const created = await first.runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "add a README note"
  });
  await first.runtime.runTurn(created.sessionId, "add a README note");
  const patchId = first.runtime.getSession(created.sessionId)?.patchProposals[0]?.id;
  assert.ok(patchId);
  await first.runtime.approvePatch(created.sessionId, patchId);
  await first.runtime.reportPatchApplyResult(created.sessionId, patchId, {
    status: "applied",
    message: "Patch applied by Rust authority",
    reconciliationSnapshot: {
      after: {
        available: true,
        isGitRepo: true,
        changedFiles: ["AGENT_PROPOSAL.md"],
        diffText: first.runtime.getSession(created.sessionId)?.patchProposals[0]?.unifiedDiff ?? "",
        dirty: true,
        checkedAt: new Date().toISOString()
      }
    }
  });
  const request = first.runtime.getSession(created.sessionId)?.commandRequests[0];
  assert.ok(request);
  await first.runtime.reportCommandResult(created.sessionId, request.id, {
    command: request.command,
    cwd: request.cwd,
    risk: request.risk,
    status: "executed",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    message: "Command executed through Rust"
  });
  await first.app.close();

  const second = await buildServer({ ...loadConfig(), storageDir });
  try {
    const restored = second.runtime.getSession(created.sessionId);
    assert.ok(restored);
    assert.equal((restored?.taskState as { restoreStatus?: string }).restoreStatus, "restored");
    assert.equal(restored?.taskState.restoreState?.source, "snapshot_restored");
    assert.equal(restored?.taskState.transitions.some((entry) => entry.type === "session.restored"), true);
    assert.equal((restored?.orchestration?.agentRuns.find((agent) => agent.id === "agent_task_1")?.allowedActions ?? []).includes("inspect_assigned_paths"), true);
    assert.equal((restored?.orchestration?.agentRuns.find((agent) => agent.id === "agent_local_codex")?.testsRun ?? []).includes("git diff --check"), true);
    assert.equal((restored?.reviewGate?.decisionsByAgent?.length ?? 0) >= 1, true);
  } finally {
    await second.app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("review gate marks shared and unattributed files conservatively", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-attribution-${Date.now()}`);
  const manager = new SessionManager(storageDir, new EventBus());
  await manager.load();
  const session = await manager.createSession({
    workspacePath: storageDir,
    mode: "demo_mock",
    userPrompt: "attribute diff telemetry"
  });
  await manager.updateSession(session.id, (draft) => {
    draft.orchestration = {
      agentRuns: [
        {
          id: "agent_a",
          sessionId: draft.id,
          agentName: "Runtime",
          displayName: "Runtime",
          role: "Senior Coding Agent",
          ownedPaths: ["src/one.ts", "src/shared.ts"],
          changedFiles: ["src/one.ts"],
          status: "running",
          startedAt: draft.createdAt,
          workJournal: []
        },
        {
          id: "agent_b",
          sessionId: draft.id,
          agentName: "UI",
          displayName: "UI",
          role: "Frontend",
          ownedPaths: ["src/shared.ts"],
          changedFiles: ["src/shared.ts"],
          status: "running",
          startedAt: draft.createdAt,
          workJournal: []
        }
      ],
      workerOutputs: [],
      securityReviews: [],
      reviewerSummaries: [],
      orchestrationEvents: [],
      approvalDecisions: [],
      safetySettings: draft.orchestration?.safetySettings ?? { blockDangerousCommands: true, redactSecrets: true, allowNetworkCommands: false, autoApplyValidatedPatches: false, autoRunSafeCommands: false, autoRunMediumCommands: false, autoRunBackgroundCommands: false, autoRunNetworkCommands: false, requireApprovalForPatches: true, maxParallelAgents: 3 },
      lockedFiles: {},
      selectedWorkerAgents: [],
      mandatoryGateAgents: [],
      workOrders: [],
      qualityGateResults: [],
      retryCount: 0
    };
    draft.patchProposals = [{
      id: "patch_1",
      sessionId: draft.id,
      title: "attribution patch",
      summary: "test patch",
      riskLevel: "medium",
      filesChanged: [
        { path: "src/one.ts", changeType: "modify", explanation: "single-owner file" },
        { path: "src/shared.ts", changeType: "modify", explanation: "shared file" },
        { path: "src/unowned.ts", changeType: "modify", explanation: "unowned file" }
      ],
      unifiedDiff: [
        "diff --git a/src/one.ts b/src/one.ts",
        "--- a/src/one.ts",
        "+++ b/src/one.ts",
        "@@ -1 +1,2 @@",
        "-old",
        "+new",
        "+extra",
        "diff --git a/src/shared.ts b/src/shared.ts",
        "--- a/src/shared.ts",
        "+++ b/src/shared.ts",
        "@@ -1 +1 @@",
        "-sharedOld",
        "+sharedNew",
        "diff --git a/src/unowned.ts b/src/unowned.ts",
        "--- a/src/unowned.ts",
        "+++ b/src/unowned.ts",
        "@@ -1 +1 @@",
        "-ghost",
        "+ghost2"
      ].join("\n"),
      requiresApproval: true,
      status: "proposed",
      createdAt: new Date().toISOString()
    }];
  });

  const gate = buildAttributedReviewGate(manager.getSession(session.id)!, {
    summary: "pending review",
    status: "pending",
    checks: [{ name: "Patch proposal", status: "passed", detail: "ok" }]
  });

  assert.equal(gate.totalFilesChanged, 3);
  assert.equal(gate.totalAdditions, 4);
  assert.equal(gate.totalDeletions, 3);
  assert.equal(gate.changesByAgent.some((entry) => entry.agentId === "agent_a" && entry.confidence === "reported"), true);
  assert.equal(gate.changesByAgent.find((entry) => entry.agentId === "agent_a")?.additions, 2);
  assert.equal(gate.sharedFiles?.some((file) => file.path === "src/shared.ts" && file.confidence === "shared"), true);
  assert.equal(gate.unattributedFiles?.some((file) => file.path === "src/unowned.ts" && file.confidence === "unattributed"), true);

  await rm(storageDir, { recursive: true, force: true });
});

test("review gate keeps line totals unknown when unified diff stats are unavailable", async () => {
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-diff-unknown-${Date.now()}`);
  const manager = new SessionManager(storageDir, new EventBus());
  await manager.load();
  const session = await manager.createSession({
    workspacePath: storageDir,
    mode: "demo_mock",
    userPrompt: "unknown diff telemetry"
  });
  await manager.updateSession(session.id, (draft) => {
    draft.orchestration = {
      agentRuns: [{
        id: "agent_runtime",
        sessionId: draft.id,
        agentName: "Runtime",
        displayName: "Runtime",
        role: "Senior Coding Agent",
        ownedPaths: ["src/unknown.ts"],
        changedFiles: ["src/unknown.ts"],
        status: "running",
        startedAt: draft.createdAt,
        workJournal: []
      }],
      workerOutputs: [],
      securityReviews: [],
      reviewerSummaries: [],
      orchestrationEvents: [],
      approvalDecisions: [],
      safetySettings: draft.orchestration?.safetySettings ?? { blockDangerousCommands: true, redactSecrets: true, allowNetworkCommands: false, autoApplyValidatedPatches: false, autoRunSafeCommands: false, autoRunMediumCommands: false, autoRunBackgroundCommands: false, autoRunNetworkCommands: false, requireApprovalForPatches: true, maxParallelAgents: 3 },
      lockedFiles: {},
      selectedWorkerAgents: [],
      mandatoryGateAgents: [],
      workOrders: [],
      qualityGateResults: [],
      retryCount: 0
    };
    draft.patchProposals = [{
      id: "patch_unknown",
      sessionId: draft.id,
      title: "unknown diff",
      summary: "missing diff body",
      riskLevel: "low",
      filesChanged: [{ path: "src/unknown.ts", changeType: "modify", explanation: "missing diff body" }],
      unifiedDiff: "",
      requiresApproval: true,
      status: "proposed",
      createdAt: new Date().toISOString()
    }];
  });

  const gate = buildAttributedReviewGate(manager.getSession(session.id)!, {
    summary: "pending review",
    status: "pending",
    checks: [{ name: "Patch proposal", status: "passed", detail: "ok" }]
  });

  assert.equal(gate.totalFilesChanged, 1);
  assert.equal(gate.totalAdditions, undefined);
  assert.equal(gate.totalDeletions, undefined);
  assert.equal(gate.changesByAgent[0]?.additions, undefined);
  assert.equal(gate.changesByAgent[0]?.deletions, undefined);
  assert.equal(gate.changesByAgent[0]?.lineTotalsKnown, false);

  await rm(storageDir, { recursive: true, force: true });
});

test("post-apply reconciliation marks unavailable git data as unavailable, not matched", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        after: {
          available: false,
          source: "rust_git_snapshot",
          isGitRepo: false,
          changedFiles: [],
          diffText: "",
          dirty: false,
          checkedAt: new Date().toISOString(),
          unavailableReason: "Workspace is not a git repository."
        }
      }
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.reconciliationReport?.status, "unavailable");
    assert.equal(session?.reconciliationReport?.checkedBy, "rust");
    assert.equal(session?.reconciliationReport?.evidenceSource, "unavailable");
    assert.equal(session?.reviewGate?.recommendation, "caution");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Reconciliation")?.status, "unavailable");
  } finally {
    await fixture.close();
  }
});

test("post-apply reconciliation divergence blocks trust when files differ from the proposed patch", async () => {
  const fixture = await createPatchFixture("add a README note");
  try {
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        after: {
          available: true,
          source: "desktop_git_snapshot_bridge",
          isGitRepo: true,
          changedFiles: ["EXTRA_FILE.md"],
          diffText: [
            "diff --git a/EXTRA_FILE.md b/EXTRA_FILE.md",
            "--- a/EXTRA_FILE.md",
            "+++ b/EXTRA_FILE.md",
            "@@ -0,0 +1 @@",
            "+extra"
          ].join("\n"),
          dirty: true,
          checkedAt: new Date().toISOString()
        }
      }
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.reconciliationReport?.status, "diverged");
    assert.equal(session?.reconciliationReport?.checkedBy, "git");
    assert.equal(session?.reconciliationReport?.evidenceSource, "desktop_git_snapshot_bridge");
    assert.equal((session?.reconciliationReport?.extraFiles ?? []).includes("EXTRA_FILE.md"), true);
    assert.equal(session?.reviewGate?.recommendation, "do_not_apply");
    assert.equal(session?.verificationResult?.status, "failed");
  } finally {
    await fixture.close();
  }
});

async function createPatchFixture(userPrompt: string) {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const server = await buildServer({ ...loadConfig(), storageDir });
  const created = await server.runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt
  });
  await server.runtime.runTurn(created.sessionId, userPrompt);

  return {
    runtime: server.runtime,
    sessionId: created.sessionId,
    close: async () => {
      await server.app.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}
