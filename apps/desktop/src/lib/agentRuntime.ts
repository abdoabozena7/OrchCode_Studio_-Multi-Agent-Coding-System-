import type {
  AccessProfile,
  AgentRuntimeSession,
  AppEvent,
  CreateRuntimeSessionResponse,
  PatchApprovalResponse,
  RuntimeExecutionMode,
  SafetySettings,
  RuntimeTurnResponse
} from "@orchcode/protocol";

const runtimeBaseUrl = import.meta.env.VITE_AGENT_RUNTIME_URL ?? "http://127.0.0.1:4317";

export async function createRuntimeSession(input: {
  workspacePath: string;
  mode: "mock" | "real";
  executionMode: RuntimeExecutionMode;
  accessProfile?: AccessProfile;
  thinkFirst?: boolean;
  userPrompt: string;
  safetySettings?: Partial<SafetySettings>;
}) {
  return runtimeFetch<CreateRuntimeSessionResponse>("/sessions", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function runRuntimeTurn(sessionId: string, message: string) {
  return runtimeFetch<RuntimeTurnResponse>(`/sessions/${sessionId}/turn`, {
    method: "POST",
    body: JSON.stringify({ message })
  });
}

export async function getRuntimeSession(sessionId: string) {
  return runtimeFetch<AgentRuntimeSession>(`/sessions/${sessionId}`);
}

export async function approveRuntimePatch(sessionId: string, patchId: string) {
  return runtimeFetch<PatchApprovalResponse>(`/sessions/${sessionId}/patches/${patchId}/approve`, {
    method: "POST"
  });
}

export async function rejectRuntimePatch(sessionId: string, patchId: string) {
  return runtimeFetch<PatchApprovalResponse>(`/sessions/${sessionId}/patches/${patchId}/reject`, {
    method: "POST"
  });
}

export function subscribeRuntimeEvents(
  sessionId: string,
  handlers: {
    onEvent?: (event: AppEvent) => void;
    onSession?: (session: AgentRuntimeSession) => void;
    onError?: () => void;
  }
) {
  const source = new EventSource(`${runtimeBaseUrl}/sessions/${sessionId}/events`);
  const handleEvent = (raw: MessageEvent<string>) => {
    const event = JSON.parse(raw.data) as AppEvent;
    handlers.onEvent?.(event);
    if (event.type === "runtime.session.updated") {
      handlers.onSession?.(event.session);
    }
  };
  const eventTypes: AppEvent["type"][] = [
    "runtime.session.updated",
    "runtime.progress.updated",
    "runtime.patch.stats.updated",
    "runtime.run.completed",
    "runtime.orchestration.event",
    "runtime.patch.proposed",
    "runtime.command.requested"
  ];
  for (const type of eventTypes) {
    source.addEventListener(type, handleEvent as EventListener);
  }
  source.onerror = () => handlers.onError?.();
  return () => source.close();
}

async function runtimeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${runtimeBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Runtime request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
