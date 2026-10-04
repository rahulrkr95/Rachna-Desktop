// lib/defaultCwd.ts
//
// Resolves a safe working directory for terminal commands when no project
// is open. Used by terminalTool.ts so TERMINAL_TASK turns (see
// intentClassifier.ts) can actually run — that flow is documented as
// "no repo context requirement," but terminalTool previously hard-blocked
// on !ctx.projectRoot regardless. Falls back to the OS home directory.
//
// Cached for the session, same pattern as lib/systemInfo.ts — home dir
// doesn't change mid-session.

import { homeDir } from '@tauri-apps/api/path'

let cached: string | null = null
let pending: Promise<string> | null = null

/** Resolves and caches the current user's home directory via Tauri. */
export async function getDefaultCwd(): Promise<string> {
  if (cached) return cached
  if (pending) return pending

  pending = (async () => {
    try {
      cached = (await homeDir()).replace(/[\\/]+$/, '')
    } catch {
      // Not running under Tauri, or the call failed — '.' lets the OS
      // shell resolve to its own default cwd rather than us hard-failing.
      cached = '.'
    } finally {
      pending = null
    }
    return cached
  })()

  return pending
}