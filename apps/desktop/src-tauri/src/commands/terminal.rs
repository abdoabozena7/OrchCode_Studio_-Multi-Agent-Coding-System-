use crate::models::{CommandResult, RuntimeCommandExecutionResponse, SafetySettingsInput};
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
pub async fn execute_approved_command(
    session_id: String,
    request_id: String,
    command: String,
    auto_run: Option<bool>,
    safety_settings: Option<SafetySettingsInput>,
    session_token: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<RuntimeCommandExecutionResponse, String> {
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
            "diagnosis": result.diagnosis,
            "provenance": result.provenance,
            "backgroundJob": result.background_job,
            "createdAt": chrono::Utc::now().to_rfc3339()
        }
    });
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.append_authoritative_session_event(&session_id, event_type, &payload.to_string())
            .map_err(|err| format!("Failed to persist command result: {err}"))?;
    }

    let updated_session = post_runtime_command_result(
        &session_id,
        &request_id,
        &command,
        auto_run,
        &result,
        session_token.as_deref(),
    )
    .await?;

    Ok(RuntimeCommandExecutionResponse {
        result,
        updated_session,
    })
}

async fn post_runtime_command_result(
    session_id: &str,
    request_id: &str,
    command: &str,
    auto_run: bool,
    result: &CommandResult,
    session_token: Option<&str>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let runtime_base = std::env::var("HIVO_AGENT_RUNTIME_URL")
        .or_else(|_| std::env::var("ORCHCODE_AGENT_RUNTIME_URL"))
        .or_else(|_| std::env::var("VITE_AGENT_RUNTIME_URL"))
        .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string());
    let url = format!(
        "{}/sessions/{}/commands/{}/result",
        runtime_base.trim_end_matches('/'),
        session_id,
        request_id
    );
    let mut request = client.post(url).json(&json!({
        "command": command,
        "cwd": result.cwd,
        "risk": result.risk,
        "status": result.status,
        "exitCode": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "message": result.message,
        "diagnosis": result.diagnosis,
        "autoRun": auto_run,
        "provenance": result.provenance,
        "backgroundJob": result.background_job
    }));
    if let Some(token) = session_token {
        request = request.header("x-hivo-session-token", token);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("Failed to report command result to runtime: {err}"))?;
    if !response.status().is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Runtime rejected the command result.".to_string());
        return Err(format!("Runtime rejected command result: {body}"));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|err| format!("Failed to decode runtime session payload: {err}"))
}
