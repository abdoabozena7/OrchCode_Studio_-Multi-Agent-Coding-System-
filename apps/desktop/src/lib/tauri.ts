import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentStatus,
  AgentRuntimeSession,
  CommandResult,
  CreateSessionResponse,
  FileEntry,
  GitStatus,
  ModelInfo,
  ModelProviderConfig,
  ModelProviderType,
  Task,
  WorkspaceDiffSnapshot,
  WorkspaceInfo
} from "@hivo/protocol";
import type { AppEvent, SafetySettings } from "@hivo/protocol";

export type ModelProviderConfigInput = {
  id: string;
  providerType: ModelProviderType;
  providerName: string;
  baseUrl: string;
  selectedModel: string;
  routerModel?: string;
  verifierModel?: string;
  embeddingModel?: string;
  apiKey?: string;
};

export type CodeFreshnessStatus = {
  status: "fresh" | "stale" | "unknown";
  desktopStartedAt: string;
  runtimeStartedAt?: string;
  latestSourceModifiedAt?: string;
  staleFiles: string[];
  reason?: string;
};

let browserDevWorkspace: WorkspaceInfo | null = null;

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  if (hasTauriRuntime()) return invoke<T>(command, args);
  return browserDevInvoke<T>(command, args);
}

async function browserDevInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!import.meta.env.DEV) {
    throw new Error(`Tauri command ${command} is unavailable outside the desktop runtime.`);
  }
  switch (command) {
    case "open_workspace": {
      const path = String(args.path ?? "").trim();
      if (!path) throw new Error("Workspace path is required.");
      browserDevWorkspace = browserDevWorkspaceInfo(path);
      return browserDevWorkspace as T;
    }
    case "get_workspace_info": {
      if (!browserDevWorkspace) throw new Error("Open a workspace first.");
      return browserDevWorkspace as T;
    }
    case "list_workspace_files":
      return browserDevWorkspaceFiles() as T;
    case "read_workspace_file":
      throw new Error("Reading files from the Browser dev harness is unavailable; runtime tools read the real workspace.");
    case "get_git_status":
      return {
        isRepo: Boolean(browserDevWorkspace),
        branch: undefined,
        statusText: "Browser dev harness does not query git status.",
        changedFiles: []
      } as T;
    case "get_git_diff":
      return "" as T;
    case "run_workspace_command":
    case "execute_approved_command":
    case "apply_runtime_patch":
    case "reject_runtime_patch":
      throw new Error(`Tauri command ${command} requires the desktop runtime.`);
    case "create_runtime_run":
      return browserDevRuntimeRun(args.userPrompt) as T;
    case "append_session_event":
    case "upsert_orchestration_run":
    case "upsert_agent_run":
      return undefined as T;
    case "get_saved_runtime_session":
      throw new Error("Saved desktop sessions are unavailable in the Browser dev harness.");
    case "get_tasks_for_session":
    case "get_agent_statuses":
      return [] as T;
    case "validate_model_provider":
    case "save_model_provider_config":
      return requireBrowserDevProviderConfig(args.config as ModelProviderConfigInput | undefined) as T;
    case "list_available_models": {
      const config = requireBrowserDevProviderConfig(args.config as ModelProviderConfigInput | undefined);
      return [{ id: config.selectedModel, name: config.selectedModel, providerId: config.id, isLocal: config.providerType === "ollama" }] as T;
    }
    case "get_model_provider_config":
      return browserDevProviderConfig() as T;
    case "clear_model_provider_config":
      return undefined as T;
    case "open_external_target":
      if (typeof args.target === "string") window.open(args.target, "_blank", "noopener,noreferrer");
      return undefined as T;
    case "restart_with_latest_code":
      window.location.reload();
      return undefined as T;
    case "get_code_freshness_status":
      return {
        status: "unknown",
        desktopStartedAt: new Date().toISOString(),
        runtimeStartedAt: typeof args.runtimeStartedAt === "string" ? args.runtimeStartedAt : undefined,
        staleFiles: [],
        reason: "Browser dev harness cannot inspect desktop process freshness."
      } as T;
    default:
      throw new Error(`Browser dev harness does not implement Tauri command ${command}.`);
  }
}

