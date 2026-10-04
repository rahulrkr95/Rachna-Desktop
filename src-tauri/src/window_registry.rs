// src-tauri/src/window_registry.rs
//
// Running Window Registry (Part 2) — a snapshot of the *actual currently
// visible* top-level application windows on the desktop: HWND, owning pid,
// title, executable name, screen bounds, and minimized/maximized state.
//
// Why this exists: a launched process's pid is not reliably the pid that
// ends up owning the app's visible window (packaged/Store apps relaunch
// through a host process, some apps spawn a helper/launcher that exits
// once the real UI process starts, browsers own several processes and
// only one owns the window, etc). Desktop tools that need to *act* on a
// window — screenshot it, focus it, click inside it — must not assume
// "the pid I launched" == "the pid/HWND that owns the window". This
// module answers "what windows actually exist right now, and which pid
// really owns each one" by asking Windows directly (EnumWindows), rather
// than trusting whatever pid a launch call happened to return.
//
// Sibling, not a replacement:
//   - app_registry.rs (Part 1) tracks *installed* apps and how to launch
//     them — nothing about what's currently running or on-screen.
//   - window_control.rs already does its own tiny pid → HWND lookup
//     (windows_for_pid) purely to focus/close a *known* pid's window; it
//     doesn't enumerate or expose the desktop's window list. That
//     function/module is intentionally left untouched here — Part 3
//     (desktop tool integration) will decide whether/how focus_app etc.
//     end up sourcing HWNDs from this registry instead.
//   - This module is the general-purpose "what's actually on screen"
//     inventory: every visible top-level window, not just one pid's.
//
// Architecture mirrors Part 1's split (see app_registry.rs's doc comment):
// this Rust module stays a minimal, "dumb" scanner — enumerate, filter out
// noise, resolve exe names, done. Ranking/matching a free-text app name,
// executable, or title against the scan result is deliberately left to
// the TS layer (services/windowRegistry/matching.ts), which reuses the
// same fuzzy scorer services/appRegistry/matching.ts already uses instead
// of a second, competing matcher living in Rust.
//
// Independent from the AI/LLM layer: this file has no knowledge of the
// agent, tools, or prompts — it is a plain OS-facing service that Part 3
// will wire into desktop tools, not something the model calls directly.
//
// Windows-only, matching the rest of the desktop-control surface
// (app_registry.rs, window_control.rs) — Rachna AI Studio targets Windows
// first. `list_visible_windows` returns an empty list on other platforms,
// the same fallback stance those modules already take.

type CmdResult<T> = Result<T, String>;

/// Minimized/maximized/normal state of a top-level window, so callers
/// (e.g. a future screenshot tool) can tell "this window exists but is
/// minimized" apart from "this window is on screen right now" without a
/// second round-trip.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    Normal,
    Minimized,
    Maximized,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct RunningWindow {
    /// The HWND's raw pointer value, stringified (hex) — kept as a string
    /// rather than a number so it round-trips through JSON/JS without
    /// floating-point precision loss, and so it's usable as an opaque,
    /// stable-for-this-scan identifier by callers that don't otherwise
    /// care about its numeric value.
    pub hwnd: String,
    /// The pid Windows reports as actually owning this window — this is
    /// the pid to act on, which may differ from whatever pid a caller
    /// originally launched (see module doc comment above).
    pub pid: u32,
    pub title: String,
    /// Process/executable name (e.g. "notepad.exe"), resolved from `pid`
    /// via sysinfo — the same process-name source window_control.rs
    /// already uses (get_foreground_app), rather than a second lookup
    /// mechanism.
    pub exe_name: String,
    pub bounds: WindowBounds,
    /// Always true for entries returned by `list_visible_windows` (the
    /// scan only ever collects visible windows) — included explicitly so
    /// callers don't have to assume that invariant from the method name
    /// alone, and so it stays meaningful if a future caller merges in
    /// hidden windows for some other purpose.
    pub visible: bool,
    pub state: WindowState,
}

