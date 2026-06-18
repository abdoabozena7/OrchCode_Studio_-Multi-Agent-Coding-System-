use chrono::{DateTime, Utc};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;
use walkdir::WalkDir;

static DESKTOP_STARTED_AT: LazyLock<DateTime<Utc>> = LazyLock::new(Utc::now);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFreshnessStatus {
    pub status: String,
    pub desktop_started_at: String,
    pub runtime_started_at: Option<String>,
    pub latest_source_modified_at: Option<String>,
    pub stale_files: Vec<String>,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn open_external_target(target: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &target])
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|err| err.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
pub fn restart_with_latest_code(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        spawn_dev_launcher().map_err(|err| err.to_string())?;
        app.exit(0);
        return Ok(());
    }

    #[cfg(not(debug_assertions))]
    {
        app.restart();
        Ok(())
    }
}

#[tauri::command]
pub fn get_code_freshness_status(
    runtime_started_at: Option<String>,
) -> Result<CodeFreshnessStatus, String> {
    #[cfg(debug_assertions)]
    {
        let repo_root = dev_repo_root().map_err(|err| err.to_string())?;
        return Ok(code_freshness_status(
            &repo_root,
            *DESKTOP_STARTED_AT,
            runtime_started_at.as_deref(),
        ));
    }

    #[cfg(not(debug_assertions))]
    {
        Ok(CodeFreshnessStatus {
            status: "unknown".to_string(),
            desktop_started_at: DESKTOP_STARTED_AT.to_rfc3339(),
            runtime_started_at,
            latest_source_modified_at: None,
            stale_files: Vec::new(),
            reason: Some("Source freshness is only available in development mode.".to_string()),
        })
    }
}

#[cfg(debug_assertions)]
fn code_freshness_status(
    repo_root: &Path,
    desktop_started_at: DateTime<Utc>,
    runtime_started_at: Option<&str>,
) -> CodeFreshnessStatus {
    let runtime_started = runtime_started_at.and_then(|value| {
        DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|timestamp| timestamp.with_timezone(&Utc))
    });
    let effective_started_at = runtime_started
        .map(|timestamp| timestamp.min(desktop_started_at))
        .unwrap_or(desktop_started_at);
    let mut modified_files = Vec::new();

    for entry in WalkDir::new(repo_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry
                .path()
                .strip_prefix(repo_root)
                .map(is_relevant_source_path_or_parent)
                .unwrap_or(false)
        })
    {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(repo_root) else {
            continue;
        };
        if !is_relevant_source_file(relative) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let modified_at: DateTime<Utc> = modified.into();
        modified_files.push((relative.to_string_lossy().replace('\\', "/"), modified_at));
    }

    modified_files.sort_by(|left, right| right.1.cmp(&left.1));
    let latest_source_modified_at = modified_files.first().map(|entry| entry.1.to_rfc3339());
    let stale_files = modified_files
        .iter()
        .filter(|entry| entry.1 > effective_started_at)
        .take(24)
        .map(|entry| entry.0.clone())
        .collect::<Vec<_>>();

    if runtime_started_at.is_some() && runtime_started.is_none() {
        return CodeFreshnessStatus {
            status: "unknown".to_string(),
            desktop_started_at: desktop_started_at.to_rfc3339(),
            runtime_started_at: runtime_started_at.map(str::to_string),
            latest_source_modified_at,
            stale_files,
            reason: Some("Agent runtime returned an invalid start timestamp.".to_string()),
        };
    }

    CodeFreshnessStatus {
        status: if runtime_started_at.is_none() {
            "unknown"
        } else if stale_files.is_empty() {
            "fresh"
        } else {
            "stale"
        }
        .to_string(),
        desktop_started_at: desktop_started_at.to_rfc3339(),
        runtime_started_at: runtime_started_at.map(str::to_string),
        latest_source_modified_at,
        stale_files,
        reason: if runtime_started_at.is_none() {
            Some(
                "Agent runtime start time is unavailable, so full code freshness cannot be proven."
                    .to_string(),
            )
        } else {
            None
        },
    }
}

#[cfg(debug_assertions)]
fn is_relevant_source_path_or_parent(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return true;
    }
    let normalized = path.to_string_lossy().replace('\\', "/");
    if is_ignored_path(&normalized) {
        return false;
    }
    [
        "apps",
        "apps/desktop",
        "apps/desktop/src",
        "apps/desktop/src-tauri",
        "apps/desktop/src-tauri/src",
        "apps/desktop/scripts",
        "apps/agent-runtime",
        "apps/agent-runtime/src",
        "packages",
        "packages/protocol",
        "packages/protocol/src",
        "scripts",
    ]
    .iter()
    .any(|prefix| {
        normalized == *prefix
            || prefix.starts_with(&format!("{normalized}/"))
            || normalized.starts_with(&format!("{prefix}/"))
    }) || is_relevant_root_file(&normalized)
}

