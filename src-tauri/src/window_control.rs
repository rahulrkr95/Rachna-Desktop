// src-tauri/src/window_control.rs
//
// Backing commands for the agent's `focus_app` and `close_app` tools
// (services/agent/tools/desktopControlTools.ts):
//   - focus_app  → brings an already-running application's window to the
//                  foreground (SetForegroundWindow), restoring it first if
//                  it's minimized. If the requested pid owns no visible
//                  window, falls back to a sibling process sharing the same
//                  executable name that does (e.g. an explicit Chrome pid
//                  with no window falls back to whichever chrome.exe pid
//                  actually owns the browser window) and returns *that*
//                  pid instead, since it's the real desktop target.
//   - close_app  → asks a running application to close gracefully by
//                  posting WM_CLOSE to its window(s) — the same signal
//                  sent when a user clicks the window's own [X] button —
//                  as opposed to `kill_process` (desktop_task.rs), which
//                  force-terminates the process outright and can lose
//                  unsaved work.
//
// Both accept either a `pid` (preferred — unambiguous) or an `app_name`
// substring to resolve against the running process list, mirroring
// desktop_task's `kill_process` / `list_processes` ergonomics.
//
// Windows-only for now, matching the rest of the desktop-control surface
// (resolve_app / reveal_in_explorer in desktop_task.rs) — Rachna AI Studio
// targets Windows first.

use sysinfo::System;

type CmdResult<T> = Result<T, String>;

/// Rachna's own pid, so every target-resolution path below can filter
/// itself out. `std::process::id()` is a cheap, synchronous OS call — no
/// need to cache it since resolve_pid already does a full process-table
/// refresh on every call anyway.
fn self_pid() -> u32 {
    std::process::id()
}

/// Resolves the caller's `pid`/`app_name` args down to a single target pid.
/// Prefers an explicit pid; otherwise substring-matches `app_name`
/// case-insensitively against running process names and picks the
/// highest-memory match (same heuristic as desktop_task's resolve_app
/// single-match case) — ambiguous by design rather than silently guessing
/// wrong when multiple instances of an app are running.
///
/// Never resolves to Rachna's own pid. An explicit `pid` equal to our own
/// is a caller bug (or a stale cached target — see resolveTarget.ts /
/// desktopInputGuard.ts on the TS side) and is rejected outright rather
/// than silently honored; an `app_name` match is filtered to exclude our
/// own process before ranking by memory, so a name substring that happens
/// to also match Rachna itself (e.g. a generic "studio"/"code" query)
/// can't resolve back to the agent's own window.
fn resolve_pid(pid: Option<u32>, app_name: Option<String>) -> CmdResult<u32> {
    let own_pid = self_pid();

    if let Some(pid) = pid {
        if pid == own_pid {
            return Err(
                "Refusing to target Rachna AI Studio's own process — this pid is Rachna itself."
                    .to_string(),
            );
        }
        return Ok(pid);
    }

    let name = app_name.ok_or_else(|| "Either pid or appName is required.".to_string())?;
    let needle = name.trim().to_lowercase();
    if needle.is_empty() {
        return Err("appName must not be empty.".to_string());
    }

    let mut sys = System::new_all();
    sys.refresh_all();

    let mut matches: Vec<_> = sys
        .processes()
        .values()
        .filter(|p| p.pid().as_u32() != own_pid)
        .filter(|p| p.name().to_string_lossy().to_lowercase().contains(&needle))
        .collect();

    if matches.is_empty() {
        return Err(format!("No running process matching \"{name}\" was found."));
    }

    matches.sort_by_key(|p| std::cmp::Reverse(p.memory()));
    Ok(matches[0].pid().as_u32())
}

