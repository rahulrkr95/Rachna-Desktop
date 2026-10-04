// services/agent/tools/inputControlTools.ts
//
// Tools: mouse_click, press_key, press_key_sequence, type_link_in_browser
//
// Simulates real mouse clicks and keyboard input via the Tauri
// `mouse_click` / `press_key` commands (src-tauri/src/input_control.rs,
// backed by the `enigo` crate).
//
// Safety, in three layers:
//   1. Permission gate — exactly like run_terminal_command / take_screenshot,
//      EVERY call requires explicit user approval via
//      ctx.requestTerminalPermission before anything is simulated.
//   2. Screenshot-first guard — driving the mouse/keyboard without having
//      just seen the screen is how an agent clicks the wrong thing or types
//      into the wrong field. Both tools call
//      desktopInputGuard.checkScreenshotPermit() first and refuse to run
//      (without even prompting for permission) unless a recent
//      take_screenshot call has "armed" the guard — see
//      desktopInputGuard.ts and screenshotTool.ts.
//   3. Mouse-position verification — for mouse_click and mouse_drag_path,
//      the native side moves the cursor to the target, reads the OS cursor
//      position back, and compares it against the target within a small
//      configurable tolerance (default 3px, Settings > Actions) before
//      clicking/dragging at all — retrying the move a bounded number of
//      times and returning a clear failure instead of clicking blindly if
//      it never lands within tolerance. This check is local and
//      deterministic (a coordinate comparison), not a model call — see
//      move_and_verify_position in src-tauri/src/input_control.rs and
//      store/useMousePositionToleranceStore.ts.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, toolErrDenied, type AgentTool, type ToolContext } from '../types'
import { checkScreenshotPermit, getTargetApp } from '../desktopInputGuard'
import { useInputActionOverlayStore } from '../../../store/useInputActionOverlayStore'
import { getInputActionDelayMs } from '../../../store/useInputActionDelayStore'
import { getMousePositionTolerancePx } from '../../../store/useMousePositionToleranceStore'
import { sampleParametricPath } from '../../../lib/mathExprEval'
import { resolveWindowTarget } from '../../windowRegistry/resolveTarget'
import { withOrbView } from '../desktopViewModeGuard'

// ── visual feedback + input-block helpers ───────────────────────────────────
//
// Pure presentation, wired into every execute() below right after
// permission + refocus succeed and right before the real native call —
// never before approval (so the permission dialog itself stays usable) and
// always undone in a `finally` (so a failed/thrown call can't leave the
// user's input blocked). See store/useInputActionOverlayStore.ts and
// components/InputActionOverlay.tsx — none of this feeds back into what
// the tools actually do.
//
// Between the cue appearing and the real click/keystroke firing, every
// tool also awaits waitForVisualCue() — a small user-configurable pause
// (default 1000ms, Settings > Actions) so the cue actually has time to be
// seen instead of the real input landing the instant it appears. See
// store/useInputActionDelayStore.ts.
const overlay = () => useInputActionOverlayStore.getState()

/** Runs `fn` with the overlay's input-block flag set, always clearing it
 *  afterward regardless of success/failure/throw. */
async function withInputBlocked<T>(fn: () => Promise<T>): Promise<T> {
  overlay().setBlocking(true)
  try {
    return await fn()
  } finally {
    overlay().setBlocking(false)
  }
}

/** Waits for the user-configurable "visual cue delay" (Settings > Actions,
 *  see store/useInputActionDelayStore.ts) — the gap between the overlay
 *  cue becoming visible (the ring/dot/key-bar) and the real click/keystroke
 *  actually firing. Defaults to 1000ms; 0 disables the wait entirely.
 *  Always called AFTER overlay().showX(...) and BEFORE the native
 *  invoke() call, never before permission/refocus. */
