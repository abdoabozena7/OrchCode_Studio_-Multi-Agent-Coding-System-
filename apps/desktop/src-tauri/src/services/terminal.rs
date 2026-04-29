use crate::models::{CommandResult, CommandRisk};
use crate::services::command_policy::CommandPolicyService;
use std::path::Path;
use std::process::Command;

pub struct TerminalService;

impl TerminalService {
    pub fn new() -> Self {
        Self
    }

    pub fn run_command(&self, command: &str, cwd: &Path, workspace: &Path) -> CommandResult {
        let risk = CommandPolicyService::classify(command, workspace);
        if risk == CommandRisk::Dangerous {
            return CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "blocked".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some("Dangerous command blocked by policy".to_string()),
            };
        }

        if risk == CommandRisk::Medium {
            return CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "approval_required".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some("Medium-risk commands require approval. Module 1 returns this instead of executing.".to_string()),
            };
        }

        let output = if cfg!(windows) {
            Command::new("cmd")
                .args(["/C", command])
                .current_dir(cwd)
                .output()
        } else {
            Command::new("sh")
                .args(["-lc", command])
                .current_dir(cwd)
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
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                message: None,
            },
            Err(err) => CommandResult {
                command: command.to_string(),
                cwd: cwd.to_string_lossy().to_string(),
                risk,
                status: "failed".to_string(),
                exit_code: None,
                stdout: String::new(),
                stderr: err.to_string(),
                message: Some("Failed to execute command".to_string()),
            },
        }
    }
}