#[cfg(target_os = "windows")]
pub(crate) mod win {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, IsZoomed, PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE,
        WM_CLOSE,
    };

    struct FindCtx {
        target_pid: u32,
        found: Vec<HWND>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut FindCtx);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == ctx.target_pid && IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0 {
            ctx.found.push(hwnd);
        }
        TRUE
    }

    /// Every visible, titled top-level window owned by `pid` — a reasonable
    /// proxy for "the app's main window(s)" without needing to guess which
    /// one is `the` main window when a process opens more than one.
    fn windows_for_pid(pid: u32) -> Vec<HWND> {
        let mut ctx = FindCtx {
            target_pid: pid,
            found: vec![],
        };
        unsafe {
            EnumWindows(Some(enum_proc), &mut ctx as *mut FindCtx as LPARAM);
        }
        ctx.found
    }

    pub fn foreground_pid() -> Option<u32> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd == std::ptr::null_mut() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            (pid != 0).then_some(pid)
        }
    }

    pub fn is_pid_focused(pid: u32) -> bool {
        foreground_pid() == Some(pid)
    }

    /// When `pid` itself owns no visible window (e.g. the caller passed a
    /// Chrome renderer/utility pid rather than the pid that actually owns
    /// the browser window), looks up `pid`'s executable name and searches
    /// sibling processes sharing that name for one that does own a visible
    /// window. Returns the sibling's pid and that window's handle.
    fn sibling_with_window(pid: u32) -> Option<(u32, HWND)> {
        use sysinfo::{Pid, System};

        let mut sys = System::new_all();
        sys.refresh_all();

        let name = sys
            .process(Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_lowercase())?;

        let mut siblings: Vec<u32> = sys
            .processes()
            .values()
            .filter(|p| p.name().to_string_lossy().to_lowercase() == name)
            .map(|p| p.pid().as_u32())
            .collect();
        siblings.sort_unstable();

        siblings.into_iter().find_map(|sib_pid| {
            windows_for_pid(sib_pid)
                .first()
                .map(|&hwnd| (sib_pid, hwnd))
        })
    }

    /// Focuses `pid`'s window, or — if `pid` has none — the window of a
    /// sibling process sharing its executable name. Returns the pid that
    /// actually ended up focused, which may differ from the pid passed in.
    /// When `maximize` is true, also maximizes that window (SW_MAXIMIZE)
    /// once it's been restored/focused — used by open_app so a freshly
    /// launched app lands maximized and in the foreground rather than at
    /// whatever default size/position it opened with.
    pub fn focus_pid(pid: u32, maximize: bool) -> Result<u32, String> {
        let windows = windows_for_pid(pid);
        let (focused_pid, hwnd) = if let Some(&hwnd) = windows.first() {
            (pid, hwnd)
        } else if let Some((sib_pid, hwnd)) = sibling_with_window(pid) {
            (sib_pid, hwnd)
        } else {
            return Err(format!(
                "No visible window found for pid {pid}, and no sibling process with the same \
                 executable name owns one either — it may not have a window, or may have exited."
            ));
        };
        unsafe {
            if maximize {
                // SW_MAXIMIZE both restores a minimized window and
                // maximizes it in one call, so this replaces (rather than
                // follows) the plain SW_RESTORE below when requested.
                ShowWindow(hwnd, SW_MAXIMIZE);
            } else if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetForegroundWindow(hwnd) == 0 {
                return Err(
                    "Windows refused the foreground-window request (it can block focus-stealing \
                     from background processes). Try clicking the app manually."
                        .to_string(),
                );
            }
        }
        Ok(focused_pid)
    }

    pub fn close_pid(pid: u32) -> Result<bool, String> {
        let windows = windows_for_pid(pid);
        if windows.is_empty() {
            return Err(format!(
                "No visible window found for pid {pid} — it may not have a window, or may have exited."
            ));
        }
        let mut sent_any = false;
        for hwnd in windows {
            unsafe {
                if PostMessageW(hwnd, WM_CLOSE, 0, 0) != 0 {
                    sent_any = true;
                }
            }
        }
        Ok(sent_any)
    }

    /// Resolves `pid` down to a single target window, same fallback as
    /// `focus_pid`/`close_pid` above (sibling process sharing the same
    /// executable name, when `pid` itself owns no visible window). Shared
    /// by move/resize/minimize/maximize below so that fallback logic lives
    /// in exactly one place.
    fn resolve_window(pid: u32) -> Result<(u32, HWND), String> {
        let windows = windows_for_pid(pid);
        if let Some(&hwnd) = windows.first() {
            return Ok((pid, hwnd));
        }
        if let Some((sib_pid, hwnd)) = sibling_with_window(pid) {
            return Ok((sib_pid, hwnd));
        }
        Err(format!(
            "No visible window found for pid {pid}, and no sibling process with the same \
             executable name owns one either — it may not have a window, or may have exited."
        ))
    }

    /// Moves a window to `(x, y)` in screen coordinates, leaving its size
    /// unchanged (SWP_NOSIZE). Restores the window first if it's currently
    /// minimized or maximized — Windows silently ignores move/resize
    /// requests against a minimized/maximized window otherwise, which
    /// would make this a confusing no-op rather than a clear error.
    pub fn move_window_pid(pid: u32, x: i32, y: i32) -> Result<u32, String> {
        let (target_pid, hwnd) = resolve_window(pid)?;
        unsafe {
            if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE) == 0 {
                return Err("Windows refused to move the window.".to_string());
            }
        }
        Ok(target_pid)
    }

    /// Resizes a window to `width` x `height`, leaving its position
    /// unchanged (SWP_NOMOVE). Restores first, same rationale as
    /// `move_window_pid` above.
    pub fn resize_window_pid(pid: u32, width: i32, height: i32) -> Result<u32, String> {
        let (target_pid, hwnd) = resolve_window(pid)?;
        unsafe {
            if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) == 0 {
                return Err("Windows refused to resize the window.".to_string());
            }
        }
        Ok(target_pid)
    }

    /// Minimizes a window to the taskbar (SW_MINIMIZE). Unlike
    /// move/resize, this deliberately does NOT steal focus — minimizing is
    /// a background-safe operation, not something that should yank the
    /// user's attention the way focus_app intentionally does.
    pub fn minimize_pid(pid: u32) -> Result<u32, String> {
        let (target_pid, hwnd) = resolve_window(pid)?;
        unsafe {
            ShowWindow(hwnd, SW_MINIMIZE);
        }
        Ok(target_pid)
    }

    /// Maximizes a window (SW_MAXIMIZE) to fill the work area of its
    /// current monitor. Does not bring it to the foreground on its own —
    /// callers that also want the window focused should follow up with
    /// focus_app (maximize=true already covers the launch-time case).
    pub fn maximize_pid(pid: u32) -> Result<u32, String> {
        let (target_pid, hwnd) = resolve_window(pid)?;
        unsafe {
            ShowWindow(hwnd, SW_MAXIMIZE);
        }
        Ok(target_pid)
    }
}

