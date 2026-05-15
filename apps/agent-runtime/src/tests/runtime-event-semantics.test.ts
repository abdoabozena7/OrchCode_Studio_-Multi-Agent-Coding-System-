import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppEvent } from "@orchcode/protocol";
import { loadConfig } from "../config.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("patch apply reports verification handoff events after Rust apply is acknowledged", async () => {
  const fixture = await createRuntimeFixture("add a README note");
  const events: AppEvent[] = [];
  const unsubscribe = fixture.eventBus.subscribe((event) => events.push(event));
  try {
    await fixture.runtime.runTurn(fixture.sessionId, "add a README note");
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);

    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    events.length = 0;

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

    assert.equal(events.some((event) => event.type === "runtime.artifact.created"), true);
    assert.equal(events.some((event) => event.type === "runtime.verification.pending"), true);
    assert.equal(events.some((event) => event.type === "runtime.run.completed"), true);

    const verificationEvent = events.find((event) => event.type === "runtime.verification.pending");
    assert.equal(verificationEvent?.type, "runtime.verification.pending");
    assert.equal(verificationEvent?.verification.summary, "Patch applied. Verification commands are still pending.");

    const lastSessionUpdate = [...events].reverse().find((event) => event.type === "runtime.session.updated");
    assert.equal(lastSessionUpdate?.type, "runtime.session.updated");
    assert.equal(lastSessionUpdate?.session.lifecycleStage, "POST_VERIFY");
    assert.equal(lastSessionUpdate?.session.nextAction?.kind, "approve_commands");
  } finally {
    unsubscribe();
    await fixture.close();
  }
});

test("command execution emits explicit completion events for projection consumers", async () => {
  const fixture = await createRuntimeFixture("add a README note");
  const events: AppEvent[] = [];
  const unsubscribe = fixture.eventBus.subscribe((event) => events.push(event));
  try {
    await fixture.runtime.runTurn(fixture.sessionId, "add a README note");
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
    events.length = 0;

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

    const commandEvent = events.find((event) => event.type === "runtime.command.completed");
    assert.equal(commandEvent?.type, "runtime.command.completed");
    assert.equal(commandEvent?.execution.requestId, request.id);
    assert.equal(commandEvent?.execution.status, "executed");
    assert.equal(commandEvent?.execution.message, "Command executed through Rust");

    const runSummaryEvent = events.find((event) => event.type === "runtime.run.completed");
    assert.equal(runSummaryEvent?.type, "runtime.run.completed");
    assert.equal(runSummaryEvent?.summary.status, "completed");
  } finally {
    unsubscribe();
    await fixture.close();
  }
});

async function createRuntimeFixture(userPrompt: string) {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-events-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-events-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n", "utf8");
  await writeFile(path.join(workspace, "README.md"), "fixture\n", "utf8");

  const eventBus = new EventBus();
  const sessionManager = new SessionManager(storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime(loadConfig(), sessionManager);
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt
  });

  return {
    eventBus,
    runtime,
    sessionId: created.sessionId,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}
