import type { AgentRuntimeSession } from "@hivo/protocol";

export class ProviderConfigurationError extends Error {
  constructor(
    public readonly code:
      | "provider_missing"
      | "provider_api_key_missing"
      | "provider_validation_failed"
      | "provider_mock_forbidden",
    message: string
  ) {
    super(message);
  }
}

export function assertProviderGate(input: {
  mode: AgentRuntimeSession["mode"];
  providerConfig?: AgentRuntimeSession["providerConfig"];
}) {
  if (input.mode !== "real_provider") {
    throw new ProviderConfigurationError("provider_mock_forbidden", "Demo and mock sessions are no longer supported.");
  }
  validateRealProviderConfig(input.providerConfig);
}

export function validateRealProviderConfig(config: AgentRuntimeSession["providerConfig"]): asserts config is NonNullable<AgentRuntimeSession["providerConfig"]> {
  if (!config) {
    throw new ProviderConfigurationError("provider_missing", "real_provider requires a provider configuration.");
  }
  if (!config.isValid || !config.baseUrl?.trim() || !config.selectedModel?.trim()) {
    throw new ProviderConfigurationError("provider_validation_failed", "real_provider requires a valid provider configuration.");
  }
  if (config.providerType === "openai_compatible") {
    const apiKeyEnv = config.apiKeyEnv?.trim() || "OPENAI_API_KEY";
    if (!process.env[apiKeyEnv]?.trim()) {
      throw new ProviderConfigurationError("provider_api_key_missing", `API key environment variable ${apiKeyEnv} is not configured.`);
    }
  }
}
