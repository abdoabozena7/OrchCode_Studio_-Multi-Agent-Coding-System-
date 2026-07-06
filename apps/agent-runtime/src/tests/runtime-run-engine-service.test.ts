import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimeRunEngineService } from "../runtime/RuntimeRunEngineService.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

test("RuntimeRunEngineService owns local RunEngine dispatch behind approval gates", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-run-engine-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-run-engine-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Fixture\n", "utf8");
  try {
    const manager = new SessionManager(storageDir, new EventBus(), {
      runtimeEventLoader: async () => []
    });
    await manager.load();
    const session = await manager.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      executionMode: "simple_mode",
      userPrompt: "add a README note"
    });

    const result = await new RuntimeRunEngineService(manager).run({
      sessionId: session.id,
      prompt: "add a README note",
      provider: new ScriptedProvider(),
      resolvedMode: "simple_mode",
      projectMap: {
        stack: ["markdown"],
        packageManagers: [],
        testCommands: [],
        entryPoints: ["README.md"],
        importantFiles: ["README.md"]
      },
      thinkFirst: false
    });

    assert.equal(result.status, "needs_approval");
    assert.equal(result.agentName, "Local Run");
    assert.equal(result.patchProposals.length, 1);
    assert.equal(result.patchProposals[0]?.requiresApproval, true);
    assert.equal(result.commandRequests.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});
