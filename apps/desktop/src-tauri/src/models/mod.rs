use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub is_secret_candidate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub important_files: Vec<String>,
    pub languages: HashMap<String, usize>,
    pub package_managers: Vec<String>,
    pub test_commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub status_text: String,
    pub changed_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandRisk {
    Safe,
    Medium,
    Dangerous,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandExecutionProvenance {
    pub source: String,
    pub trigger: String,
    pub requested_by: Option<String>,
    pub approval_source: Option<String>,
    pub policy_decision: Option<String>,
    pub policy_reason: Option<String>,
    pub execution_authority: Option<String>,
    pub reason: Option<String>,
    pub session_id: Option<String>,
    pub request_id: Option<String>,
    pub agent_id: Option<String>,
    pub background: Option<bool>,
    pub process_id: Option<u32>,
    pub network_detected: Option<bool>,
    pub background_detected: Option<bool>,
    pub detection_source: Option<String>,
    pub network_detection_source: Option<String>,
    pub background_detection_source: Option<String>,
    pub output_summary: Option<String>,
    pub background_tracking_limited: Option<bool>,
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobRecord {
    pub job_id: String,
    pub request_id: Option<String>,
    pub session_id: String,
    pub command: String,
    pub cwd: String,
    pub process_id: Option<u32>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub status: String,
    pub last_known_at: String,
    pub exit_code: Option<i32>,
    pub output_summary: Option<String>,
    pub detection_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandFailureDiagnosis {
    pub category: String,
    pub severity: String,
    pub summary: String,
    pub next_step: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command: String,
    pub cwd: String,
    pub risk: CommandRisk,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub message: Option<String>,
    pub diagnosis: Option<CommandFailureDiagnosis>,
    pub provenance: Option<CommandExecutionProvenance>,
    pub background_job: Option<BackgroundJobRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommandExecutionResponse {
    pub result: CommandResult,
    pub updated_session: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: Option<String>,
    pub user_prompt: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub status: String,
    pub agent_role: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub session: Session,
    pub tasks: Vec<Task>,
    pub agents: Vec<AgentStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRuntimeRunResponse {
    pub session_id: String,
    pub session_token: String,
    pub session_token_expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetySettingsInput {
    pub block_dangerous_commands: bool,
    pub redact_secrets: bool,
    pub allow_network_commands: bool,
    pub auto_run_medium_commands: Option<bool>,
    pub auto_run_background_commands: Option<bool>,
    pub auto_run_network_commands: Option<bool>,
    pub approval_granted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchApplyResult {
    pub patch_id: String,
    pub status: String,
    pub message: String,
    pub authority: String,
    pub reconciliation_source: String,
    pub before_snapshot: Option<WorkspaceDiffSnapshot>,
    pub after_snapshot: Option<WorkspaceDiffSnapshot>,
    pub durable_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiffSnapshot {
    pub available: bool,
    pub source: String,
    pub is_git_repo: Option<bool>,
    pub changed_files: Option<Vec<String>>,
    pub diff_text: Option<String>,
    pub file_stats: Option<Vec<DiffFileStat>>,
    pub status_entries: Option<Vec<String>>,
    pub dirty: Option<bool>,
    pub checked_at: Option<String>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileStat {
    pub path: String,
    pub change_type: String,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProviderType {
    Ollama,
    OpenaiCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConfig {
    pub id: String,
    pub provider_type: ModelProviderType,
    pub provider_name: String,
    pub base_url: String,
    pub selected_model: String,
    pub router_model: Option<String>,
    pub verifier_model: Option<String>,
    pub embedding_model: Option<String>,
    pub api_key_configured: bool,
    pub is_valid: bool,
    pub last_validated_at: Option<String>,
    pub last_validation_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderConfigInput {
    pub id: String,
    pub provider_type: ModelProviderType,
    pub provider_name: String,
    pub base_url: String,
    pub selected_model: String,
    pub router_model: Option<String>,
    pub verifier_model: Option<String>,
    pub embedding_model: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider_id: String,
    pub context_window: Option<u32>,
    pub supports_tools: Option<bool>,
    pub supports_vision: Option<bool>,
    pub is_local: bool,
}
