import type { LlmProvider } from "./LlmProvider.js";

export type ProviderCapability = "router" | "author" | "verifier" | "embedding";

export type ProviderCapabilityProbeResult = {
  role: ProviderCapability;
  available: boolean;
  latencyMs: number;
  error?: string;
  structuredOutputSupported: boolean;
  classification?: "empty_content" | "truncated_json" | "malformed_structured" | "success" | "failed_provider";
};

export type ProviderCapabilityProfile = {
  providerLabel: string;
  probes: ProviderCapabilityProbeResult[];
  allRequiredAvailable: boolean;
  embeddingConfigured: boolean;
  embeddingModel?: string;
};

const PROBE_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const BOUNDED_RETRY_BACKOFF_MS = 1_000;

async function probeWithBoundedRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries: number = MAX_RETRIES
): Promise<{ result: T | undefined; error: string | undefined; attempts: number }> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, error: undefined, attempts: attempt + 1 };
    } catch (error) {
      lastError = formatProbeError(error);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, BOUNDED_RETRY_BACKOFF_MS * (attempt + 1)));
      }
    }
  }
  return { result: undefined, error: lastError, attempts: maxRetries + 1 };
}

function classifyProviderOutput(output: unknown, isStructured: boolean): ProviderCapabilityProbeResult["classification"] {
  if (output === undefined || output === null) return "empty_content";
  if (isStructured) {
    if (typeof output === "string") {
      if (!output.trim()) return "empty_content";
      try {
        JSON.parse(output);
        return "success";
      } catch {
        // Check for truncated JSON
        const trimmed = output.trim();
        if (
          (trimmed.startsWith("{") && !trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && !trimmed.endsWith("]"))
        ) {
          return "truncated_json";
        }
        return "malformed_structured";
      }
    }
    if (typeof output === "object" && output !== null) return "success";
    return "malformed_structured";
  }
  if (typeof output === "string") {
    if (!output.trim()) return "empty_content";
    return "success";
  }
  return "malformed_structured";
}

export async function probeProviderCapability(
  provider: LlmProvider,
  role: ProviderCapability,
  embeddingModel?: string
): Promise<ProviderCapabilityProbeResult> {
  const startedAt = Date.now();

  if (role === "embedding") {
    if (!provider.embed || !embeddingModel) {
      return {
        role,
        available: false,
        latencyMs: Date.now() - startedAt,
        structuredOutputSupported: false,
        error: embeddingModel ? "Provider lacks embed method" : "No embedding model configured",
        classification: "failed_provider"
      };
    }
    const { result, error } = await probeWithBoundedRetry("embedding_probe", async () => {
      return await provider.embed!({ inputs: ["test probe"], model: embeddingModel! });
    });
    return {
      role,
      available: result !== undefined,
      latencyMs: Date.now() - startedAt,
      structuredOutputSupported: false,
      error,
      classification: result ? "success" : "failed_provider"
    };
  }

  const probeSchema = {
    name: "probe_result",
    type: "object",
    properties: {
      probe: { type: "string" },
      timestamp: { type: "string" }
    },
    required: ["probe", "timestamp"]
  };

  const { result, error } = await probeWithBoundedRetry(`${role}_probe`, async () => {
    return await provider.generateStructured<{ probe: string; timestamp: string }>(
      {
        systemPrompt: "Return a simple JSON object confirming capability.",
        userPrompt: `Confirm you can act as a ${role} provider. Return { "probe": "${role}_ok", "timestamp": "<current UTC ISO>" }.`,
        maxOutputTokens: 128,
        timeoutMs: PROBE_TIMEOUT_MS
      },
      probeSchema
    );
  });

  if (result) {
    return {
      role,
      available: true,
      latencyMs: Date.now() - startedAt,
      structuredOutputSupported: true,
      classification: classifyProviderOutput(result, true),
      error
    };
  }

  // Fallback to text probe when structured fails
  const textResult = await probeWithBoundedRetry(`${role}_text_probe`, async () => {
    return await provider.generateText({
      systemPrompt: "Confirm capability briefly.",
      userPrompt: `Can you act as a ${role}? Answer yes or no in one word.`,
      maxOutputTokens: 32,
      timeoutMs: PROBE_TIMEOUT_MS
    });
  });

  const classification = classifyProviderOutput(textResult.result, false);

  return {
    role,
    available: classification === "success",
    latencyMs: Date.now() - startedAt,
    structuredOutputSupported: false,
    error: textResult.error,
    classification
  };
}

export async function buildProviderCapabilityProfile(
  provider: LlmProvider,
  options: { embeddingModel?: string } = {}
): Promise<ProviderCapabilityProfile> {
  const roles: ProviderCapability[] = ["router", "author", "verifier"];
  const probes = await Promise.all(
    roles.map((role) => probeProviderCapability(provider, role))
  );
  const embeddingProbe = await probeProviderCapability(provider, "embedding", options.embeddingModel);
  probes.push(embeddingProbe);
  const allRequiredAvailable = probes
    .filter((p) => p.role !== "embedding")
    .every((p) => p.available);
  return {
    providerLabel: provider.constructor?.name ?? "unknown",
    probes,
    allRequiredAvailable,
    embeddingConfigured: embeddingProbe.available,
    embeddingModel: options.embeddingModel
  };
}

function formatProbeError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (/timeout/i.test(msg)) return "provider_timeout";
    if (/unauthorized|invalid.*api/i.test(msg)) return "provider_unauthorized";
    if (/network|econnrefused|enotfound/i.test(msg)) return "provider_network_error";
    return msg.slice(0, 200);
  }
  return String(error).slice(0, 200);
}
