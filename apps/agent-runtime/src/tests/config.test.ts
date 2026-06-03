import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../config.js";

test("loadConfig exposes real provider request timeout instead of fixed provider defaults", () => {
  const previousHivo = process.env.HIVO_PROVIDER_TIMEOUT_MS;
  const previousOrchcode = process.env.ORCHCODE_PROVIDER_TIMEOUT_MS;
  try {
    process.env.HIVO_PROVIDER_TIMEOUT_MS = "12345";
    delete process.env.ORCHCODE_PROVIDER_TIMEOUT_MS;

    assert.equal(loadConfig().providerRequestTimeoutMs, 12345);

    delete process.env.HIVO_PROVIDER_TIMEOUT_MS;
    process.env.ORCHCODE_PROVIDER_TIMEOUT_MS = "23456";
    assert.equal(loadConfig().providerRequestTimeoutMs, 23456);
  } finally {
    restoreEnv("HIVO_PROVIDER_TIMEOUT_MS", previousHivo);
    restoreEnv("ORCHCODE_PROVIDER_TIMEOUT_MS", previousOrchcode);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