#[cfg(debug_assertions)]
fn is_relevant_source_file(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if is_ignored_path(&normalized) {
        return false;
    }
    if is_relevant_root_file(&normalized) {
        return true;
    }
    normalized.starts_with("apps/desktop/src/")
        || normalized.starts_with("apps/desktop/src-tauri/src/")
        || normalized.starts_with("apps/agent-runtime/src/")
        || normalized.starts_with("packages/protocol/src/")
        || normalized == "apps/desktop/src-tauri/Cargo.toml"
        || normalized == "apps/desktop/src-tauri/Cargo.lock"
        || normalized == "apps/desktop/src-tauri/tauri.conf.json"
        || normalized == "apps/desktop/package.json"
        || normalized == "apps/desktop/tsconfig.json"
        || normalized == "apps/desktop/vite.config.ts"
        || normalized == "apps/desktop/scripts/dev-or-reuse.mjs"
        || normalized == "apps/agent-runtime/package.json"
        || normalized == "apps/agent-runtime/tsconfig.json"
        || normalized == "packages/protocol/package.json"
        || normalized == "packages/protocol/tsconfig.json"
        || normalized == "scripts/launch-desktop.mjs"
}

#[cfg(debug_assertions)]
fn is_relevant_root_file(path: &str) -> bool {
    matches!(path, "package.json" | "package-lock.json")
}

#[cfg(debug_assertions)]
fn is_ignored_path(path: &str) -> bool {
    path.split('/').any(|part| {
        matches!(
            part,
            ".git"
                | ".agent_memory"
                | ".orchcode-agent-runtime"
                | ".hivo-agent-runtime"
                | "node_modules"
                | "dist"
                | "target"
                | "coverage"
                | "docs"
                | "tmp"
                | "test-results"
                | "tests"
                | "__tests__"
                | "gen"
        )
    }) || path.ends_with(".test.ts")
        || path.ends_with(".test.tsx")
        || path.ends_with(".spec.ts")
        || path.ends_with(".spec.tsx")
}

#[cfg(debug_assertions)]
fn spawn_dev_launcher() -> Result<(), std::io::Error> {
    let repo_root = dev_repo_root()?;

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "Start-Sleep -Seconds 3; Set-Location -LiteralPath '{}'; $env:HIVO_DEV_FRESH='1'; & npm.cmd run dev -- --fresh",
            escape_powershell_single_quotes(&repo_root.to_string_lossy())
        );
        Command::new("cmd")
            .args([
                "/C",
                "start",
                "",
                "powershell",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &script,
            ])
            .spawn()?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "sleep 2; cd '{}' && HIVO_DEV_FRESH=1 npm run dev -- --fresh",
            escape_shell_single_quotes(&repo_root.to_string_lossy())
        );
        Command::new("sh").args(["-lc", &script]).spawn()?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script = format!(
            "sleep 2; cd '{}' && HIVO_DEV_FRESH=1 npm run dev -- --fresh",
            escape_shell_single_quotes(&repo_root.to_string_lossy())
        );
        Command::new("sh").args(["-lc", &script]).spawn()?;
        return Ok(());
    }
}

#[cfg(debug_assertions)]
fn dev_repo_root() -> Result<PathBuf, std::io::Error> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("..").join("..").join("..").canonicalize()
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn escape_shell_single_quotes(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::{code_freshness_status, is_relevant_source_file};
    use chrono::{Duration, Utc};
    use std::fs;

    #[test]
    fn source_filter_includes_runtime_surfaces_and_excludes_non_runtime_files() {
        assert!(is_relevant_source_file(std::path::Path::new(
            "apps/desktop/src/app/App.tsx"
        )));
        assert!(is_relevant_source_file(std::path::Path::new(
            "apps/desktop/src-tauri/src/commands/system.rs"
        )));
        assert!(is_relevant_source_file(std::path::Path::new(
            "apps/agent-runtime/src/server.ts"
        )));
        assert!(is_relevant_source_file(std::path::Path::new(
            "packages/protocol/src/agent-runtime.ts"
        )));
        assert!(!is_relevant_source_file(std::path::Path::new(
            "apps/agent-runtime/src/tests/runtime.test.ts"
        )));
        assert!(!is_relevant_source_file(std::path::Path::new(
            "docs/README.md"
        )));
        assert!(!is_relevant_source_file(std::path::Path::new(
            "apps/desktop/dist/index.js"
        )));
    }

    #[test]
    fn freshness_reports_files_changed_after_desktop_or_runtime_started() {
        let root = std::env::temp_dir().join(format!("hivo-freshness-{}", uuid::Uuid::new_v4()));
        let source = root.join("apps/desktop/src/app/App.tsx");
        fs::create_dir_all(source.parent().expect("source parent")).expect("create source parent");
        fs::write(&source, "export const fresh = true;\n").expect("write source");

        let before_write = Utc::now() - Duration::seconds(2);
        let stale = code_freshness_status(&root, before_write, Some(&before_write.to_rfc3339()));
        assert_eq!(stale.status, "stale");
        assert_eq!(stale.stale_files, vec!["apps/desktop/src/app/App.tsx"]);

        let after_write = Utc::now() + Duration::seconds(2);
        let stale_runtime =
            code_freshness_status(&root, after_write, Some(&before_write.to_rfc3339()));
        assert_eq!(stale_runtime.status, "stale");
        let stale_desktop =
            code_freshness_status(&root, before_write, Some(&after_write.to_rfc3339()));
        assert_eq!(stale_desktop.status, "stale");
        let fresh = code_freshness_status(&root, after_write, Some(&after_write.to_rfc3339()));
        assert_eq!(fresh.status, "fresh");
        assert!(fresh.stale_files.is_empty());
        fs::remove_dir_all(root).expect("remove fixture");
    }
}
