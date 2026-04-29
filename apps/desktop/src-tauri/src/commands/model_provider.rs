use crate::models::ModelProviderType;
use crate::models::{ModelInfo, ModelProviderConfig, ModelProviderConfigInput};
use crate::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn validate_model_provider(
    config: ModelProviderConfigInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ModelProviderConfig, String> {
    Ok(state.model_provider.validate(config).await)
}

#[tauri::command]
pub async fn list_available_models(
    config: ModelProviderConfigInput,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<ModelInfo>, String> {
    state.model_provider.list_available_models(config).await
}

#[tauri::command]
pub async fn save_model_provider_config(
    config: ModelProviderConfigInput,
    state: State<'_, Arc<AppState>>,
) -> Result<ModelProviderConfig, String> {
    let provider_type = config.provider_type.clone();
    let mut validated = state.model_provider.validate(config).await;
    if matches!(provider_type, ModelProviderType::OpenaiCompatible) {
        validated.api_key_configured = false;
        validated.is_valid = false;
        validated.last_validation_error = Some(
            "Secure API key storage is not implemented in Module 1; non-secret provider settings were saved, but cloud providers cannot unlock sessions yet.".to_string(),
        );
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.save_model_provider_config(&validated)
        .map_err(|err| format!("Failed to save provider config: {err}"))?;
    Ok(validated)
}

#[tauri::command]
pub fn get_model_provider_config(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<ModelProviderConfig>, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.get_model_provider_config()
        .map_err(|err| format!("Failed to load provider config: {err}"))
}

#[tauri::command]
pub fn clear_model_provider_config(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.clear_model_provider_config()
        .map_err(|err| format!("Failed to clear provider config: {err}"))
}
