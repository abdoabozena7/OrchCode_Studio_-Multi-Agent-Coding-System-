#[path = "../models/mod.rs"]
mod models;

#[path = "../db/mod.rs"]
mod db;

#[path = "../security/mod.rs"]
mod security;

mod services {
    #[path = "../../services/command_policy.rs"]
    pub mod command_policy;
    #[path = "../../services/git.rs"]
    pub mod git;
    #[path = "../../services/patch.rs"]
    pub mod patch;
    #[path = "../../services/terminal.rs"]
    pub mod terminal;
    #[path = "../../services/workspace.rs"]
    pub mod workspace;
}

use chrono::Utc;
use db::DatabaseService;
use models::{CommandResult, PatchApplyResult, SafetySettingsInput};
use serde_json::{json, Value};
use services::git::GitService;
use services::patch::{extract_patch_payload, PatchService};
use services::terminal::TerminalService;
use services::workspace::WorkspaceService;
use std::collections::HashMap;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = parse_args()?;
    let workspace = PathBuf::from(
        args.get("--workspace")
            .ok_or_else(|| "Missing --workspace".to_string())?,
    );
    if args
        .get("--open-workspace")
        .map(|value| value == "true")
        .unwrap_or(false)
    {
        let mut workspace_service = WorkspaceService::new();
        let canonical = workspace_service.open_workspace(
            &workspace.to_string_lossy(),
            "desktop-smoke-real-workspace".to_string(),
        )?;
        let files = workspace_service.list_files(None, true)?;
        println!(
            "{}",
            serde_json::to_string(&json!({
                "workspaceOpened": true,
                "authority": "rust_workspace_service",
                "canonicalWorkspace": canonical.to_string_lossy(),
                "fileCount": files.len(),
                "sampleFiles": files.iter().take(20).collect::<Vec<_>>()
            }))
            .map_err(|err| err.to_string())?
        );
        return Ok(());
    }
    if args
        .get("--apply-runtime-patch")
        .map(|value| value == "true")
        .unwrap_or(false)
    {
        let session_id = args
            .get("--session-id")
            .ok_or_else(|| "Missing --session-id".to_string())?;
        let patch_id = args
            .get("--patch-id")
            .ok_or_else(|| "Missing --patch-id".to_string())?;
        let proposal_json = args
            .get("--proposal-json")
            .ok_or_else(|| "Missing --proposal-json".to_string())?;
        let proposal: Value = serde_json::from_str(proposal_json)
            .map_err(|err| format!("Invalid --proposal-json: {err}"))?;
        let result = apply_runtime_patch_for_smoke(&workspace, session_id, patch_id, proposal)?;
        println!(
            "{}",
            serde_json::to_string(&json!({ "patchResult": result }))
                .map_err(|err| err.to_string())?
        );
        return Ok(());
    }
    let cwd = PathBuf::from(args.get("--cwd").ok_or_else(|| "Missing --cwd".to_string())?);
    let command = args
        .get("--command")
        .ok_or_else(|| "Missing --command".to_string())?;
    let runtime_url = args.get("--runtime-url").map(String::as_str);
    let session_id = args.get("--session-id").map(String::as_str);
    let request_id = args.get("--request-id").map(String::as_str);
    let approval_granted = args
        .get("--approval-granted")
        .map(|value| value == "true")
        .unwrap_or(true);

    let terminal = TerminalService::new();
    let mut result = terminal.run_command(
        command,
        &cwd,
        &workspace,
        Some(SafetySettingsInput {
            block_dangerous_commands: true,
            redact_secrets: true,
            allow_network_commands: false,
            auto_run_medium_commands: Some(false),
            auto_run_background_commands: Some(false),
            auto_run_network_commands: Some(false),
            approval_granted: Some(approval_granted),
        }),
    );

    if let (Some(runtime_url), Some(session_id), Some(request_id)) = (runtime_url, session_id, request_id) {
        if let Some(provenance) = result.provenance.as_mut() {
            provenance.source = "agent".to_string();
            provenance.trigger = if approval_granted {
                "auto_approved".to_string()
            } else {
                "manual".to_string()
            };
            provenance.requested_by = Some("agent".to_string());
            provenance.session_id = Some(session_id.to_string());
            provenance.request_id = Some(request_id.to_string());
            provenance.approval_source = Some(if approval_granted {
                "auto".to_string()
            } else {
                "manual".to_string()
            });
            provenance.output_summary = result.message.clone();
        }
        if let Some(job) = result.background_job.as_mut() {
            job.request_id = Some(request_id.to_string());
            job.session_id = session_id.to_string();
        }

        let updated_session = post_runtime_command_result(
            runtime_url,
            session_id,
            request_id,
            command,
            approval_granted,
            &result,
        )
        .await?;

        println!(
            "{}",
            serde_json::to_string(&json!({
                "commandResult": result,
                "updatedSession": updated_session
            }))
            .map_err(|err| err.to_string())?
        );
    } else {
        println!(
            "{}",
            serde_json::to_string(&json!({
                "commandResult": result
            }))
            .map_err(|err| err.to_string())?
        );
    }
    Ok(())
}

