import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandExecutionRecord, RunToGreenState } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimeRunToGreenService } from "../runtime/RuntimeRunToGreenService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("RuntimeRunToGreenService marks a successful selected command green", async () => {
  const fixture = await runToGreenFixture();
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.runToGreen = buildRunToGreenState(draft.id, fixture.workspace);
    });

    const service = new RuntimeRunToGreenService(fixture.manager, () => fakeProvider);
    await service.advanceFromCommandResult(fixture.sessionId, buildCommandRecord(fixture.sessionId, fixture.workspace, 0));

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.runToGreen?.status, "passed");
    assert.equal(session.runToGreen?.finalStatus, "green");
    assert.equal(session.runToGreen?.attempts[0]?.status, "passed");
    assert.match(session.decisionLedger.at(-1)?.finding ?? "", /Run-to-green/);
  } finally {
    await fixture.cleanup();
  }
});

test("RuntimeRunToGreenService queues the pending rerun after a repair patch applies", async () => {
  const fixture = await runToGreenFixture();
  try {
    await fixture.manager.updateSession(fixture.sessionId, (draft) => {
      draft.runToGreen = {
        ...buildRunToGreenState(draft.id, fixture.workspace),
        pendingRepairPatchId: "patch_repair",
        pendingRerunCommand: "npm test",
        pendingRerunReason: "Retry npm test after repair."
      };
    });

    const service = new RuntimeRunToGreenService(fixture.manager, () => fakeProvider);
    await service.queuePendingRerun(fixture.manager.getSession(fixture.sessionId)!, "patch_repair", "Repair applied.");

    const session = fixture.manager.getSession(fixture.sessionId)!;
    assert.equal(session.commandRequests.length, 1);
    assert.equal(session.commandRequests[0]?.command, "npm test");
    assert.equal(session.runToGreen?.currentAttempt, 2);
    assert.equal(session.runToGreen?.attempts[1]?.status, "running");
    assert.equal(session.runToGreen?.pendingRepairPatchId, undefined);
    assert.equal(session.toolIntents.at(-1)?.type, "command.requested");
  } finally {
    await fixture.cleanup();
  }
});

async function runToGreenFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-r2g-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-r2g-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });

  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "make it run"
  });

  return {
    workspace,
    storageDir,
    manager,
    sessionId: session.id,
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

function buildRunToGreenState(sessionId: string, workspace: string): RunToGreenState {
  const now = "2026-06-29T00:00:00.000Z";
  return {
    id: "r2g_test",
    sessionId,
    status: "running",
    intent: "run_to_green",
    objective: "make it run",
    selectedCommands: [{
      command: "npm test",
      cwd: workspace,
      source: "project_intake_command",
      reason: "Fixture command."
    }],
    currentAttempt: 1,
    maxAttempts: 3,
    attempts: [{
      attemptNumber: 1,
      command: "npm test",
      cwd: workspace,
      startedAt: now,
      status: "running",
      changedFiles: []
    }],
    finalStatus: "unknown",
    createdAt: now,
    updatedAt: now
  };
}

function buildCommandRecord(sessionId: string, workspace: string, exitCode: number): CommandExecutionRecord {
  return {
    id: "exec_r2g_test",
    sessionId,
    requestId: "cmd_r2g_test",
    autoRun: false,
    command: "npm test",
    cwd: workspace,
    risk: "safe",
    status: "executed",
    exitCode,
    stdout: exitCode === 0 ? "ok" : "",
    stderr: exitCode === 0 ? "" : "failed",
    message: exitCode === 0 ? "Command passed." : "Command failed.",
    createdAt: "2026-06-29T00:00:00.000Z"
  };
}

const fakeProvider: LlmProvider = {
  async generateStructured() {
    throw new Error("provider_not_expected");
  },
  async generateText() {
    throw new Error("provider_not_expected");
  }
};
