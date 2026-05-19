use std::path::PathBuf;
use std::process::Command;

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

#[cfg(debug_assertions)]
fn spawn_dev_launcher() -> Result<(), std::io::Error> {
    let repo_root = dev_repo_root()?;

    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "Start-Sleep -Seconds 3; Set-Location -LiteralPath '{}'; $env:ORCHCODE_DEV_FRESH='1'; & npm.cmd run dev -- --fresh",
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
                &script
            ])
            .spawn()?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!("sleep 2; cd '{}' && ORCHCODE_DEV_FRESH=1 npm run dev -- --fresh", escape_shell_single_quotes(&repo_root.to_string_lossy()));
        Command::new("sh").args(["-lc", &script]).spawn()?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let script = format!("sleep 2; cd '{}' && ORCHCODE_DEV_FRESH=1 npm run dev -- --fresh", escape_shell_single_quotes(&repo_root.to_string_lossy()));
        Command::new("sh").args(["-lc", &script]).spawn()?;
        return Ok(());
    }
}

#[cfg(debug_assertions)]
fn dev_repo_root() -> Result<PathBuf, std::io::Error> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(any(target_os = "macos", all(unix, not(target_os = "macos"))))]
fn escape_shell_single_quotes(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}
