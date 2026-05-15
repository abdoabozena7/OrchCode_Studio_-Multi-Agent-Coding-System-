use crate::models::PatchApplyResult;
use crate::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

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
    let before_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
    let apply_started_event_id = append_canonical_runtime_event(
        &state,
        &session_id,
        "patch.apply_started",
        &serde_json::json!({
            "sessionId": session_id,
            "patchId": patch_id,
            "status": "started",
            "snapshotSource": "rust_git_snapshot",
            "beforeSnapshotAvailable": before_snapshot.available
        }),
        Some(&patch_id),
    )?;

    if let Err(err) = state.patch.apply_patch(&patch_text, &workspace_path) {
        let db = state
            .db
            .lock()
            .map_err(|_| "Database lock poisoned".to_string())?;
        db.append_authoritative_session_event(
            &session_id,
            "runtime.patch.apply_failed",
            &serde_json::json!({
                "patchId": patch_id,
                "status": "apply_failed",
                "message": err.clone(),
                "provenance": {
                    "executionAuthority": "rust_patch_service"
                }
            })
            .to_string(),
        )
        .map_err(|append_err| format!("Failed to record patch apply failure: {append_err}"))?;
        return Err(err);
    }

    let after_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
    let reconciliation_event_id = {
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
                "beforeSnapshot": before_snapshot.clone(),
                "afterSnapshot": after_snapshot.clone(),
                "reconciliationSource": "rust_git_snapshot",
                "provenance": {
                    "executionAuthority": "rust_patch_service"
                }
            })
            .to_string(),
        )
        .map_err(|err| format!("Failed to record patch apply: {err}"))?;
        if after_snapshot.available {
            None
        } else {
            Some(
                append_canonical_runtime_event_locked(
                    &db,
                    &session_id,
                    "patch.reconciled",
                    &serde_json::json!({
                        "sessionId": session_id,
                        "patchId": patch_id,
                        "reconciliation": {
                            "status": "unavailable",
                            "checkedBy": "rust",
                            "evidenceSource": "unavailable",
                            "reason": after_snapshot
                                .unavailable_reason
                                .clone()
                                .unwrap_or_else(|| "Rust could not capture post-apply Git evidence.".to_string())
                        }
                    }),
                    Some(&patch_id),
                )
                .map_err(|err| format!("Failed to append patch reconciliation event: {err}"))?,
            )
        }
    };
    Ok(PatchApplyResult {
        patch_id,
        status: "applied".to_string(),
        message: "Patch applied by Rust authority".to_string(),
        authority: "rust_patch_service".to_string(),
        reconciliation_source: "rust_git_snapshot".to_string(),
        before_snapshot: Some(before_snapshot),
        after_snapshot: Some(after_snapshot),
        durable_event_ids: std::iter::once(apply_started_event_id)
            .chain(reconciliation_event_id.into_iter())
            .collect(),
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
        authority: "rust_patch_service".to_string(),
        reconciliation_source: "unknown".to_string(),
        before_snapshot: None,
        after_snapshot: None,
        durable_event_ids: Vec::new(),
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

fn append_canonical_runtime_event(
    state: &State<'_, Arc<AppState>>,
    session_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
    correlation_id: Option<&str>,
) -> Result<String, String> {
    let db = state
        .db
        .lock()
        .map_err(|_| "Database lock poisoned".to_string())?;
    append_canonical_runtime_event_locked(&db, session_id, event_type, payload, correlation_id)
        .map_err(|err| format!("Failed to append runtime event: {err}"))
}

fn append_canonical_runtime_event_locked(
    db: &crate::db::DatabaseService,
    session_id: &str,
    event_type: &str,
    payload: &serde_json::Value,
    correlation_id: Option<&str>,
) -> rusqlite::Result<String> {
    let event_id = format!("rt_evt_{}", Uuid::new_v4());
    db.append_runtime_event(crate::db::RuntimeEventInsert {
        id: Some(&event_id),
        session_id,
        sequence: None,
        event_type,
        actor: "rust",
        authority: "rust",
        payload_json: &payload.to_string(),
        created_at: Some(&chrono::Utc::now().to_rfc3339()),
        version: 1,
        correlation_id,
        causation_id: None,
    })?;
    Ok(event_id)
}
