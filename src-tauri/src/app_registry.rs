// src-tauri/src/app_registry.rs
//
// Installed App Registry — a session-cached inventory of applications
// installed on the system, covering both traditional Win32 programs and
// Microsoft Store/packaged (UWP/MSIX) apps. Backs the agent's `open_app`
// tool (services/agent/tools/desktopTaskTool.ts, desktopControlTools.ts):
// the TypeScript layer scans once via `scan_installed_apps` — at app
// startup, see App.tsx — caches the result for the session (services/
// appRegistry/appRegistryService.ts), and matches a friendly name against
// it (services/appRegistry/matching.ts, reusing the fuzzy scorer already
// used elsewhere in the app) before ever falling back to the older
// needle-search `resolve_app` command below in desktop_task.rs.
//
// Deliberately a separate module/command rather than folded into
// `resolve_app`: `resolve_app`'s Start Menu (.lnk) + "App Paths" registry
// search stays untouched as open_app's fallback path (see
// services/appRegistry/openApp.ts), while this module is free to build a
// richer, structured inventory once per session instead of re-searching
// the filesystem/registry on every call — and, later, sit next to a
// Running Window Registry (PID/HWND tracking of *currently open* windows)
// as a sibling module without entangling the two. That Running Window
// Registry is explicitly out of scope here — see the TODO at the bottom.
//
// Sources merged into the registry (Windows):
//   1. `Get-StartApps` (PowerShell) — the same source Windows' own Start
//      Menu search uses, so it enumerates BOTH traditional Win32 programs
//      and Microsoft Store/packaged apps in a single pass. Each entry's
//      AppID is either a filesystem path (Win32: a .lnk or, occasionally,
//      a bare .exe) or a `PackageFamilyName!AppId` moniker (packaged) —
//      which is exactly the identifier needed to relaunch a packaged app
//      reliably via `explorer.exe shell:AppsFolder\<AppID>`, since
//      packaged apps have no single "exe path" to launch directly.
//   2. The existing Start Menu shortcut walk and "App Paths" registry
//      search (`search_start_menu` / `search_app_paths` in
//      desktop_task.rs), reused here — with an empty search needle, so
//      their substring filter (`.contains(needle)`) matches everything —
//      rather than re-implemented, so this registry benefits from exactly
//      the same scanning logic `resolve_app` already relies on, and picks
//      up any Win32 app pinned to the Start Menu or registered for the Run
//      dialog that Get-StartApps happens to miss.
//
// On non-Windows platforms `scan_installed_apps` returns an empty list —
// the same fallback stance `resolve_app` already takes.

use std::collections::HashSet;

// Direct launches use these when command-line arguments are supplied;
// packaged-app launches also use them on Windows.
use crate::process_ext::NoWindow;
use std::process::Command;

use crate::desktop_task::{search_app_paths, search_start_menu};

type CmdResult<T> = Result<T, String>;

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum AppKind {
    /// A traditional desktop program with its own executable/shortcut.
    Win32,
    /// A Microsoft Store / packaged (UWP or MSIX) app, identified by an
    /// AppUserModelID rather than a plain executable path.
    Packaged,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct InstalledApp {
    /// Display name, e.g. "Google Chrome", "Calculator".
    pub name: String,
    pub kind: AppKind,
    /// What `launch_installed_app` hands off to actually start the app: a
    /// .lnk/.exe path for `Win32`, or a `shell:AppsFolder\<AppID>` moniker
    /// for `Packaged`.
    pub launch_target: String,
    /// The packaged app's `PackageFamilyName!AppId`, present only for
    /// `Packaged` entries (kept alongside `launch_target`, which already
    /// embeds it, so callers can identify the app without string-parsing
    /// the launch target).
    pub app_user_model_id: Option<String>,
    /// Where this entry was found: "start_apps" | "start_menu" | "app_paths".
    pub source: String,
}

// ── Get-StartApps: Win32 + packaged apps in a single pass ───────────────────

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
struct StartAppEntry {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "AppID")]
    app_id: String,
}

/// A packaged app's AppID looks like `PackageFamilyName!AppId` — it has no
/// backslash or drive-letter colon, since it isn't a filesystem path. A
/// Win32 AppID from Get-StartApps, by contrast, IS a filesystem path
/// (typically a Start Menu .lnk, occasionally a bare .exe).
#[cfg(target_os = "windows")]
fn classify_app_id(app_id: &str) -> AppKind {
    let looks_like_path = app_id.contains('\\') || app_id.contains(':');
    if !looks_like_path && app_id.contains('!') {
        AppKind::Packaged
    } else {
        AppKind::Win32
    }
}

