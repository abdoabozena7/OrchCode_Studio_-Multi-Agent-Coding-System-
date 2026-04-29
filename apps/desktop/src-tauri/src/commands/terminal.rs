use crate::models::CommandResult;
use crate::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn run_workspace_command(
    command: String,
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
    Ok(state.terminal.run_command(&command, &cwd, &workspace_path))
}
