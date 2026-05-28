import assert from "node:assert/strict";
import test from "node:test";
import { accessProfileDefaults } from "@hivo/protocol";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";

test("command policy classifies safe, medium, and dangerous commands", () => {
  assert.equal(classifyCommandRisk("git status", "C:/workspace/app"), "safe");
  assert.equal(classifyCommandRisk("npm run build", "C:/workspace/app"), "safe");
  assert.equal(classifyCommandRisk("cargo check", "C:/workspace/app"), "safe");
  assert.equal(classifyCommandRisk("npm install", "C:/workspace/app"), "medium");
  assert.equal(classifyCommandRisk("npm run dev", "C:/workspace/app"), "medium");
  assert.equal(classifyCommandRisk("git status && npm test", "C:/workspace/app"), "medium");
  assert.equal(classifyCommandRisk("git push origin main", "C:/workspace/app"), "dangerous");
  assert.equal(classifyCommandRisk("rm -rf .", "C:/workspace/app"), "dangerous");
});

test("full access defaults auto-apply and auto-run broad local commands", () => {
  const settings = accessProfileDefaults("full_access");
  assert.equal(settings.autoApplyValidatedPatches, true);
  assert.equal(settings.requireApprovalForPatches, false);
  assert.equal(settings.autoRunSafeCommands, true);
  assert.equal(settings.autoRunMediumCommands, true);
  assert.equal(settings.autoRunBackgroundCommands, true);
  assert.equal(settings.autoRunNetworkCommands, true);
  assert.equal(settings.blockDangerousCommands, false);
  assert.equal(settings.allowNetworkCommands, true);
});
