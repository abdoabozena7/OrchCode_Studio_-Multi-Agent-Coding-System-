import assert from "node:assert/strict";
import test from "node:test";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import { autoSuggestEmbeddingModel, createRealProvider } from "../runtime/RuntimeProviderFactory.js";
import { ProviderConfigurationError } from "../runtime/RuntimeProviderGate.js";

test("RuntimeProviderFactory creates real providers behind the provider gate", () => {
  const ollama = createRealProvider({
    providerType: "ollama",
    providerName: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    selectedModel: "llama3",
    isValid: true
  }, 10_000);

  assert.equal(ollama instanceof OllamaProvider, true);
  assert.equal(autoSuggestEmbeddingModel({
    providerType: "ollama",
    providerName: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    selectedModel: "llama3",
    isValid: true
  }), "nomic-embed-text:latest");
});

test("RuntimeProviderFactory validates OpenAI-compatible API keys before construction", () => {
  const key = "HIVO_RUNTIME_PROVIDER_FACTORY_TEST_KEY";
  const previous = process.env[key];
  try {
    delete process.env[key];
    assert.throws(
      () => createRealProvider({
        providerType: "openai_compatible",
        providerName: "openai-compatible",
        baseUrl: "https://example.test/v1",
        selectedModel: "gpt-test",
        apiKeyEnv: key,
        isValid: true
      }, 10_000),
      (error) => error instanceof ProviderConfigurationError && error.code === "provider_api_key_missing"
    );

    process.env[key] = "test-key";
    const provider = createRealProvider({
      providerType: "openai_compatible",
      providerName: "openai-compatible",
      baseUrl: "https://example.test/v1",
      selectedModel: "gpt-test",
      apiKeyEnv: key,
      isValid: true
    }, 10_000);
    assert.equal(provider instanceof OpenAIProvider, true);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
