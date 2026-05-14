use crate::models::{CommandResult, SafetySettingsInput};
use crate::AppState;
use serde_json::json;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn run_workspace_command(
    command: String,
    safety_settings: Option<SafetySettingsInput>,
    state: State<'_, Arc<AppState>>,
) -> Result<CommandResult, String> {
    let (workspace_path, cwd) = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        let workspace_path = workspace.workspace_path()?;
        let cwd = workspace.ensure_command_cwd(None)?;
        (workspace_path, cwd)
    };
    Ok(state
        .terminal
        .run_command(&command, &cwd, &workspace_path, safety_settings))
}

#[tauri::command]
pub fn execute_approved_command(
    session_id: String,
    request_id: String,
    command: String,
    safety_settings: Option<SafetySettingsInput>,
    state: State<'_, Arc<AppState>>,
) -> Result<CommandResult, String> {
    let safety_settings = safety_settings.map(|mut settings| {
        settings.approval_granted = Some(true);
        settings
    });
    let (workspace_path, cwd) = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        let workspace_path = workspace.workspace_path()?;
        let cwd = workspace.ensure_command_cwd(None)?;
        (workspace_path, cwd)
    };
    let result = state
        .terminal
        .run_command(&command, &cwd, &workspace_path, safety_settings);
    let payload = json!({
        "requestId": request_id,
        "command": command,
        "result": result.clone(),
        "provenance": {
            "approvalSource": "explicit_ui_approval",
            "executionAuthority": "rust_terminal",
            "requestedVsExecuted": if result.status == "executed" || result.status == "failed" { "executed_attempted" } else { "requested_only" },
            "networkDetected": looks_like_network_command(&command),
            "backgroundDetected": looks_like_background_command(&command)
        }
    });
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.append_authoritative_session_event(
        &session_id,
        "runtime.command.completed",
        &payload.to_string(),
    )
        .map_err(|err| format!("Failed to persist command result: {err}"))?;
    Ok(result)
}

fn looks_like_network_command(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    [
        "curl",
        "wget",
        "invoke-webrequest",
        "iwr ",
        "irm ",
        "npm install",
        "pnpm add",
        "pnpm install",
        "pip install",
        "cargo install",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn looks_like_background_command(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.contains("python -m http.server")
        || normalized.contains("npm run dev")
        || normalized.contains("pnpm dev")
        || normalized.contains("yarn dev")
        || normalized.contains("vite")
        || normalized.contains("next dev")
        || normalized.contains("react-scripts start")
}
