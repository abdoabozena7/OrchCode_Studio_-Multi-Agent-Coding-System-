use crate::models::WorkspaceInfo;
use crate::services::paths::display_path;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub struct ProjectIndexService;

impl ProjectIndexService {
    pub fn new() -> Self {
        Self
    }

    pub fn summarize(
        &self,
        workspace: &Path,
        is_git_repo: bool,
        branch: Option<String>,
    ) -> WorkspaceInfo {
        let mut languages: HashMap<String, usize> = HashMap::new();
        let mut important_files = Vec::new();

        for entry in WalkDir::new(workspace)
            .max_depth(4)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| !should_skip(entry.path()))
            .take(1000)
        {
            let path = entry.path();
            if path.is_file() {
                if let Some(language) = language_for_path(path) {
                    *languages.entry(language.to_string()).or_insert(0) += 1;
                }
                if is_important_file(path) {
                    if let Ok(relative) = path.strip_prefix(workspace) {
                        important_files.push(relative.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        }

        let package_managers = detect_package_managers(workspace);
        let test_commands = guess_test_commands(workspace, &package_managers, &languages);

        WorkspaceInfo {
            path: display_path(workspace),
            name: workspace
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Workspace")
                .to_string(),
            is_git_repo,
            current_branch: branch,
            important_files,
            languages,
            package_managers,
            test_commands,
        }
    }
}

fn should_skip(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        matches!(
            value.as_ref(),
            "node_modules" | "target" | "dist" | "build" | ".git"
        )
    })
}

fn language_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "ts" | "tsx" => Some("TypeScript"),
        "js" | "jsx" => Some("JavaScript"),
        "rs" => Some("Rust"),
        "py" => Some("Python"),
        "go" => Some("Go"),
        "java" => Some("Java"),
        "cs" => Some("C#"),
        "css" => Some("CSS"),
        "html" => Some("HTML"),
        "md" => Some("Markdown"),
        _ => None,
    }
}

fn is_important_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    matches!(
        name,
        "package.json"
            | "pnpm-lock.yaml"
            | "package-lock.json"
            | "Cargo.toml"
            | "pyproject.toml"
            | "README.md"
            | "tsconfig.json"
            | "vite.config.ts"
            | "tauri.conf.json"
    )
}

fn detect_package_managers(workspace: &Path) -> Vec<String> {
    let checks = [
        ("pnpm", "pnpm-lock.yaml"),
        ("npm", "package-lock.json"),
        ("yarn", "yarn.lock"),
        ("cargo", "Cargo.toml"),
        ("pip/pytest", "pyproject.toml"),
    ];
    checks
        .iter()
        .filter_map(|(name, file)| workspace.join(file).exists().then(|| (*name).to_string()))
        .collect()
}

fn guess_test_commands(
    workspace: &Path,
    managers: &[String],
    languages: &HashMap<String, usize>,
) -> Vec<String> {
    let mut commands = Vec::new();
    if managers.iter().any(|manager| manager == "pnpm") {
        commands.push("pnpm test".to_string());
    } else if workspace.join("package.json").exists() {
        commands.push("npm test".to_string());
    }
    if managers.iter().any(|manager| manager == "cargo") {
        commands.push("cargo test".to_string());
    }
    if languages.contains_key("Python") {
        commands.push("pytest".to_string());
    }
    commands
}

#[allow(dead_code)]
fn read_dir(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default()
}
