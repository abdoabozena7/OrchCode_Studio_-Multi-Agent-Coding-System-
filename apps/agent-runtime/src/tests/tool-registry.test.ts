import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("ToolRegistry exposes guarded workspace tools", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-tools-${Date.now()}`);
  await mkdir(path.join(workspace, ".venv", "Lib"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello agent\n", "utf8");
  await writeFile(path.join(workspace, ".venv", "Lib", "ignored.py"), "value = 1\n", "utf8");
  const registry = new ToolRegistry(workspace);
  assert.equal(registry.workspace.readFile("README.md"), "hello agent\n");
  assert.equal(registry.workspace.listFiles().some((entry) => entry.path.includes(".venv")), false);
  assert.throws(() => registry.workspace.readFile("../outside.txt"), /outside/);
  await rm(workspace, { recursive: true, force: true });
});

test("ToolRegistry enforces capability grants for tools, paths, and network commands", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-tools-grant-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello agent\n", "utf8");
  const registry = new ToolRegistry(workspace, {
    id: "grant_1",
    workerId: "worker_1",
    sessionId: "session_1",
    allowedPaths: ["README.md"],
    allowedTools: ["workspace.read_file", "command.request_run"],
    allowedCommandRisks: ["safe", "medium"],
    canProposePatches: false,
    canRequestCommands: true,
    allowNetwork: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(registry.workspace.readFile("README.md"), "hello agent\n");
  assert.throws(() => registry.workspace.listFiles(), /workspace\.list_files/);
  assert.throws(() => registry.patch.propose({
    title: "Nope",
    summary: "No patch permission",
    riskLevel: "low",
    filesChanged: [],
    unifiedDiff: "",
    requiresApproval: true,
    status: "proposed"
  }, "session_1"), /patch\.propose/);
  assert.throws(() => registry.command.requestRun("session_1", "curl https://example.com", "network"), /network/);

  await rm(workspace, { recursive: true, force: true });
});
