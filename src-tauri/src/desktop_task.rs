// src-tauri/src/desktop_task.rs
//
// Backing commands for the agent's `desktop_task` tool
// (services/agent/tools/desktopTaskTool.ts). Covers the broad "Desktop Task"
// surface described in the plan: opening files/folders/URLs with the OS
// default handler, launching arbitrary executables, listing/killing
// processes, showing OS notifications, and reading/writing the clipboard.
//
// Security note: approval remains the TypeScript layer's responsibility, but
// the invariant that an OS terminal must never be opened is also enforced here
// at the IPC boundary. This prevents another frontend call site from bypassing
// the agent tools' checks.

use std::process::Command;

use sysinfo::{Pid, System};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::process_ext::NoWindow;

type CmdResult<T> = Result<T, String>;

const TERMINAL_BLOCK_MESSAGE: &str =
    "Opening an OS-level terminal is disabled. Use the in-app terminal instead.";

fn is_terminal_launch_target(value: &str) -> bool {
    let normalized = value.trim().replace('\\', "/").to_ascii_lowercase();
    let basename = normalized.rsplit('/').next().unwrap_or(&normalized);
    let stem = basename
        .strip_suffix(".lnk")
        .or_else(|| basename.strip_suffix(".url"))
        .unwrap_or(basename);
    matches!(
        stem,
        "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
            | "wt"
            | "wt.exe"
            | "conhost"
            | "conhost.exe"
            | "windowsterminal"
            | "windowsterminal.exe"
            | "windows terminal"
            | "windows terminal.exe"
            | "command prompt"
            | "command prompt.exe"
    ) || normalized.starts_with("ms-terminal:")
        || normalized.contains("microsoft.windowsterminal_")
}

// ── open_path ────────────────────────────────────────────────────────────────
//
// Opens a file, folder, or URL with the OS's default handler (Explorer/
// Finder/xdg-open, or the default browser for http(s) links). Uses the
// `open` crate rather than shelling out manually so behaviour is consistent
// across Windows/macOS/Linux.
#[tauri::command]
pub async fn open_path(path: String) -> CmdResult<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty.".to_string());
    }
    if is_terminal_launch_target(trimmed) {
        return Err(TERMINAL_BLOCK_MESSAGE.to_string());
    }
    open::that(trimmed).map_err(|e| format!("Failed to open \"{trimmed}\": {e}"))
}

// ── reveal_in_explorer ─────────────────────────────────────────────────────────
//
// Opens Windows Explorer directly at `path` — as opposed to `open_path`,
// which hands files to their default *application* and directories to the
// in-app Disk Viewer. This is specifically "show me this in the file
// manager" (agent tool: open_in_os_explorer): a folder opens with its contents
// listed; a file opens its parent folder with the file itself
// pre-selected/highlighted.
//
// Windows-only for now — Rachna AI Studio targets Windows first, with
// Finder/xdg-open equivalents left as follow-up work (see the TODO below).
#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> CmdResult<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let p = std::path::Path::new(trimmed);
        let mut cmd = Command::new("explorer");
        if p.is_file() {
            // /select, highlights the file inside its parent folder instead
            // of opening the file itself.
            cmd.arg(format!("/select,{trimmed}"));
        } else {
            cmd.arg(trimmed);
        }
        // explorer.exe frequently exits with a non-zero status even on a
        // successful launch, so we only check that we could spawn it at
        // all rather than waiting on/inspecting its exit code.
        cmd.no_window()
            .spawn()
            .map_err(|e| format!("Failed to open Explorer for \"{trimmed}\": {e}"))?;
        Ok(())
    }

    // TODO(cross-platform): `open ["-R"|""], trimmed` on macOS (Finder),
    // and an xdg-open-based fallback (or `dbus-send` to the file manager)
    // on Linux, once those platforms are in scope.
    #[cfg(not(target_os = "windows"))]
    {
        Err("open_in_os_explorer is only supported on Windows currently.".to_string())
    }
}

