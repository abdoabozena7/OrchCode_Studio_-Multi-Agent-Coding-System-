import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";

const sourceRoot = path.resolve(import.meta.dirname, "..", "..", "src");

test("production provider calls are confined to ReasoningKernel and provider adapters", async () => {
  const files = await sourceFiles(sourceRoot);
  const violations: string[] = [];
  for (const file of files) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    if (relative.startsWith("tests/") || relative.startsWith("llm/") || relative === "runtime/ReasoningKernel.ts") continue;
    const content = await readFile(file, "utf8");
    if (/\.generateStructured\s*(?:<[^>]+>)?\s*\(|\.generateText\s*\(/.test(content)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});

test("runtime mock providers and legacy semantic answer engines cannot re-enter AgentRuntime", async () => {
  const files = await sourceFiles(sourceRoot);
  const production = files.filter((file) => !path.relative(sourceRoot, file).replaceAll("\\", "/").startsWith("tests/"));
  const violations: string[] = [];
  for (const file of production) {
    const relative = path.relative(sourceRoot, file).replaceAll("\\", "/");
    const content = await readFile(file, "utf8");
    if (/MockLlmProvider|defaultMockWorker/.test(content)) violations.push(relative);
  }
  const agentRuntime = await readFile(path.join(sourceRoot, "runtime", "AgentRuntime.ts"), "utf8");
  assert.doesNotMatch(agentRuntime, /UniversalProjectQuestionEngine|ProjectQuestionGrounding|createDeterministicGroundedFallbackAnswer/);
  assert.deepEqual(violations, []);
});

test("ReasoningKernel starts with a combined provider understanding and ReasoningStep and never silently truncates context", async () => {
  const kernel = await readFile(path.join(sourceRoot, "runtime", "ReasoningKernel.ts"), "utf8");
  const providerContract = await readFile(path.join(sourceRoot, "llm", "LlmProvider.ts"), "utf8");
  assert.match(kernel, /initialReasoningDecisionSchema/);
  assert.doesNotMatch(kernel, /reasoningDirectiveSchema/);
  assert.doesNotMatch(providerContract, /provider context truncated/);
  assert.match(providerContract, /provider\.context_too_large/);
});

test("adaptive read-only delegation and composite investigation remain inside ReasoningKernel", async () => {
  const escalation = await readFile(path.join(sourceRoot, "runtime", "ProjectUnderstandingEscalation.ts"), "utf8");
  const dispatcher = await readFile(path.join(sourceRoot, "runtime", "ReasoningToolDispatcher.ts"), "utf8");
  const kernel = await readFile(path.join(sourceRoot, "runtime", "ReasoningKernel.ts"), "utf8");
  assert.match(escalation, /runAdaptiveReasoningTurn/);
  assert.doesNotMatch(escalation, /SwarmAutopilotRuntime/);
  assert.match(dispatcher, /investigateProject/);
  assert.match(kernel, /informationGain/);
  assert.match(kernel, /REASONING_STAGE_BUDGETS/);
});

test("SessionManager rejects assistant messages without provider provenance", async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), "hivo-provider-provenance-"));
  try {
    const manager = new SessionManager(storage, new EventBus());
    await manager.load();
    const session = await manager.createSession({
      workspacePath: storage,
      mode: "real_provider",
      userPrompt: "hello"
    });
    await assert.rejects(
      manager.addMessage(session.id, { role: "assistant", content: "local answer" }),
      /provider_provenance_required/
    );
    await manager.addMessage(session.id, { role: "assistant", content: "provider answer", providerRequestRefs: ["provider_request_1"] });
    assert.equal(manager.getSession(session.id)?.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

async function sourceFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await sourceFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".ts")) results.push(fullPath);
  }
  return results;
}
