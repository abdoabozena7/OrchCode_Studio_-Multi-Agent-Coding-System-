import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

test("agent lifecycle creates plan, tool calls, command request, and patch proposal", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-agent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-agent-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n", "utf8");
  await writeFile(path.join(workspace, "README.md"), "test fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "mock",
    userPrompt: "add a README note"
  });
  const turn = await runtime.runTurn(created.sessionId, "add a README note");
  const session = runtime.getSession(created.sessionId);

  assert.equal(turn.status, "needs_approval");
  assert.ok(session?.plan);
  assert.ok((session?.toolCalls.length ?? 0) >= 5);
  assert.equal(session?.patchProposals.length, 1);
  assert.equal(session?.commandRequests.length, 1);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});