// ── launch_app ───────────────────────────────────────────────────────────────
//
// Launches an executable directly (as opposed to open_path's "hand it to
// the OS's default handler" behaviour). Used for starting a specific
// application binary with arguments, e.g. launching a browser with a
// specific profile flag. The spawned process is detached — this command
// only reports whether the spawn itself succeeded and its pid.
#[derive(serde::Serialize)]
pub struct LaunchAppResult {
    pub pid: u32,
}

#[tauri::command]
pub async fn launch_app(app_path: String, args: Vec<String>) -> CmdResult<LaunchAppResult> {
    let trimmed = app_path.trim();
    if trimmed.is_empty() {
        return Err("app_path must not be empty.".to_string());
    }
    if is_terminal_launch_target(trimmed) {
        return Err(TERMINAL_BLOCK_MESSAGE.to_string());
    }

    let child = Command::new(trimmed)
        .args(&args)
        .no_window()
        .spawn()
        .map_err(|e| format!("Failed to launch \"{trimmed}\": {e}"))?;

    Ok(LaunchAppResult { pid: child.id() })
}

// ── list_processes ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// Full path to the process executable, if resolvable.
    pub exe: Option<String>,
    /// CPU usage percentage since the last refresh.
    pub cpu_usage: f32,
    /// Resident memory usage, in bytes.
    pub memory_bytes: u64,
}

/// Returns every currently running process. `name_filter`, when provided, is
/// matched case-insensitively as a substring against the process name so the
/// agent can ask for e.g. "chrome" instead of paging through everything.
#[tauri::command]
pub async fn list_processes(name_filter: Option<String>) -> CmdResult<Vec<ProcessInfo>> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let needle = name_filter
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    let mut processes: Vec<ProcessInfo> = sys
        .processes()
        .values()
        .filter(|p| {
            let Some(needle) = &needle else { return true };
            p.name().to_string_lossy().to_lowercase().contains(needle)
        })
        .map(|p| ProcessInfo {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            exe: p.exe().map(|e| e.to_string_lossy().into_owned()),
            cpu_usage: p.cpu_usage(),
            memory_bytes: p.memory(),
        })
        .collect();

    // Highest memory usage first — the common "what's eating my RAM" case,
    // and keeps an unfiltered call from returning an unordered wall of PIDs.
    processes.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes));

    Ok(processes)
}

// ── kill_process ───────────────────────────────────────────────────────────────
//
// Sends a kill signal to `pid`. The TypeScript tool layer is responsible for
// gating this behind user approval before calling it — see the module-level
// note above.
#[tauri::command]
pub async fn kill_process(pid: u32) -> CmdResult<bool> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let target = Pid::from_u32(pid);
    match sys.process(target) {
        Some(process) => Ok(process.kill()),
        None => Err(format!("No running process with pid {pid}.")),
    }
}

// ── resolve_app ──────────────────────────────────────────────────────────────
//
// Resolves a friendly application name (e.g. "chrome", "notepad") to one or
// more installed-application candidates, so the agent's `desktop_task`
// open_app action can launch an app the user names without needing its
// exact executable path up front.
//
// Search order (Windows):
//   1. Start Menu shortcuts (.lnk) — per-user and all-users. A .lnk path
//      can be handed straight to `open_path`/`open::that()`, which lets
//      Windows resolve and launch the shortcut's target itself, so we never
//      need to parse the .lnk binary format.
//   2. Registry "App Paths" — HKCU/HKLM …CurrentVersion\App Paths\*.exe,
//      the same key the Windows "Run" dialog consults.
//
// On non-Windows platforms this currently returns an empty list; see the
// TODO below for macOS (Spotlight/mdfind) and Linux (.desktop file)
// equivalents.
//
// NOTE: `open_app` (the TS tool layer) now tries the Installed App
// Registry (app_registry.rs's `scan_installed_apps` — a broader,
// session-cached inventory covering Win32 *and* packaged/Store apps)
// before ever calling `resolve_app`. This command remains exactly as it
// was as open_app's fallback when the registry isn't loaded or doesn't
// produce a confident/ambiguous result — see services/appRegistry/
// openApp.ts.
use walkdir::WalkDir;

