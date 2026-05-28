import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { OllamaProvider } from "../../apps/agent-runtime/src/llm/OllamaProvider.js";
import { AgentRuntime } from "../../apps/agent-runtime/src/runtime/AgentRuntime.js";
import { EventBus } from "../../apps/agent-runtime/src/runtime/EventBus.js";
import { SessionManager } from "../../apps/agent-runtime/src/runtime/SessionManager.js";
import { loadConfig } from "../../apps/agent-runtime/src/config.js";

const auditDir = path.resolve("tmp/full-system-audit");
const outputPath = path.join(auditDir, "real-provider-smoke.json");
const baseUrl = "http://127.0.0.1:11434";
const preferredModel = "qwen2.5-coder:7b";

type ProviderCall = {
  url: string;
  model?: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  status?: number;
  error?: string;
};

const calls: ProviderCall[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.includes("/api/chat")) {
    return originalFetch(input, init);
  }
  let model: string | undefined;
  try {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    model = body?.model;
  } catch {
    model = undefined;
  }
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const response = await originalFetch(input, init);
    calls.push({
      url,
      model,
      startedAt,
      durationMs: Math.round(performance.now() - start),
      ok: response.ok,
      status: response.status
    });
    return response;
  } catch (error) {
    calls.push({
      url,
      model,
      startedAt,
      durationMs: Math.round(performance.now() - start),
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}) as typeof fetch;

async function main() {
  await mkdir(auditDir, { recursive: true });
  const result: Record<string, unknown> = {
    baseUrl,
    preferredModel,
    startedAt: new Date().toISOString(),
    directProvider: null,
    runtimeRealProvider: null,
    calls
  };

  const tagsStart = performance.now();
  const tagsResponse = await originalFetch(`${baseUrl}/api/tags`);
  const tagsBody = await tagsResponse.json() as { models?: Array<{ name?: string }> };
  const models = (tagsBody.models ?? []).map((model) => model.name).filter(Boolean);
  const model = models.includes(preferredModel) ? preferredModel : models[0];
  result.availableModels = models;
  result.selectedModel = model;
  result.tagsLatencyMs = Math.round(performance.now() - tagsStart);

  if (!model) {
    result.status = "unavailable";
    result.reason = "Ollama is reachable but returned no models.";
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return;
  }

  const directStart = performance.now();
  try {
    const provider = new OllamaProvider(baseUrl, model, 30_000);
    const text = await provider.generateText({
      systemPrompt: "You are a smoke test responder.",
      userPrompt: "Reply with exactly OK."
    });
    result.directProvider = {
      status: "succeeded",
      providerMode: "real_provider",
      model,
      responsePreview: text.slice(0, 200),
      latencyMs: Math.round(performance.now() - directStart)
    };
  } catch (error) {
    result.directProvider = {
      status: "failed",
      providerMode: "real_provider",
      model,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - directStart)
    };
  }

  const beforeRuntimeCalls = calls.length;
  const runtimeStart = performance.now();
  try {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "orchcode-real-provider-workspace-"));
    const storageDir = await mkdtemp(path.join(os.tmpdir(), "orchcode-real-provider-storage-"));
    await writeFile(path.join(workspace, "README.md"), "# Smoke Workspace\n\nThis workspace is for an OrchCode real-provider audit smoke.\n", "utf8");
    const sessionManager = new SessionManager(storageDir, new EventBus());
    await sessionManager.load();
    const runtime = new AgentRuntime(
      { ...loadConfig(), storageDir, defaultMode: "real_provider" },
      sessionManager
    );
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: {
        providerType: "ollama",
        providerName: "Ollama",
        baseUrl,
        selectedModel: model,
        isValid: true
      },
      userPrompt: "Explain this project in one sentence."
    });
    const turn = await runtime.runTurn(created.sessionId, "Explain this project in one sentence.");
    const session = runtime.getSession(created.sessionId);
    const assistant = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
    result.runtimeRealProvider = {
      status: turn.status,
      sessionStatus: session?.status,
      lifecycleStage: session?.lifecycleStage,
      providerMode: session?.mode,
      model,
      providerCalls: calls.length - beforeRuntimeCalls,
      fallbackUsed: session?.artifacts.some((artifact) => JSON.stringify(artifact.metadata ?? {}).includes("\"fallbackUsed\":true")) ?? false,
      assistantPreview: assistant.slice(0, 500),
      artifactTypes: session?.artifacts.map((artifact) => artifact.type),
      commandRequests: session?.commandRequests.length,
      patchProposals: session?.patchProposals.length,
      latencyMs: Math.round(performance.now() - runtimeStart)
    };
  } catch (error) {
    result.runtimeRealProvider = {
      status: "failed",
      providerMode: "real_provider",
      model,
      providerCalls: calls.length - beforeRuntimeCalls,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - runtimeStart)
    };
  }

  result.finishedAt = new Date().toISOString();
  result.providerCallCount = calls.length;
  result.responseCount = calls.filter((call) => call.ok).length;
  result.mockFallbackUsage = false;
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

main().catch(async (error) => {
  await mkdir(auditDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    status: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    calls
  }, null, 2)}\n`, "utf8");
  process.exitCode = 1;
});