// ── focus_app ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn focus_app(pid: Option<u32>, app_name: Option<String>, maximize: Option<bool>) -> CmdResult<u32> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        win::focus_pid(target, maximize.unwrap_or(false))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target, maximize);
        Err("focus_app is only supported on Windows currently.".to_string())
    }
}

// ── close_app ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct CloseAppResult {
    pub pid: u32,
    /// True once a close signal (WM_CLOSE) was successfully posted to at
    /// least one of the app's windows. Doesn't guarantee the app actually
    /// exited — e.g. it may prompt to save unsaved changes first — only
    /// that the graceful-close request was delivered.
    pub closed: bool,
}

#[tauri::command]
pub async fn close_app(pid: Option<u32>, app_name: Option<String>) -> CmdResult<CloseAppResult> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        let closed = win::close_pid(target)?;
        Ok(CloseAppResult {
            pid: target,
            closed,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("close_app is only supported on Windows currently.".to_string())
    }
}

// ── move_window / resize_window / minimize_window / maximize_window ────────────
//
// Backing commands for the agent's move_window / resize_window /
// minimize_window / maximize_window tools (desktopControlTools.ts). Same
// pid/app_name resolution (resolve_pid) and same sibling-window fallback
// as focus_app/close_app above — see window::win::resolve_window.

