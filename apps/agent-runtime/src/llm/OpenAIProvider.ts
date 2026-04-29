import type { LlmProvider, LlmRequest } from "./LlmProvider.js";

export class OpenAIProvider implements LlmProvider {
  constructor(
    private readonly apiKey?: string,
    private readonly baseUrl = "https://api.openai.com"
  ) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured. Use mock mode or set the environment variable.");
    }
    throw new Error(`OpenAIProvider is isolated for Module 2 and not wired to SDK calls yet (${this.baseUrl}).`);
  }

  async generateText(_input: LlmRequest): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured. Use mock mode or set the environment variable.");
    }
    throw new Error(`OpenAIProvider is isolated for Module 2 and not wired to SDK calls yet (${this.baseUrl}).`);
  }
}
