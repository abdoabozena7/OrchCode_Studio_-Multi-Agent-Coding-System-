mod commands;
mod db;
mod models;
mod security;
mod services;

use db::DatabaseService;
use services::git::GitService;
use services::model_provider::ModelProviderService;
use services::patch::PatchService;
use services::project_index::ProjectIndexService;
use services::terminal::TerminalService;
use services::workspace::WorkspaceService;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub workspace: Mutex<WorkspaceService>,
    pub db: Mutex<DatabaseService>,
    pub git: GitService,
    pub terminal: TerminalService,
    pub patch: PatchService,
    pub index: ProjectIndexService,
    pub model_provider: ModelProviderService,
}

fn build_state() -> Result<AppState, String> {
    let db = DatabaseService::new().map_err(|err| err.to_string())?;
    Ok(AppState {
        workspace: Mutex::new(WorkspaceService::new()),
        db: Mutex::new(db),
        git: GitService::new(),
        terminal: TerminalService::new(),
        patch: PatchService::new(),
        index: ProjectIndexService::new(),
        model_provider: ModelProviderService::new(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(build_state().expect("failed to initialize app state"));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::workspace::open_workspace,
            commands::workspace::get_workspace_info,
            commands::workspace::list_workspace_files,
            commands::workspace::read_workspace_file,
            commands::git::get_git_status,
            commands::git::get_git_diff,
            commands::terminal::run_workspace_command,
            commands::terminal::execute_approved_command,
            commands::sessions::create_mock_session,
            commands::sessions::create_runtime_run,
            commands::sessions::get_saved_runtime_session,
            commands::sessions::append_session_event,
            commands::sessions::upsert_orchestration_run,
            commands::sessions::upsert_agent_run,
            commands::patch::apply_runtime_patch,
            commands::patch::reject_runtime_patch,
            commands::sessions::get_tasks_for_session,
            commands::sessions::get_agent_statuses,
            commands::system::open_external_target,
            commands::system::restart_with_latest_code,
            commands::model_provider::validate_model_provider,
            commands::model_provider::list_available_models,
            commands::model_provider::save_model_provider_config,
            commands::model_provider::get_model_provider_config,
            commands::model_provider::clear_model_provider_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
