use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn node_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;

    #[cfg(target_os = "windows")]
    let bundled = dir.join("node/windows-x64/node.exe");

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let bundled = dir.join("node/macos-arm64/node");

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let bundled = dir.join("node/macos-x64/node");

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let bundled = dir.join("node/linux-x64/node");

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let bundled = dir.join("node/linux-arm64/node");

    if bundled.exists() {
        return Some(bundled);
    }

    which::which("node").ok()
}