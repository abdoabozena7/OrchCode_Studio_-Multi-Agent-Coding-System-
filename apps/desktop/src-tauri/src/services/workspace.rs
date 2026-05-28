use crate::models::FileEntry;
use crate::security::is_secret_candidate;
use ignore::WalkBuilder;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct WorkspaceService {
    workspace_path: Option<PathBuf>,
    project_id: Option<String>,
}

impl WorkspaceService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open_workspace(&mut self, path: &str, project_id: String) -> Result<PathBuf, String> {
        let canonical = fs::canonicalize(path)
            .map_err(|err| format!("Workspace path is not accessible: {err}"))?;
        if !canonical.is_dir() {
            return Err("Workspace path must be a directory".to_string());
        }
        self.workspace_path = Some(canonical.clone());
        self.project_id = Some(project_id);
        Ok(canonical)
    }

    pub fn workspace_path(&self) -> Result<PathBuf, String> {
        self.workspace_path
            .clone()
            .ok_or_else(|| "No workspace is open".to_string())
    }

    pub fn project_id(&self) -> Option<String> {
        self.project_id.clone()
    }

    pub fn ensure_inside_workspace(&self, path: &Path) -> Result<PathBuf, String> {
        let workspace = self.workspace_path()?;
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            workspace.join(path)
        };

        let canonical =
            fs::canonicalize(&candidate).map_err(|err| format!("Path is not accessible: {err}"))?;
        if !canonical.starts_with(&workspace) {
            return Err("Path is outside the active workspace".to_string());
        }
        Ok(canonical)
    }

    pub fn ensure_command_cwd(&self, cwd: Option<&str>) -> Result<PathBuf, String> {
        let workspace = self.workspace_path()?;
        match cwd {
            Some(value) if !value.trim().is_empty() => {
                self.ensure_inside_workspace(Path::new(value))
            }
            _ => Ok(workspace),
        }
    }

    pub fn list_files(
        &self,
        root: Option<&str>,
        respect_gitignore: bool,
    ) -> Result<Vec<FileEntry>, String> {
        let workspace = self.workspace_path()?;
        let root_path = match root {
            Some(value) if !value.trim().is_empty() => {
                self.ensure_inside_workspace(Path::new(value))?
            }
            _ => workspace.clone(),
        };

        let mut builder = WalkBuilder::new(&root_path);
        builder
            .hidden(false)
            .git_ignore(respect_gitignore)
            .git_exclude(respect_gitignore)
            .parents(respect_gitignore)
            .max_depth(Some(4));

        let mut entries = Vec::new();
        for result in builder.build().filter_map(Result::ok).take(600) {
            let path = result.path();
            if path == root_path {
                continue;
            }
            if should_skip_path(path) {
                continue;
            }
            let relative = path.strip_prefix(&workspace).unwrap_or(path);
            entries.push(FileEntry {
                path: relative.to_string_lossy().replace('\\', "/"),
                name: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                is_dir: path.is_dir(),
                is_secret_candidate: is_secret_candidate(path),
            });
        }

        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    pub fn read_file(&self, path: &str) -> Result<String, String> {
        let canonical = self.ensure_inside_workspace(Path::new(path))?;
        if canonical.is_dir() {
            return Err("Cannot read a directory".to_string());
        }
        if is_secret_candidate(&canonical) {
            return Err(
                "Secret-like files are blocked by the Module 1 security baseline".to_string(),
            );
        }
        fs::read_to_string(canonical).map_err(|err| format!("Failed to read file: {err}"))
    }
}

fn should_skip_path(path: &Path) -> bool {
    path.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        matches!(
            value.as_ref(),
            ".cache"
                | ".git"
                | ".mypy_cache"
                | ".next"
                | ".nox"
                | ".nuxt"
                | ".playwright-cli"
                | ".pytest_cache"
                | ".ruff_cache"
                | ".svelte-kit"
                | ".tox"
                | ".turbo"
                | ".venv"
                | ".vite"
                | "__pycache__"
                | "ENV"
                | "build"
                | "coverage"
                | "dist"
                | "env"
                | "htmlcov"
                | "node_modules"
                | "out"
                | "output"
                | "outputs"
                | "playwright-report"
                | "screenshots"
                | "site-packages"
                | "target"
                | "test-results"
                | "venv"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::WorkspaceService;
    use std::fs;

    #[test]
    fn rejects_paths_outside_workspace() {
        let base = std::env::temp_dir().join(format!("hivo-test-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("hivo-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        fs::write(outside.join("missing-parent"), "").ok();
        let outside_file =
            std::env::temp_dir().join(format!("hivo-outside-file-{}", uuid::Uuid::new_v4()));
        fs::write(&outside_file, "nope").unwrap();

        let mut service = WorkspaceService::new();
        service
            .open_workspace(base.to_str().unwrap(), "project".to_string())
            .unwrap();

        let result = service.ensure_inside_workspace(&outside_file);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(base);
        let _ = fs::remove_file(outside_file);
    }
}
