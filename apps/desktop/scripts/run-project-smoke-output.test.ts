import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderTruthTelemetry } from "@hivo/protocol";
import { createProviderTruthSmokeOutput } from "./run-project-smoke.ts";

test("real workspace smoke output exposes provider truth telemetry", () => {
  const telemetry: ProviderTruthTelemetry = {
    providerMode: "real_provider",
    providerName: "OpenAI-compatible",
    modelName: "smoke-model",
    providerBaseUrl: "http://127.0.0.1:47891",
    providerRequestCount: 2,
    mockProviderRequestCount: 0,
    realProviderRequestCount: 2,
    providerResponseCount: 1,
    providerFailureCount: 1,
    providerTimeoutCount: 0,
    totalProviderLatencyMs: 42,
    perPromptProviderLatencyMs: [
      {
        requestId: "provider_1",
        requestType: "text",
        providerName: "OpenAI-compatible",
        modelName: "smoke-model",
        latencyMs: 42,
        status: "failure",
        errorSummary: "provider request failed without exposing secrets"
      }
    ],
    fallbackUsed: false,
    lastError: "provider gate preserved last error",
    deterministicOnly: false,
    mockProviderUsed: false,
    realProviderUsed: true,
    activeProviderSource: "explicit_cli",
    updatedAt: "2026-06-03T00:00:00.000Z"
  };

  const output = createProviderTruthSmokeOutput({
    providerTelemetry: telemetry,
    runSummary: undefined,
    reasoningSummaries: []
  });

  assert.equal(output.activeProviderSource, "explicit_cli");
  assert.equal(output.mockProviderUsed, false);
  assert.equal(output.fallbackUsed, false);
  assert.equal(output.requestCount, 2);
  assert.equal(output.lastError, "provider gate preserved last error");
  assert.equal(output.raw?.providerBaseUrl, "http://127.0.0.1:47891");
});
