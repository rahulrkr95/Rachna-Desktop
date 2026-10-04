// services/appRegistry/appRegistryService.ts
//
// Session-cached registry of installed Windows applications (Win32 +
// Microsoft Store/packaged), backing the agent's `open_app` tool. Scanned
// once via the Rust `scan_installed_apps` command (src-tauri/src/
// app_registry.rs) — kicked off eagerly at app startup (see App.tsx) — and
// kept in memory for the rest of the session, so every subsequent
// open_app call is a fast in-memory lookup rather than a fresh
// filesystem/registry scan.
//
// Kept in its own module (rather than folded into desktopTaskTool.ts /
// desktopControlTools.ts) so the Running Window Registry (Part 2 —
// PID/HWND tracking of *currently open* windows, services/windowRegistry/)
// can live alongside this installed-app registry as a sibling module
// without entangling the two.

import { invoke } from '@tauri-apps/api/core'
import type { InstalledApp, TauriInstalledApp } from './types'

let cache: InstalledApp[] | null = null
let inFlight: Promise<InstalledApp[]> | null = null

function fromTauri(raw: TauriInstalledApp): InstalledApp {
  return {
    name: raw.name,
    kind: raw.kind,
    launchTarget: raw.launch_target,
    appUserModelId: raw.app_user_model_id ?? undefined,
    source: raw.source,
  }
}

async function scan(): Promise<InstalledApp[]> {
  const raw = await invoke<TauriInstalledApp[]>('scan_installed_apps')
  return raw.map(fromTauri)
}

/**
 * Triggers the installed-app scan if it hasn't run yet this session (or a
 * previous attempt failed) and resolves with the cached list once ready.
 * Safe to call from multiple places concurrently — every caller shares one
 * in-flight scan rather than kicking off duplicate scans. Intended to be
 * called once, eagerly, at startup (see App.tsx) — callers that just want
 * to use the registry if it's already warm should use
 * `getCachedAppRegistry()` instead.
 */
export async function ensureAppRegistryLoaded(): Promise<InstalledApp[]> {
  if (cache) return cache
  if (!inFlight) {
    inFlight = scan()
      .then((apps) => {
        cache = apps
        return apps
      })
      .catch((err) => {
        // Leave `cache` unset so a later call can retry — e.g. if the very
        // first attempt raced app startup and failed transiently.
        inFlight = null
        throw err
      })
  }
  return inFlight
}

/** Synchronous best-effort read — null until the first successful scan
 *  completes. Most callers should await `ensureAppRegistryLoaded()`
 *  instead; this exists for UI that wants to render "not ready yet"
 *  without awaiting. */
export function getCachedAppRegistry(): InstalledApp[] | null {
  return cache
}

/** Forces a fresh scan the next time the registry is needed (e.g. after
 *  installing a new app mid-session). Not currently wired to any UI —
 *  exposed for completeness / future use. */
export function invalidateAppRegistry(): void {
  cache = null
  inFlight = null
}

/** Launches a registry entry using the mechanism appropriate to its kind
 *  (see `launch_installed_app` in src-tauri/src/app_registry.rs). */
export async function launchInstalledApp(app: InstalledApp, args: string[] = []): Promise<void> {
  await invoke('launch_installed_app', { kind: app.kind, launchTarget: app.launchTarget, args })
}
