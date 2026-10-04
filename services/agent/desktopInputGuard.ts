// services/agent/desktopInputGuard.ts
//
// Lightweight in-memory guard enforcing "look before you click": the agent
// must call `take_screenshot` before either `mouse_click` or `press_key`
// runs. Driving the desktop blind — guessing coordinates or typing into
// whatever happens to have focus without having just seen the screen — is
// exactly the failure mode this exists to prevent.
//
// Session-scoped (module-level singleton) rather than threaded through
// ToolContext, since neither mouse/keyboard tools nor ToolContext currently
// carry a per-turn identifier — same scope as the terminal-permission
// "remember for session" state in useTerminalPermissionStore.
//
// The permit expires after SCREENSHOT_PERMIT_MS so a screenshot taken long
// ago (the screen may well have changed since) can't be used to justify an
// input action much later — the agent has to re-capture first.

const SCREENSHOT_PERMIT_MS = 2 * 60 * 1000 // 2 minutes

let lastScreenshotAt: number | null = null

/**
 * The app the agent was actually looking at, captured at take_screenshot
 * time (see screenshotTool.ts) — either the explicit focusPid/focusAppName
 * the caller passed, or (when omitted) whatever process was in the
 * foreground the instant the screenshot was requested, before the
 * permission dialog pulled focus back to the Rachna IDE window.
 *
 * mouse_click / press_key fall back to this when their own call omits
 * requiredPid/requiredAppName, so a click doesn't silently land on the IDE
 * itself just because the model forgot to name a target explicitly.
 * Cleared whenever the screenshot permit lapses, same lifetime as the
 * screenshot itself — a stale target is exactly as unsafe as a stale
 * screenshot.
 */
export interface DesktopTargetApp {
  pid?: number
  appName?: string
}

let targetApp: DesktopTargetApp | null = null

/**
 * Call after a successful take_screenshot execution. `target`, when
 * provided, is remembered as the default focus target for later
 * mouse_click / press_key calls that don't specify their own.
 */
export function recordScreenshot(target?: DesktopTargetApp): void {
  lastScreenshotAt = Date.now()
  if (target && (typeof target.pid === 'number' || (target.appName && target.appName.trim()))) {
    targetApp = target
  }
}

/** Returns the remembered target app, or null if none is set or the screenshot permit has lapsed. */
export function getTargetApp(): DesktopTargetApp | null {
  if (checkScreenshotPermit() !== null) return null
  return targetApp
}

/**
 * Call before executing mouse_click / press_key. Returns an error message
 * when no recent-enough screenshot exists (input should NOT proceed), or
 * null when a screenshot permit is active and the input action may run.
 */
export function checkScreenshotPermit(): string | null {
  if (lastScreenshotAt === null) {
    return (
      'No screenshot has been taken yet. Call take_screenshot first so you can see the ' +
      'current screen before clicking or pressing keys.'
    )
  }
  const ageMs = Date.now() - lastScreenshotAt
  if (ageMs > SCREENSHOT_PERMIT_MS) {
    return (
      `The last screenshot is ${Math.round(ageMs / 1000)}s old and may no longer reflect the ` +
      'current screen. Call take_screenshot again before clicking or pressing keys.'
    )
  }
  return null
}

/** Test-only: reset state between unit tests. */
export function _resetDesktopInputGuardForTests(): void {
  lastScreenshotAt = null
  targetApp = null
}
