use crate::models::{AgentStatus, CreateRuntimeRunResponse, CreateSessionResponse, Task};
use crate::AppState;
use chrono::{Duration, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub fn create_mock_session(
    user_prompt: String,
    state: State<'_, Arc<AppState>>,
) -> Result<CreateSessionResponse, String> {
    if user_prompt.trim().is_empty() {
        return Err("Enter a task before creating a plan".to_string());
    }

    let provider = {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.get_model_provider_config()
            .map_err(|err| format!("Failed to read provider config: {err}"))?
    };

    if !provider.map(|config| config.is_valid).unwrap_or(false) {
        return Err(
            "Configure and validate a model provider in Settings before starting an agent session."
                .to_string(),
        );
    }

    let project_id = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.project_id()
    };

    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.create_mock_session(project_id, &user_prompt)
        .map_err(|err| format!("Failed to create mock session: {err}"))
}

#[tauri::command]
pub fn get_tasks_for_session(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Task>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.tasks_for_session(&session_id)
        .map_err(|err| format!("Failed to load tasks: {err}"))
}

#[tauri::command]
pub fn get_agent_statuses(
    session_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AgentStatus>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.agents_for_session(&session_id)
        .map_err(|err| format!("Failed to load agent statuses: {err}"))
}

#[tauri::command]
pub fn create_runtime_run(
    user_prompt: String,
    trust_profile: String,
    state: State<'_, Arc<AppState>>,
) -> Result<CreateRuntimeRunResponse, String> {
    if user_prompt.trim().is_empty() {
        return Err("Enter a task before creating a run".to_string());
    }
    let session_id = format!("session_{}", Uuid::new_v4());
    let token = format!("rt_{}", Uuid::new_v4());
    let expires_at = (Utc::now() + Duration::hours(2)).to_rfc3339();
    let token_hash = hash_token(&token);
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.create_orchestration_run(
        &session_id,
        &user_prompt,
        "created",
        &trust_profile,
        &token_hash,
        &expires_at,
    )
    .map_err(|err| format!("Failed to create runtime run: {err}"))?;
    Ok(CreateRuntimeRunResponse {
        session_id,
        session_token: token,
        session_token_expires_at: expires_at,
    })
}

#[tauri::command]
pub fn append_session_event(
    session_id: String,
    event_type: String,
    payload: Value,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.append_session_event(&session_id, &event_type, &payload.to_string())
        .map_err(|err| format!("Failed to append session event: {err}"))
}

#[tauri::command]
pub fn upsert_orchestration_run(
    session_id: String,
    status: String,
    product_brief: Option<Value>,
    business_brief: Option<Value>,
    technical_plan: Option<Value>,
    assignment_plan: Option<Value>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let product = product_brief.as_ref().map(Value::to_string);
    let business = business_brief.as_ref().map(Value::to_string);
    let technical = technical_plan.as_ref().map(Value::to_string);
    let assignment = assignment_plan.as_ref().map(Value::to_string);
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.upsert_orchestration_run(
        &session_id,
        &status,
        product.as_deref(),
        business.as_deref(),
        technical.as_deref(),
        assignment.as_deref(),
    )
    .map_err(|err| format!("Failed to upsert orchestration run: {err}"))
}

#[tauri::command]
pub fn upsert_agent_run(
    session_id: String,
    agent_id: String,
    role_title: String,
    lifecycle_stage: String,
    artifact_json: Option<Value>,
    status: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let artifact = artifact_json.as_ref().map(Value::to_string);
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.upsert_agent_run(
        &session_id,
        &agent_id,
        &role_title,
        &lifecycle_stage,
        artifact.as_deref(),
        &status,
    )
    .map_err(|err| format!("Failed to upsert agent run: {err}"))
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}
