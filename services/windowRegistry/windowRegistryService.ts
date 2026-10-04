// services/windowRegistry/windowRegistryService.ts
//
// Scan/cache layer for the Running Window Registry, backed by the Rust
// `list_visible_windows` command (src-tauri/src/window_registry.rs) —
// which enumerates every currently visible, usable top-level window on
// the desktop and resolves each one's *actual* owning pid, title,
// executable name, bounds, and minimized/maximized state.
//
// Deliberately NOT session-cached the way services/appRegistry/
// appRegistryService.ts caches installed apps: the set of installed apps
// barely changes during a session, but the set of open windows changes
// constantly (apps opening/closing/minimizing every few seconds), so a
// stale cache here would routinely hand back windows that no longer
// exist. Every list/find call below re-scans; `getLastSnapshot()` is the
// only place a caller can get a non-fresh read, and it's explicit about
// that in its name and doc comment.
//
// Kept as its own module (sibling to services/appRegistry/) rather than
// folded into it, per the Part 1 doc comments' stated plan — installed
// apps and running windows are different concerns with different
// freshness requirements, and desktop-tool integration (Part 3) can pull
// from either independently.

import { invoke } from '@tauri-apps/api/core'
import type { RunningWindow, TauriRunningWindow } from './types'
import { getSelfPid } from './selfPid'

let lastSnapshot: RunningWindow[] = []

function fromTauri(raw: TauriRunningWindow): RunningWindow {
  return {
    hwnd: raw.hwnd,
    pid: raw.pid,
    title: raw.title,
    exeName: raw.exe_name,
    bounds: raw.bounds,
    visible: raw.visible,
    state: raw.state,
  }
}

/**
 * Re-scans the desktop for every currently visible, usable top-level
 * window and returns the fresh result. This *is* "refresh" — there's no
 * separate cached mode to invalidate, since a scan is the only way this
 * registry is ever populated (see module doc comment above). Updates
 * `getLastSnapshot()`'s return value as a side effect.
 */
export async function refreshWindowRegistry(): Promise<RunningWindow[]> {
  const raw = await invoke<TauriRunningWindow[]>('list_visible_windows')
  const selfPid = await getSelfPid()
  // Filter Rachna's own window(s) out at the source — see selfPid.ts's
  // doc comment for why this is the one place that matters. `selfPid` is
  // null only when the lookup itself failed (non-Windows, transient
  // error); in that case every window is kept, same as before this guard
  // existed, rather than blocking the scan on it.
  lastSnapshot = raw.map(fromTauri).filter((w) => selfPid === null || w.pid !== selfPid)
  return lastSnapshot
}

/** Lists every currently visible, usable top-level window. Alias for
 *  `refreshWindowRegistry()` — kept as a separate name so call sites read
 *  naturally ("list the windows" vs "refresh the registry") even though
 *  they do the same thing here. */
export async function listVisibleWindows(): Promise<RunningWindow[]> {
  return refreshWindowRegistry()
}

/** Best-effort synchronous read of the most recent scan — populated only
 *  after `refreshWindowRegistry()`/`listVisibleWindows()` has resolved at
 *  least once; empty before that. Given how quickly the window set goes
 *  stale, most callers should await a fresh `listVisibleWindows()` call
 *  instead; this exists for UI that wants to render something without
 *  awaiting a fresh scan first. */
export function getLastSnapshot(): RunningWindow[] {
  return lastSnapshot
}