#[derive(serde::Serialize, Clone)]
pub struct AppMatch {
    /// Display name, e.g. "Google Chrome".
    pub name: String,
    /// Path to hand to `open_path`/`launch_app` — a .lnk shortcut path or a
    /// resolved .exe path, depending on `source`.
    pub path: String,
    /// Where this candidate was found: "start_menu" | "app_paths".
    pub source: String,
}

fn start_menu_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = vec![];
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(std::path::PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Ok(programdata) = std::env::var("PROGRAMDATA") {
        dirs.push(std::path::PathBuf::from(programdata).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    dirs
}

// `pub(crate)` (rather than private) so app_registry.rs's
// `scan_installed_apps` can reuse this exact scanning logic — called with
// an empty needle (`.contains("")` is always true) to get its full result
// set — instead of re-implementing a Start Menu walk of its own.
pub(crate) fn search_start_menu(needle: &str) -> Vec<AppMatch> {
    let mut out = vec![];
    for dir in start_menu_dirs() {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("lnk") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if stem.to_lowercase().contains(needle) {
                out.push(AppMatch {
                    name: stem.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    source: "start_menu".to_string(),
                });
            }
        }
    }
    out
}

// `pub(crate)` for the same reason as `search_start_menu` above — reused
// (with an empty needle) by app_registry.rs's `scan_installed_apps`.
#[cfg(target_os = "windows")]
pub(crate) fn search_app_paths(needle: &str) -> Vec<AppMatch> {
    use winreg::enums::*;
    use winreg::RegKey;

    let mut out = vec![];
    let base = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let hive = RegKey::predef(root);
        let Ok(key) = hive.open_subkey(base) else { continue };
        for name in key.enum_keys().filter_map(|k| k.ok()) {
            if !name.to_lowercase().contains(needle) {
                continue;
            }
            let Ok(sub) = key.open_subkey(&name) else { continue };
            let Ok(default_val) = sub.get_value::<String, _>("") else { continue };
            out.push(AppMatch {
                name: name.trim_end_matches(".exe").to_string(),
                path: default_val,
                source: "app_paths".to_string(),
            });
        }
    }
    out
}

// TODO(cross-platform): add macOS (`mdfind kMDItemKind == 'Application'`)
// and Linux (scan .desktop files under /usr/share/applications and
// ~/.local/share/applications) equivalents here so open_app degrades
// gracefully instead of always returning empty on those platforms.
#[cfg(not(target_os = "windows"))]
pub(crate) fn search_app_paths(_needle: &str) -> Vec<AppMatch> {
    vec![]
}

/// Finds installed applications whose name contains `name` (case-insensitive).
/// Returns every match found — the caller (desktopTaskTool.ts) decides whether
/// to auto-launch a single confident match or surface a disambiguation list.
#[tauri::command]
pub async fn resolve_app(name: String) -> CmdResult<Vec<AppMatch>> {
    let needle = name.trim().to_lowercase();
    if needle.is_empty() {
        return Err("name must not be empty.".to_string());
    }

    let mut matches = search_start_menu(&needle);
    matches.extend(search_app_paths(&needle));
    matches.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));

    Ok(matches)
}

// ── show_notification ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn show_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> CmdResult<()> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| format!("Failed to show notification: {e}"))
}

// ── clipboard ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_clipboard(app: tauri::AppHandle) -> CmdResult<String> {
    app.clipboard()
        .read_text()
        .map_err(|e| format!("Failed to read clipboard: {e}"))
}

#[tauri::command]
pub async fn write_clipboard(app: tauri::AppHandle, text: String) -> CmdResult<()> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("Failed to write clipboard: {e}"))
}

