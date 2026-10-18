import type { AgentRuntimeSession } from "@hivo/protocol";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import { ProviderConfigurationError, validateRealProviderConfig } from "./RuntimeProviderGate.js";

export function createRealProvider(config: AgentRuntimeSession["providerConfig"], timeoutMs: number) {
  validateRealProviderConfig(config);
  const embeddingModel = config.embeddingModel
    ?? process.env.HIVO_EMBEDDING_MODEL
    ?? (config.providerType === "ollama" ? (process.env.OLLAMA_EMBEDDING_MODEL || autoSuggestEmbeddingModel(config)) : process.env.OPENAI_EMBEDDING_MODEL);
  if (config.providerType === "ollama") {
    return new OllamaProvider(config.baseUrl, config.selectedModel, timeoutMs, embeddingModel, ollamaContextTokens());
  }
  if (config.providerType === "openai_compatible") {
    const apiKeyEnv = config.apiKeyEnv?.trim() || "OPENAI_API_KEY";
    return new OpenAIProvider(process.env[apiKeyEnv], config.baseUrl, config.selectedModel, timeoutMs, embeddingModel);
  }
  throw new ProviderConfigurationError("provider_validation_failed", `Unsupported provider type: ${config.providerType}`);
}

function ollamaContextTokens() {
  const configured = Number(process.env.HIVO_OLLAMA_NUM_CTX ?? process.env.OLLAMA_NUM_CTX ?? "32768");
  return Number.isFinite(configured) ? Math.max(8_192, Math.min(Math.floor(configured), 131_072)) : 32_768;
}

export function autoSuggestEmbeddingModel(config: AgentRuntimeSession["providerConfig"]): string | undefined {
  if (config?.providerType === "ollama") {
    return "nomic-embed-text:latest";
  }
  return undefined;
}
