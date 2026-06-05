import { userPromptWithContext, type LlmProvider, type LlmRequest } from "./LlmProvider.js";

export class OpenAIProvider implements LlmProvider {
  constructor(
    private readonly apiKey?: string,
    private readonly baseUrl = "https://api.openai.com",
    private readonly model = "gpt-4o-mini",
    private readonly timeoutMs = 90_000
  ) {}

  async generateStructured<T>(input: LlmRequest, _schema: unknown): Promise<T> {
    const text = await this.generateText({
      ...input,
      userPrompt: `${input.userPrompt}\n\nReturn only strict JSON. Do not wrap it in markdown.`
    });
    for (const candidate of [text, extractJsonObject(text)]) {
      if (!candidate) continue;
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // Try the next candidate before reporting the malformed response.
      }
    }
    throw new Error("openai_compatible.invalid_json: provider returned malformed structured JSON.");
  }

  async generateText(input: LlmRequest): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured. Use mock mode or set the environment variable.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: input.systemPrompt },
            { role: "user", content: userPromptWithContext(input) }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`openai_compatible.http_${response.status}: ${await response.text()}`);
      }
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (body.error?.message) {
        throw new Error(`openai_compatible.error: ${body.error.message}`);
      }
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("openai_compatible.malformed_response: missing choices[0].message.content");
      }
      return content;
    } catch (error) {
      if (String(error).includes("AbortError")) {
        throw new Error("openai_compatible.timeout: request timed out");
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
