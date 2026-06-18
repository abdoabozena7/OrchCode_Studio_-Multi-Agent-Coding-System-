import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppEvent } from "@hivo/protocol";
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

test("patch proposal does not change files before Rust apply acknowledgement", async () => {
  const fixture = await createRuntimeFixture("add a README note");
  try {
    await fixture.runtime.runTurn(fixture.sessionId, "add a README note");
    const proposal = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0];
    assert.equal(proposal?.status, "proposed");
    await assert.rejects(access(path.join(fixture.workspace, "AGENT_PROPOSAL.md")));
    assert.doesNotMatch(fixture.runtime.getSession(fixture.sessionId)?.messages.at(-1)?.content ?? "", /\b(applied|fixed|files changed)\b/i);
  } finally {
    await fixture.close();
  }
});

test("invalid patch cannot be approved", async () => {
  const fixture = await createRuntimeFixture("add a README note");
  try {
    await fixture.runtime.runTurn(fixture.sessionId, "add a README note");
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.sessionManager.updateSession(fixture.sessionId, (session) => {
      const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
      if (patch) patch.unifiedDiff = "";
    });
    await assert.rejects(fixture.runtime.approvePatch(fixture.sessionId, patchId), /patch_invalid_missing_diff/);
    assert.equal(fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.status, "proposed");
  } finally {
    await fixture.close();
  }
});

test("Rust apply failure acknowledgement becomes apply_failed and surfaces the error", async () => {
  const fixture = await createRuntimeFixture("add a README note");
  try {
    await fixture.runtime.runTurn(fixture.sessionId, "add a README note");
    const patchId = fixture.runtime.getSession(fixture.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "apply_started",
      message: "Rust patch apply requested."
    });
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "failed",
      message: "patch_invalid_apply_check_failed: hunk does not apply"
    });
    const session = fixture.runtime.getSession(fixture.sessionId);
    assert.equal(session?.patchProposals[0]?.status, "apply_failed");
    assert.match(session?.messages.at(-1)?.content ?? "", /hunk does not apply/);
  } finally {
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

test("blocked and approval-required validation never become verified_passed", async () => {
  for (const status of ["blocked", "approval_required"] as const) {
    const fixture = await createRuntimeFixture(`add a README note ${status}`);
    const events: AppEvent[] = [];
    const unsubscribe = fixture.eventBus.subscribe((event) => events.push(event));
    try {
      await fixture.runtime.runTurn(fixture.sessionId, `add a README note ${status}`);
      const request = fixture.runtime.getSession(fixture.sessionId)?.commandRequests[0];
      assert.ok(request);
      await fixture.runtime.reportCommandResult(fixture.sessionId, request.id, {
        command: request.command,
        cwd: request.cwd,
        risk: request.risk,
        status,
        stdout: "",
        stderr: "",
        message: status === "blocked" ? "Blocked by Rust TerminalService policy" : "Rust TerminalService requires approval"
      });
      const truth = fixture.runtime.getSession(fixture.sessionId)?.verificationResult?.truthStatus;
      assert.equal(truth, status === "blocked" ? "not_run_blocked_by_policy" : "not_run_needs_approval");
      assert.notEqual(truth, "verified_passed");
      if (status === "approval_required") {
        assert.equal(events.some((event) => event.type === "runtime.command.blocked"), true);
        assert.equal(events.some((event) => event.type === "runtime.command.completed"), false);
      }
    } finally {
      unsubscribe();
      await fixture.close();
    }
  }
});

async function createRuntimeFixture(userPrompt: string) {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-events-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-events-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });

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
    sessionManager,
    sessionId: created.sessionId,
    workspace,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}
