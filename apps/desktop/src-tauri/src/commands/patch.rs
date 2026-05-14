use crate::models::PatchApplyResult;
use crate::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn apply_runtime_patch(
    session_id: String,
    patch_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<PatchApplyResult, String> {
    let workspace_path = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        workspace.workspace_path()?
    };
    let payload = {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.patch_payload_for_session(&session_id, &patch_id)
            .map_err(|err| format!("Failed to load patch proposal: {err}"))?
            .ok_or_else(|| "Patch proposal not found in Rust session_events".to_string())?
    };
    let patch_text = extract_patch_text(&payload, &patch_id)?;
    state
        .patch
        .validate_patch_paths_inside_workspace(&patch_text, &workspace_path)?;
    state.patch.apply_patch(&patch_text, &workspace_path)?;
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.append_authoritative_session_event(
            &session_id,
            "runtime.patch.applied",
            &serde_json::json!({
                "patchId": patch_id,
                "status": "applied",
                "message": "Patch applied by Rust authority",
                "provenance": {
                    "executionAuthority": "rust_patch_service"
                }
            })
            .to_string(),
        )
        .map_err(|err| format!("Failed to record patch apply: {err}"))?;
    }
    Ok(PatchApplyResult {
        patch_id,
        status: "applied".to_string(),
        message: "Patch applied by Rust authority".to_string(),
    })
}

#[tauri::command]
pub fn reject_runtime_patch(
    session_id: String,
    patch_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<PatchApplyResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    db.append_authoritative_session_event(
        &session_id,
        "runtime.patch.rejected",
        &serde_json::json!({
            "patchId": patch_id,
            "provenance": {
                "decisionAuthority": "rust_patch_service"
            }
        })
        .to_string(),
    )
    .map_err(|err| format!("Failed to record patch rejection: {err}"))?;
    Ok(PatchApplyResult {
        patch_id,
        status: "rejected".to_string(),
        message: "Patch rejected. No files were changed.".to_string(),
    })
}

fn extract_patch_text(payload: &str, patch_id: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(payload)
        .map_err(|err| format!("Invalid patch event payload: {err}"))?;
    let proposal = value.get("proposal").unwrap_or(&value);
    if proposal.get("id").and_then(Value::as_str) != Some(patch_id) {
        return Err("Patch event payload did not match requested patch id".to_string());
    }
    proposal
        .get("unifiedDiff")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Patch payload does not include unifiedDiff".to_string())
}
