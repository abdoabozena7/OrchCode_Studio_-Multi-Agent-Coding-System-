import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("ToolRegistry exposes guarded workspace tools", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-tools-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello agent\n", "utf8");
  const registry = new ToolRegistry(workspace);
  assert.equal(registry.workspace.readFile("README.md"), "hello agent\n");
  assert.throws(() => registry.workspace.readFile("../outside.txt"), /outside/);
  await rm(workspace, { recursive: true, force: true });
});
