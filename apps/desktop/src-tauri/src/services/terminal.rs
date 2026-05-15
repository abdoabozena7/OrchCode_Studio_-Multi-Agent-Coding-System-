use crate::models::{
    BackgroundJobRecord, CommandExecutionProvenance, CommandResult, CommandRisk,
    SafetySettingsInput,
};
use crate::services::command_policy::{CommandPolicyAnalysis, CommandPolicyService};
use chrono::Utc;
use std::path::Path;
use std::process::{Command, Stdio};

pub struct TerminalService;

impl TerminalService {
    pub fn new() -> Self {
        Self
    }

    pub fn run_command(
        &self,
        command: &str,
        cwd: &Path,
        workspace: &Path,
        safety: Option<SafetySettingsInput>,
    ) -> CommandResult {
        let safety = safety.unwrap_or(SafetySettingsInput {
            block_dangerous_commands: true,
            redact_secrets: true,
            allow_network_commands: false,
            approval_granted: None,
        });
        let approval_granted = safety.approval_granted.unwrap_or(false);
        let canonical_workspace = match std::fs::canonicalize(workspace) {
            Ok(path) => path,
            Err(err) => {
                return blocked_result(
                    command,
                    cwd,
                    &synthetic_policy("Workspace path is not accessible."),
                    format!("Workspace path is not accessible: {err}"),
                    approval_granted,
                );
            }
        };
        let canonical_cwd = match std::fs::canonicalize(cwd) {
            Ok(path) if path.starts_with(&canonical_workspace) => path,
            Ok(_) => {
                return blocked_result(
                    command,
                    cwd,
                    &synthetic_policy("Command cwd is outside the active workspace."),
                    "Command cwd is outside the active workspace".to_string(),
                    approval_granted,
                );
            }
            Err(err) => {
                return blocked_result(
                    command,
                    cwd,
                    &synthetic_policy("Command cwd is not accessible."),
                    format!("Command cwd is not accessible: {err}"),
                    approval_granted,
                );
            }
        };
        let policy = CommandPolicyService::analyze(command, workspace);
        let risk = policy.risk.clone();
        if safety.block_dangerous_commands && risk == CommandRisk::Dangerous {
            return CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "blocked".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some("Dangerous command blocked by policy before execution.".to_string()),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    approval_granted,
                    false,
                    None,
                    Some("Command was denied by policy before execution.".to_string()),
                )),
                background_job: None,
            };
        }

        if !safety.allow_network_commands && looks_like_network_command(command) {
            return blocked_result(
                command,
                cwd,
                &policy,
                "Network commands are blocked by active safety settings".to_string(),
                approval_granted,
            );
        }

        if !approval_granted
            && (risk == CommandRisk::Medium
                || looks_like_background_server(command)
                || looks_like_network_command(command))
        {
            return CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "approval_required".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some(approval_required_message(command)),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    false,
                    false,
                    None,
                    Some("Policy heuristics require explicit approval before Rust execution.".to_string()),
                )),
                background_job: None,
            };
        }

        if looks_like_background_server(command) {
            let spawned = if cfg!(windows) {
                Command::new("cmd")
                    .args(["/C", command])
                    .current_dir(&canonical_cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
            } else {
                Command::new("sh")
                    .args(["-lc", command])
                    .current_dir(&canonical_cwd)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
            };

            return match spawned {
                Ok(child) => {
                    let now = Utc::now().to_rfc3339();
                    let pid = child.id();
                    CommandResult {
                        command: command.to_string(),
                        cwd: cwd.to_string_lossy().to_string(),
                        risk,
                        status: "running".to_string(),
                        exit_code: None,
                        stdout: String::new(),
                        stderr: String::new(),
                        message: Some(format!(
                            "Policy-classified background command started by Rust terminal authority with pid {}. Background tracking is limited unless a later terminal result is recorded.",
                            pid
                        )),
                        provenance: Some(build_provenance(
                            command,
                            cwd,
                            &policy,
                            approval_granted,
                            true,
                            Some(pid),
                            Some("Background command started by Rust authority with limited tracking.".to_string()),
                        )),
                        background_job: Some(BackgroundJobRecord {
                            job_id: format!("job_{}", pid),
                            request_id: None,
                            session_id: String::new(),
                            command: command.to_string(),
                            cwd: cwd.to_string_lossy().to_string(),
                            process_id: Some(pid),
                            started_at: now.clone(),
                            completed_at: None,
                            status: "running".to_string(),
                            last_known_at: now,
                            exit_code: None,
                            output_summary: Some(
                                "Background process started. Durable completion tracking is limited.".to_string(),
                            ),
                            detection_source: "heuristic".to_string(),
                        }),
                    }
                }
                Err(err) => CommandResult {
                    command: command.to_string(),
                    cwd: cwd.to_string_lossy().to_string(),
                    risk,
                    status: "failed".to_string(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: Some(format!(
                        "Approved background command failed to start under Rust terminal authority: {err}"
                    )),
                    provenance: Some(build_provenance(
                        command,
                        cwd,
                        &policy,
                        approval_granted,
                        true,
                        None,
                        Some("Background command failed to start under Rust authority.".to_string()),
                    )),
                    background_job: Some(BackgroundJobRecord {
                        job_id: format!("job_failed_{}", Utc::now().timestamp_millis()),
                        request_id: None,
                        session_id: String::new(),
                        command: command.to_string(),
                        cwd: cwd.to_string_lossy().to_string(),
                        process_id: None,
                        started_at: Utc::now().to_rfc3339(),
                        completed_at: Some(Utc::now().to_rfc3339()),
                        status: "failed".to_string(),
                        last_known_at: Utc::now().to_rfc3339(),
                        exit_code: None,
                        output_summary: Some("Background process failed to start.".to_string()),
                        detection_source: "heuristic".to_string(),
                    }),
                },
            };
        }

        let output = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", command])
                .current_dir(&canonical_cwd)
                .output()
        } else {
            Command::new("sh")
                .args(["-lc", command])
                .current_dir(&canonical_cwd)
                .output()
        };

        match output {
            Ok(output) => CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: if output.status.success() {
                    "executed"
                } else {
                    "failed"
                }
                .to_string(),
                exit_code: output.status.code(),
                stdout: maybe_redact(
                    String::from_utf8_lossy(&output.stdout).to_string(),
                    safety.redact_secrets,
                ),
                stderr: maybe_redact(
                    String::from_utf8_lossy(&output.stderr).to_string(),
                    safety.redact_secrets,
                ),
                message: Some(if output.status.success() {
                    "Command executed by Rust terminal authority.".to_string()
                } else {
                    format!(
                        "Command execution failed under Rust terminal authority with exit code {}.",
                        output
                            .status
                            .code()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "unknown".to_string())
                        )
                }),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    approval_granted,
                    false,
                    None,
                    Some(if output.status.success() {
                        "Foreground command completed under Rust authority.".to_string()
                    } else {
                        "Foreground command failed under Rust authority.".to_string()
                    }),
                )),
                background_job: None,
            },
            Err(err) => CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "failed".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: err.to_string(),
                message: Some("Rust terminal authority failed to execute command".to_string()),
                provenance: Some(build_provenance(
                    command,
                    cwd,
                    &policy,
                    approval_granted,
                    false,
                    None,
                    Some("Rust terminal authority failed before completion.".to_string()),
                )),
                background_job: None,
            },
        }
    }
}

