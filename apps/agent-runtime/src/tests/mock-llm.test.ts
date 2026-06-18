import assert from "node:assert/strict";
import test from "node:test";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";
import { agentPlanSchema } from "../schemas/sessionSchemas.js";

test("ScriptedProvider returns deterministic plans", async () => {
  const provider = new ScriptedProvider();
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