function browserDevWorkspaceInfo(workspacePath: string): WorkspaceInfo {
  const normalized = workspacePath.replaceAll("/", "\\");
  const name = normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace";
  return {
    path: normalized,
    name,
    isGitRepo: true,
    importantFiles: ["README.md", "AGENTS.md", "package.json"],
    languages: {},
    packageManagers: [],
    testCommands: []
  };
}

function browserDevWorkspaceFiles(): FileEntry[] {
  if (!browserDevWorkspace) return [];
  return [
    { path: "README.md", name: "README.md", isDir: false, isSecretCandidate: false },
    { path: "AGENTS.md", name: "AGENTS.md", isDir: false, isSecretCandidate: false },
    { path: "package.json", name: "package.json", isDir: false, isSecretCandidate: false },
    { path: "apps", name: "apps", isDir: true, isSecretCandidate: false },
    { path: "packages", name: "packages", isDir: true, isSecretCandidate: false }
  ];
}

function browserDevRuntimeRun(userPrompt: unknown) {
  if (typeof userPrompt !== "string" || !userPrompt.trim()) {
    throw new Error("Enter a task before creating a run");
  }
  const id = browserDevId();
  return {
    sessionId: `session_browser_${id}`,
    sessionToken: `rt_browser_${id}`,
    sessionTokenExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  };
}

function browserDevProviderConfig(input?: ModelProviderConfigInput): ModelProviderConfig | null {
  const params = new URLSearchParams(window.location.search);
  const selectedModel = input?.selectedModel ?? params.get("hivoProviderModel") ?? "";
  const baseUrl = input?.baseUrl ?? params.get("hivoProviderBaseUrl") ?? "";
  if (!selectedModel || !baseUrl) return null;
  const providerType = input?.providerType ?? (params.get("hivoProviderType") as ModelProviderType | null) ?? "ollama";
  const providerName = input?.providerName ?? params.get("hivoProviderName") ?? (providerType === "ollama" ? "Ollama" : "OpenAI Compatible");
  return {
    id: input?.id ?? "browser-dev-provider",
    providerType,
    providerName,
    baseUrl,
    selectedModel,
    routerModel: input?.routerModel ?? params.get("hivoRouterModel") ?? undefined,
    verifierModel: input?.verifierModel ?? params.get("hivoVerifierModel") ?? undefined,
    embeddingModel: input?.embeddingModel ?? params.get("hivoEmbeddingModel") ?? undefined,
    apiKeyConfigured: Boolean(input?.apiKey),
    isValid: true,
    lastValidatedAt: new Date().toISOString()
  };
}

function requireBrowserDevProviderConfig(input?: ModelProviderConfigInput): ModelProviderConfig {
  const config = browserDevProviderConfig(input);
  if (!config) {
    throw new Error("Browser dev harness requires hivoProviderBaseUrl and hivoProviderModel query parameters.");
  }
  return config;
}

function browserDevId() {
  return globalThis.crypto?.randomUUID?.().replaceAll("-", "_") ?? String(Date.now());
}

export function openWorkspace(path: string) {
  return tauriInvoke<WorkspaceInfo>("open_workspace", { path });
}

export async function pickWorkspaceDirectory() {
  if (!hasTauriRuntime()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select workspace"
  });
  return typeof selected === "string" ? selected : null;
}

export function getWorkspaceInfo() {
  return tauriInvoke<WorkspaceInfo>("get_workspace_info");
}

export function listWorkspaceFiles() {
  return tauriInvoke<FileEntry[]>("list_workspace_files");
}

export function readWorkspaceFile(path: string) {
  return tauriInvoke<string>("read_workspace_file", { path });
}

export function getGitStatus() {
  return tauriInvoke<GitStatus>("get_git_status");
}

export function getGitDiff() {
  return tauriInvoke<string>("get_git_diff");
}

export function runWorkspaceCommand(command: string, safetySettings?: CommandSafetySettings) {
  return tauriInvoke<CommandResult>("run_workspace_command", { command, safetySettings });
}