fn apply_runtime_patch_for_smoke(
    workspace: &PathBuf,
    session_id: &str,
    patch_id: &str,
    proposal: Value,
) -> Result<PatchApplyResult, String> {
    let db = DatabaseService::new().map_err(|err| format!("Failed to open desktop DB: {err}"))?;
    db.create_orchestration_run(
        session_id,
        "patch truth smoke",
        "needs_approval",
        "default_permissions",
        "",
        "",
    )
    .map_err(|err| format!("Failed to create smoke session row: {err}"))?;
    db.append_session_event(
        session_id,
        "runtime.patch.proposed",
        &json!({
            "type": "runtime.patch.proposed",
            "sessionId": session_id,
            "proposal": proposal_with_status(&proposal, "proposed")
        })
        .to_string(),
    )
    .map_err(|err| format!("Failed to persist patch proposal: {err}"))?;
    db.append_session_event(
        session_id,
        "runtime.patch.approved",
        &json!({
            "type": "runtime.patch.approved",
            "sessionId": session_id,
            "proposal": proposal_with_status(&proposal, "approved")
        })
        .to_string(),
    )
    .map_err(|err| format!("Failed to persist patch approval: {err}"))?;
    let approved = db
        .patch_approval_exists_for_session(session_id, patch_id)
        .map_err(|err| format!("Failed to verify patch approval: {err}"))?;
    let persisted_proposal = db
        .patch_payload_for_session(session_id, patch_id)
        .map_err(|err| format!("Failed to look up patch proposal: {err}"))?;
    let lookup_result = if persisted_proposal.is_some() { "found" } else { "missing" };
    eprintln!(
        "patch_apply_lookup proposal_id={} persistence_target=sqlite.session_events lookup_source=session_events lookup_result={} approved={}",
        patch_id, lookup_result, approved
    );
    if !approved {
        return Err("patch_not_approved: Patch approval was not found in sqlite.session_events.".to_string());
    }
    let persisted_payload = persisted_proposal
        .ok_or_else(|| "proposal_not_found: Patch proposal not found in sqlite.session_events.".to_string())?;
    let (patch_text, files_changed) = extract_patch_payload(&persisted_payload, patch_id)?;
    let patch = PatchService::new();
    patch.preflight_patch(&patch_text, &files_changed, workspace)?;
    let git = GitService::new();
    let before_snapshot = git.snapshot(workspace, "rust_git_snapshot");
    db.append_authoritative_session_event(
        session_id,
        "runtime.patch.apply_started",
        &json!({
            "patchId": patch_id,
            "status": "apply_started",
            "snapshotSource": "rust_git_snapshot",
            "beforeSnapshotAvailable": before_snapshot.available
        })
        .to_string(),
    )
    .map_err(|err| format!("Failed to record patch apply start: {err}"))?;
    if let Err(error) = patch.apply_patch(&patch_text, workspace) {
        db.append_authoritative_session_event(
            session_id,
            "runtime.patch.apply_failed",
            &json!({
                "patchId": patch_id,
                "status": "apply_failed",
                "message": error,
                "lookupSource": "sqlite.session_events",
                "provenance": { "executionAuthority": "rust_patch_service" }
            })
            .to_string(),
        )
        .map_err(|err| format!("Failed to record patch apply failure: {err}"))?;
        return Err(error);
    }
    let after_snapshot = git.snapshot(workspace, "rust_git_snapshot");
    db.append_authoritative_session_event(
        session_id,
        "runtime.patch.applied",
        &json!({
            "patchId": patch_id,
            "status": "applied",
            "message": "Patch applied by Rust authority",
            "beforeSnapshot": before_snapshot,
            "afterSnapshot": after_snapshot,
            "reconciliationSource": "rust_git_snapshot",
            "provenance": { "executionAuthority": "rust_patch_service" }
        })
        .to_string(),
    )
    .map_err(|err| format!("Failed to record patch apply: {err}"))?;
    eprintln!("patch_apply_result proposal_id={} apply_result=applied", patch_id);
    Ok(PatchApplyResult {
        patch_id: patch_id.to_string(),
        status: "applied".to_string(),
        message: "Patch applied by Rust authority".to_string(),
        authority: "rust_patch_service".to_string(),
        reconciliation_source: "rust_git_snapshot".to_string(),
        before_snapshot: Some(before_snapshot),
        after_snapshot: Some(after_snapshot),
        durable_event_ids: Vec::new(),
    })
}

fn proposal_with_status(proposal: &Value, status: &str) -> Value {
    let mut value = proposal.clone();
    if let Some(object) = value.as_object_mut() {
        object.insert("status".to_string(), Value::String(status.to_string()));
    }
    value
}

async fn post_runtime_command_result(
    runtime_url: &str,
    session_id: &str,
    request_id: &str,
    command: &str,
    auto_run: bool,
    result: &CommandResult,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/sessions/{}/commands/{}/result",
            runtime_url.trim_end_matches('/'),
            session_id,
            request_id
        ))
        .json(&json!({
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
            "backgroundJob": result.background_job,
            "reportedAt": Utc::now().to_rfc3339()
        }))
        .send()
        .await
        .map_err(|err| format!("Failed to post runtime command result: {err}"))?;
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
        .map_err(|err| format!("Failed to decode updated session: {err}"))
}

fn parse_args() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        if !flag.starts_with("--") {
            return Err(format!("Unexpected argument: {flag}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {flag}"))?;
        values.insert(flag, value);
    }
    Ok(values)
}
