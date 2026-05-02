import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentStatus,
  CommandResult,
  CreateSessionResponse,
  FileEntry,
  GitStatus,
  ModelInfo,
  ModelProviderConfig,
  ModelProviderType,
  Task,
  WorkspaceInfo
} from "@orchcode/protocol";

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

export function runWorkspaceCommand(command: string) {
  return invoke<CommandResult>("run_workspace_command", { command });
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
