use std::path::Path;

pub fn display_path(path: &Path) -> String {
    #[cfg(target_os = "windows")]
    {
        let raw = path.to_string_lossy().to_string();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_string();
        }
        return raw;
    }

    #[cfg(not(target_os = "windows"))]
    {
        path.to_string_lossy().to_string()
    }
}
