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

test("patch validation rejects missing diff before approval", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-missing-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const result = new PatchTools(workspace).validate({
    filesChanged: [{ path: "safe.txt", changeType: "create", explanation: "safe" }],
    unifiedDiff: ""
  });
  assert.equal(result.valid, false);
  assert.equal(result.codes.includes("patch_invalid_missing_diff"), true);
  await rm(workspace, { recursive: true, force: true });
});

test("patch validation rejects filesChanged mismatch", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-mismatch-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const result = new PatchTools(workspace).validate({
    filesChanged: [{ path: "declared.txt", changeType: "create", explanation: "mismatch" }],
    unifiedDiff: [
      "diff --git a/actual.txt b/actual.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/actual.txt",
      "@@ -0,0 +1 @@",
      "+actual"
    ].join("\n")
  });
  assert.equal(result.valid, false);
  assert.equal(result.codes.includes("patch_invalid_paths"), true);
  await rm(workspace, { recursive: true, force: true });
});

test("patch validation rejects secret files", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-secret-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const result = new PatchTools(workspace).validate({
    filesChanged: [{ path: ".env.local", changeType: "create", explanation: "secret" }],
    unifiedDiff: [
      "diff --git a/.env.local b/.env.local",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/.env.local",
      "@@ -0,0 +1 @@",
      "+TOKEN=secret"
    ].join("\n")
  });
  assert.equal(result.valid, false);
  assert.equal(result.codes.includes("patch_invalid_secret_file"), true);
  await rm(workspace, { recursive: true, force: true });
});

test("patch validation rejects a diff that fails git apply --check", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-check-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  const result = new PatchTools(workspace).validate({
    filesChanged: [{ path: "missing.txt", changeType: "modify", explanation: "cannot apply" }],
    unifiedDiff: [
      "diff --git a/missing.txt b/missing.txt",
      "--- a/missing.txt",
      "+++ b/missing.txt",
      "@@ -1 +1 @@",
      "-missing",
      "+changed"
    ].join("\n")
  });
  assert.equal(result.valid, false);
  assert.equal(result.codes.includes("patch_invalid_apply_check_failed"), true);
  await rm(workspace, { recursive: true, force: true });
});
