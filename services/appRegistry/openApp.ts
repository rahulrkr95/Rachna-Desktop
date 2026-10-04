// services/appRegistry/openApp.ts
//
// Shared open_app resolution, used by both agent-tool entry points —
// services/agent/tools/desktopTaskTool.ts's `desktop_task` open_app action,
// and services/agent/tools/desktopControlTools.ts's standalone `open_app`
// tool — so the "registry first, legacy fallback" logic lives in exactly
// one place instead of being duplicated across both.
//
// Resolution order:
//   1. Installed App Registry (this session's cached `scan_installed_apps`
//      result — services/appRegistry/appRegistryService.ts) — ranked via
//      services/appRegistry/matching.ts's reused keyword/fuzzy scorer.
//   2. Legacy `resolve_app` (Rust: Start Menu .lnk walk + "App Paths"
//      registry substring search) — completely unchanged, used whenever
//      the registry isn't loaded yet, found nothing, or produced no
//      usable (unblocked) candidate.
//
// Part 3 addition: after actually launching a candidate, this module polls
// the Running Window Registry (services/windowRegistry/) for the window
// the launch produced and attaches its real pid/hwnd to the match — the
// launcher never assumes its own return value (or lack thereof — Win32
// launches via `launchInstalledApp`/`open_path` return no pid at all) is
// the pid that ends up owning the visible window. See
// services/windowRegistry/resolveTarget.ts's `waitForAppWindow` doc
// comment for why a fresh poll, not the launch pid, is the source of
// truth here. Best-effort: if no window resolves in time, `pid`/`hwnd`
// are simply omitted rather than failing the whole open_app call — the
// app may still be starting up, or may be a background/tray-only app with
// no top-level window to find.

import { invoke } from '@tauri-apps/api/core'
import { ensureAppRegistryLoaded, launchInstalledApp } from './appRegistryService'
import { pickAppMatch } from './matching'
import type { InstalledApp } from './types'
import { listVisibleWindows } from '../windowRegistry/windowRegistryService'
import { waitForAppWindow } from '../windowRegistry/resolveTarget'

/** Common result shape for a matched app, regardless of which path (the
 *  registry or the legacy resolve_app search) found it — this is what
 *  both tool files already returned to the model before this change, so
 *  it's kept as-is with 'installed_registry' added as a new possible
 *  `source` value. */
export interface LegacyAppMatch {
  name: string
  path: string
  source: 'start_menu' | 'app_paths' | 'installed_registry'
  /**
   * The real pid/hwnd of the window that appeared after launch, resolved
   * via the Running Window Registry (not the launcher's own pid, which
   * may not own any window — e.g. packaged apps launch through
   * explorer.exe, and Win32 launches via the OS default handler return no
   * pid at all). Omitted if no matching window showed up within the
   * resolution window.
   */
  pid?: number
  hwnd?: string
  windowTitle?: string
}

export type OpenAppResolution =
  | { status: 'launched'; match: LegacyAppMatch }
  | { status: 'ambiguous'; matches: LegacyAppMatch[] }
  | { status: 'not_found' }
  /** At least one candidate existed (from the registry and/or the legacy
   *  fallback) but every one of them was rejected by `isBlocked` — distinct
   *  from `not_found` so callers can surface a specific "that's blocked"
   *  message instead of a generic "no app found" one. */
  | { status: 'blocked' }

function toLegacyMatch(app: InstalledApp): LegacyAppMatch {
  return { name: app.name, path: app.launchTarget, source: 'installed_registry' }
}

/**
 * Snapshots the Window Registry, runs `launch`, then polls the registry
 * for the window `windowQuery` (the app's display name) actually produced
 * and attaches its real pid/hwnd to `match`. Shared by all three launch
 * sites below (registry-confident, registry-ambiguous-resolved-to-one,
 * and legacy-fallback) so the "snapshot → launch → poll" sequence lives
 * in exactly one place. Never throws — a window-resolution failure just
 * means `match` comes back without pid/hwnd, not a failed open_app call.
 */
