// services/agent/tools/desktopControlTools.ts
//
// Eight focused, single-purpose desktop-control tools — as opposed to the
// broader `desktop_task` dispatcher (desktopTaskTool.ts), which folds several
// related actions behind one `action` enum. These exist so the narrower
// DESKTOP_TASK:apps / DESKTOP_TASK:files / TERMINAL_TASK / BROWSER_TASK /
// WORK_WITH_REPO / BUILD_NEW_PROJECT tool sets (see ToolRegistry.ts) can each
// be handed just the couple of tools they actually need, with a schema and
// description scoped to exactly one job:
//
//   openInOsExplorerTool — open a folder or file directly in Windows Explorer.
//   openFileTool        — open a file with its OS-default application/editor.
//   openAppTool         — launch any installed desktop application by name.
//   focusAppTool        — bring an already-running application to the foreground.
//   closeAppTool        — gracefully close an application (WM_CLOSE, not a kill).
//   listRunningAppsTool — list currently running applications, sourced from
//                          the shared appManager singleton (services/appManager).
//   killProcessTool     — force-terminate a running process.
//   openUrlTool         — open a website in the OS default browser.
//   moveWindowTool      — move a running app's window to a screen position.
//   resizeWindowTool    — resize a running app's window.
//   minimizeWindowTool  — minimize a running app's window to the taskbar.
//   maximizeWindowTool  — maximize a running app's window.
//   listOpenWindowsTool — list open top-level windows, sourced from the same
//                          shared appManager singleton listRunningAppsTool uses.
//
// Windows-only for now (per product scope) — several of the underlying
// Tauri commands (reveal_in_explorer, focus_app, close_app, resolve_app)
// return a clear error on other platforms rather than silently no-op'ing;
// see src-tauri/src/desktop_task.rs and src-tauri/src/window_control.rs.
//
// Safety: openApp, focusApp, closeApp, and killProcess can affect other
// running programs, so — same as run_terminal_command / desktop_task's
// launch_app/kill_process/open_app — they're gated behind the user's
// terminal-permission approval flow (ctx.requestTerminalPermission) before
// the underlying Tauri command is invoked. openInExplorer, openFile,
// listRunningApps, and openUrl are read-only or benign enough to run
// without a prompt.
//
// Part 3 — Window Registry integration: open_app resolves its launch
// through the Installed App Registry (services/appRegistry/openApp.ts,
// unchanged here) and now returns the real pid/hwnd of the window the
// launch actually produced, resolved via the Running Window Registry
// (services/windowRegistry/) — never the launcher's own pid, which isn't
// reliably the window owner (see window_registry.rs's module doc
// comment). focus_app, close_app, and list_running_apps consult the same
// registry (via services/windowRegistry/resolveTarget.ts) to resolve an
// appName argument against real window titles/executables before falling
// back to the existing Rust pid-substring resolution — that Rust-side
// resolution (window_control.rs's resolve_pid + sibling-window search) is
// left completely untouched as the fallback path.

import { invoke } from '@tauri-apps/api/core'
import { resolveWorkspacePath, resolveSystemPath } from '../pathUtils'
import { resolveAndOpenApp, type LegacyAppMatch } from '../../appRegistry/openApp'
import { resolveWindowTarget } from '../../windowRegistry/resolveTarget'
import { appManager, type RunningApp } from '../../appManager/appManager'
import { toolOk, toolErr, toolErrDenied, type AgentTool, type ToolContext } from '../types'
import { isBlockedTerminalTarget, TERMINAL_BLOCK_MESSAGE } from '../terminalSafety'

// ── Shared helpers ────────────────────────────────────────────────────────────

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Resolves a model-supplied path for open_in_explorer / open_file.
 *
 * - When ctx.allowExternalPaths is set (DESKTOP_TASK:files turns), resolves
 *   via resolveSystemPath: absolute OS paths are used as-is, and relative
 *   paths (e.g. "Desktop\\notes.txt") fall back to the OS home directory
 *   instead of requiring a project to be open — this is the fix for
 *   external Desktop/Documents paths failing when no project is open.
 * - Otherwise (ordinary project/coding turns), behavior is unchanged:
 *   resolves against the project root, falling back to the raw value for
 *   anything that isn't workspace-relative (e.g. an absolute path outside
 *   the project, or a URL).
 */
