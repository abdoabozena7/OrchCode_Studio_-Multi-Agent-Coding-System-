export type LlmRequest = {
  systemPrompt: string;
  userPrompt: string;
  context?: unknown;
};

export interface LlmProvider {
  generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T>;
  generateText(input: LlmRequest): Promise<string>;
}
