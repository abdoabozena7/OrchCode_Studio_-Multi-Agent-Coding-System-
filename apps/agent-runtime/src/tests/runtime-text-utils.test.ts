import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession } from "@hivo/protocol";
import {
  detectResponseLanguage,
  isArabicRuntimeLanguage,
  summarizeRuntimeOutput,
  waitingForProviderSummary
} from "../runtime/RuntimeTextUtils.js";

test("RuntimeTextUtils centralizes deterministic language and output summaries", () => {
  assert.equal(detectResponseLanguage("hello"), "en");
  assert.equal(detectResponseLanguage("مرحبا"), "ar");
  assert.equal(isArabicRuntimeLanguage("arabic"), true);
  assert.equal(isArabicRuntimeLanguage("en"), false);
  assert.equal(summarizeRuntimeOutput("  one\n two \t three  "), "one two three");
  assert.equal(summarizeRuntimeOutput("abcdef", 5), "ab...");
  assert.match(waitingForProviderSummary(runtimeSession(), "en"), /Waiting for test-model/);
});

function runtimeSession(): AgentRuntimeSession {
  return {
    providerConfig: {
      providerType: "openai_compatible",
      baseUrl: "https://example.test",
      selectedModel: "test-model"
    }
  } as AgentRuntimeSession;
}
