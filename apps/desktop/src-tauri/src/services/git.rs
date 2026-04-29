use crate::models::GitStatus;
use std::path::Path;
use std::process::Command;

pub struct GitService;

impl GitService {
    pub fn new() -> Self {
        Self
    }

    pub fn is_repo(&self, workspace: &Path) -> bool {
        run_git(workspace, &["rev-parse", "--is-inside-work-tree"])
            .map(|output| output.trim() == "true")
            .unwrap_or(false)
    }

    pub fn current_branch(&self, workspace: &Path) -> Option<String> {
        run_git(workspace, &["branch", "--show-current"])
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    pub fn status(&self, workspace: &Path) -> GitStatus {
        if !self.is_repo(workspace) {
            return GitStatus {
                is_repo: false,
                branch: None,
                status_text: "Workspace is not a git repository".to_string(),
                changed_files: Vec::new(),
            };
        }

        let status_text = run_git(workspace, &["status", "--short"]).unwrap_or_else(|err| err);
        let changed_files = status_text
            .lines()
            .filter_map(|line| line.get(3..))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect();

        GitStatus {
            is_repo: true,
            branch: self.current_branch(workspace),
            status_text,
            changed_files,
        }
    }

    pub fn diff(&self, workspace: &Path) -> String {
        if !self.is_repo(workspace) {
            return "Workspace is not a git repository".to_string();
        }
        run_git(workspace, &["diff", "--", "."]).unwrap_or_else(|err| err)
    }

    pub fn create_safety_branch(&self, workspace: &Path, name: &str) -> Result<String, String> {
        if !self.is_repo(workspace) {
            return Err("Workspace is not a git repository".to_string());
        }
        let branch_name = format!("codex/{name}");
        run_git(workspace, &["checkout", "-b", &branch_name])?;
        Ok(branch_name)
    }
}

fn run_git(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .map_err(|err| format!("Failed to run git: {err}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
