use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub struct PatchService;

impl PatchService {
    pub fn new() -> Self {
        Self
    }

    pub fn get_current_diff(&self, diff_text: String) -> String {
        diff_text
    }

    pub fn apply_patch(&self, patch_text: &str, workspace: &Path) -> Result<(), String> {
        self.validate_patch_paths_inside_workspace(patch_text, workspace)?;
        let canonical_workspace = fs::canonicalize(workspace)
            .map_err(|err| format!("Workspace path is not accessible: {err}"))?;
        let patch_path = temp_patch_path();
        fs::write(&patch_path, patch_text)
            .map_err(|err| format!("Failed to stage patch: {err}"))?;
        let output = Command::new("git")
            .args([
                "apply",
                "--whitespace=nowarn",
                patch_path.to_string_lossy().as_ref(),
            ])
            .current_dir(&canonical_workspace)
            .output()
            .map_err(|err| format!("Failed to run git apply: {err}"));
        let _ = fs::remove_file(&patch_path);
        let output = output?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(())
    }

    pub fn validate_patch_paths_inside_workspace(
        &self,
        patch_text: &str,
        workspace: &Path,
    ) -> Result<(), String> {
        for line in patch_text.lines() {
            if let Some(path) = line
                .strip_prefix("+++ b/")
                .or_else(|| line.strip_prefix("--- a/"))
            {
                let relative = Path::new(path);
                if relative.components().any(|component| {
                    matches!(
                        component,
                        Component::ParentDir | Component::RootDir | Component::Prefix(_)
                    )
                }) {
                    return Err("Patch references a path outside the workspace".to_string());
                }
                let canonical_workspace = std::fs::canonicalize(workspace)
                    .map_err(|err| format!("Workspace path is not accessible: {err}"))?;
                let candidate = canonical_workspace.join(relative);
                let parent = candidate.parent().unwrap_or(&canonical_workspace);
                let canonical_parent = if parent.exists() {
                    std::fs::canonicalize(parent)
                        .map_err(|err| format!("Patch path parent is not accessible: {err}"))?
                } else {
                    canonicalize_existing_ancestor(parent, &canonical_workspace)?
                };
                if !canonical_parent.starts_with(&canonical_workspace) {
                    return Err("Patch references a path outside the workspace".to_string());
                }
            }
        }
        Ok(())
    }
}

fn temp_patch_path() -> PathBuf {
    std::env::temp_dir().join(format!("orchcode-patch-{}.diff", uuid::Uuid::new_v4()))
}

fn canonicalize_existing_ancestor(path: &Path, workspace: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    while !current.exists() {
        current = current
            .parent()
            .ok_or_else(|| "Patch path has no existing parent".to_string())?;
    }
    let canonical = std::fs::canonicalize(current)
        .map_err(|err| format!("Patch path parent is not accessible: {err}"))?;
    if !canonical.starts_with(workspace) {
        return Err("Patch references a path outside the workspace".to_string());
    }
    Ok(canonical)
}