async function waitForVisualCue(): Promise<void> {
  const ms = getInputActionDelayMs()
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

interface FocusTargetArgs {
  requiredPid?: number
  requiredAppName?: string
}

/**
 * Resolves an explicit requiredPid/requiredAppName, falling back to the app
 * captured at take_screenshot time (see desktopInputGuard.ts) when the call
 * itself doesn't name a target. Returns null when there's nothing to focus.
 *
 * Re-resolves through the Window Registry (resolveWindowTarget) at
 * click-time rather than trusting the pid/appName verbatim — the set of
 * running windows/pids can change between when the screenshot was taken
 * (or when the model decided on a requiredPid) and when this click
 * actually fires, and resolveWindowTarget also filters out Rachna's own
 * window (see windowRegistry/selfPid.ts) so a stale or ambiguous cached
 * target can't resolve back onto the agent itself. Falls back to the raw
 * pid/appName unchanged when the registry has no confident match, rather
 * than failing outright — the existing Rust-side resolve_pid/sibling-
 * window fallback still gets a chance to resolve it.
 */
async function resolveFocusTarget(args: FocusTargetArgs): Promise<{ pid?: number; appName?: string } | null> {
  let raw: { pid?: number; appName?: string } | null = null
  if (typeof args.requiredPid === 'number') {
    raw = { pid: args.requiredPid }
  } else if (typeof args.requiredAppName === 'string' && args.requiredAppName.trim()) {
    raw = { appName: args.requiredAppName }
  } else {
    const remembered = getTargetApp()
    if (remembered && (typeof remembered.pid === 'number' || remembered.appName?.trim())) {
      raw = { pid: remembered.pid, appName: remembered.appName }
    }
  }
  if (!raw) return null

  const resolution = await resolveWindowTarget(raw.pid, raw.appName)
  if (resolution.kind === 'resolved') {
    return { pid: resolution.pid }
  }
  // Ambiguous or unresolved (or the registry scan itself failed) — fall
  // through to the raw target as originally given, unchanged.
  return raw
}

function isRequiredFocusError(err: unknown): boolean {
  return String(err instanceof Error ? err.message : err).includes('Required window is not focused')
}

const FOCUS_POLL_INTERVAL_MS = 50
const FOCUS_POLL_TIMEOUT_MS = 800

interface ForegroundAppInfo {
  pid: number
  name: string
}

/**
 * Polls get_foreground_app every ~50ms (up to FOCUS_POLL_TIMEOUT_MS) until
 * it actually reports `pid` as focused. focus_app's promise resolving does
 * NOT mean the OS has actually finished switching foreground windows by
 * the time it returns — firing the native mouse/key call immediately after
 * a blind `await invoke('focus_app', ...)` raced that switch and was a
 * source of clicks/keys landing on the wrong (previously-focused) window.
 * Best-effort: gives up silently after the timeout rather than erroring,
 * since assert_focused_app on the Rust side still catches a genuine
 * mismatch and the caller's existing isRequiredFocusError retry handles it.
 */
async function pollForFocus(pid: number): Promise<void> {
  const deadline = Date.now() + FOCUS_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const fg = await invoke<ForegroundAppInfo>('get_foreground_app')
      if (fg.pid === pid) return
    } catch {
      // Best-effort only — e.g. non-Windows, or no foreground window this
      // instant. Keep polling until the deadline rather than bailing.
    }
    await new Promise((resolve) => setTimeout(resolve, FOCUS_POLL_INTERVAL_MS))
  }
}

/**
 * Unconditionally brings the resolved target window to the foreground, and
 * waits for the OS to actually confirm the switch before returning. Called
 * right after permission approval and immediately before the native
 * mouse_click/press_key call — approving the dialog necessarily focuses the
 * Rachna IDE window (the user just clicked a button in it), so refocusing
 * here can't be skipped just because an earlier check happened to pass.
 * No-ops when there's no target to focus (e.g. the model didn't provide one
 * and no screenshot target was recorded).
 */
async function refocusTarget(target: { pid?: number; appName?: string } | null): Promise<string | null> {
  if (!target) return null
  try {
    const focusedPid = await invoke<number>('focus_app', { pid: target.pid, appName: target.appName })
    // Close the focus_app-resolved-then-immediately-acted race: poll until
    // the OS itself reports this pid in the foreground rather than
    // trusting focus_app's promise resolution alone.
    if (typeof focusedPid === 'number') {
      await pollForFocus(focusedPid)
    }
    return null
  } catch (err) {
    return `could not focus the required window before running: ${err instanceof Error ? err.message : String(err)}`
  }
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
      message: `Action denied by user: "${description}". The user chose not to allow this.`,
    }
  }
  return { denied: false }
}

// ── mouse_click ──────────────────────────────────────────────────────────────

/** All mouse buttons enigo exposes: primary/secondary/middle plus the
 *  "extra" back/forward buttons found on many mice. */
export type MouseButtonArg = 'left' | 'right' | 'middle' | 'back' | 'forward'

const MOUSE_BUTTONS: MouseButtonArg[] = ['left', 'right', 'middle', 'back', 'forward']

export interface MouseClickArgs {
  /** X coordinate in screen pixels (0 = left edge of the primary monitor). */
  x: number
  /** Y coordinate in screen pixels (0 = top edge of the primary monitor). */
  y: number
  /** Which mouse button to click. */
  button: MouseButtonArg
  /** If true, fires two clicks in quick succession (a double-click). Default false. */
  double?: boolean
  /** Required focused app process id; action is aborted if another window has focus. */
  requiredPid?: number
  /** Required focused app name substring; action is aborted if another window has focus. */
  requiredAppName?: string
}

export interface MouseClickResult {
  x: number
  y: number
  button: MouseButtonArg
  double?: boolean
}

