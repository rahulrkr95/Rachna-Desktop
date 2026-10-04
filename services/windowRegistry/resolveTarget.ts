// services/windowRegistry/resolveTarget.ts
//
// Part 3 — desktop-tool integration glue for the Running Window Registry.
// Two small, focused helpers that every desktop-control tool needing a
// real HWND/pid goes through, so the "poll the registry / rank a query
// against it" logic lives in exactly one place rather than being
// re-implemented inside open_app, focus_app, close_app, take_screenshot,
// and list_running_apps individually.
//
// Neither function touches window_registry.rs or windowRegistryService.ts
// — both are pure consumers of the existing `listVisibleWindows` /
// `findWindowMatch` APIs (services/windowRegistry/windowRegistryService.ts,
// services/windowRegistry/matching.ts), per the "don't rebuild the
// registry" constraint on this work.

import { listVisibleWindows } from './windowRegistryService'
import { findWindowMatch } from './matching'
import type { RunningWindow } from './types'

// ── waitForAppWindow ─────────────────────────────────────────────────────────
//
// Used right after launching an app (open_app) to find the window it
// actually produced. A launcher pid — whether from `launch_installed_app`
// (which doesn't return one at all for Win32 targets) or the process that
// spawned a packaged app's host — is not reliably the pid that ends up
// owning the visible window (see window_registry.rs's module doc comment),
// so this polls the registry for a fresh window matching the app's name
// instead of trusting any pid the launch call happened to hand back.
//
// `excludeHwnds` should be a snapshot of HWNDs taken *before* the launch,
// so an app that was already running (and just got re-focused rather than
// spawning a new top-level window — common for single-instance apps like
// Calculator) doesn't get silently skipped: if nothing new shows up within
// the timeout, the best pre-existing name match is returned as a fallback
// rather than nothing at all.

export interface WaitForAppWindowOptions {
  /** HWNDs that already existed before the launch — used to prefer a
   *  genuinely new window over a pre-existing one sharing the same name. */
  excludeHwnds?: Set<string>
  /** Total time to keep polling before giving up. */
  timeoutMs?: number
  /** Delay between polls. */
  pollIntervalMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls the Window Registry for a window matching `query` (an app/display
 * name), preferring one that didn't exist in `excludeHwnds`. Returns null
 * if nothing matched within the timeout — callers should treat that as
 * "app launched, but no window resolved yet" rather than a hard failure,
 * since some apps (background/tray-only utilities, slow-starting installers,
 * etc.) never produce — or take a while to produce — a top-level window.
 */
export async function waitForAppWindow(
  query: string,
  opts: WaitForAppWindowOptions = {}
): Promise<RunningWindow | null> {
  const timeoutMs = opts.timeoutMs ?? 6000
  const pollIntervalMs = opts.pollIntervalMs ?? 300
  const exclude = opts.excludeHwnds ?? new Set<string>()
  const deadline = Date.now() + timeoutMs

  let bestSoFar: RunningWindow | null = null

  while (true) {
    let windows: RunningWindow[] = []
    try {
      windows = await listVisibleWindows()
    } catch {
      // Registry scan failed this round — keep polling until the deadline
      // rather than giving up on a single transient error.
    }

    const fresh = windows.filter((w) => !exclude.has(w.hwnd))
    // Rank fresh (newly-appeared) windows first — that's the common case
    // for a genuine new launch. Only fall back to ranking the full set
    // (which may re-surface a pre-existing window) if nothing new matches
    // at all, so a coincidentally-similarly-named pre-existing window
    // doesn't shadow the one the launch actually just created.
    const freshDecision = findWindowMatch(query, fresh)
    if (freshDecision.kind === 'confident') return freshDecision.window
    if (freshDecision.kind === 'ambiguous' && freshDecision.candidates.length > 0) {
      bestSoFar = freshDecision.candidates[0]
    } else if (!bestSoFar) {
      const anyDecision = findWindowMatch(query, windows)
      if (anyDecision.kind === 'confident') bestSoFar = anyDecision.window
      else if (anyDecision.kind === 'ambiguous' && anyDecision.candidates.length > 0) {
        bestSoFar = anyDecision.candidates[0]
      }
    }

    if (Date.now() >= deadline) return bestSoFar
    await sleep(pollIntervalMs)
  }
}

// ── resolveWindowTarget ──────────────────────────────────────────────────────
//
// Used by focus_app / close_app / take_screenshot to turn a (pid?, appName?)
// tool argument pair into a concrete window before falling through to the
// existing Rust resolution (window_control.rs's `resolve_pid` + sibling-
// window search, invoked via the `focus_app`/`close_app` Tauri commands).
// This is additive, not a replacement: the Rust side already handles "pid
// owns no window, but a sibling process does" correctly and is left alone
// (see window_control.rs) — this just gives the *appName* path a better
// first guess by ranking against titles as well as process names, which
// the Rust substring-on-process-name-only match can't do, before the
// existing pid-based command runs.

export type WindowTargetResolution =
  | { kind: 'resolved'; pid: number; hwnd: string; window: RunningWindow }
  | { kind: 'ambiguous'; candidates: RunningWindow[] }
  /** No confident registry match — caller should fall back to passing the
   *  original pid/appName straight through to the existing Rust command. */
  | { kind: 'unresolved' }

export async function resolveWindowTarget(
  pid?: number,
  appName?: string
): Promise<WindowTargetResolution> {
  try {
    const windows = await listVisibleWindows()

    if (typeof pid === 'number') {
      const owned = windows.filter((w) => w.pid === pid)
      if (owned.length > 0) {
        return { kind: 'resolved', pid: owned[0].pid, hwnd: owned[0].hwnd, window: owned[0] }
      }
      // pid owns no visible window per the registry — let the existing
      // Rust sibling-window fallback (window_control.rs) handle it rather
      // than guessing here.
      return { kind: 'unresolved' }
    }

    const query = appName?.trim()
    if (!query) return { kind: 'unresolved' }

    const decision = findWindowMatch(query, windows)
    if (decision.kind === 'confident') {
      return { kind: 'resolved', pid: decision.window.pid, hwnd: decision.window.hwnd, window: decision.window }
    }
    if (decision.kind === 'ambiguous') {
      return { kind: 'ambiguous', candidates: decision.candidates }
    }
    return { kind: 'unresolved' }
  } catch {
    return { kind: 'unresolved' }
  }
}
