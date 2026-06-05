import type {
  ActiveProviderSource,
  AgentRuntimeMode,
  ProviderPromptLatency,
  ProviderTruthTelemetry,
  SanitizedProviderConfig
} from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "./LlmProvider.js";

type ProviderTelemetryInput = {
  mode: AgentRuntimeMode;
  providerConfig?: SanitizedProviderConfig;
  activeProviderSource?: ActiveProviderSource;
};

type ProviderRequestType = ProviderPromptLatency["requestType"];

export class ProviderTelemetryRecorder {
  private providerRequestCount = 0;
  private providerResponseCount = 0;
  private providerFailureCount = 0;
  private providerTimeoutCount = 0;
  private totalProviderLatencyMs = 0;
  private totalProviderPromptChars = 0;
  private totalProviderResponseChars = 0;
  private totalProviderContextChars = 0;
  private perPromptProviderLatencyMs: ProviderPromptLatency[] = [];
  private fallbackUsed = false;
  private fallbackReason: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly input: ProviderTelemetryInput) {}

  async measure<T>(requestType: ProviderRequestType, request: LlmRequest, operation: () => Promise<T>): Promise<T> {
    const requestId = `provider_${Date.now()}_${this.providerRequestCount + 1}`;
    const promptSize = measureProviderPromptSize(request);
    const startedAt = Date.now();
    this.providerRequestCount += 1;
    try {
      const result = await operation();
      this.recordLatency({
        requestId,
        requestType,
        latencyMs: Date.now() - startedAt,
        status: "success",
        ...promptSize,
        responseChars: estimateSerializedChars(result)
      });
      this.providerResponseCount += 1;
      return result;
    } catch (error) {
      this.markProviderError(error);
      const timeout = isProviderTimeout(error);
      this.recordLatency({
        requestId,
        requestType,
        latencyMs: Date.now() - startedAt,
        status: timeout ? "timeout" : "failure",
        errorSummary: summarizeProviderError(error),
        ...promptSize
      });
      this.providerFailureCount += 1;
      if (timeout) this.providerTimeoutCount += 1;
      throw error;
    }
  }

  markFallback(reason: string) {
    this.fallbackUsed = true;
    this.fallbackReason = this.fallbackReason ? `${this.fallbackReason}; ${reason}` : reason;
  }

  markProviderError(error: unknown) {
    this.lastError = summarizeProviderError(error);
  }

  snapshot(): ProviderTruthTelemetry {
    const providerName = this.providerName();
    const modelName = this.modelName();
    return {
      providerMode: this.input.mode,
      providerName,
      modelName,
      providerBaseUrl: sanitizeProviderBaseUrl(this.input.providerConfig?.baseUrl),
      providerRequestCount: this.providerRequestCount,
      mockProviderRequestCount: this.input.mode === "demo_mock" ? this.providerRequestCount : 0,
      realProviderRequestCount: this.input.mode === "real_provider" ? this.providerRequestCount : 0,
      providerResponseCount: this.providerResponseCount,
      providerFailureCount: this.providerFailureCount,
      providerTimeoutCount: this.providerTimeoutCount,
      totalProviderLatencyMs: this.totalProviderLatencyMs,
      totalProviderPromptChars: this.totalProviderPromptChars,
      totalProviderResponseChars: this.totalProviderResponseChars,
      totalProviderContextChars: this.totalProviderContextChars,
      perPromptProviderLatencyMs: this.perPromptProviderLatencyMs,
      fallbackUsed: this.fallbackUsed,
      fallbackReason: this.fallbackReason,
      lastError: this.lastError,
      deterministicOnly: this.providerRequestCount === 0,
      mockProviderUsed: this.input.mode === "demo_mock" && this.providerRequestCount > 0,
      realProviderUsed: this.input.mode === "real_provider" && this.providerRequestCount > 0,
      activeProviderSource: this.input.activeProviderSource ?? "unknown",
      updatedAt: new Date().toISOString()
    };
  }

  private recordLatency(input: Omit<ProviderPromptLatency, "providerName" | "modelName">) {
    this.totalProviderLatencyMs += input.latencyMs;
    this.totalProviderPromptChars += input.promptChars ?? 0;
    this.totalProviderResponseChars += input.responseChars ?? 0;
    this.totalProviderContextChars += input.contextChars ?? 0;
    this.perPromptProviderLatencyMs.push({
      ...input,
      providerName: this.providerName(),
      modelName: this.modelName()
    });
  }

  private providerName() {
    if (this.input.mode === "demo_mock") return "mock_demo";
    return this.input.providerConfig?.providerName || this.input.providerConfig?.providerType || "real_provider";
  }

  private modelName() {
    if (this.input.mode === "demo_mock") return "mock-demo";
    return this.input.providerConfig?.selectedModel;
  }
}

export class TelemetryLlmProvider implements LlmProvider {
  constructor(
    private readonly inner: LlmProvider,
    private readonly recorder: ProviderTelemetryRecorder
  ) {}

  generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    return this.recorder.measure("structured", input, () => this.inner.generateStructured<T>(input, schema));
  }

  generateText(input: LlmRequest): Promise<string> {
    return this.recorder.measure("text", input, () => this.inner.generateText(input));
  }
}

export function createProviderTelemetryRecorder(input: ProviderTelemetryInput) {
  return new ProviderTelemetryRecorder({
    ...input,
    activeProviderSource: input.activeProviderSource ?? inferActiveProviderSource(input.mode, input.providerConfig)
  });
}

export function inferActiveProviderSource(
  mode: AgentRuntimeMode,
  providerConfig?: SanitizedProviderConfig
): ActiveProviderSource {
  if (mode === "demo_mock" && !providerConfig) return "runtime_default";
  if (providerConfig?.isValid) return "session_override";
  return "unknown";
}

function sanitizeProviderBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/\/[^/@]+@/, "//[redacted]@").split("?")[0];
  }
}

function isProviderTimeout(error: unknown) {
  const text = summarizeProviderError(error);
  return /\b(timeout|timed out|abort|aborted|AbortError)\b/i.test(text);
}

function summarizeProviderError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function measureProviderPromptSize(request: LlmRequest) {
  const systemPromptChars = request.systemPrompt.length;
  const userPromptChars = request.userPrompt.length;
  const contextChars = request.context === undefined ? 0 : estimateSerializedChars(request.context);
  return {
    systemPromptChars,
    userPromptChars,
    contextChars,
    promptChars: systemPromptChars + userPromptChars + contextChars
  };
}

function estimateSerializedChars(value: unknown, depth = 0, seen = new WeakSet<object>()): number {
  if (value === null) return 4;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (typeof value === "undefined") return 0;
  if (typeof value !== "object") return String(value).length;
  if (seen.has(value)) return 12;
  if (depth > 6) return 64;
  seen.add(value);
  if (Array.isArray(value)) {
    return 2 + value.reduce((sum, item, index) => sum + (index ? 1 : 0) + estimateSerializedChars(item, depth + 1, seen), 0);
  }
  return 2 + Object.entries(value as Record<string, unknown>).reduce((sum, [key, entry]) => {
    return sum + key.length + 3 + estimateSerializedChars(entry, depth + 1, seen);
  }, 0);
}