async function launchAndAttachWindow<T extends LegacyAppMatch>(
  windowQuery: string,
  launch: () => Promise<void>,
  match: T
): Promise<T> {
  let before = new Set<string>()
  try {
    before = new Set((await listVisibleWindows()).map((w) => w.hwnd))
  } catch {
    // Best-effort snapshot — proceed without one rather than blocking the launch.
  }

  await launch()

  try {
    const win = await waitForAppWindow(windowQuery, { excludeHwnds: before })
    if (win) {
      return { ...match, pid: win.pid, hwnd: win.hwnd, windowTitle: win.title }
    }
  } catch {
    // No confident window resolved in time — leave pid/hwnd unset.
  }
  return match
}

/**
 * Resolves `query` to an installed application and launches it if a
 * single confident (or unambiguous-after-filtering) candidate is found.
 *
 * `isBlocked`, when supplied, is applied to every candidate's name AND
 * launch target/path — from either the registry or the legacy fallback —
 * so callers can keep enforcing their own safety rules (e.g.
 * desktopTaskTool.ts's terminal-app block list) uniformly regardless of
 * which path produced the match.
 */
export async function resolveAndOpenApp(
  query: string,
  isBlocked?: (value: string | undefined | null) => boolean,
  launchArguments: string[] = []
): Promise<OpenAppResolution> {
  const blocked = isBlocked ?? (() => false)
  let sawBlockedCandidate = false

  // ── 1. Installed App Registry ────────────────────────────────────────
  try {
    const apps = await ensureAppRegistryLoaded()
    if (apps.length > 0) {
      const decision = pickAppMatch(query, apps)

      if (decision.kind === 'confident') {
        if (!blocked(decision.app.name) && !blocked(decision.app.launchTarget)) {
          const match = await launchAndAttachWindow(
            decision.app.name,
            () => launchInstalledApp(decision.app, launchArguments),
            toLegacyMatch(decision.app)
          )
          return { status: 'launched', match }
        }
        // The one confident match was blocked — nothing safe to launch or
        // disambiguate from the registry; fall through to the legacy path.
        sawBlockedCandidate = true
      } else if (decision.kind === 'ambiguous') {
        const safe = decision.candidates.filter(
          (a) => !blocked(a.name) && !blocked(a.launchTarget)
        )
        if (safe.length !== decision.candidates.length) sawBlockedCandidate = true
        if (safe.length === 1) {
          const match = await launchAndAttachWindow(
            safe[0].name,
            () => launchInstalledApp(safe[0], launchArguments),
            toLegacyMatch(safe[0])
          )
          return { status: 'launched', match }
        }
        if (safe.length > 1) {
          return { status: 'ambiguous', matches: safe.map(toLegacyMatch) }
        }
        // Every candidate was blocked — fall through and let the legacy
        // search make its own call rather than assuming it'll also fail.
      }
    }
  } catch {
    // Registry scan failed, or hasn't resolved yet — fall through to the
    // legacy resolver below rather than failing open_app outright.
  }

  // ── 2. Legacy fallback (unchanged resolve_app behavior) ──────────────
  const legacyMatches = await invoke<LegacyAppMatch[]>('resolve_app', { name: query })
  const safeLegacy = legacyMatches.filter((m) => !blocked(m.name) && !blocked(m.path))
  if (safeLegacy.length !== legacyMatches.length) sawBlockedCandidate = true

  if (safeLegacy.length === 0) {
    return sawBlockedCandidate ? { status: 'blocked' } : { status: 'not_found' }
  }
  if (safeLegacy.length === 1) {
    const match = await launchAndAttachWindow(
      safeLegacy[0].name,
      () => launchArguments.length > 0
        ? invoke('launch_app', { appPath: safeLegacy[0].path, args: launchArguments })
        : invoke('open_path', { path: safeLegacy[0].path }),
      safeLegacy[0]
    )
    return { status: 'launched', match }
  }
  return { status: 'ambiguous', matches: safeLegacy }
}