async function resolveTargetPath(raw: string, ctx: ToolContext): Promise<string> {
  if (ctx.allowExternalPaths) {
    const resolved = await resolveSystemPath(raw, ctx.projectRoot)
    return resolved.ok ? resolved.path : raw
  }
  const resolved = resolveWorkspacePath(raw, ctx.projectRoot)
  return resolved.ok ? resolved.path : raw
}

async function requestPermission(
  ctx: ToolContext,
  description: string
): Promise<{ denied: true; message: string } | { denied: false }> {
  if (!ctx.requestTerminalPermission) return { denied: false }
  const decision = await ctx.requestTerminalPermission(description)
  if (decision === 'deny') {
    return {
      denied: true,
      message:
        `Action denied by user: "${description}". The user chose not to allow this.`,
    }
  }
  return { denied: false }
}

// ── open_in_os_explorer ──────────────────────────────────────────────────────

export interface OpenInExplorerArgs {
  /** File or folder path to reveal in Windows Explorer, e.g. "dist/" or "README.md". */
  path: string
}
export interface OpenInExplorerResult {
  path: string
}

export const openInOsExplorerTool: AgentTool<OpenInExplorerArgs, OpenInExplorerResult> = {
  declaration: {
    name: 'open_in_os_explorer',
    description:
      'Opens a folder or file directly in the OS file manager (Windows Explorer on Windows). ' +
      'A folder opens with its contents listed; a file opens its parent folder with the ' +
      'file itself pre-selected/highlighted. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or folder path to reveal in the OS file manager, e.g. "dist/" or "README.md".',
        },
      },
      required: ['path'],
    },
  },
  describeCall: (args) => `Revealing ${args.path ?? '…'} in file manager`,
  execute: async (args, ctx: ToolContext) => {
    const raw = (args.path ?? '').trim()
    if (!raw) return toolErr('path is required for open_in_os_explorer.')
    const target = await resolveTargetPath(raw, ctx)
    try {
      await invoke('reveal_in_explorer', { path: target })
      return toolOk<OpenInExplorerResult>({ path: target })
    } catch (err) {
      return toolErr(`open_in_os_explorer failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── open_file ────────────────────────────────────────────────────────────────

export interface OpenFileArgs {
  /** Path of the file to open with its default application/editor. */
  path: string
}
export interface OpenFileResult {
  path: string
}

export const openFileTool: AgentTool<OpenFileArgs, OpenFileResult> = {
  declaration: {
    name: 'open_file',
    description:
      'Opens a file with its OS default application/editor (e.g. a .docx in Word, a ' +
      '.png in the default image viewer). For folders, use open_in_os_explorer instead.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path of the file to open. For coding/project work: relative to the project ' +
            'root, e.g. "notes.txt" or "assets/logo.png". For a DESKTOP_TASK:files request ' +
            'with no project open: a full absolute OS path (e.g. ' +
            '"C:\\Users\\me\\Desktop\\test.txt") or a path relative to the user\'s home folder ' +
            '(e.g. "Desktop\\RachnaSystemTest\\test.txt") — either resolves correctly with no ' +
            'project open. Paths may contain spaces.',
        },
      },
      required: ['path'],
    },
  },
  describeCall: (args) => `Opening ${args.path ?? '…'}`,
  execute: async (args, ctx: ToolContext) => {
    const raw = (args.path ?? '').trim()
    if (!raw) return toolErr('path is required for open_file.')
    const target = await resolveTargetPath(raw, ctx)
    try {
      await invoke('open_path', { path: target })
      return toolOk<OpenFileResult>({ path: target })
    } catch (err) {
      return toolErr(`open_file failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── open_app ─────────────────────────────────────────────────────────────────

export interface OpenAppArgs {
  /** Friendly application name to search for and launch, e.g. "chrome", "notepad", "vs code". */
  appName: string
}
/** Re-exported for callers that imported the old local name — structurally
 *  identical to (and now literally aliases) LegacyAppMatch from
 *  services/appRegistry/openApp.ts, which is the single source of truth
 *  for this shape now that it carries the Window-Registry-resolved
 *  pid/hwnd as well. */
export type AppMatch = LegacyAppMatch
export type OpenAppResult =
  | { appName: string; launched: AppMatch }
  | { appName: string; matches: AppMatch[] }

export const openAppTool: AgentTool<OpenAppArgs, OpenAppResult> = {
  declaration: {
    name: 'open_app',
    description:
      'Finds and launches an installed desktop application by a friendly name — no ' +
      'install path needed, e.g. "notepad", "vs code". Resolved against Start Menu shortcuts and installed-app registrations.' + 
      'On success, the launched window is also brought to the foreground and maximized where possible.'+ 
      "The result's pid/hwnd reflect the real launched window (resolved via the Running Window Registry),"+
      ' not the launcher process — use that pid with focus_app/close_app before take_screenshot. '+
      'This tools is not to be used for launching web browser, we have special tools for that.',
    parameters: {
      type: 'object',
      properties: {
        appName: {
          type: 'string',
          description: 'Friendly application name to search for and launch, e.g. "paint, excel".',
        },
      },
      required: ['appName'],
    },
  },
  describeCall: (args) => `Finding and opening ${args.appName ?? '…'}`,
  execute: async (args, ctx: ToolContext) => {
    const query = (args.appName ?? '').trim()
    if (!query) return toolErr('appName is required for open_app.')
    if (isBlockedTerminalTarget(query)) return toolErr(TERMINAL_BLOCK_MESSAGE)

    const permission = await requestPermission(ctx, `open_app: ${query}`)
    if (permission.denied) return toolErrDenied(permission.message)

    try {
      // Apply the terminal deny-list to both registry and legacy candidates;
      // a benign-looking alias must never resolve into an OS terminal.
      const resolution = await resolveAndOpenApp(query, isBlockedTerminalTarget)

      switch (resolution.status) {
        case 'not_found':
          return toolErr(`No installed application matching "${query}" was found.`)
        case 'blocked':
          return toolErr(TERMINAL_BLOCK_MESSAGE)
        case 'launched': {
          // Best-effort: bring the freshly launched window to the
          // foreground and maximize it. Deliberately not allowed to fail
          // the whole open_app call — the app already launched
          // successfully, so a focus/maximize hiccup (e.g. the launched
          // app takes a moment longer to create its window than the
          // Running Window Registry poll waited for, so resolution.match
          // has no pid yet) should surface as a launched-but-not-focused
          // result, not an open_app error.
          if (resolution.match.pid !== undefined) {
            try {
              await focusAppWindow({ pid: resolution.match.pid }, true)
            } catch (err) {
              console.warn(`[open_app] launched "${query}" but failed to focus/maximize it:`, err)
            }
          }
          return toolOk<OpenAppResult>({ appName: query, launched: resolution.match })
        }
        case 'ambiguous':
          // Ambiguous — surface candidates rather than guessing which one the user meant.
          return toolOk<OpenAppResult>({ appName: query, matches: resolution.matches })
      }
    } catch (err) {
      return toolErr(`open_app failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── focus_app ────────────────────────────────────────────────────────────────

export interface FocusAppArgs {
  /** Process id of the running app to focus. Preferred over appName when known. */
  pid?: number
  /** Case-insensitive substring to match against running process names, e.g. "chrome". */
  appName?: string
}
export interface FocusAppResult {
  pid: number
}

/**
 * Shared by focusAppTool below and openAppTool's post-launch focus step.
 * `maximize` isn't exposed on the focus_app tool's own declaration/schema
 * (the model has never been able to request it, and focus_app's job is
 * just "bring to foreground" — forcing a resize on every focus_app call
 * would be a behavior change nobody asked for) — it's only ever passed
 * `true` internally, right after open_app successfully launches something.
 */
async function focusAppWindow(
  target: { pid?: number; appName?: string },
  maximize: boolean,
): Promise<{ pid: number }> {
  const resolution = await resolveWindowTarget(target.pid, target.appName?.trim())
  const targetPid = resolution.kind === 'resolved' ? resolution.pid : target.pid ?? null
  const targetAppName = resolution.kind === 'resolved' ? null : target.appName?.trim() || null

  const pid = await invoke<number>('focus_app', {
    pid: targetPid,
    appName: targetAppName,
    maximize,
  })
  return { pid }
}

export const focusAppTool: AgentTool<FocusAppArgs, FocusAppResult> = {
  declaration: {
    name: 'focus_app',
    description:
      'Brings an already-running application to the foreground, restoring it first if ' +
      "it's minimized. Identify the app by pid (preferred) or by a case-insensitive " +
      'name substring. If the target pid owns no visible window, falls back to a sibling ' +
      'process with the same executable name that does (e.g. a Chrome renderer pid falls ' +
      "back to the chrome.exe pid that owns the browser window) — the result's pid reflects " +
      'whichever process was actually focused, which may differ from the pid requested. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id of the app to focus.' },
        appName: {
          type: 'string',
          description: 'Case-insensitive substring to match against running process names, e.g. "chrome".',
        },
      },
    },
  },
  describeCall: (args) => `Focusing ${args.appName ?? (args.pid !== undefined ? `pid ${args.pid}` : '…')}`,
  execute: async (args) => {
    if (args.pid === undefined && !args.appName?.trim()) {
      return toolErr('Either pid or appName is required for focus_app.')
    }
    try {
      // Window-Registry-first: for an appName query, this ranks against
      // real window titles/executables (not just a process-name
      // substring), so e.g. "calculator" reliably finds the packaged
      // Calculator app's actual window. Falls through to the existing
      // Rust pid resolution (including its sibling-window fallback)
      // whenever the registry can't produce a confident match — an
      // explicit pid that owns no window, per the registry, is exactly
      // that case, since window_control.rs's own sibling search already
      // handles it correctly.
      const result = await focusAppWindow({ pid: args.pid, appName: args.appName }, false)
      return toolOk<FocusAppResult>(result)
    } catch (err) {
      return toolErr(`focus_app failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── close_app ────────────────────────────────────────────────────────────────

export interface CloseAppArgs {
  /** Process id of the running app to close. Preferred over appName when known. */
  pid?: number
  /** Case-insensitive substring to match against running process names, e.g. "notepad". */
  appName?: string
}
export interface CloseAppResult {
  pid: number
  closed: boolean
}

export const closeAppTool: AgentTool<CloseAppArgs, CloseAppResult> = {
  declaration: {
    name: 'close_app',
    description:
      'Gracefully closes an application by asking its window(s) to close (the same ' +
      "signal sent by clicking the window's own close button) — the app may prompt to " +
      'save unsaved changes first. For an unresponsive app that ignores this, use ' +
      'kill_process instead. Identify the app by pid (preferred) or a name substring. ' +
      'Requires user approval. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id of the app to close.' },
        appName: {
          type: 'string',
          description: 'Case-insensitive substring to match against running process names, e.g. "notepad".',
        },
      },
    },
  },
  describeCall: (args) => `Closing ${args.appName ?? (args.pid !== undefined ? `pid ${args.pid}` : '…')}`,
  execute: async (args, ctx: ToolContext) => {
    if (args.pid === undefined && !args.appName?.trim()) {
      return toolErr('Either pid or appName is required for close_app.')
    }
    const label = args.appName ?? `pid ${args.pid}`
    const permission = await requestPermission(ctx, `close_app: ${label}`)
    if (permission.denied) return toolErrDenied(permission.message)

    try {
      // Same Window-Registry-first resolution as focus_app above, for the
      // same reason — a registry-confident appName match closes the right
      // window even when several processes share a similar name; anything
      // it can't confidently resolve falls straight through to the
      // existing Rust resolve_pid + close_pid path unchanged.
      const resolution = await resolveWindowTarget(args.pid, args.appName?.trim())
      const targetPid = resolution.kind === 'resolved' ? resolution.pid : args.pid ?? null
      const targetAppName = resolution.kind === 'resolved' ? null : args.appName?.trim() || null

      const result = await invoke<CloseAppResult>('close_app', {
        pid: targetPid,
        appName: targetAppName,
      })
      return toolOk<CloseAppResult>(result)
    } catch (err) {
      return toolErr(`close_app failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── shared window-target resolution for move/resize/minimize/maximize ─────────
//
// Same Window-Registry-first resolution as focus_app/close_app above: an
// appName query is ranked against real window titles/executables first,
// falling through to the existing Rust pid-substring + sibling-window
// resolution whenever the registry can't produce a confident match.

async function resolveWindowPidArgs(
  pid: number | undefined,
  appName: string | undefined
): Promise<{ pid?: number; appName?: string }> {
  const resolution = await resolveWindowTarget(pid, appName?.trim())
  return resolution.kind === 'resolved'
    ? { pid: resolution.pid }
    : { appName: appName?.trim() || undefined, pid }
}

// ── move_window ──────────────────────────────────────────────────────────────

export interface MoveWindowArgs {
  /** Process id of the app whose window to move. Preferred over appName when known. */
  pid?: number
  /** Case-insensitive substring to match against running process names, e.g. "notepad". */
  appName?: string
  /** New X position (screen coordinates, pixels). */
  x: number
  /** New Y position (screen coordinates, pixels). */
  y: number
}
export interface MoveWindowResult {
  pid: number
  x: number
  y: number
}

export const moveWindowTool: AgentTool<MoveWindowArgs, MoveWindowResult> = {
  declaration: {
    name: 'move_window',
    description:
      "Moves a running application's window to a new screen position, leaving its size " +
      'unchanged. Restores the window first if it is minimized or maximized. Identify the ' +
      'app by pid (preferred) or a name substring. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id of the app whose window to move.' },
        appName: {
          type: 'string',
          description: 'Case-insensitive substring to match against running process names, e.g. "notepad".',
        },
        x: { type: 'number', description: 'New X position in screen coordinates (pixels).' },
        y: { type: 'number', description: 'New Y position in screen coordinates (pixels).' },
      },
      required: ['x', 'y'],
    },
  },
  describeCall: (args) =>
    `Moving ${args.appName ?? (args.pid !== undefined ? `pid ${args.pid}` : 'window')} to (${args.x}, ${args.y})…`,
  execute: async (args) => {
    if (args.pid === undefined && !args.appName?.trim()) {
      return toolErr('Either pid or appName is required for move_window.')
    }
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      return toolErr('x and y are required for move_window.')
    }
    try {
      const target = await resolveWindowPidArgs(args.pid, args.appName)
      const pid = await invoke<number>('move_window', { pid: target.pid, appName: target.appName, x: args.x, y: args.y })
      return toolOk<MoveWindowResult>({ pid, x: args.x, y: args.y })
    } catch (err) {
      return toolErr(`move_window failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── resize_window ────────────────────────────────────────────────────────────

export interface ResizeWindowArgs {
  /** Process id of the app whose window to resize. Preferred over appName when known. */
  pid?: number
  /** Case-insensitive substring to match against running process names, e.g. "notepad". */
  appName?: string
  /** New width in pixels. */
  width: number
  /** New height in pixels. */
  height: number
}
export interface ResizeWindowResult {
  pid: number
  width: number
  height: number
}

export const resizeWindowTool: AgentTool<ResizeWindowArgs, ResizeWindowResult> = {
  declaration: {
    name: 'resize_window',
    description:
      "Resizes a running application's window, leaving its position unchanged. Restores " +
      'the window first if it is minimized or maximized. Identify the app by pid ' +
      '(preferred) or a name substring. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id of the app whose window to resize.' },
        appName: {
          type: 'string',
          description: 'Case-insensitive substring to match against running process names, e.g. "notepad".',
        },
        width: { type: 'number', description: 'New window width in pixels.' },
        height: { type: 'number', description: 'New window height in pixels.' },
      },
      required: ['width', 'height'],
    },
  },
  describeCall: (args) =>
    `Resizing ${args.appName ?? (args.pid !== undefined ? `pid ${args.pid}` : 'window')} to ${args.width}×${args.height}…`,
  execute: async (args) => {
    if (args.pid === undefined && !args.appName?.trim()) {
      return toolErr('Either pid or appName is required for resize_window.')
    }
    if (typeof args.width !== 'number' || typeof args.height !== 'number') {
      return toolErr('width and height are required for resize_window.')
    }
    try {
      const target = await resolveWindowPidArgs(args.pid, args.appName)
      const pid = await invoke<number>('resize_window', {
        pid: target.pid,
        appName: target.appName,
        width: args.width,
        height: args.height,
      })
      return toolOk<ResizeWindowResult>({ pid, width: args.width, height: args.height })
    } catch (err) {
      return toolErr(`resize_window failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── minimize_window ──────────────────────────────────────────────────────────

export interface MinimizeWindowArgs {
  /** Process id of the app whose window to minimize. Preferred over appName when known. */
  pid?: number
  /** Case-insensitive substring to match against running process names, e.g. "notepad". */
  appName?: string
}
export interface MinimizeWindowResult {
  pid: number
}

export const minimizeWindowTool: AgentTool<MinimizeWindowArgs, MinimizeWindowResult> = {
  declaration: {
    name: 'minimize_window',
    description:
      "Minimizes a running application's window to the taskbar. Does not steal focus. " +
      'Identify the app by pid (preferred) or a name substring. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id of the app whose window to minimize.' },
        appName: {
          type: 'string',
          description: 'Case-insensitive substring to match against running process names, e.g. "notepad".',
        },
      },
    },
  },
  describeCall: (args) => `Minimizing ${args.appName ?? (args.pid !== undefined ? `pid ${args.pid}` : 'window')}…`,
  execute: async (args) => {
    if (args.pid === undefined && !args.appName?.trim()) {
      return toolErr('Either pid or appName is required for minimize_window.')
    }
    try {
      const target = await resolveWindowPidArgs(args.pid, args.appName)
      const pid = await invoke<number>('minimize_window', { pid: target.pid, appName: target.appName })
      return toolOk<MinimizeWindowResult>({ pid })
    } catch (err) {
      return toolErr(`minimize_window failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── maximize_window ──────────────────────────────────────────────────────────

export interface MaximizeWindowArgs {
  /** Process id of the app whose window to maximize. Preferred over appName when known. */
  pid?: number
  /** Case-insensitive substring to match against running process names, e.g. "notepad". */
  appName?: string
}
export interface MaximizeWindowResult {
  pid: number
}

export const maximizeWindowTool: AgentTool<MaximizeWindowArgs, MaximizeWindowResult> = {
  declaration: {
    name: 'maximize_window',
    description:
      "Maximizes a running application's window to fill its current monitor. Does not " +
      'bring it to the foreground on its own — use focus_app afterward if it also needs ' +
      'to become the active window. Identify the app by pid (preferred) or a name ' +
      'substring. Windows only.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id of the app whose window to maximize.' },
        appName: {
          type: 'string',
          description: 'Case-insensitive substring to match against running process names, e.g. "notepad".',
        },
      },
    },
  },
  describeCall: (args) => `Maximizing ${args.appName ?? (args.pid !== undefined ? `pid ${args.pid}` : 'window')}…`,
  execute: async (args) => {
    if (args.pid === undefined && !args.appName?.trim()) {
      return toolErr('Either pid or appName is required for maximize_window.')
    }
    try {
      const target = await resolveWindowPidArgs(args.pid, args.appName)
      const pid = await invoke<number>('maximize_window', { pid: target.pid, appName: target.appName })
      return toolOk<MaximizeWindowResult>({ pid })
    } catch (err) {
      return toolErr(`maximize_window failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── list_open_windows ────────────────────────────────────────────────────────
//
// Per product direction: reuses the same shared appManager singleton
// list_running_apps already reads through (services/appManager), rather
// than adding a second independent scan — appManager.getAll() already
// carries a `windows` field (every top-level HWND owned by that pid), so
// this just flattens that per-app data down to one entry per window
// instead of one entry per app, which is the granularity move_window /
// resize_window / minimize_window / maximize_window actually act on.

export interface OpenWindowInfo {
  pid: number
  exeName: string
  hwnd: number
  /** Only populated for the app's representative window (appManager doesn't
   *  track a title per-hwnd for multi-window apps — see appManager.ts). */
  title?: string
  isFocused: boolean
}
export type ListOpenWindowsArgs = Record<string, never>
export type ListOpenWindowsResult = OpenWindowInfo[]

export const listOpenWindowsTool: AgentTool<ListOpenWindowsArgs, ListOpenWindowsResult> = {
  declaration: {
    name: 'list_open_windows',
    description:
      'Returns every currently open top-level window (pid, exeName, hwnd, title when ' +
      'known, isFocused), one entry per window rather than one per app — useful before ' +
      'move_window/resize_window/minimize_window/maximize_window when an app owns more ' +
      'than one window. Returns an empty array when nothing is open — never an error just ' +
      'because the list is empty. Backed by the same shared app-manager cache as ' +
      'list_running_apps, refreshed against the live OS state before every call.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  describeCall: () => 'Listing open windows',
  execute: async () => {
    try {
      await appManager.refresh()
      const apps = appManager.getAll()
      const windows: OpenWindowInfo[] = []
      for (const app of apps) {
        if (!app.isVisible) continue
        const hwnds = app.windows.length > 0 ? app.windows : (app.hwnd !== undefined ? [app.hwnd] : [])
        for (const hwnd of hwnds) {
          windows.push({
            pid: app.pid,
            exeName: app.exeName,
            hwnd,
            title: hwnd === app.hwnd ? app.title : undefined,
            isFocused: app.isFocused && hwnd === app.hwnd,
          })
        }
      }
      return toolOk<ListOpenWindowsResult>(windows)
    } catch (err) {
      return toolErr(`list_open_windows failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── list_running_apps ────────────────────────────────────────────────────────
//
// Backed entirely by the appManager singleton (services/appManager) — the
// same cache the rest of the app reads from — rather than talking to Tauri
// or the Running Window Registry directly. appManager.refresh() re-polls the
// OS and repopulates its internal pid → RunningApp map; getAll() then just
// snapshots that map. No caching or process-tracking logic is duplicated
// here — refresh()/getAll() are the single source of truth for "what apps
// are running right now" everywhere else in the app too.

export type ListRunningAppsArgs = Record<string, never>
export type ListRunningAppsResult = RunningApp[]

export const listRunningAppsTool: AgentTool<ListRunningAppsArgs, ListRunningAppsResult> = {
  declaration: {
    name: 'list_running_apps',
    description:
      'Returns all currently running applications, each with its pid, exeName, exePath, ' +
      'hwnd, title, isVisible, isFocused, and windows. Returns an empty array when nothing ' +
      'is running — never an error just because the list is empty. Backed by the shared ' +
      'app-manager cache, refreshed against the live OS state before every call.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  describeCall: () => 'Listing running apps',
  execute: async () => {
    try {
      // Always re-poll before reading — getAll() alone would just return
      // whatever was cached from the last refresh anywhere else in the app.
      await appManager.refresh()
      const apps = appManager.getAll()
      // appManager.getAll() already returns [] when nothing is tracked, so
      // there's nothing further to special-case for the empty case.
      return toolOk<ListRunningAppsResult>(apps)
    } catch (err) {
      return toolErr(`list_running_apps failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── kill_process ─────────────────────────────────────────────────────────────

export interface KillProcessArgs {
  /** Process id to terminate. */
  pid: number
}
export interface KillProcessResult {
  pid: number
  killed: boolean
}

export const killProcessTool: AgentTool<KillProcessArgs, KillProcessResult> = {
  declaration: {
    name: 'kill_process',
    description:
      'Force-terminates a running process by pid. Prefer close_app for a graceful ' +
      "shutdown when possible — kill_process doesn't give the app a chance to save " +
      'unsaved work. Requires user approval.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'The process id (pid) to terminate.' },
      },
      required: ['pid'],
    },
  },
  describeCall: (args) => `Terminating process ${args.pid ?? '…'}`,
  execute: async (args, ctx: ToolContext) => {
    if (typeof args.pid !== 'number' || !Number.isFinite(args.pid)) {
      return toolErr('pid is required for kill_process.')
    }
    const permission = await requestPermission(ctx, `kill_process: pid ${args.pid}`)
    if (permission.denied) return toolErrDenied(permission.message)

    try {
      const killed = await invoke<boolean>('kill_process', { pid: args.pid })
      return toolOk<KillProcessResult>({ pid: args.pid, killed })
    } catch (err) {
      return toolErr(`kill_process failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── open_url ─────────────────────────────────────────────────────────────────

export interface OpenUrlArgs {
  /** The URL to open, e.g. "https://example.com". */
  url: string
}
export interface OpenUrlResult {
  url: string
}

export const openUrlTool: AgentTool<OpenUrlArgs, OpenUrlResult> = {
  declaration: {
    name: 'open_url',
    description: 'Opens a website in the OS default browser.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open, e.g. "https://example.com".' },
      },
      required: ['url'],
    },
  },
  describeCall: (args) => `Opening ${args.url ?? '…'}`,
  execute: async (args) => {
    const raw = (args.url ?? '').trim()
    if (!raw) return toolErr('url is required for open_url.')
    // Default to https:// when the model passes a bare domain — open::that
    // would otherwise hand a schema-less string straight to the OS, which
    // on Windows can fail to resolve as a web address.
    const url = URL_RE.test(raw) ? raw : `https://${raw}`
    try {
      await invoke('open_path', { path: url })
      return toolOk<OpenUrlResult>({ url })
    } catch (err) {
      return toolErr(`open_url failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}


// ── open_project_folder ──────────────────────────────────────────────────────
//
// DESKTOP_TASK:files — opens an existing folder as the current workspace in
// Rachna AI Studio, exactly as if the user had chosen File → Open Folder.
//
// If `path` is provided the folder is opened directly (after validating it
// exists); if it is omitted, a native folder-picker dialog is shown first.
//
// The lifecycle is:
//   1. Prompt for a path (if none was given).
//   2. Close the currently-open workspace (if any).
//   3. Index/load the selected folder as the new project root.
//   4. Wait until repository indexing is complete (status === 'ready') before
//      resolving — the agent MUST NOT continue execution until the workspace
//      is fully loaded, because subsequent steps may need the index.
//   5. Return the canonical project root so the agent can update its context.
//
// The actual folder-closing + indexing + waiting is handled by the
// `ctx.openProjectFolder` callback, wired at the useChat level (the
// IDELayout-owned operations that own the project lifecycle).

export interface OpenProjectFolderArgs {
  /**
   * Absolute path to the folder to open as the new workspace, e.g.
   * "C:\\Users\\me\\repos\\my-app". When omitted, a native folder-picker
   * dialog is shown so the user can select the folder interactively.
   */
  path?: string
}
export interface OpenProjectFolderResult {
  /** The canonical project root that was loaded. */
  projectRoot: string
}

export const openProjectFolderTool: AgentTool<OpenProjectFolderArgs, OpenProjectFolderResult> = {
  declaration: {
    name: 'open_project_folder',
    description:
      'Opens an existing folder as the current workspace in Rachna AI Studio (equivalent ' +
      'to File → Open Folder). The current workspace is unloaded first, the selected ' +
      'folder is loaded as the new project, repository indexing is restarted, terminal ' +
      'sessions are initialized for the new workspace, and the chat context is updated to ' +
      'reference the new project. When `path` is supplied the folder is opened directly; ' +
      'when omitted a native folder-picker dialog is shown. The agent MUST wait for this ' +
      'tool to return before continuing — it resolves only once the workspace is fully ' +
      'loaded and the repository index is ready.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute path to the folder to open, e.g. "C:\\Users\\me\\repos\\my-app". ' +
            'Omit to show a native folder-picker dialog.',
        },
      },
      required: [],
    },
  },
  describeCall: (args) =>
    args.path ? `Opening project folder ${args.path}` : 'Selecting project folder…',
  execute: async (args, ctx: ToolContext) => {
    if (!ctx.openProjectFolder) {
      return toolErr(
        'open_project_folder is not available in this context. ' +
        'The tool is only usable in a DESKTOP_TASK:files turn inside Rachna AI Studio.'
      )
    }
    const raw = (args.path ?? '').trim()
    const path = raw || null
    try {
      const root = await ctx.openProjectFolder(path)
      if (!root) {
        return toolErr(
          'No folder was selected — the project was not changed. ' +
          'Either the user cancelled the picker or the supplied path was invalid.'
        )
      }
      return toolOk<OpenProjectFolderResult>({ projectRoot: root })
    } catch (err) {
      return toolErr(
        `open_project_folder failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  },
}