#[cfg(target_os = "windows")]
fn scan_start_apps() -> Vec<InstalledApp> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
        ])
        .no_window()
        .output();

    let Ok(output) = output else { return vec![] };
    if !output.status.success() {
        return vec![];
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    // Get-StartApps | ConvertTo-Json returns a single JSON *object*
    // (not wrapped in an array) when there's exactly one result — Windows
    // PowerShell's JSON cmdlets do this for every single-element pipeline,
    // so both shapes have to be handled.
    let entries: Vec<StartAppEntry> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        serde_json::from_str::<StartAppEntry>(trimmed)
            .map(|e| vec![e])
            .unwrap_or_default()
    };

    entries
        .into_iter()
        .filter(|e| !e.name.trim().is_empty() && !e.app_id.trim().is_empty())
        .map(|e| {
            let kind = classify_app_id(&e.app_id);
            let launch_target = match kind {
                AppKind::Packaged => format!(r"shell:AppsFolder\{}", e.app_id),
                AppKind::Win32 => e.app_id.clone(),
            };
            InstalledApp {
                name: e.name,
                kind,
                launch_target,
                app_user_model_id: matches!(kind, AppKind::Packaged).then(|| e.app_id),
                source: "start_apps".to_string(),
            }
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn scan_start_apps() -> Vec<InstalledApp> {
    vec![]
}

// ── Merge in the existing Start Menu / App Paths scans ──────────────────────

/// Reuses `search_start_menu` / `search_app_paths` (desktop_task.rs) — the
/// scanning logic `resolve_app` already relies on — with an empty needle
/// to get their *entire* result set instead of a filtered one, so this
/// registry is built from exactly the same source rather than a second,
/// competing scanner.
fn scan_legacy_win32() -> Vec<InstalledApp> {
    let mut out: Vec<InstalledApp> = search_start_menu("")
        .into_iter()
        .map(|m| InstalledApp {
            name: m.name,
            kind: AppKind::Win32,
            launch_target: m.path,
            app_user_model_id: None,
            source: m.source,
        })
        .collect();

    out.extend(search_app_paths("").into_iter().map(|m| InstalledApp {
        name: m.name,
        kind: AppKind::Win32,
        launch_target: m.path,
        app_user_model_id: None,
        source: m.source,
    }));

    out
}

/// Scans for every installed application (Win32 + packaged) and returns a
/// deduplicated registry, suitable for caching client-side for the rest of
/// the session. `scan_start_apps` / `scan_legacy_win32` already resolve to
/// their empty, non-Windows variants on other platforms, so this function
/// doesn't need its own cfg split — see the module doc comment above for
/// why the whole registry is effectively a no-op off Windows for now.
#[tauri::command]
pub async fn scan_installed_apps() -> CmdResult<Vec<InstalledApp>> {
    let mut apps = scan_start_apps();
    apps.extend(scan_legacy_win32());

    // Dedupe by launch target first (catches the same shortcut/exe turning
    // up via more than one source), then by kind+name (catches the same
    // app registered under slightly different paths — e.g. a Start Menu
    // .lnk *and* an App Paths entry for the same program). Whichever copy
    // was found first wins; Get-StartApps is scanned first and is
    // generally the more reliably launchable of the two (it's what
    // Windows' own Start Menu search uses).
    let mut seen_targets: HashSet<String> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    apps.retain(|a| {
        let target_key = a.launch_target.to_lowercase();
        if !seen_targets.insert(target_key) {
            return false;
        }
        let name_key = format!("{:?}:{}", a.kind, a.name.to_lowercase());
        seen_names.insert(name_key)
    });

    Ok(apps)
}

// ── launch_installed_app ─────────────────────────────────────────────────────
//
// Launches a registry entry using the mechanism appropriate to its kind:
// Win32 targets (a .lnk or .exe path) go through the same OS default-
// handler open as `open_path`/`open::that()`; packaged targets need
// `explorer.exe` handed the `shell:AppsFolder\<AppID>` moniker directly,
// since there's no single executable to point a normal "open" call at.
#[tauri::command]
pub async fn launch_installed_app(
    kind: AppKind,
    launch_target: String,
    args: Vec<String>,
) -> CmdResult<()> {
    let trimmed = launch_target.trim();
    if trimmed.is_empty() {
        return Err("launch_target must not be empty.".to_string());
    }

    match kind {
        AppKind::Win32 => {
            if args.is_empty() {
                open::that(trimmed).map_err(|e| format!("Failed to launch \"{trimmed}\": {e}"))
            } else {
                Command::new(trimmed)
                    .args(args)
                    .no_window()
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Failed to launch \"{trimmed}\" with arguments: {e}"))
            }
        }
        AppKind::Packaged => {
            #[cfg(target_os = "windows")]
            {
                Command::new("explorer")
                    .arg(trimmed)
                    .no_window()
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("Failed to launch packaged app \"{trimmed}\": {e}"))
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err("Launching packaged apps is only supported on Windows.".to_string())
            }
        }
    }
}

// Part 2 — Running Window Registry (tracking currently *running*
// application windows: pid/hwnd, title, bounds, minimized/maximized
// state) now lives in window_registry.rs as a sibling module — so
// open_app can eventually check "is this already running? focus it
// instead of launching a second instance" once Part 3 wires the two
// together. This module only covers *installed* apps and how to launch
// them; PID/HWND window tracking is intentionally not implemented here.
