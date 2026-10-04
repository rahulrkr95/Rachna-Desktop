// store/useAppManagerStore.ts
//
// Reactive (Zustand) wrapper around services/appManager/appManager.ts — the
// in-memory snapshot of *currently running* apps on the machine (as
// opposed to useAppRegistryStore, which tracks *installed* apps). Backs
// the App Manager panel UI so a user can see what's running and
// focus/close/kill a process by hand, without going through the chat
// agent's list_running_apps / focus_app / close_app / kill_process tools.
//
// This is the ONLY thing the UI should call refresh()/focus()/close()/kill()
// through — every consumer observes the same status/apps state.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { appManager, type RunningApp } from '../services/appManager/appManager'

export type AppManagerStatus = 'idle' | 'loading' | 'ready' | 'error'

interface CloseAppResult {
  pid: number
  closed: boolean
}

interface AppManagerStoreState {
  status: AppManagerStatus
  apps: RunningApp[]
  /** Failure message from the most recent refresh attempt, if any. Cleared on the next refresh(). */
  error: string | null
  /** Wall-clock time (Date.now()) the last successful refresh finished, for "last updated" display. */
  lastRefreshedAt: number | null
  /** pid currently mid-action (focus/close/kill), so the panel can disable just that row's buttons. */
  pendingPid: number | null

  // ── Panel open/close (mirrors useAppRegistryStore's panelOpen) ────────
  panelOpen: boolean
  openPanel: () => void
  closePanel: () => void

  /** Polls the OS for the current list of running apps. Safe to call repeatedly (e.g. panel mount + manual refresh). */
  refresh: () => Promise<void>
  /** Brings a running app's window to the foreground. Windows only, mirrors the agent's focus_app tool. */
  focus: (pid: number) => Promise<void>
  /** Gracefully asks a running app to close (may prompt the app to save). Windows only, mirrors close_app. */
  close: (pid: number) => Promise<void>
  /** Force-terminates a process by pid when a graceful close isn't working. Mirrors kill_process. */
  kill: (pid: number) => Promise<void>
}

export const useAppManagerStore = create<AppManagerStoreState>((set, get) => ({
  status: 'idle',
  apps: [],
  error: null,
  lastRefreshedAt: null,
  pendingPid: null,
  panelOpen: false,

  openPanel() { set({ panelOpen: true }) },
  closePanel() { set({ panelOpen: false }) },

  async refresh() {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      await appManager.refresh()
      set({ status: 'ready', apps: appManager.getAll(), lastRefreshedAt: Date.now(), error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ status: 'error', error: message })
    }
  },

  async focus(pid: number) {
    set({ pendingPid: pid })
    try {
      await invoke<number>('focus_app', { pid, appName: null, maximize: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ pendingPid: null })
    }
  },

  async close(pid: number) {
    set({ pendingPid: pid })
    try {
      await invoke<CloseAppResult>('close_app', { pid, appName: null })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ pendingPid: null })
      await get().refresh()
    }
  },

  async kill(pid: number) {
    set({ pendingPid: pid })
    try {
      await invoke<boolean>('kill_process', { pid })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ pendingPid: null })
      await get().refresh()
    }
  },
}))