#[tauri::command]
pub async fn move_window(pid: Option<u32>, app_name: Option<String>, x: i32, y: i32) -> CmdResult<u32> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        win::move_window_pid(target, x, y)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target, x, y);
        Err("move_window is only supported on Windows currently.".to_string())
    }
}

#[tauri::command]
pub async fn resize_window(pid: Option<u32>, app_name: Option<String>, width: i32, height: i32) -> CmdResult<u32> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        win::resize_window_pid(target, width, height)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target, width, height);
        Err("resize_window is only supported on Windows currently.".to_string())
    }
}

#[tauri::command]
pub async fn minimize_window(pid: Option<u32>, app_name: Option<String>) -> CmdResult<u32> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        win::minimize_pid(target)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("minimize_window is only supported on Windows currently.".to_string())
    }
}

#[tauri::command]
pub async fn maximize_window(pid: Option<u32>, app_name: Option<String>) -> CmdResult<u32> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        win::maximize_pid(target)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("maximize_window is only supported on Windows currently.".to_string())
    }
}

/// Resolves the expected app/window and verifies it is the active foreground window.
pub(crate) fn assert_focused_app(pid: Option<u32>, app_name: Option<String>) -> CmdResult<u32> {
    let target = resolve_pid(pid, app_name)?;

    #[cfg(target_os = "windows")]
    {
        if win::is_pid_focused(target) {
            Ok(target)
        } else {
            let focused = win::foreground_pid()
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".to_string());
            Err(format!(
                "Required window is not focused. Expected pid {target}, but foreground pid is {focused}. Use focus_app or ask the user to focus the required window, then take a fresh screenshot before retrying."
            ))
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target;
        Err("Focused-window checks are only supported on Windows currently.".to_string())
    }
}

#[tauri::command]
pub async fn ensure_focused_app(pid: Option<u32>, app_name: Option<String>) -> CmdResult<u32> {
    assert_focused_app(pid, app_name)
}

// ── get_foreground_app ──────────────────────────────────────────────────────
//
// Reports whichever window is currently in the foreground, identified by
// pid and process name. Used by the TS layer (desktopInputGuard.ts) to
// remember "the app the agent is actually looking at" at the moment
// `take_screenshot` is called — i.e. *before* the permission dialog steals
// focus back to the Rachna IDE window for the user to click Approve — so
// later `mouse_click` / `press_key` calls that omit an explicit
// requiredPid/requiredAppName still have something to refocus onto instead
// of silently acting on whatever the IDE itself has focused.

#[derive(serde::Serialize)]
pub struct ForegroundAppInfo {
    pub pid: u32,
    pub name: String,
}

// ── get_self_pid ─────────────────────────────────────────────────────────────
//
// Rachna's own pid, exposed to the TS layer so window-target resolution
// there (services/windowRegistry/matching.ts, resolveTarget.ts) can filter
// Rachna's own window(s) out of candidate lists — the TS-side counterpart
// of resolve_pid's self-pid guard above. Approving a permission dialog
// necessarily brings Rachna to the foreground, which previously made it an
// easy (and wrong) candidate for a subsequent name-based match.

#[tauri::command]
pub async fn get_self_pid() -> CmdResult<u32> {
    Ok(self_pid())
}

#[tauri::command]
pub async fn get_foreground_app() -> CmdResult<ForegroundAppInfo> {
    #[cfg(target_os = "windows")]
    {
        let pid = win::foreground_pid().ok_or_else(|| "No foreground window found.".to_string())?;
        let mut sys = System::new_all();
        sys.refresh_all();
        let name = sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(ForegroundAppInfo { pid, name })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("get_foreground_app is only supported on Windows currently.".to_string())
    }
}