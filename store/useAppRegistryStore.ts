// store/useAppRegistryStore.ts
//
// Reactive (Zustand) wrapper around services/appRegistry/appRegistryService.ts
// — the plain in-memory cache backing the agent's `open_app` tool. That
// module has no notion of "loading"/"error" as observable state (it just
// resolves or rejects a promise), so there was previously no way for any
// UI to show whether the Installed App Registry scan actually succeeded.
// This store adds that: `status` tracks the scan's lifecycle, `apps`
// mirrors the resolved list, and `error` carries the failure message when
// the scan (or the platform's `scan_installed_apps` command) fails — e.g.
// on a non-Windows build, where the registry doesn't apply.
//
// This is the ONLY thing that should call ensureAppRegistryLoaded /
// invalidateAppRegistry going forward, so every consumer (App.tsx's eager
// startup scan, and the AppRegistryPanel UI) observes the same status.

import { create } from 'zustand'
import {
  ensureAppRegistryLoaded,
  getCachedAppRegistry,
  invalidateAppRegistry,
} from '../services/appRegistry/appRegistryService'
import type { InstalledApp } from '../services/appRegistry/types'

export type AppRegistryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface AppRegistryStoreState {
  status: AppRegistryStatus
  apps: InstalledApp[]
  /** Failure message from the most recent scan attempt, if any. Cleared on the next load()/refresh(). */
  error: string | null
  /** Wall-clock time (Date.now()) the last successful scan finished, for "last scanned" display. */
  lastScannedAt: number | null

  // ── Panel open/close (mirrors useMcpStore's panelOpen) ────────────────
  panelOpen: boolean
  openPanel: () => void
  closePanel: () => void

  /** Kicks off the scan if it hasn't run yet (or the last attempt failed); no-op while already loading. Safe to call from multiple places (e.g. App.tsx startup AND the panel mounting) — they share one in-flight scan via appRegistryService's own dedup. */
  load: () => Promise<void>
  /** Forces a fresh scan (e.g. the user just installed something and wants the list updated) and re-runs load(). */
  refresh: () => Promise<void>
}

export const useAppRegistryStore = create<AppRegistryStoreState>((set, get) => ({
  status: getCachedAppRegistry() ? 'ready' : 'idle',
  apps: getCachedAppRegistry() ?? [],
  error: null,
  lastScannedAt: null,
  panelOpen: false,

  openPanel() { set({ panelOpen: true }) },
  closePanel() { set({ panelOpen: false }) },

  async load() {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      const apps = await ensureAppRegistryLoaded()
      set({ status: 'ready', apps, lastScannedAt: Date.now(), error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ status: 'error', error: message })
    }
  },

  async refresh() {
    invalidateAppRegistry()
    await get().load()
  },
}))