fn blocked_result(
    command: &str,
    cwd: &Path,
    policy: &CommandPolicyAnalysis,
    message: String,
    approval_granted: bool,
) -> CommandResult {
    CommandResult {
        command: command.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        risk: policy.risk.clone(),
        status: "blocked".to_string(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        message: Some(message),
        provenance: Some(build_provenance(
            command,
            cwd,
            policy,
            approval_granted,
            policy.background_detected.unwrap_or(false),
            None,
            Some("Command was blocked before Rust execution.".to_string()),
        )),
        background_job: None,
    }
}

fn synthetic_policy(reason: &str) -> CommandPolicyAnalysis {
    CommandPolicyAnalysis {
        risk: CommandRisk::Dangerous,
        policy_decision: "deny",
        policy_reason: reason.to_string(),
        network_detected: None,
        background_detected: None,
        detection_source: "system",
    }
}

fn build_provenance(
    _command: &str,
    _cwd: &Path,
    policy: &CommandPolicyAnalysis,
    approval_granted: bool,
    background: bool,
    process_id: Option<u32>,
    reason: Option<String>,
) -> CommandExecutionProvenance {
    CommandExecutionProvenance {
        source: if approval_granted {
            "user".to_string()
        } else {
            "system".to_string()
        },
        trigger: if approval_granted {
            "manual".to_string()
        } else {
            "auto_approved".to_string()
        },
        requested_by: Some(if approval_granted {
            "user".to_string()
        } else {
            "system".to_string()
        }),
        approval_source: Some(match policy.policy_decision {
            "deny" => "denied",
            "require_approval" if approval_granted => "manual",
            "require_approval" => "none",
            "allow" if approval_granted => "manual",
            "allow" => "policy",
            _ => "unknown",
        }
        .to_string()),
        policy_decision: Some(policy.policy_decision.to_string()),
        policy_reason: Some(policy.policy_reason.clone()),
        execution_authority: Some("rust".to_string()),
        reason,
        session_id: None,
        request_id: None,
        agent_id: None,
        background: Some(background),
        process_id,
        network_detected: policy.network_detected,
        background_detected: Some(policy.background_detected.unwrap_or(false) || background),
        detection_source: Some(policy.detection_source.to_string()),
        network_detection_source: Some(if policy.network_detected.is_some() {
            policy.detection_source.to_string()
        } else {
            "unknown".to_string()
        }),
        background_detection_source: Some(if policy.background_detected.is_some() || background {
            "heuristic".to_string()
        } else {
            "unknown".to_string()
        }),
        output_summary: None,
        background_tracking_limited: Some(background),
        job_id: process_id.map(|pid| format!("job_{pid}")),
    }
}

fn approval_required_message(command: &str) -> String {
    let mut detail =
        "Command was requested but not executed. Explicit approval is required before Rust terminal execution."
            .to_string();
    if looks_like_network_command(command) {
        detail.push_str(" Network access was detected.");
    }
    if looks_like_background_server(command) {
        detail.push_str(" Background or long-running process behavior was detected.");
    }
    detail
}

fn looks_like_network_command(command: &str) -> bool {
    let normalized = command.to_lowercase();
    [
        "curl",
        "wget",
        "Invoke-WebRequest",
        "iwr ",
        "irm ",
        "npm install",
        "pnpm add",
        "pnpm install",
        "pip install",
        "cargo install",
    ]
    .iter()
    .any(|needle| normalized.contains(&needle.to_lowercase()))
}

fn looks_like_background_server(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.contains("python -m http.server")
        || normalized.contains("npm run dev")
        || normalized.contains("pnpm dev")
        || normalized.contains("yarn dev")
        || normalized.contains("vite")
        || normalized.contains("next dev")
        || normalized.contains("react-scripts start")
}

fn maybe_redact(text: String, enabled: bool) -> String {
    if !enabled {
        return text;
    }
    let mut redacted = text;
    for marker in [
        "api_key",
        "apikey",
        "token",
        "password",
        "secret",
        "authorization",
    ] {
        redacted = redact_marker(&redacted, marker);
    }
    redacted
}

fn redact_marker(input: &str, marker: &str) -> String {
    input
        .split_whitespace()
        .map(|part| {
            if part.to_lowercase().contains(marker) && (part.contains('=') || part.contains(':')) {
                format!("{}=[REDACTED]", marker)
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::TerminalService;
    use crate::models::SafetySettingsInput;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn policy_classified_allowed_command_includes_provenance() {
        let workspace = temp_workspace();
        let service = TerminalService::new();
        let result = service.run_command(
            "rg --version",
            &workspace,
            &workspace,
            Some(SafetySettingsInput {
                block_dangerous_commands: true,
                redact_secrets: true,
                allow_network_commands: false,
                approval_granted: None,
            }),
        );
        assert!(matches!(result.status.as_str(), "executed" | "failed"));
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.policy_decision.as_deref()),
            Some("allow")
        );
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.detection_source.as_deref()),
            Some("policy")
        );
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn approval_required_command_preserves_heuristic_background_detection() {
        let workspace = temp_workspace();
        let service = TerminalService::new();
        let result = service.run_command(
            "npm run dev",
            &workspace,
            &workspace,
            Some(SafetySettingsInput {
                block_dangerous_commands: true,
                redact_secrets: true,
                allow_network_commands: false,
                approval_granted: None,
            }),
        );
        assert_eq!(result.status, "approval_required");
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.policy_decision.as_deref()),
            Some("require_approval")
        );
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.background_detected),
            Some(true)
        );
        assert_eq!(
            result
                .provenance
                .as_ref()
                .and_then(|provenance| provenance.background_detection_source.as_deref()),
            Some("heuristic")
        );
        let _ = fs::remove_dir_all(&workspace);
    }

    fn temp_workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "orchcode-terminal-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_millis()
        ));
        fs::create_dir_all(&path).expect("workspace");
        path
    }
}