type CommandSafetySettings = Pick<
  SafetySettings,
  | "blockDangerousCommands"
  | "redactSecrets"
  | "allowNetworkCommands"
  | "autoRunMediumCommands"
  | "autoRunBackgroundCommands"
  | "autoRunNetworkCommands"
>;

export function runApprovedWorkspaceCommand(command: string, safetySettings: CommandSafetySettings) {
  return tauriInvoke<CommandResult>("run_workspace_command", { command, safetySettings });
}

export function executeApprovedCommand(
  sessionId: string,
  requestId: string,
  command: string,
  autoRun: boolean,
  safetySettings: CommandSafetySettings,
  sessionToken?: string
) {
  return tauriInvoke<{
    result: CommandResult;
    updatedSession: AgentRuntimeSession;
  }>("execute_approved_command", { sessionId, requestId, command, autoRun, safetySettings, sessionToken });
}

export function createRuntimeRun(userPrompt: string, trustProfile: string) {
  return tauriInvoke<{ sessionId: string; sessionToken: string; sessionTokenExpiresAt: string }>("create_runtime_run", { userPrompt, trustProfile });
}

export function appendSessionEvent(sessionId: string, eventType: string, payload: AppEvent | Record<string, unknown>) {
  return tauriInvoke<void>("append_session_event", { sessionId, eventType, payload });
}

export function getSavedRuntimeSession(sessionId: string) {
  return tauriInvoke<AgentRuntimeSession>("get_saved_runtime_session", { sessionId });
}

export function upsertOrchestrationRun(session: AgentRuntimeSession) {
  return tauriInvoke<void>("upsert_orchestration_run", {
    sessionId: session.id,
    status: session.status,
    productBrief: session.orchestration?.productBrief,
    businessBrief: session.orchestration?.businessBrief,
    technicalPlan: session.orchestration?.technicalPlan,
    assignmentPlan: session.orchestration?.assignmentPlan
  });
}

export function upsertAgentRun(sessionId: string, input: {
  agentId: string;
  roleTitle: string;
  lifecycleStage: string;
  artifactJson?: unknown;
  status: string;
}) {
  return tauriInvoke<void>("upsert_agent_run", { sessionId, ...input });
}

export function applyRuntimePatch(sessionId: string, patchId: string) {
  return tauriInvoke<{
    patchId: string;
    status: string;
    message: string;
    authority: string;
    reconciliationSource: string;
    beforeSnapshot?: WorkspaceDiffSnapshot;
    afterSnapshot?: WorkspaceDiffSnapshot;
    durableEventIds: string[];
  }>("apply_runtime_patch", { sessionId, patchId });
}

export function rejectRuntimePatchViaRust(sessionId: string, patchId: string) {
  return tauriInvoke<{ patchId: string; status: string; message: string }>("reject_runtime_patch", { sessionId, patchId });
}

export function getTasksForSession(sessionId: string) {
  return tauriInvoke<Task[]>("get_tasks_for_session", { sessionId });
}

export function getAgentStatuses(sessionId: string) {
  return tauriInvoke<AgentStatus[]>("get_agent_statuses", { sessionId });
}

export function validateModelProvider(config: ModelProviderConfigInput) {
  return tauriInvoke<ModelProviderConfig>("validate_model_provider", { config });
}

export function listAvailableModels(config: ModelProviderConfigInput) {
  return tauriInvoke<ModelInfo[]>("list_available_models", { config });
}

export function saveModelProviderConfig(config: ModelProviderConfigInput) {
  return tauriInvoke<ModelProviderConfig>("save_model_provider_config", { config });
}

export function getModelProviderConfig() {
  return tauriInvoke<ModelProviderConfig | null>("get_model_provider_config");
}

export function clearModelProviderConfig() {
  return tauriInvoke<void>("clear_model_provider_config");
}

export function openExternalTarget(target: string) {
  return tauriInvoke<void>("open_external_target", { target });
}

export function restartWithLatestCode() {
  return tauriInvoke<void>("restart_with_latest_code");
}

export function getCodeFreshnessStatus(runtimeStartedAt?: string) {
  return tauriInvoke<CodeFreshnessStatus>("get_code_freshness_status", { runtimeStartedAt });
}
