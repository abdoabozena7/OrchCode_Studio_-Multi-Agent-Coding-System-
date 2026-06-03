import type {
  AccessProfile,
  AgentRuntimeSession,
  AppEvent,
  CreateRuntimeSessionResponse,
  PatchApprovalResponse,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RuntimeExecutionMode,
  SafetySettings,
  RuntimeTurnResponse
} from "@hivo/protocol";

const runtimeBaseUrl = import.meta.env.VITE_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4317";

export type RuntimeHealth = {
  status: "ok";
  mode: "demo_mock" | "real_provider";
};

export class RuntimeUnavailableError extends Error {
  readonly code = "runtime_unavailable";

  constructor(message = "Agent runtime disconnected. Start or restart the agent-runtime service on 127.0.0.1:4317, then retry.") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export async function checkRuntimeHealth(timeoutMs = 2500): Promise<RuntimeHealth> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${runtimeBaseUrl}/health`, { signal: controller.signal });
    if (!response.ok) {
      throw new RuntimeUnavailableError(`Agent runtime disconnected. /health returned HTTP ${response.status}.`);
    }
    const health = await response.json() as RuntimeHealth;
    if (health.status !== "ok") {
      throw new RuntimeUnavailableError("Agent runtime disconnected. /health did not report an ok runtime.");
    }
    return health;
  } catch (error) {
    if (error instanceof RuntimeUnavailableError) throw error;
    throw new RuntimeUnavailableError();
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function assertRuntimeAvailable() {
  return checkRuntimeHealth();
}

export async function createRuntimeSession(input: {
  workspacePath: string;
  mode: "demo_mock" | "real_provider";
  requireRealProvider?: boolean;
  trustProfile?: "strict_gated" | "trusted_internal";
  providerConfig?: AgentRuntimeSession["providerConfig"];
  activeProviderSource?: AgentRuntimeSession["activeProviderSource"];
  sessionToken?: string;
  sessionTokenExpiresAt?: string;
  executionMode: RuntimeExecutionMode;
  accessProfile?: AccessProfile;
  thinkFirst?: boolean;
  userPrompt: string;
  safetySettings?: Partial<SafetySettings>;
}) {
  await assertRuntimeAvailable();
  return runtimeFetch<CreateRuntimeSessionResponse>("/sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function runRuntimeTurn(sessionId: string, message: string, sessionToken?: string) {
  await assertRuntimeAvailable();
  return runtimeFetch<RuntimeTurnResponse>(`/sessions/${sessionId}/turn`, {
    method: "POST",
    body: JSON.stringify({ message }),
    sessionToken
  });
}

export async function getRuntimeSession(sessionId: string, sessionToken?: string) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}`, { sessionToken });
}

export async function approveRuntimePatch(sessionId: string, patchId: string, sessionToken?: string) {
  return runtimeFetch<PatchApprovalResponse>(`/sessions/${sessionId}/patches/${patchId}/approve`, {
    method: "POST",
    sessionToken
  });
}

export async function rejectRuntimePatch(sessionId: string, patchId: string, sessionToken?: string) {
  return runtimeFetch<PatchApprovalResponse>(`/sessions/${sessionId}/patches/${patchId}/reject`, {
    method: "POST",
    sessionToken
  });
}

export async function reportRuntimePatchApplyResult(
  sessionId: string,
  patchId: string,
  result: ReportPatchApplyResultRequest,
  sessionToken?: string
) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/patches/${patchId}/result`, {
    method: "POST",
    body: JSON.stringify(result),
    sessionToken
  });
}

export async function reportRuntimeCommandResult(
  sessionId: string,
  requestId: string,
  result: ReportCommandResultRequest,
  sessionToken?: string
) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}/commands/${requestId}/result`, {
    method: "POST",
    body: JSON.stringify(result),
    sessionToken
  });
}

export function subscribeRuntimeEvents(
  sessionId: string,
  sessionToken: string | undefined,
  handlers: {
    onEvent?: (event: AppEvent) => void;
    onSession?: (session: AgentRuntimeSession) => void;
    onError?: () => void;
  }
) {
  const tokenQuery = sessionToken ? `?token=${encodeURIComponent(sessionToken)}` : "";
  const source = new EventSource(`${runtimeBaseUrl}/sessions/${sessionId}/events${tokenQuery}`);
  const handleEvent = (raw: MessageEvent<string>) => {
    const event = JSON.parse(raw.data) as AppEvent;
    handlers.onEvent?.(event);
    if (event.type === "runtime.session.updated") {
      handlers.onSession?.(event.session);
    }
  };
  const eventTypes: AppEvent["type"][] = [
    "runtime.session.updated",
    "runtime.session.restored",
    "runtime.session.expired",
    "runtime.progress.updated",
    "runtime.tool_intent.updated",
    "runtime.artifact.created",
    "runtime.verification.pending",
    "runtime.verification.passed",
    "runtime.verification.failed",
    "runtime.verification.unavailable",
    "runtime.verification.skipped",
    "runtime.patch.stats.updated",
    "runtime.run.completed",
    "runtime.orchestration.event",
    "runtime.patch.proposed",
    "runtime.patch.approved",
    "runtime.patch.rejected",
    "runtime.patch.applied",
    "runtime.patch.apply_failed",
    "runtime.command.requested",
    "runtime.command.started",
    "runtime.command.completed",
    "runtime.command.failed",
    "runtime.command.blocked"
  ];
  for (const type of eventTypes) {
    source.addEventListener(type, handleEvent as EventListener);
  }
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}

async function runtimeFetch<T>(path: string, init?: RequestInit & { sessionToken?: string }): Promise<T> {
  const { sessionToken, ...requestInit } = init ?? {};
  let response: Response;
  try {
    response = await fetch(`${runtimeBaseUrl}${path}`, {
      ...requestInit,
      headers: {
        "content-type": "application/json",
        ...(sessionToken ? { "x-hivo-session-token": sessionToken } : {}),
        ...(requestInit.headers ?? {})
      }
    });
  } catch {
    throw new RuntimeUnavailableError();
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Runtime request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
