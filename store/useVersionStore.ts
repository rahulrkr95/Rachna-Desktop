// store/useVersionStore.ts
//
// App-version state for Rachna IDE. Two independent things live here:
//
// 1. `isBlocked` / `info` — a HARD version gate, now UNUSED by the app shell:
//    the IDE no longer requires signing in, so there is no app-wide gate. An
//    outdated app is told to update inline in the Rachna Cloud sign-in dialog
//    (components/LoginScreen.tsx) when POST /api/auth/login or /api/auth/google
//    answers 426 UPGRADE_REQUIRED, and the IDE keeps working. Kept (with
//    `forceBlocked`) only so a future caller can still raise a full-screen gate.
//
// 2. `currentVersion` — just the running app's own version number, read
//    locally via Tauri (no network call). Used only for a non-blocking
//    "update available" UI.

import { create } from 'zustand'
import { getCurrentAppVersion } from '../lib/appVersion'

export interface AppVersionInfo {
  latestVersion: string
  minSupportedVersion: string
  downloadUrl: string
}

interface VersionState {
  /** True only when the website's login flow rejected this app version. */
  isBlocked: boolean
  info: AppVersionInfo | null
  /** Set when the web login page redirects back with a 426 UPGRADE_REQUIRED
   *  error instead of a session token. */
  forceBlocked: (info: AppVersionInfo) => void

  /** This app's own version (e.g. "0.1.x"), for the non-blocking
   *  "update available" indicator only — not used for gating. */
  currentVersion: string
  loadCurrentVersion: () => Promise<void>
}

export const useVersionStore = create<VersionState>((set) => ({
  isBlocked: false,
  info: null,

  forceBlocked: (info: AppVersionInfo) => {
    set({ isBlocked: true, info })
  },

  currentVersion: '0.0.0',
  loadCurrentVersion: async () => {
    const v = await getCurrentAppVersion()
    set({ currentVersion: v })
  },
}))