// ── take_screenshot ──────────────────────────────────────────────────────────
//
// Captures the current contents of a monitor and saves it as a PNG under
// the app's local data directory. Backs the agent's `take_screenshot` tool
// (services/agent/tools/screenshotTool.ts).
//
// Security note: same threat model as the rest of this module — the
// TypeScript layer is responsible for gating every call behind the user's
// permission-approval flow (ctx.requestTerminalPermission /
// useTerminalPermissionStore) *every time*, not just on first use, before
// this command is ever invoked. A screenshot can expose whatever is on
// screen (passwords being typed, private messages, etc.), so this is
// treated at least as sensitively as run_terminal_command.
use image::RgbaImage;
use xcap::Monitor;

#[derive(serde::Serialize)]
pub struct ScreenshotResult {
    /// Absolute path to the saved PNG file.
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Human-readable name/label of the monitor that was captured.
    pub monitor: String,
    /// Index of the captured monitor within Monitor::all() — echoed back so
    /// the caller can request the same monitor again.
    pub monitor_index: usize,
    /// Total number of monitors detected — lets the agent know whether
    /// other monitors exist that it might also want to capture.
    pub monitor_count: usize,
}

/// Hides every currently-visible webview window belonging to this app and
/// returns the ones actually hidden, so the caller can restore exactly
/// those afterward. Best-effort: a window that fails to hide is simply
/// left out of the returned list (and therefore left alone on restore)
/// rather than aborting the whole screenshot.
fn hide_own_windows(app: &tauri::AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows()
        .values()
        .filter(|w| w.is_visible().unwrap_or(false))
        .filter(|w| w.hide().is_ok())
        .cloned()
        .collect()
}

fn restore_own_windows(windows: &[tauri::WebviewWindow]) {
    for w in windows {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn capture_monitor(app: &tauri::AppHandle, monitor_index: Option<usize>) -> CmdResult<ScreenshotResult> {
    let monitors = Monitor::all().map_err(|e| format!("Failed to list monitors: {e}"))?;
    if monitors.is_empty() {
        return Err("No monitors were detected on this system.".to_string());
    }
    let monitor_count = monitors.len();

    let index = monitor_index.unwrap_or(0);
    let monitor = monitors.into_iter().nth(index).ok_or_else(|| {
        format!("No monitor at index {index} — {monitor_count} monitor(s) detected (indices 0..{}).",
            monitor_count.saturating_sub(1))
    })?;

    let monitor_name = monitor.name().unwrap_or_default();

    let image: RgbaImage = monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture screen: {e}"))?;

    let dir = crate::commands::local_data_dir(app)?.join("screenshots");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create screenshots directory at {}: {e}", dir.display()))?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("screenshot-{timestamp}.png"));

    image
        .save(&path)
        .map_err(|e| format!("Failed to save screenshot to {}: {e}", path.display()))?;

    Ok(ScreenshotResult {
        path: path.to_string_lossy().into_owned(),
        width: image.width(),
        height: image.height(),
        monitor: monitor_name,
        monitor_index: index,
        monitor_count,
    })
}

#[tauri::command]
pub async fn take_screenshot(
    app: tauri::AppHandle,
    monitor_index: Option<usize>,
) -> CmdResult<ScreenshotResult> {
    // Hide Rachna AI Studio's own window(s) before grabbing pixels, so the
    // app itself never shows up in the screenshot. Without this, approving
    // the permission dialog brings this window to the foreground right
    // before capture, and a full-monitor grab would include it — hiding it
    // from any monitor it happens to be on avoids that entirely.
    let hidden = hide_own_windows(&app);

    // hide() just posts the request — give the compositor a moment to
    // actually stop drawing the window before we capture the screen.
    if !hidden.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    let result = capture_monitor(&app, monitor_index);

    // Always restore, even on capture failure, so a failed screenshot
    // never leaves the app stuck hidden.
    restore_own_windows(&hidden);

    result
}
