use crate::models::{CommandResult, CommandRisk, SafetySettingsInput};
use crate::services::command_policy::CommandPolicyService;
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
                    CommandRisk::Dangerous,
                    format!("Workspace path is not accessible: {err}"),
                );
            }
        };
        let canonical_cwd = match std::fs::canonicalize(cwd) {
            Ok(path) if path.starts_with(&canonical_workspace) => path,
            Ok(_) => {
                return blocked_result(
                    command,
                    cwd,
                    CommandRisk::Dangerous,
                    "Command cwd is outside the active workspace".to_string(),
                );
            }
            Err(err) => {
                return blocked_result(
                    command,
                    cwd,
                    CommandRisk::Dangerous,
                    format!("Command cwd is not accessible: {err}"),
                );
            }
        };
        let risk = CommandPolicyService::classify(command, workspace);
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
            };
        }

        if !safety.allow_network_commands && looks_like_network_command(command) {
            return blocked_result(
                command,
                cwd,
                risk,
                "Network commands are blocked by active safety settings".to_string(),
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
                Ok(child) => CommandResult {
                    command: command.to_string(),
                    cwd: cwd.to_string_lossy().to_string(),
                    risk,
                    status: "executed".to_string(),
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: Some(format!(
                        "Approved background command started by Rust terminal authority with pid {}. It may continue running after this result.",
                        child.id()
                    )),
                },
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
            },
        }
    }
}

fn blocked_result(command: &str, cwd: &Path, risk: CommandRisk, message: String) -> CommandResult {
    CommandResult {
        command: command.to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        risk,
        status: "blocked".to_string(),
        exit_code: None,
        stdout: String::new(),
        stderr: String::new(),
        message: Some(message),
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