export const mouseClickTool: AgentTool<MouseClickArgs, MouseClickResult> = {
  declaration: {
    name: 'mouse_click',
    description:
      'Moves the mouse to an absolute screen position and clicks a mouse button — left, right, ' +
      'middle, or the back/forward "extra" buttons found on many mice. Coordinates are screen ' +
      'pixels with (0,0) at the top-left of the primary monitor — use take_screenshot first to ' +
      'see the screen and work out where to click; this tool refuses to run without a recent ' +
      'screenshot. Set `double: true` to double-click instead of a single click. The user is ' +
      'prompted to approve every click before it happens.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in screen pixels.' },
        y: { type: 'number', description: 'Y coordinate in screen pixels.' },
        button: {
          type: 'string',
          enum: MOUSE_BUTTONS,
          description: 'Which mouse button to click: left, right, middle, back, or forward.',
        },
        double: {
          type: 'boolean',
          description: 'If true, double-clicks instead of single-clicking. Defaults to false.',
        },
        requiredPid: {
          type: 'number',
          description: 'Process id of the app/window to focus before clicking when it is not already focused.',
        },
        requiredAppName: {
          type: 'string',
          description: 'App/process name substring to focus before clicking when it is not already focused.',
        },
      },
      required: ['x', 'y', 'button'],
    },
  },

  describeCall: (args) =>
    `${args.double ? 'Double-clicking' : 'Clicking'} ${args.button ?? 'left'} mouse button at (${args.x}, ${args.y})`,

  execute: async (args, ctx: ToolContext) => {
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      return toolErr('x and y are required numbers for mouse_click.')
    }
    if (!MOUSE_BUTTONS.includes(args.button)) {
      return toolErr(`button must be one of: ${MOUSE_BUTTONS.join(', ')} for mouse_click.`)
    }

    // ── Screenshot-first guard — checked before even prompting for permission ──
    const guardError = checkScreenshotPermit()
    if (guardError) return toolErr(guardError)

    // Explicit requiredPid/requiredAppName wins; otherwise fall back to
    // whatever app the screenshot guard remembers as the current target.
    const target = await resolveFocusTarget(args)

    // Every click asks — no "remember for session" carve-out, since the
    // point of asking each time is that screen state (and click target)
    // changes between actions; see useTerminalPermissionStore.
    const description = `mouse_click: ${args.double ? 'double-' : ''}${args.button} click at (${args.x}, ${args.y})`
    const permission = await requestPermission(ctx, description)
    if (permission.denied) return toolErrDenied(permission.message)

    // Refocus unconditionally right before clicking — approving the dialog
    // above just brought the Rachna IDE window to the foreground.
    const focusError = await refocusTarget(target)
    if (focusError) return toolErr(`mouse_click ${focusError}`)

    // Visual feedback (ring at the click point) — shown right before the
    // real click, purely cosmetic.
    overlay().showClick(args.x, args.y, args.button, args.double)

    // Give the user a moment to actually see the cue before the real click
    // fires — see waitForVisualCue's doc comment / Settings > Actions.
    await waitForVisualCue()

    try {
      return await withInputBlocked(async () => {
        const clickPayload = {
          x: Math.round(args.x),
          y: Math.round(args.y),
          button: args.button,
          double: args.double ?? false,
          requiredPid: target?.pid,
          requiredAppName: target?.appName,
          // Pixel tolerance for the Rust-side move-then-verify check (see
          // move_and_verify_position in input_control.rs) — the native
          // command moves the cursor, reads the OS cursor position back,
          // and only clicks once it's confirmed within this many pixels of
          // (x, y), retrying the move a bounded number of times otherwise.
          // Purely local/deterministic; not exposed to the model, only to
          // this Settings-backed default, so the agent can't loosen it.
          tolerancePx: getMousePositionTolerancePx(),
        }
        // Shrink to the orb for the native click itself — this window is
        // already the foreground app from the permission approval above,
        // so getting it out of the way before the click fires is what
        // gives the click a clear shot at the target app underneath.
        await withOrbView(async () => {
          try {
            await invoke('mouse_click', clickPayload)
          } catch (err) {
            if (!isRequiredFocusError(err) || !target) throw err
            await refocusTarget(target)
            await invoke('mouse_click', clickPayload)
          }
        })
        return toolOk<MouseClickResult>({ x: args.x, y: args.y, button: args.button, double: args.double })
      })
    } catch (err) {
      return toolErr(`mouse_click failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── mouse_drag_path ──────────────────────────────────────────────────────────
//
// A continuous click-and-drag sibling of mouse_click: instead of a single
// point, the path is given as two parametric equations x(t)/y(t) sampled
// over [tMin, tMax] — e.g. a circle (`500 + 150*cos(t)`, `400 + 150*sin(t)`,
// t: 0..2*pi), a straight line, a zigzag, a signature-like curve, etc.
//
// Like press_key_sequence (and unlike mouse_click / press_key's per-chord
// `sequence` mode), this asks for exactly ONE upfront approval covering the
// whole drag, then plays the entire path through natively in a single Tauri
// call — a multi-hundred-point drag would be unusable at one prompt per
// point. The equations themselves are parsed by a small allow-listed
// evaluator on the Rust side (see src-tauri/src/input_control.rs `expr`
// module) — not `eval`, so there's no way to smuggle in anything beyond
// arithmetic on `t`.

const MOUSE_DRAG_PATH_MAX_STEPS = 2000
const MOUSE_DRAG_PATH_MAX_DURATION_MS = 30_000

export interface MouseDragPathArgs {
  /** X(t) equation, e.g. "500 + 150*cos(t)". Variable: t. Constants: pi, e. Functions: sin, cos, tan, sqrt, abs, exp, ln, log10, floor, ceil, round, pow, min, max. */
  xEquation: string
  /** Y(t) equation, e.g. "400 + 150*sin(t)". Same grammar as xEquation. */
  yEquation: string
  /** Start of the t range sampled along the path. */
  tMin: number
  /** End of the t range sampled along the path. */
  tMax: number
  /** Number of points to sample between tMin and tMax (inclusive of both ends). 2–2000. */
  steps: number
  /** Total time in milliseconds to spend moving through the whole path. Defaults to 1000, capped at 30000. */
  durationMs?: number
  /** Which mouse button to hold down for the drag. Defaults to "left". */
  button?: MouseButtonArg
  /** Required focused app process id; action is aborted if another window has focus. */
  requiredPid?: number
  /** Required focused app name substring; action is aborted if another window has focus. */
  requiredAppName?: string
}

export interface MouseDragPathResult {
  steps: number
  start: { x: number; y: number }
  end: { x: number; y: number }
  button: MouseButtonArg
}

interface TauriDragPathSummary {
  steps: number
  start: [number, number]
  end: [number, number]
}

export const mouseDragPathTool: AgentTool<MouseDragPathArgs, MouseDragPathResult> = {
  declaration: {
    name: 'mouse_drag_path',
    description:
      'Presses a mouse button down and drags the cursor along a path, then releases the ' +
      'button — a single continuous click-and-drag, as opposed to mouse_click\'s single ' +
      'point-and-click. The path is defined by two parametric equations, xEquation and ' +
      'yEquation, each a function of a variable `t` sampled evenly from tMin to tMax across ' +
      '`steps` points (2–2000). Equations support +, -, *, /, ^, parentheses, the constants ' +
      'pi and e, and the functions sin, cos, tan, sqrt, abs, exp, ln, log10, floor, ceil, ' +
      'round, pow(a,b), min(a,b), max(a,b). Coordinates are screen pixels with (0,0) at the ' +
      'top-left of the primary monitor. Example — a circle of radius 150 centered at ' +
      '(500, 400): xEquation "500 + 150*cos(t)", yEquation "400 + 150*sin(t)", tMin 0, ' +
      'tMax 6.283185, steps 200. Use take_screenshot first to see the screen and work out ' +
      'the path; this tool refuses to run without a recent screenshot. Unlike per-click ' +
      'confirmation, the WHOLE drag is approved with a single prompt up front, then plays ' +
      'through without further interruption — there is no per-point confirmation.',
    parameters: {
      type: 'object',
      properties: {
        xEquation: { type: 'string', description: 'X(t) equation, e.g. "500 + 150*cos(t)".' },
        yEquation: { type: 'string', description: 'Y(t) equation, e.g. "400 + 150*sin(t)".' },
        tMin: { type: 'number', description: 'Start of the t range sampled along the path.' },
        tMax: { type: 'number', description: 'End of the t range sampled along the path.' },
        steps: {
          type: 'number',
          description: `Number of points to sample between tMin and tMax, inclusive. 2–${MOUSE_DRAG_PATH_MAX_STEPS}.`,
        },
        durationMs: {
          type: 'number',
          description: `Total time in ms to spend moving through the path. Defaults to 1000, capped at ${MOUSE_DRAG_PATH_MAX_DURATION_MS}.`,
        },
        button: {
          type: 'string',
          enum: MOUSE_BUTTONS,
          description: 'Which mouse button to hold down for the drag. Defaults to "left".',
        },
        requiredPid: {
          type: 'number',
          description: 'Process id of the app/window to focus before dragging when it is not already focused.',
        },
        requiredAppName: {
          type: 'string',
          description: 'App/process name substring to focus before dragging when it is not already focused.',
        },
      },
      required: ['xEquation', 'yEquation', 'tMin', 'tMax', 'steps'],
    },
  },

  describeCall: (args) =>
    `Dragging ${args.button ?? 'left'} mouse button along path "${args.xEquation ?? '…'}, ${args.yEquation ?? '…'}" ` +
    `(t: ${args.tMin ?? '…'} → ${args.tMax ?? '…'}, ${args.steps ?? '…'} steps)`,

  execute: async (args, ctx: ToolContext) => {
    const xEquation = (args.xEquation ?? '').trim()
    const yEquation = (args.yEquation ?? '').trim()
    if (!xEquation || !yEquation) {
      return toolErr('xEquation and yEquation are required for mouse_drag_path.')
    }
    if (typeof args.tMin !== 'number' || typeof args.tMax !== 'number' || !Number.isFinite(args.tMin) || !Number.isFinite(args.tMax)) {
      return toolErr('tMin and tMax are required finite numbers for mouse_drag_path.')
    }
    if (!Number.isFinite(args.steps) || args.steps < 2 || args.steps > MOUSE_DRAG_PATH_MAX_STEPS) {
      return toolErr(`steps must be a number between 2 and ${MOUSE_DRAG_PATH_MAX_STEPS} for mouse_drag_path.`)
    }
    const button = args.button ?? 'left'
    if (!MOUSE_BUTTONS.includes(button)) {
      return toolErr(`button must be one of: ${MOUSE_BUTTONS.join(', ')} for mouse_drag_path.`)
    }
    const durationMs = Math.min(args.durationMs ?? 1000, MOUSE_DRAG_PATH_MAX_DURATION_MS)

    // ── Screenshot-first guard — checked before even prompting for permission ──
    const guardError = checkScreenshotPermit()
    if (guardError) return toolErr(guardError)

    const target = await resolveFocusTarget(args)

    // ONE approval for the entire path — see the tool-level comment above.
    const steps = Math.round(args.steps)
    const description =
      `mouse_drag_path: ${button} drag along "${xEquation}, ${yEquation}" ` +
      `(t: ${args.tMin} → ${args.tMax}, ${steps} steps, ~${durationMs}ms)`
    const permission = await requestPermission(ctx, description)
    if (permission.denied) return toolErrDenied(permission.message)

    // Refocus unconditionally right before dragging — approving the dialog
    // above just brought the Rachna IDE window to the foreground.
    const focusError = await refocusTarget(target)
    if (focusError) return toolErr(`mouse_drag_path ${focusError}`)

    // Visual feedback (the drag's outline/curve, traced over the same
    // duration as the real drag) — shown right before the real drag,
    // purely cosmetic. Sampling here is independent of and capped well
    // below the real `steps`; a failed sample (bad equation edge case)
    // just means no preview is drawn, never a blocked or altered drag.
    const previewPoints = sampleParametricPath(xEquation, yEquation, args.tMin, args.tMax, steps)
    if (previewPoints.length >= 2) {
      overlay().showDrag(previewPoints, durationMs, button)
    }

    // Give the user a moment to actually see the cue before the real drag
    // fires — see waitForVisualCue's doc comment / Settings > Actions.
    await waitForVisualCue()

    try {
      return await withInputBlocked(async () => {
        const dragPayload = {
          xEquation,
          yEquation,
          tMin: args.tMin,
          tMax: args.tMax,
          steps,
          durationMs,
          button,
          requiredPid: target?.pid,
          requiredAppName: target?.appName,
          // Same move-then-verify tolerance as mouse_click, applied to the
          // drag's start point (where the button actually goes down) —
          // see move_and_verify_position in input_control.rs.
          tolerancePx: getMousePositionTolerancePx(),
        }
        // Shrink to the orb for the native drag itself — same rationale as
        // mouse_click above.
        const summary = await withOrbView(async () => {
          try {
            return await invoke<TauriDragPathSummary>('mouse_drag_path', dragPayload)
          } catch (err) {
            if (!isRequiredFocusError(err) || !target) throw err
            await refocusTarget(target)
            return await invoke<TauriDragPathSummary>('mouse_drag_path', dragPayload)
          }
        })
        return toolOk<MouseDragPathResult>({
          steps: summary.steps,
          start: { x: summary.start[0], y: summary.start[1] },
          end: { x: summary.end[0], y: summary.end[1] },
          button,
        })
      })
    } catch (err) {
      return toolErr(`mouse_drag_path failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── press_key ────────────────────────────────────────────────────────────────

export interface PressKeyArgs {
  /**
   * One or more key names to press together as a single chord, e.g.
   * ["ctrl", "c"] for copy, or ["enter"] alone. Released in reverse order
   * after all are pressed. Provide exactly one of `keys`, `sequence`, or `text`.
   */
  keys?: string[]
  /**
   * An ordered list of chords to press one after another, with a short
   * pause between each — for multi-step keyboard shortcuts (e.g.
   * [["ctrl","k"],["ctrl","s"]] for VS Code's "save without formatting"),
   * or for walking through a series of individual key presses (e.g.
   * [["down"],["down"],["enter"]] to move down a menu and select an item).
   * Each inner array is a chord, pressed/released exactly like `keys`.
   * Provide exactly one of `keys`, `sequence`, or `text`.
   */
  sequence?: string[][]
  /**
   * Literal text to type (Unicode-aware), e.g. "hello@example.com".
   * Provide exactly one of `keys`, `sequence`, or `text`.
   */
  text?: string
  /** Pause between chords in `sequence`, in milliseconds. Defaults to 80. */
  delayMs?: number
  /** Required focused app process id; action is aborted if another window has focus. */
  requiredPid?: number
  /** Required focused app name substring; action is aborted if another window has focus. */
  requiredAppName?: string
}

export interface PressKeyResult {
  keys?: string[]
  sequence?: string[][]
  text?: string
}

const KEY_NAMES_HINT =
  'a single character (e.g. "a", "5", "@") or one of: ctrl, alt, shift, meta, enter, tab, ' +
  'escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, ' +
  'capslock, insert, f1-f12.'

function describeChord(chord: string[]): string {
  return chord.join('+') || '…'
}

export const pressKeyTool: AgentTool<PressKeyArgs, PressKeyResult> = {
  declaration: {
    name: 'press_key',
    description:
      'Simulates keyboard input in one of three ways — provide exactly one: ' +
      '(1) `text` types literal text into whatever currently has focus; ' +
      '(2) `keys` presses one or more keys together as a single chord, e.g. ["ctrl", "c"] for ' +
      'copy, or ["enter"] alone; ' +
      '(3) `sequence` presses an ordered list of chords one after another (each inner array is ' +
      'a chord), for multi-step keyboard shortcuts like VS Code\'s Ctrl+K Ctrl+S ' +
      '(sequence: [["ctrl","k"],["ctrl","s"]]) or for a run of individual key presses like ' +
      'navigating a menu (sequence: [["down"],["down"],["enter"]]). ' +
      'Use take_screenshot first to confirm the right field/window has focus. Pass requiredPid or requiredAppName when the target window is known so the tool focuses/verifies it before input — this tool ' +
      'refuses to run without a recent screenshot. The user is prompted to approve every call ' +
      'before it happens — for `sequence`, each chord is its own separate approval, not one ' +
      'approval for the whole array, and a denial partway through stops the remaining steps.',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: `Key names to press together as a single chord. Each item is ${KEY_NAMES_HINT}`,
        },
        sequence: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' },
          },
          description:
            'Ordered list of chords to press one after another (e.g. [["ctrl","k"],["ctrl","s"]]). ' +
            `Each item within a chord is ${KEY_NAMES_HINT}`,
        },
        text: {
          type: 'string',
          description: 'Literal text to type into the currently focused field.',
        },
        delayMs: {
          type: 'number',
          description: 'Pause between chords in "sequence", in milliseconds. Defaults to 80.',
        },
        requiredPid: {
          type: 'number',
          description: 'Process id of the app/window to focus before pressing keys when it is not already focused.',
        },
        requiredAppName: {
          type: 'string',
          description: 'App/process name substring to focus before pressing keys when it is not already focused.',
        },
      },
    },
  },

  describeCall: (args) => {
    if (args.text) return `Typing "${args.text}"`
    if (Array.isArray(args.sequence) && args.sequence.length > 0) {
      return `Pressing ${args.sequence.map(describeChord).join(' then ')}`
    }
    return `Pressing ${describeChord(args.keys ?? [])}`
  },

  execute: async (args, ctx: ToolContext) => {
    const hasText = typeof args.text === 'string' && args.text.length > 0
    const hasKeys = Array.isArray(args.keys) && args.keys.length > 0
    const hasSequence = Array.isArray(args.sequence) && args.sequence.length > 0

    const provided = [hasText, hasKeys, hasSequence].filter(Boolean).length
    if (provided > 1) {
      return toolErr('Provide exactly one of "text", "keys", or "sequence" for press_key, not more than one.')
    }
    if (provided === 0) {
      return toolErr(
        'press_key requires exactly one of: a non-empty "text" string, a non-empty "keys" array, ' +
          'or a non-empty "sequence" array of key arrays.'
      )
    }
    if (hasSequence && args.sequence!.some((chord) => !Array.isArray(chord) || chord.length === 0)) {
      return toolErr('Every chord in "sequence" must be a non-empty array of key names.')
    }

    // ── Screenshot-first guard — checked before even prompting for permission ──
    const guardError = checkScreenshotPermit()
    if (guardError) return toolErr(guardError)

    const target = await resolveFocusTarget(args)

    // `sequence` is multiple distinct keyboard actions, not one — each step
    // gets its own permission prompt and its own refocus, exactly like a
    // standalone `keys` call would, rather than bundling the whole array
    // behind a single approval. A denial partway through stops the rest of
    // the sequence rather than silently continuing.
    if (hasSequence) {
      const chords = args.sequence!
      const delayMs = args.delayMs ?? 80
      for (let i = 0; i < chords.length; i++) {
        const chord = chords[i]
        const description = `press_key: ${describeChord(chord)} (step ${i + 1} of ${chords.length})`
        const permission = await requestPermission(ctx, description)
        if (permission.denied) {
          return toolErrDenied(
            `${permission.message} ${i} of ${chords.length} step(s) completed before denial.`
          )
        }

        const focusError = await refocusTarget(target)
        if (focusError) return toolErr(`press_key ${focusError} (stopped at step ${i + 1} of ${chords.length}).`)

        // Visual feedback for this chord — shown right before it's pressed.
        overlay().showKeys(describeChord(chord))

        // Give the user a moment to actually see the cue before the real
        // chord fires — see waitForVisualCue's doc comment / Settings > Actions.
        await waitForVisualCue()

        try {
          await withInputBlocked(async () => {
            const chordPayload = { keys: chord, requiredPid: target?.pid, requiredAppName: target?.appName }
            // Shrink to the orb for the native chord press itself — same
            // rationale as mouse_click above.
            await withOrbView(async () => {
              try {
                await invoke('press_key', chordPayload)
              } catch (err) {
                if (!isRequiredFocusError(err) || !target) throw err
                await refocusTarget(target)
                await invoke('press_key', chordPayload)
              }
            })
          })
        } catch (err) {
          return toolErr(
            `press_key failed at step ${i + 1} of ${chords.length}: ${err instanceof Error ? err.message : String(err)}`
          )
        }

        if (i + 1 < chords.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
      return toolOk<PressKeyResult>({ sequence: chords })
    }

    const description = hasText ? `press_key: type "${args.text}"` : `press_key: ${describeChord(args.keys ?? [])}`
    const permission = await requestPermission(ctx, description)
    if (permission.denied) return toolErrDenied(permission.message)

    const focusError = await refocusTarget(target)
    if (focusError) return toolErr(`press_key ${focusError}`)

    // Visual feedback — a "Type: <text>" bar for literal text, a
    // "Keys: <chord>" bar otherwise. Shown right before the real call.
    if (hasText) {
      overlay().showTyping(args.text!)
    } else {
      overlay().showKeys(describeChord(args.keys ?? []))
    }

    // Give the user a moment to actually see the cue before the real
    // keystroke(s) fire — see waitForVisualCue's doc comment / Settings > Actions.
    await waitForVisualCue()

    try {
      return await withInputBlocked(async () => {
        const keyPayload = {
          keys: hasKeys ? args.keys : undefined,
          text: hasText ? args.text : undefined,
          requiredPid: target?.pid,
          requiredAppName: target?.appName,
        }
        // Shrink to the orb for the native key press itself — same
        // rationale as mouse_click above.
        await withOrbView(async () => {
          try {
            await invoke('press_key', keyPayload)
          } catch (err) {
            if (!isRequiredFocusError(err) || !target) throw err
            await refocusTarget(target)
            await invoke('press_key', keyPayload)
          }
        })
        return toolOk<PressKeyResult>(hasText ? { text: args.text } : { keys: args.keys })
      })
    } catch (err) {
      return toolErr(`press_key failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── type_link_in_browser ────────────────────────────────────────────────────

export interface TypeLinkInBrowserArgs { url: string }
export interface TypeLinkInBrowserResult { text: string }

export const typeLinkInBrowserTool: AgentTool<TypeLinkInBrowserArgs, TypeLinkInBrowserResult> = {
  declaration: {
    name: 'type_link_in_browser',
    description:
      'Types a URL exactly as provided into the currently focused browser address bar, then appends one trailing space. ' +
      'Does not press Enter and does not otherwise modify the URL. Use this instead of press_key or generic text typing whenever entering a URL in a browser address bar.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to type exactly; the tool appends one trailing space.' },
      },
      required: ['url'],
    },
  },
  describeCall: (args) => `Typing browser URL "${args.url}"`,
  execute: async (args, ctx) => {
    if (typeof args.url !== 'string' || args.url.length === 0) {
      return toolErr('type_link_in_browser requires a non-empty "url" string.')
    }
    const guardError = checkScreenshotPermit()
    if (guardError) return toolErr(guardError)

    const text = `${args.url} `
    const permission = await requestPermission(ctx, `type_link_in_browser: type "${text}"`)
    if (permission.denied) return toolErrDenied(permission.message)
    const target = await resolveFocusTarget({})
    const focusError = await refocusTarget(target)
    if (focusError) return toolErr(`type_link_in_browser ${focusError}`)

    overlay().showTyping(text)
    await waitForVisualCue()
    try {
      return await withInputBlocked(async () => {
        const payload = { text, requiredPid: target?.pid, requiredAppName: target?.appName }
        // Shrink to the orb for the native key press itself — same
        // rationale as mouse_click above.
        await withOrbView(async () => {
          try {
            await invoke('press_key', payload)
          } catch (err) {
            if (!isRequiredFocusError(err) || !target) throw err
            await refocusTarget(target)
            await invoke('press_key', payload)
          }
        })
        return toolOk<TypeLinkInBrowserResult>({ text })
      })
    } catch (err) {
      return toolErr(`type_link_in_browser failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}

// ── press_key_sequence ───────────────────────────────────────────────────────
//
// A dedicated long-form sibling of `press_key`'s `sequence` mode. `press_key`
// asks for a fresh approval before EVERY chord — the right behavior for a
// handful of deliberate shortcut chords, but unworkable for a long run of
// individual key presses (e.g. walking a list 200 rows down, or replaying a
// captured macro): a 2000-key run would mean 2000 approval prompts.
//
// `press_key_sequence` instead takes ONE flat array of up to
// MAX_SEQUENCE_KEYS individual keys, asks for a SINGLE upfront approval that
// summarizes the whole run (count + a short preview), then plays every key
// through in one native call — reusing the existing `press_key` Tauri
// command by wrapping each key as its own one-key "chord"
// (sequence: [[k1], [k2], …]), so no Rust changes are needed.
//
// Intended for DESKTOP_TASK ('apps' category — see ToolRegistry.ts) alongside
// mouse_click/press_key. BROWSER_TASK gets the equivalent capability via the
// `pressSequence` step in web_task (webTaskTool.ts / web-task.js), which
// drives the headless browser's own keyboard instead of the OS's — that's a
// different execution surface, so it's implemented as a step action there
// rather than sharing this tool.

const MAX_SEQUENCE_KEYS = 2000

export interface PressKeySequenceArgs {
  /** Ordered list of individual key names to press one after another (NOT chords — each key is pressed and released on its own before the next). Up to 2000 keys. */
  keys: string[]
  /** Pause between keys, in milliseconds. Defaults to 30 (fast — this is for long runs, not chorded shortcuts). */
  delayMs?: number
  /** Required focused app process id; action is aborted if another window has focus. */
  requiredPid?: number
  /** Required focused app name substring; action is aborted if another window has focus. */
  requiredAppName?: string
}

export interface PressKeySequenceResult {
  count: number
  /** First few keys, for a quick sanity check — full list can be long, so it isn't echoed back in full. */
  preview: string[]
}

function previewKeys(keys: string[], max = 10): string[] {
  return keys.slice(0, max)
}

function describeKeySequence(keys: string[]): string {
  const shown = previewKeys(keys, 8).join(', ')
  const suffix = keys.length > 8 ? `, … (${keys.length} keys total)` : ` (${keys.length} key${keys.length === 1 ? '' : 's'})`
  return `${shown}${suffix}`
}

export const pressKeySequenceTool: AgentTool<PressKeySequenceArgs, PressKeySequenceResult> = {
  declaration: {
    name: 'press_key_sequence',
    description:
      'Presses a long ordered run of individual keys, one after another — for macros, ' +
      'repeated navigation (e.g. pressing "down" 50 times then "enter"), or replaying a ' +
      'captured sequence of keystrokes. Up to 2000 keys per call. Unlike press_key\'s ' +
      '`sequence` mode (which asks for approval before every chord — meant for a handful of ' +
      'deliberate keyboard shortcuts), this tool asks for ONE approval covering the entire run, ' +
      'then plays every key through without further prompts. Each item is ' +
      KEY_NAMES_HINT +
      ' Use take_screenshot first to confirm the right field/window has focus — this tool ' +
      'refuses to run without a recent screenshot.',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: `Ordered list of individual keys to press one after another (up to 2000). Each item is ${KEY_NAMES_HINT}`,
        },
        delayMs: {
          type: 'number',
          description: 'Pause between individual keys, in milliseconds. Defaults to 30.',
        },
        requiredPid: {
          type: 'number',
          description: 'Process id of the app/window to focus before pressing keys when it is not already focused.',
        },
        requiredAppName: {
          type: 'string',
          description: 'App/process name substring to focus before pressing keys when it is not already focused.',
        },
      },
      required: ['keys'],
    },
  },

  describeCall: (args) => `Pressing key sequence: ${describeKeySequence(args.keys ?? [])}`,

  execute: async (args, ctx: ToolContext) => {
    const keys = Array.isArray(args.keys) ? args.keys : []
    if (keys.length === 0) {
      return toolErr('keys is required and must be a non-empty array for press_key_sequence.')
    }
    if (keys.length > MAX_SEQUENCE_KEYS) {
      return toolErr(`Too many keys (${keys.length}); max is ${MAX_SEQUENCE_KEYS} per call.`)
    }
    if (keys.some((k) => typeof k !== 'string' || k.length === 0)) {
      return toolErr('Every item in "keys" must be a non-empty string.')
    }

    // ── Screenshot-first guard — checked before even prompting for permission ──
    const guardError = checkScreenshotPermit()
    if (guardError) return toolErr(guardError)

    const target = await resolveFocusTarget(args)

    // ONE approval for the whole run — see the tool-level comment above for
    // why this differs from press_key's per-chord approval.
    const description = `press_key_sequence: ${describeKeySequence(keys)}`
    const permission = await requestPermission(ctx, description)
    if (permission.denied) return toolErrDenied(permission.message)

    const focusError = await refocusTarget(target)
    if (focusError) return toolErr(`press_key_sequence ${focusError}`)

    // Visual feedback — a "Keys: <preview>" bar covering the whole run,
    // shown right before it starts playing.
    overlay().showKeys(describeKeySequence(keys))

    // Give the user a moment to actually see the cue before the real key
    // sequence starts playing — see waitForVisualCue's doc comment /
    // Settings > Actions.
    await waitForVisualCue()

    try {
      const payload = {
        sequence: keys.map((k) => [k]),
        delayMs: args.delayMs ?? 30,
        requiredPid: target?.pid,
        requiredAppName: target?.appName,
      }
      await withInputBlocked(async () => {
        // Shrink to the orb for the native key-sequence playback itself —
        // same rationale as mouse_click above. Covers the whole run (it's
        // one native call under the hood), not a per-key shrink/restore.
        await withOrbView(async () => {
          try {
            await invoke('press_key', payload)
          } catch (err) {
            if (!isRequiredFocusError(err) || !target) throw err
            await refocusTarget(target)
            await invoke('press_key', payload)
          }
        })
      })
      return toolOk<PressKeySequenceResult>({ count: keys.length, preview: previewKeys(keys) })
    } catch (err) {
      return toolErr(`press_key_sequence failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
}
