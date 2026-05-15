use crate::models::{DiffFileStat, GitStatus, WorkspaceDiffSnapshot};
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

    pub fn snapshot(&self, workspace: &Path, source: &str) -> WorkspaceDiffSnapshot {
        let checked_at = Some(chrono::Utc::now().to_rfc3339());
        if !self.is_repo(workspace) {
            return WorkspaceDiffSnapshot {
                available: false,
                source: source.to_string(),
                is_git_repo: Some(false),
                changed_files: Some(Vec::new()),
                diff_text: None,
                file_stats: None,
                status_entries: None,
                dirty: Some(false),
                checked_at,
                unavailable_reason: Some("Workspace is not a git repository.".to_string()),
            };
        }

        let status_text = match run_git(workspace, &["status", "--short"]) {
            Ok(output) => output,
            Err(err) => {
                return WorkspaceDiffSnapshot {
                    available: false,
                    source: source.to_string(),
                    is_git_repo: Some(true),
                    changed_files: None,
                    diff_text: None,
                    file_stats: None,
                    status_entries: None,
                    dirty: None,
                    checked_at,
                    unavailable_reason: Some(format!("Failed to capture git status: {err}")),
                }
            }
        };
        let diff_text = match run_git(workspace, &["diff", "--", "."]) {
            Ok(output) => output,
            Err(err) => {
                return WorkspaceDiffSnapshot {
                    available: false,
                    source: source.to_string(),
                    is_git_repo: Some(true),
                    changed_files: Some(parse_changed_files(&status_text)),
                    diff_text: None,
                    file_stats: None,
                    status_entries: Some(parse_status_entries(&status_text)),
                    dirty: Some(!status_text.trim().is_empty()),
                    checked_at,
                    unavailable_reason: Some(format!("Failed to capture git diff: {err}")),
                }
            }
        };
        let numstat = run_git(workspace, &["diff", "--numstat", "--", "."]).ok();
        WorkspaceDiffSnapshot {
            available: true,
            source: source.to_string(),
            is_git_repo: Some(true),
            changed_files: Some(parse_changed_files(&status_text)),
            diff_text: Some(diff_text),
            file_stats: numstat.as_deref().map(parse_numstat),
            status_entries: Some(parse_status_entries(&status_text)),
            dirty: Some(!status_text.trim().is_empty()),
            checked_at,
            unavailable_reason: None,
        }
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

fn parse_changed_files(status_text: &str) -> Vec<String> {
    status_text
        .lines()
        .filter_map(|line| line.get(3..))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn parse_status_entries(status_text: &str) -> Vec<String> {
    status_text
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn parse_numstat(numstat_text: &str) -> Vec<DiffFileStat> {
    numstat_text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let additions = parts.next()?;
            let deletions = parts.next()?;
            let path = parts.next()?.trim();
            Some(DiffFileStat {
                path: path.to_string(),
                change_type: "modify".to_string(),
                additions: additions.parse::<i64>().ok(),
                deletions: deletions.parse::<i64>().ok(),
            })
        })
        .collect()
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
