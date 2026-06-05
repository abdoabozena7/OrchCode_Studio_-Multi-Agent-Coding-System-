export type LlmRequest = {
  systemPrompt: string;
  userPrompt: string;
  context?: unknown;
};

export interface LlmProvider {
  generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T>;
  generateText(input: LlmRequest): Promise<string>;
}

const MAX_RENDERED_CONTEXT_CHARS = 32_000;

export function userPromptWithContext(input: LlmRequest): string {
  if (input.context === undefined) return input.userPrompt;
  const rendered = renderProviderContext(input.context);
  if (!rendered) return input.userPrompt;
  return [
    input.userPrompt,
    "",
    "Provider context:",
    "```json",
    rendered,
    "```"
  ].join("\n");
}

function renderProviderContext(context: unknown) {
  try {
    const serialized = JSON.stringify(context, null, 2);
    if (!serialized || serialized === "null") return "";
    return serialized.length > MAX_RENDERED_CONTEXT_CHARS
      ? `${serialized.slice(0, MAX_RENDERED_CONTEXT_CHARS)}\n... [provider context truncated ${serialized.length - MAX_RENDERED_CONTEXT_CHARS} chars]`
      : serialized;
  } catch {
    return String(context).slice(0, MAX_RENDERED_CONTEXT_CHARS);
  }
}
