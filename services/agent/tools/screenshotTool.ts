// services/agent/tools/screenshotTool.ts
//
// Tool: take_screenshot
//
// Captures the current screen content and saves it as a PNG file, so the
// agent can "see" what's actually on screen before driving it further (see
// mouse_click / press key tools in inputControlTools.ts). Backed by the
// Tauri `take_screenshot` command (src-tauri/src/desktop_task.rs), which
// uses the `xcap` crate for cross-platform capture.
//
// Self-capture note: the Rust command hides Rachna AI Studio's own
// window(s) immediately before grabbing pixels and restores them right
// after, so the IDE itself is never included in the resulting image —
// even though approving the permission dialog below brings this window to
// the foreground just before the capture happens.
//
// Security: a screenshot can expose whatever happens to be on screen at
// that moment — passwords being typed, private messages, unrelated
// windows, etc. — so, exactly like run_terminal_command, EVERY call is
// gated behind ctx.requestTerminalPermission and requires explicit user
// approval before it runs. There is no read-only/benign carve-out here.
//
// Workflow note: a successful capture also "arms" the desktop-input guard
// (see desktopInputGuard.ts) — mouse_click and press_key both refuse to
// run until a recent-enough screenshot has been taken, so the agent can't
// blindly click or type without having just looked at the screen.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, toolErrDenied, type AgentTool, type ToolContext } from '../types'
import { recordScreenshot, type DesktopTargetApp } from '../desktopInputGuard'
import { resolveWindowTarget } from '../../windowRegistry/resolveTarget'
import { withOrbView } from '../desktopViewModeGuard'

interface ForegroundAppInfo {
  pid: number
  name: string
}

export interface TakeScreenshotArgs {
  /**
   * Which monitor to capture, by index into the system's monitor list
   * (0 = first/primary monitor on most systems). Omit to capture the
   * first monitor.
   */
  monitorIndex?: number
  /** Optional app pid to focus before capture, after screenshot approval. */
  focusPid?: number
  /** Optional app/process name to focus before capture, after screenshot approval. */
  focusAppName?: string
}

export interface TakeScreenshotResult {
  /** Absolute path to the saved PNG file on disk. */
  path: string
  width: number
  height: number
  /** Human-readable name/label of the captured monitor. */
  monitor: string
  monitorIndex: number
  /** Total number of monitors detected on this system. */
  monitorCount: number
}

interface TauriScreenshotResult {
  path: string
  width: number
  height: number
  monitor: string
  monitor_index: number
  monitor_count: number
}

