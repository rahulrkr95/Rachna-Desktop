use std::path::PathBuf;
use std::process::Command;

use crate::process_ext::NoWindow;

fn managed_node_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("com.rachnaai.ide"));
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|p| p.join("Library/Application Support/com.rachnaai.ide"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg).join("com.rachnaai.ide"));
        }
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|p| p.join(".local/share/com.rachnaai.ide"));
    }
    #[allow(unreachable_code)]
    None
}

fn managed_node_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("RACHNA_MANAGED_NODE_DIR").map(PathBuf::from) {
        return Some(dir);
    }
    let root = managed_node_root()?.join("node");
    #[cfg(target_os = "windows")]
    let dir = root.join("windows-x64");
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let dir = root.join("macos-arm64");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let dir = root.join("macos-x64");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let dir = root.join("linux-x64");
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let dir = root.join("linux-arm64");
    Some(dir)
}

pub(crate) fn managed_node_bin(name: &str) -> Option<PathBuf> {
    let dir = managed_node_dir()?;
    #[cfg(target_os = "windows")]
    {
        let exe = dir.join(format!("{name}.cmd"));
        if exe.exists() {
            return Some(exe);
        }
        let exe = dir.join(format!("{name}.exe"));
        if exe.exists() {
            return Some(exe);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let exe = dir.join("bin").join(name);
        if exe.exists() {
            return Some(exe);
        }
    }
    None
}

// process_utils.rs
pub(crate) fn managed_node_path_entry() -> Option<PathBuf>{
    let dir = managed_node_dir()?;
    #[cfg(target_os = "windows")]
    {
        Some(dir)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Some(dir.join("bin"))
    }
}

pub(crate) fn with_managed_node_path(cmd: &mut Command) {
    if let Some(entry) = managed_node_path_entry() {
        let mut paths = vec![entry];
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
}

// Resolves a bare program name (e.g. "npx") to something `Command::new` can
// actually spawn on Windows. npm/npx are `.cmd` shims there, and CreateProcess
// does not perform PATHEXT resolution the way a shell does.
pub(crate) fn resolve_executable(program: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        if program.contains('.') {
            return program.to_string();
        }
        for ext in ["cmd", "exe", "bat"] {
            let candidate = format!("{program}.{ext}");
            if Command::new("where")
                .arg(&candidate)
                .no_window()
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return candidate;
            }
        }
        program.to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        program.to_string()
    }
}
