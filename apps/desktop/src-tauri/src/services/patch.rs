use std::path::{Component, Path};

pub struct PatchService;

impl PatchService {
    pub fn new() -> Self {
        Self
    }

    pub fn get_current_diff(&self, diff_text: String) -> String {
        diff_text
    }

    pub fn apply_patch(&self, _patch_text: &str) -> Result<(), String> {
        Err("Patch application is disabled in Module 1".to_string())
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
                let candidate = workspace.join(relative);
                if !candidate.starts_with(workspace) {
                    return Err("Patch references a path outside the workspace".to_string());
                }
            }
        }
        Ok(())
    }
}