// ── Windows: enumerate + filter + resolve ───────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use super::{RunningWindow, WindowBounds, WindowState};
    use std::ffi::c_void;
    use sysinfo::{Pid, System};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, GWL_EXSTYLE,
        GW_OWNER, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    /// Everything collected straight off the Win32 calls during
    /// enumeration, before pid → exe-name resolution (done in a single
    /// batched sysinfo pass afterward rather than per-window, since
    /// spinning up a fresh `System` inside the EnumWindows callback for
    /// every candidate window would be needlessly expensive).
    struct RawWindow {
        hwnd: HWND,
        pid: u32,
        title: String,
        bounds: WindowBounds,
        state: WindowState,
    }

    struct EnumCtx {
        found: Vec<RawWindow>,
    }

    /// True for a window that isn't meant to show up as a real,
    /// interactable desktop window — a tool window (WS_EX_TOOLWINDOW,
    /// unless it opts back in with WS_EX_APPWINDOW — e.g. floating
    /// palettes, some tray-only helper windows), or one Windows itself
    /// has cloaked (DWM's DWMWA_CLOAKED — the mechanism UWP/packaged apps
    /// use for offscreen placeholder frames, most visibly
    /// ApplicationFrameHost's hidden host windows). Both pass
    /// `IsWindowVisible` yet are pure desktop noise, not something a user
    /// (or an agent acting like one) would ever click on.
    unsafe fn is_noise_window(hwnd: HWND) -> bool {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let is_tool_window =
            (ex_style & WS_EX_TOOLWINDOW as u32) != 0 && (ex_style & WS_EX_APPWINDOW as u32) == 0;
        if is_tool_window {
            return true;
        }

        let mut cloaked: u32 = 0;
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        );
        hr == 0 && cloaked != 0
    }

    unsafe fn window_title(hwnd: HWND, len: i32) -> String {
        let mut buf: Vec<u16> = vec![0; (len as usize) + 1];
        let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        buf.truncate(copied.max(0) as usize);
        String::from_utf16_lossy(&buf)
    }

    unsafe fn window_bounds(hwnd: HWND) -> WindowBounds {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return WindowBounds { x: 0, y: 0, width: 0, height: 0 };
        }
        WindowBounds {
            x: rect.left,
            y: rect.top,
            width: (rect.right - rect.left).max(0),
            height: (rect.bottom - rect.top).max(0),
        }
    }

    unsafe fn window_state(hwnd: HWND) -> WindowState {
        if IsIconic(hwnd) != 0 {
            WindowState::Minimized
        } else if IsZoomed(hwnd) != 0 {
            WindowState::Maximized
        } else {
            WindowState::Normal
        }
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut EnumCtx);

        // Visible + has a title: the same base filter window_control.rs's
        // windows_for_pid already uses to mean "a real app window" rather
        // than a background/utility window.
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return TRUE;
        }

        // Only *unowned* top-level windows — a window with an owner
        // (GW_OWNER) is a popup/dialog belonging to another top-level
        // window (e.g. an About box), not an independent app window in
        // its own right. EnumWindows already only visits top-level
        // windows, but that still includes owned ones, so this needs its
        // own check.
        if !GetWindow(hwnd, GW_OWNER).is_null() {
            return TRUE;
        }

        if is_noise_window(hwnd) {
            return TRUE;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return TRUE;
        }

        ctx.found.push(RawWindow {
            hwnd,
            pid,
            title: window_title(hwnd, title_len),
            bounds: window_bounds(hwnd),
            state: window_state(hwnd),
        });

        TRUE
    }

    /// Enumerates every visible, usable top-level window on the desktop
    /// right now and resolves each one's owning pid to an executable
    /// name in a single batched sysinfo pass.
    pub fn scan() -> Vec<RunningWindow> {
        let mut ctx = EnumCtx { found: vec![] };
        unsafe {
            EnumWindows(Some(enum_proc), &mut ctx as *mut EnumCtx as LPARAM);
        }

        let mut sys = System::new_all();
        sys.refresh_all();

        ctx.found
            .into_iter()
            .map(|w| {
                let exe_name = sys
                    .process(Pid::from_u32(w.pid))
                    .map(|p| p.name().to_string_lossy().into_owned())
                    .unwrap_or_default();
                RunningWindow {
                    hwnd: format!("{:#x}", w.hwnd as isize),
                    pid: w.pid,
                    title: w.title,
                    exe_name,
                    bounds: w.bounds,
                    visible: true,
                    state: w.state,
                }
            })
            .collect()
    }
}

#[cfg(not(target_os = "windows"))]
mod win {
    use super::RunningWindow;
    pub fn scan() -> Vec<RunningWindow> {
        vec![]
    }
}

// ── Public API ────────────────────────────────────────────────────────────
//
// Kept as plain functions (not just Tauri commands) so Part 3's desktop
// tool integration can call `scan()`/`windows_for_pid()` directly from
// Rust — e.g. from a future screenshot/focus tool that needs a fresh HWND
// lookup mid-request — without round-tripping through the JS bridge.

/// Every visible, usable top-level window on the desktop right now. No
/// caching at this layer — the running window set changes far more
/// often than the installed-app registry does (Part 1), so every call is
/// a fresh scan; session-level caching, if any callers want it, belongs
/// in the TS service layer (services/windowRegistry/windowRegistryService.ts),
/// same as it does for the installed-app registry.
pub fn scan() -> Vec<RunningWindow> {
    win::scan()
}

/// All currently visible windows owned by `pid`. A process can own more
/// than one top-level window (e.g. a browser with multiple top-level
/// frames), so this returns all matches rather than assuming one.
pub fn windows_for_pid(pid: u32) -> Vec<RunningWindow> {
    scan().into_iter().filter(|w| w.pid == pid).collect()
}

// Matching a free-text app name/executable/title query against a scan
// result is deliberately NOT duplicated here — same "Rust returns a full
// raw scan, TS ranks it" split app_registry.rs documents for Part 1. See
// services/windowRegistry/matching.ts.

// ── Tauri commands ───────────────────────────────────────────────────────

