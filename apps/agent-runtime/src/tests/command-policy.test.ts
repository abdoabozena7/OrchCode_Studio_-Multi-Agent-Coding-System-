import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";

test("command policy classifies safe, medium, and dangerous commands", () => {
  assert.equal(classifyCommandRisk("git status", "C:/workspace/app"), "safe");
  assert.equal(classifyCommandRisk("npm install", "C:/workspace/app"), "medium");
  assert.equal(classifyCommandRisk("rm -rf .", "C:/workspace/app"), "dangerous");
});
