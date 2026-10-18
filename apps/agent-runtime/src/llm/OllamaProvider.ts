import {
  ProviderFailureError,
  providerJsonSchema,
  userPromptWithContext,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type LlmProvider,
  type LlmRequest
} from "./LlmProvider.js";
import { normalizeStructuredOutputCandidate, validateStructuredOutput } from "../schemas/validators.js";

const CLOUD_MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_FAILURE_EXCERPT_CHARS = 320;

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
};

export class OllamaProvider implements LlmProvider {
  private readonly cloudModel: boolean;
  readonly structuredRetryPolicy?: { maxKernelRepairAttempts: number };

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
    private readonly embeddingModel?: string,
    private readonly maxContextTokens = 32_768
  ) {
    this.cloudModel = /(?:^|[-:])cloud(?:$|[-:])/i.test(model);
    if (this.cloudModel) this.structuredRetryPolicy = { maxKernelRepairAttempts: 0 };
  }

  async generateStructured<T>(input: LlmRequest, _schema: unknown): Promise<T> {
    // Cloud models get one native-schema request and one JSON repair. The kernel
    // must not add another repair loop around this bounded provider policy.
    const maxAttempts = 2;
    const startedAt = Date.now();
    let lastError = "";
    let responseExcerpt: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let text: string;
      try {
        text = await this.generateText({
          ...input,
          responseFormat: "json",
          structuredSchema: _schema,
          maxOutputTokens: input.maxOutputTokens ?? 4_096,
          structuredMode: this.cloudModel && attempt === 0 ? "native" : "json",
          userPrompt: attempt === 0
            ? `${input.userPrompt}\n\nOutput only the structured JSON object. Do not wrap it in markdown.`
            : buildRepairPrompt(input.userPrompt, lastError)
        });
      } catch (error) {
        if (error instanceof ProviderFailureError && !this.cloudModel && attempt < maxAttempts - 1 && isRetryableProviderFailure(error)) {
          lastError = error.message;
          continue;
        }
        throw error instanceof ProviderFailureError
          ? error
          : createProviderFailure(error, input, attempt + 1, Date.now() - startedAt);
      }
      responseExcerpt = compactExcerpt(text);
      for (const candidate of [text, extractJsonObject(text)]) {
        if (!candidate) continue;
        try {
          const parsed = JSON.parse(candidate) as T;
          const normalized = normalizeStructuredOutputCandidate(parsed, _schema);
          const validation = validateStructuredOutput(normalized, _schema);
          if (!validation.valid) {
            lastError = `schema_validation_failed: ${validation.errors.join("; ")}`;
            continue;
          }
          return normalized;
        } catch (error) {
          lastError = String(error);
        }
      }
    }
    const failureClass = lastError.startsWith("schema_validation_failed") ? "schema_validation" : "invalid_json";
    throw new ProviderFailureError(
      `real_provider.invalid_json: Ollama returned malformed structured JSON after ${maxAttempts} attempt(s). ${lastError}`,
      {
        failureClass,
        stage: input.reasoningStage,
        attempts: maxAttempts,
        elapsedMs: Date.now() - startedAt,
        responseExcerpt,
        retryable: true
      }
    );
  }

  async generateText(input: LlmRequest): Promise<string> {
    const maxRetries = this.cloudModel ? 0 : 1;
    const maxOutputTokens = input.maxOutputTokens ?? 4_096;
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(1000 * 2 ** attempt, 8_000));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs(input));
      try {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            keep_alive: "30m",
            ...(input.responseFormat === "json"
              ? {
                  format:
                    this.cloudModel && input.structuredMode === "native"
                      ? providerJsonSchema(input.structuredSchema) ?? "json"
                      : "json"
                }
              : {}),
            options: {
              temperature: input.responseFormat === "json" ? 0 : 0.1,
              num_ctx: this.contextWindow(input, maxOutputTokens),
              num_predict: maxOutputTokens
            },
            messages: [
              { role: "system", content: input.systemPrompt ?? "" },
              { role: "user", content: userPromptWithContext(input) }
            ]
          }),
          signal: controller.signal
        });
        if (!response.ok) {
          if (attempt < maxRetries) {
            continue;
          }
          throw new Error(`real_provider.unreachable: Ollama returned HTTP ${response.status}`);
        }
        const body = (await response.json()) as OllamaChatResponse;
        if (body.error) {
          if (attempt < maxRetries) {
            continue;
          }
          throw new Error(`real_provider.malformed_response: ${body.error}`);
        }
        const content = body.message?.content;
        if (!content) throw new Error("real_provider.malformed_response: missing message.content");
        return content;
      } catch (error) {
        if (String(error).includes("AbortError")) {
          throw createProviderFailure(
            new Error("real_provider.timeout: Ollama request timed out"),
            input,
            attempt + 1,
            Date.now() - startedAt
          );
        }
        if (attempt < maxRetries && !String(error).includes("real_provider.timeout")) {
          continue;
        }
        if (error instanceof ProviderFailureError) throw error;
        throw createProviderFailure(error, input, attempt + 1, Date.now() - startedAt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("real_provider.unreachable: Ollama request failed after retries");
  }

  private requestTimeoutMs(input: LlmRequest) {
    const configured = input.timeoutMs ?? this.timeoutMs;
    return this.cloudModel
      ? Math.min(Math.max(1_000, configured), CLOUD_MAX_REQUEST_TIMEOUT_MS)
      : Math.max(this.timeoutMs, configured);
  }

  private contextWindow(input: LlmRequest, maxOutputTokens: number) {
    const promptChars = (input.systemPrompt?.length ?? 0) + (input.userPrompt?.length ?? 0) + JSON.stringify(input.context ?? "").length;
    const estimatedPromptTokens = Math.ceil(promptChars / 3.5);
    const required = estimatedPromptTokens + maxOutputTokens + 1_024;
    return Math.max(8_192, Math.min(this.maxContextTokens, required));
  }

  async embed(input: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = input.model ?? this.embeddingModel;
    if (!model) throw new Error("real_provider.embedding_model_missing");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: input.inputs }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`real_provider.embedding_http_${response.status}`);
      const body = await response.json() as { embeddings?: number[][]; model?: string; error?: string };
      if (body.error) throw new Error(`real_provider.embedding_error: ${body.error}`);
      if (!body.embeddings || body.embeddings.length !== input.inputs.length || body.embeddings.some((vector) => !vector.length)) {
        throw new Error("real_provider.embedding_malformed_response");
      }
      return { model: body.model ?? model, vectors: body.embeddings };
    } catch (error) {
      if (String(error).includes("AbortError")) throw new Error("real_provider.embedding_timeout");
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function buildRepairPrompt(userPrompt: string, validationError: string) {
  return [
    userPrompt,
    "",
    "Return only one valid JSON object matching the supplied schema.",
    "Do not include markdown, commentary, hidden reasoning, or the user request.",
    `Correct this compact validation issue: ${compactExcerpt(validationError)}`
  ].join("\n");
}

function compactExcerpt(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_FAILURE_EXCERPT_CHARS
    ? `${compact.slice(0, MAX_FAILURE_EXCERPT_CHARS)}...`
    : compact;
}

function isRetryableProviderFailure(error: ProviderFailureError) {
  return error.providerFailure.retryable || /real_provider\.(unreachable|malformed_response)/i.test(error.message);
}

function createProviderFailure(
  error: unknown,
  input: LlmRequest,
  attempts: number,
  elapsedMs: number,
  responseExcerpt?: string
) {
  const message = error instanceof Error ? error.message : String(error);
  const failureClass = classifyProviderFailure(message);
  return new ProviderFailureError(message, {
    failureClass,
    stage: input.reasoningStage,
    attempts,
    elapsedMs,
    responseExcerpt,
    retryable: !/provider\.context_too_large|embedding_model_missing/i.test(message)
  });
}

function classifyProviderFailure(message: string) {
  if (/timeout|timed out|abort/i.test(message)) return "timeout" as const;
  if (/invalid_json/i.test(message)) return "invalid_json" as const;
  if (/schema_validation/i.test(message)) return "schema_validation" as const;
  if (/unreachable|HTTP \d+/i.test(message)) return "unreachable" as const;
  if (/malformed_response/i.test(message)) return "malformed_response" as const;
  return "unknown" as const;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
