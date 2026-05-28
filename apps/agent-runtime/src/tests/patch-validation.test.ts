import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchTools } from "../tools/PatchTools.js";

test("patch validation rejects outside workspace paths", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const tools = new PatchTools(workspace);
  const result = tools.validate({
    filesChanged: [{ path: "../escape.txt", changeType: "create", explanation: "bad" }],
    unifiedDiff: "diff --git a/../escape.txt b/../escape.txt"
  });
  assert.equal(result.valid, false);
  await rm(workspace, { recursive: true, force: true });
});
