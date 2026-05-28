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
  apiKey?: string;
};

export function openWorkspace(path: string) {
  return invoke<WorkspaceInfo>("open_workspace", { path });
}

export async function pickWorkspaceDirectory() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select workspace"
  });
  return typeof selected === "string" ? selected : null;
}

export function getWorkspaceInfo() {
  return invoke<WorkspaceInfo>("get_workspace_info");
}

export function listWorkspaceFiles() {
  return invoke<FileEntry[]>("list_workspace_files");
}

export function readWorkspaceFile(path: string) {
  return invoke<string>("read_workspace_file", { path });
}

export function getGitStatus() {
  return invoke<GitStatus>("get_git_status");
}

export function getGitDiff() {
  return invoke<string>("get_git_diff");
}

export function runWorkspaceCommand(command: string, safetySettings?: CommandSafetySettings) {
  return invoke<CommandResult>("run_workspace_command", { command, safetySettings });
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
  return invoke<CommandResult>("run_workspace_command", { command, safetySettings });
}

export function executeApprovedCommand(
  sessionId: string,
  requestId: string,
  command: string,
  autoRun: boolean,
  safetySettings: CommandSafetySettings,
  sessionToken?: string
) {
  return invoke<{
    result: CommandResult;
    updatedSession: AgentRuntimeSession;
  }>("execute_approved_command", { sessionId, requestId, command, autoRun, safetySettings, sessionToken });
}

export function createRuntimeRun(userPrompt: string, trustProfile: string) {
  return invoke<{ sessionId: string; sessionToken: string; sessionTokenExpiresAt: string }>("create_runtime_run", { userPrompt, trustProfile });
}

export function appendSessionEvent(sessionId: string, eventType: string, payload: AppEvent | Record<string, unknown>) {
  return invoke<void>("append_session_event", { sessionId, eventType, payload });
}

export function getSavedRuntimeSession(sessionId: string) {
  return invoke<AgentRuntimeSession>("get_saved_runtime_session", { sessionId });
}

export function upsertOrchestrationRun(session: AgentRuntimeSession) {
  return invoke<void>("upsert_orchestration_run", {
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
  return invoke<void>("upsert_agent_run", { sessionId, ...input });
}

export function applyRuntimePatch(sessionId: string, patchId: string) {
  return invoke<{
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
  return invoke<{ patchId: string; status: string; message: string }>("reject_runtime_patch", { sessionId, patchId });
}

export function createMockSession(userPrompt: string) {
  return invoke<CreateSessionResponse>("create_mock_session", { userPrompt });
}

export function getTasksForSession(sessionId: string) {
  return invoke<Task[]>("get_tasks_for_session", { sessionId });
}

export function getAgentStatuses(sessionId: string) {
  return invoke<AgentStatus[]>("get_agent_statuses", { sessionId });
}

export function validateModelProvider(config: ModelProviderConfigInput) {
  return invoke<ModelProviderConfig>("validate_model_provider", { config });
}

export function listAvailableModels(config: ModelProviderConfigInput) {
  return invoke<ModelInfo[]>("list_available_models", { config });
}

export function saveModelProviderConfig(config: ModelProviderConfigInput) {
  return invoke<ModelProviderConfig>("save_model_provider_config", { config });
}

export function getModelProviderConfig() {
  return invoke<ModelProviderConfig | null>("get_model_provider_config");
}

export function clearModelProviderConfig() {
  return invoke<void>("clear_model_provider_config");
}

export function openExternalTarget(target: string) {
  return invoke<void>("open_external_target", { target });
}

export function restartWithLatestCode() {
  return invoke<void>("restart_with_latest_code");
}
