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
    let mut result = state
        .terminal
        .run_command(&command, &cwd, &workspace_path, safety_settings);
    if let Some(provenance) = result.provenance.as_mut() {
        provenance.source = "user".to_string();
        provenance.trigger = "manual".to_string();
        provenance.requested_by = Some("user".to_string());
    }
    Ok(result)
}

#[tauri::command]
pub fn execute_approved_command(
    session_id: String,
    request_id: String,
    command: String,
    auto_run: Option<bool>,
    safety_settings: Option<SafetySettingsInput>,
    state: State<'_, Arc<AppState>>,
) -> Result<CommandResult, String> {
    let auto_run = auto_run.unwrap_or(false);
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
    let mut result = state
        .terminal
        .run_command(&command, &cwd, &workspace_path, safety_settings);
    if let Some(provenance) = result.provenance.as_mut() {
        provenance.source = "agent".to_string();
        provenance.trigger = if auto_run {
            "auto_approved".to_string()
        } else {
            "manual".to_string()
        };
        provenance.requested_by = Some("agent".to_string());
        provenance.session_id = Some(session_id.clone());
        provenance.request_id = Some(request_id.clone());
        provenance.approval_source = Some(if auto_run {
            "auto".to_string()
        } else {
            "manual".to_string()
        });
        provenance.output_summary = result.message.clone();
    }
    if let Some(job) = result.background_job.as_mut() {
        job.request_id = Some(request_id.clone());
        job.session_id = session_id.clone();
    }
    let event_type = match result.status.as_str() {
        "running" | "executing" => "runtime.command.started",
        "failed" => "runtime.command.failed",
        "blocked" | "approval_required" => "runtime.command.blocked",
        _ => "runtime.command.completed",
    };
    let payload = json!({
        "requestId": request_id,
        "command": command,
        "result": result.clone(),
        "execution": {
            "id": format!("exec_{}", uuid::Uuid::new_v4()),
            "sessionId": session_id,
            "requestId": request_id,
            "autoRun": auto_run,
            "command": command,
            "cwd": result.cwd,
            "risk": result.risk,
            "status": result.status,
            "exitCode": result.exit_code,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "message": result.message,
            "provenance": result.provenance,
            "backgroundJob": result.background_job,
            "createdAt": chrono::Utc::now().to_rfc3339()
        }
    });
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.append_authoritative_session_event(
        &session_id,
        event_type,
        &payload.to_string(),
    )
        .map_err(|err| format!("Failed to persist command result: {err}"))?;
    Ok(result)
}
