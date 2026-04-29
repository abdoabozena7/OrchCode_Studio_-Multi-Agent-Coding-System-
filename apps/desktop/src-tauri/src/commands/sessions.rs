use crate::models::{AgentStatus, CreateSessionResponse, Task};
use crate::AppState;
use std::sync::Arc;
use tauri::State;

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