/// Lists every currently visible, usable top-level window. Always a fresh
/// scan (see `scan()` doc comment above) — refreshing is just calling this
/// again, so there's no separate "refresh" command to keep in sync with it.
#[tauri::command]
pub async fn list_visible_windows() -> CmdResult<Vec<RunningWindow>> {
    Ok(scan())
}

/// Lists every currently visible window owned by `pid`.
#[tauri::command]
pub async fn find_windows_by_pid(pid: u32) -> CmdResult<Vec<RunningWindow>> {
    Ok(windows_for_pid(pid))
}

// ── list_running_apps ────────────────────────────────────────────────────────
//
// Backing command for the agent's `list_running_apps` tool
// (services/agent/tools/desktopControlTools.ts) and the shared appManager TS
// singleton (services/appManager/appManager.ts) it reads through. This is a
// *process-centric* view — one entry per running application, with all of
// its top-level windows folded in — as opposed to `list_visible_windows`
// above (flat, one entry per window) or `list_processes`
// (desktop_task.rs; flat, one entry per OS process, no window info at all).
//
// Deliberately built entirely out of enumeration this module and
// window_control.rs already do, rather than a third independent scan:
//   - the window list comes from `scan()` above (same EnumWindows pass
//     list_visible_windows uses),
//   - "is this app focused right now" comes from
//     window_control::win::foreground_pid() (the same foreground-window
//     lookup get_foreground_app/assert_focused_app already use),
//   - exe path comes from a single batched sysinfo pass, same pattern
//     `scan()` and `list_processes` (desktop_task.rs) both already follow.

#[cfg(target_os = "windows")]
fn foreground_pid() -> Option<u32> {
    crate::window_control::win::foreground_pid()
}

#[cfg(not(target_os = "windows"))]
fn foreground_pid() -> Option<u32> {
    None
}

/// Parses a `RunningWindow.hwnd` string (formatted as `"{:#x}"` by `scan()`
/// above) back into a plain integer for JSON — kept as a signed 64-bit value
/// so it round-trips through serde/JSON without the hex-string detour that
/// `RunningWindow` uses. In practice Win32 HWNDs fit comfortably inside this
/// range, so this doesn't reintroduce the float-precision issue that string
/// formatting was originally chosen to avoid there.
fn parse_hwnd(hex: &str) -> i64 {
    i64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0)
}

/// One running application, matching the frontend `RunningApp` interface
/// (services/appManager/appManager.ts) field-for-field via
/// `#[serde(rename_all = "camelCase")]`.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunningApp {
    pub pid: u32,
    pub exe_name: String,
    pub exe_path: Option<String>,
    /// The first/representative top-level window's handle — same
    /// "one representative window, not the full set" tradeoff
    /// `list_processes`' TS caller already made for `hwnd`/`windowTitle`
    /// before this command existed; `windows` below carries the complete
    /// set for callers that need it.
    pub hwnd: Option<i64>,
    pub title: Option<String>,
    pub is_visible: bool,
    pub is_focused: bool,
    pub windows: Vec<i64>,
}

/// Aggregates `scan()`'s flat window list into one `RunningApp` per pid that
/// owns at least one visible top-level window — background/helper processes
/// with no window of their own (already excluded by `scan()`'s own
/// filtering) don't show up here, same as they don't in `list_visible_windows`.
/// Returns an empty vec, never an error, when nothing is running (or, as
/// with the rest of this module, on a non-Windows target).
pub fn running_apps() -> Vec<RunningApp> {
    let windows = scan();
    if windows.is_empty() {
        return vec![];
    }

    let focused_pid = foreground_pid();

    let mut apps: Vec<RunningApp> = Vec::new();
    let mut index_by_pid: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();

    for w in windows {
        let hwnd_val = parse_hwnd(&w.hwnd);
        if let Some(&idx) = index_by_pid.get(&w.pid) {
            apps[idx].windows.push(hwnd_val);
        } else {
            index_by_pid.insert(w.pid, apps.len());
            apps.push(RunningApp {
                pid: w.pid,
                exe_name: w.exe_name,
                exe_path: None, // resolved below in a single batched pass
                hwnd: Some(hwnd_val),
                title: Some(w.title),
                is_visible: w.visible,
                is_focused: focused_pid == Some(w.pid),
                windows: vec![hwnd_val],
            });
        }
    }

    // Single batched sysinfo pass for exe paths, same rationale scan()'s
    // own pid -> exe-name resolution documents above: cheaper than a fresh
    // System per app, and this is the only remaining field scan() doesn't
    // already carry.
    {
        use sysinfo::{Pid, System};
        let mut sys = System::new_all();
        sys.refresh_all();
        for app in &mut apps {
            if let Some(p) = sys.process(Pid::from_u32(app.pid)) {
                app.exe_path = p.exe().map(|e| e.to_string_lossy().into_owned());
            }
        }
    }

    apps
}

/// Lists every currently running application (process + its top-level
/// window(s)), refreshed fresh on every call — see `running_apps()` above.
#[tauri::command]
pub async fn list_running_apps() -> CmdResult<Vec<RunningApp>> {
    Ok(running_apps())
}
