import type {
  AccessProfile,
  AgentRuntimeSession,
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
