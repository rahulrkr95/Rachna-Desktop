// services/windowRegistry/selfPid.ts
//
// Rachna's own pid (src-tauri/src/window_control.rs's `get_self_pid`),
// cached after the first successful lookup — it can't change for the
// lifetime of the process, so there's no reason to re-invoke on every
// scan. Used by windowRegistryService.ts to filter Rachna's own window(s)
// out of every Running Window Registry result, which is the TS-side half
// of the "often selecting itself" fix (see window_control.rs's
// resolve_pid for the Rust-side half, used by focus_app/close_app/
// assert_focused_app when resolving a bare pid or app_name substring).
//
// Filtering once here, at the registry layer, means every consumer
// (matching.ts's ranking, resolveTarget.ts's resolveWindowTarget /
// waitForAppWindow) automatically never sees Rachna as a candidate,
// rather than each one needing its own guard.

import { invoke } from '@tauri-apps/api/core'

let cached: number | null = null
let inFlight: Promise<number | null> | null = null

/**
 * Returns Rachna's own pid, or null if the lookup hasn't succeeded yet
 * (e.g. non-Windows, or a transient error) — callers should treat null as
 * "no self-pid known yet, don't filter" rather than an error, since a
 * failed lookup here shouldn't block window resolution entirely.
 */
export async function getSelfPid(): Promise<number | null> {
  if (cached !== null) return cached
  if (!inFlight) {
    inFlight = invoke<number>('get_self_pid')
      .then((pid) => {
        cached = pid
        return pid
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/** Test-only: reset the cache between unit tests. */
export function _resetSelfPidForTests(): void {
  cached = null
  inFlight = null
}
