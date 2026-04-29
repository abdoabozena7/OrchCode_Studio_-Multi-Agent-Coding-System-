use crate::models::GitStatus;
use crate::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_git_status(state: State<'_, Arc<AppState>>) -> Result<GitStatus, String> {
    let workspace_path = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.workspace_path()?
    };
    Ok(state.git.status(&workspace_path))
}

#[tauri::command]
pub fn get_git_diff(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let workspace_path = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.workspace_path()?
    };
    Ok(state
        .patch
        .get_current_diff(state.git.diff(&workspace_path)))
}
