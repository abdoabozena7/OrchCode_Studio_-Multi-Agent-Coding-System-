import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

test("agent lifecycle creates plan, tool calls, command request, and patch proposal", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-agent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-agent-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const prompt = "create a new README note";
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.ok(session?.plan);
    assert.ok((session?.toolIntents.length ?? 0) >= 4);
    assert.ok((session?.artifacts.length ?? 0) >= 3);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.commandRequests.length, 1);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});
