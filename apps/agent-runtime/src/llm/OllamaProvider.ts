import { userPromptWithContext, type LlmProvider, type LlmRequest } from "./LlmProvider.js";
import { validateStructuredOutput } from "../schemas/validators.js";

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
    private readonly timeoutMs = 60_000
  ) {}

  async generateStructured<T>(input: LlmRequest, _schema: unknown): Promise<T> {
    const text = await this.generateText({
      ...input,
      userPrompt: `${input.userPrompt}\n\nReturn only strict JSON. Do not wrap it in markdown.`
    });
    let lastError = "";
    for (const candidate of [text, extractJsonObject(text)]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as T;
        const validation = validateStructuredOutput(parsed, _schema);
        if (!validation.valid) {
          lastError = `schema_validation_failed: ${validation.errors.join("; ")}`;
          continue;
        }
        return parsed;
      } catch (error) {
        lastError = String(error);
      }
    }
    throw new Error(`real_provider.invalid_json: Ollama returned malformed structured JSON. ${lastError}`);
  }

  async generateText(input: LlmRequest): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
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
}

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