export const takeScreenshotTool: AgentTool<TakeScreenshotArgs, TakeScreenshotResult> = {
  declaration: {
    name: 'take_screenshot',
    description:
      'Captures the current screen and saves it as a PNG file — use this to see what is ' +
      'actually on screen before performing a mouse_click or press_key action, since both of ' +
      'those refuse to run without a recent screenshot first. The user is prompted to approve ' +
      'every screenshot before it is taken (same as run_terminal_command) — there is no ' +
      '"remember" carve-out that skips this for later calls in unrelated contexts. Returns the ' +
      'file path and dimensions; open/read the file to inspect its contents.',
    parameters: {
      type: 'object',
      properties: {
        monitorIndex: {
          type: 'number',
          description:
            'Which monitor to capture, by index (0 = first/primary monitor). Omit to capture ' +
            'the first monitor. If a previous call reported monitorCount > 1, pass a higher ' +
            'index to capture a different monitor.',
        },
        focusPid: {
          type: 'number',
          description:
            'Optional process id to bring to the foreground before capture. Focus happens only after screenshot approval unless that app is already focused.',
        },
        focusAppName: {
          type: 'string',
          description:
            'Optional app/process name substring to bring to the foreground before capture. Focus happens only after screenshot approval unless that app is already focused.',
        },
      },
    },
  },

  describeCall: (args) =>
    typeof args.monitorIndex === 'number'
      ? `Taking a screenshot of monitor ${args.monitorIndex}`
      : 'Taking a screenshot',

  execute: async (args, ctx: ToolContext) => {
    const hasFocusTarget =
      typeof args.focusPid === 'number' ||
      (typeof args.focusAppName === 'string' && args.focusAppName.trim().length > 0)

    try {
      // Snapshot whatever's currently in the foreground *before* the
      // permission dialog appears — once the user clicks Approve inside the
      // Rachna IDE window, the IDE becomes the foreground app, so this is
      // the only reliable moment to learn what the agent actually meant to
      // capture/operate on when no explicit focus target was given.
      let inferredTarget: ForegroundAppInfo | null = null
      if (!hasFocusTarget) {
        try {
          inferredTarget = await invoke<ForegroundAppInfo>('get_foreground_app')
        } catch {
          // Best-effort only (e.g. non-Windows, or no foreground window) — a
          // missing inferred target just means later clicks need their own
          // explicit requiredPid/requiredAppName.
        }
      }

      const focusLabel = args.focusPid ?? args.focusAppName
      const focusDescription = hasFocusTarget && focusLabel ? ` after focusing ${focusLabel}` : ''
      const description =
        typeof args.monitorIndex === 'number'
          ? `take_screenshot: monitor ${args.monitorIndex}${focusDescription}`
          : `take_screenshot${focusDescription}`

      // ── Permission gate — every single call, no exceptions, no "remember" ──
      if (ctx.requestTerminalPermission) {
        const decision = await ctx.requestTerminalPermission(description)
        if (decision === 'deny') {
          return toolErrDenied(
            `Screenshot denied by user. The user chose not to allow this.`
          )
        }
      }

      // Shrink Rachna down to the orb for the duration of the refocus +
      // actual capture — must run AFTER the permission dialog above (which
      // needs the full/chat UI to render Approve/Deny) and covers both the
      // refocus call and take_screenshot itself, since both need the
      // target app's real window unobstructed. See desktopViewModeGuard.ts.
      const raw = await withOrbView(async () => {
        // Always (re)focus the target right before capturing — approving the
        // dialog above just brought the Rachna IDE window to the foreground,
        // so an explicit focus target must be re-asserted here unconditionally
        // rather than only when a pre-check happened to fail.
        if (hasFocusTarget) {
          // Same Window-Registry-first resolution focus_app/close_app use
          // (services/windowRegistry/resolveTarget.ts) — reused rather than
          // duplicated here — so a packaged app's real window is found by
          // title/exe, not just a process-name substring, before falling
          // back to the existing Rust pid resolution.
          const resolution = await resolveWindowTarget(args.focusPid, args.focusAppName)
          const focusPid = resolution.kind === 'resolved' ? resolution.pid : args.focusPid ?? null
          const focusAppName = resolution.kind === 'resolved' ? null : args.focusAppName ?? null
          await invoke('focus_app', { pid: focusPid, appName: focusAppName })
        }

        return invoke<TauriScreenshotResult>('take_screenshot', {
          monitorIndex: args.monitorIndex,
        })
      })

      // Arms the guard that mouse_click / press_key check before running,
      // and remembers the target app (explicit or inferred) so those calls
      // can refocus it even if they omit requiredPid/requiredAppName —
      // see desktopInputGuard.ts.
      const target: DesktopTargetApp | undefined = hasFocusTarget
        ? { pid: args.focusPid, appName: args.focusAppName }
        : inferredTarget
          ? { pid: inferredTarget.pid, appName: inferredTarget.name }
          : undefined
      recordScreenshot(target)

      return toolOk<TakeScreenshotResult>({
        path: raw.path,
        width: raw.width,
        height: raw.height,
        monitor: raw.monitor,
        monitorIndex: raw.monitor_index,
        monitorCount: raw.monitor_count,
      })
    } catch (err) {
      return toolErr(`take_screenshot failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}
