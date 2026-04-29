import assert from "node:assert/strict";
import test from "node:test";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { agentPlanSchema } from "../schemas/sessionSchemas.js";

test("MockLlmProvider returns deterministic plans", async () => {
  const provider = new MockLlmProvider();
  const first = await provider.generateStructured(
    { systemPrompt: "system", userPrompt: "add tests" },
    agentPlanSchema
  );
  const second = await provider.generateStructured(
    { systemPrompt: "system", userPrompt: "add tests" },
    agentPlanSchema
  );
  assert.deepEqual(first, second);
});
