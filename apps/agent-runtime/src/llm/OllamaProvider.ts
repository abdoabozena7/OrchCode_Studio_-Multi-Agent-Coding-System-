import { providerJsonSchema, userPromptWithContext, type EmbeddingRequest, type EmbeddingResponse, type LlmProvider, type LlmRequest } from "./LlmProvider.js";
import { normalizeStructuredOutputCandidate, validateStructuredOutput } from "../schemas/validators.js";

type OllamaChatResponse = {
  message?: {
    content?: string;
  };
  error?: string;
};

export class OllamaProvider implements LlmProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 60_000,
    private readonly embeddingModel?: string
  ) {}

  async generateStructured<T>(input: LlmRequest, _schema: unknown): Promise<T> {
    const text = await this.generateText({
      ...input,
      responseFormat: "json",
      structuredSchema: _schema,
      userPrompt: `${input.userPrompt}\n\nReturn only strict JSON. Do not wrap it in markdown.`
    });
    let lastError = "";
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
    throw new Error(`real_provider.invalid_json: Ollama returned malformed structured JSON. ${lastError}`);
  }

  async generateText(input: LlmRequest): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, input.timeoutMs ?? this.timeoutMs));
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          ...(input.responseFormat === "json" ? { format: providerJsonSchema(input.structuredSchema) ?? "json" } : {}),
          ...(input.responseFormat === "json" ? { options: { temperature: 0.1, num_predict: input.maxOutputTokens ?? 2_048 } } : {}),
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: userPromptWithContext(input) }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`real_provider.unreachable: Ollama returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as OllamaChatResponse;
      if (body.error) throw new Error(`real_provider.malformed_response: ${body.error}`);
      const content = body.message?.content;
      if (!content) throw new Error("real_provider.malformed_response: missing message.content");
      return content;
    } catch (error) {
      if (String(error).includes("AbortError")) {
        throw new Error("real_provider.timeout: Ollama request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
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
