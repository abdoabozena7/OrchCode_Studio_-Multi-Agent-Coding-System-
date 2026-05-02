use crate::models::{FileEntry, WorkspaceInfo};
use crate::services::paths::display_path;
use crate::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn open_workspace(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceInfo, String> {
    let canonical = std::fs::canonicalize(&path)
        .map_err(|err| format!("Workspace path is not accessible: {err}"))?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Workspace")
        .to_string();
    let canonical_str = display_path(&canonical);

    let project_id = {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.upsert_project(&name, &canonical_str)
            .map_err(|err| format!("Failed to save project: {err}"))?
    };

    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.open_workspace(&canonical_str, project_id)?;
    }

    workspace_info(state.inner())
}

#[tauri::command]
pub fn get_workspace_info(state: State<'_, Arc<AppState>>) -> Result<WorkspaceInfo, String> {
    workspace_info(state.inner())
}

#[tauri::command]
pub fn list_workspace_files(state: State<'_, Arc<AppState>>) -> Result<Vec<FileEntry>, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned".to_string())?;
    workspace.list_files(None, true)
}

#[tauri::command]
pub fn read_workspace_file(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock poisoned".to_string())?;
    workspace.read_file(&path)
}

fn workspace_info(state: &Arc<AppState>) -> Result<WorkspaceInfo, String> {
    let workspace_path = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.workspace_path()?
    };

    let is_git_repo = state.git.is_repo(&workspace_path);
    let branch = state.git.current_branch(&workspace_path);
    Ok(state.index.summarize(&workspace_path, is_git_repo, branch))
}
