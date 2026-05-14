import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { EventBus } from "../runtime/EventBus.js";
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
    assert.equal(session?.reviewGate?.totalAdditions, undefined);
    assert.equal(session?.reviewGate?.totalDeletions, undefined);
    assert.equal(session?.reviewGate?.changesByAgent.length, 0);
    assert.equal(session?.taskState.pendingPatchId, session?.patchProposals[0]?.id);
    assert.equal(session?.taskState.transitions.some((entry) => entry.type === "patch.proposed"), true);
    assert.equal(session?.taskState.transitions.some((entry) => entry.type === "verification.pending"), true);
    assert.equal((session?.taskState as { reconciliationStatus?: string }).reconciliationStatus, "pending");
  } finally {
    await fixture.close();
  }
});

test("deep audit runs record extended inspection metadata and coordinator evidence", async () => {
  const fixture = await createPatchFixture("perform a deep audit of the README update flow");
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
    assert.equal(coordinator?.roleTitle, "Coordinator");
    assert.equal((coordinator?.ownedPaths ?? []).includes("workspace://current"), true);
    assert.equal((coordinator?.forbiddenPaths ?? []).includes("tauri://rust-authority"), true);
    assert.equal(((coordinator?.recentActions ?? []).length ?? 0) >= 2, true);
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
      message: "Patch applied by Rust authority"
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.patchProposals[0]?.status, "applied");
    assert.equal(session?.status, "needs_approval");
    assert.equal(session?.nextAction?.kind, "approve_commands");
    assert.equal(session?.taskState.phase, "verification_pending");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Rust apply")?.status, "passed");
    assert.equal(session?.runSummary?.status, "blocked");
    assert.equal(session?.reviewGate?.totalAdditions, undefined);
    assert.equal(session?.reviewGate?.totalDeletions, undefined);
    assert.equal((session?.reviewGate?.changesByAgent[0]?.fileCount ?? 0) >= 1, true);
    assert.equal(session?.reviewGate?.changesByAgent[0]?.additions, undefined);
    assert.equal(session?.reviewGate?.changesByAgent[0]?.deletions, undefined);
    assert.equal((session?.taskState as { patchState?: { authority?: string } }).patchState?.authority, "rust");
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
      message: "Patch applied by Rust authority"
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

test("command execution emits an explicit runtime completion event instead of replaying a request event", async () => {
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-events-${Date.now()}`);
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

  assert.equal(events.some((type) => type === "runtime.command.completed"), true);
  assert.equal(events.filter((type) => type === "runtime.command.requested").length, 1);
  await rm(storageDir, { recursive: true, force: true });
});

test("expired session tokens mark the runtime task state as expired for reconciliation-aware recovery", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-expired-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-expired-storage-${Date.now()}`);
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
  assert.equal(updated?.lifecycleStage, "BLOCKED");

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("runtime task state restores with explicit restored markers after runtime restart", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-state-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-state-storage-${Date.now()}`);
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
    message: "Patch applied by Rust authority"
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
    assert.equal(restored?.taskState.transitions.some((entry) => entry.type === "session.restored"), true);
  } finally {
    await second.app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function createPatchFixture(userPrompt: string) {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
