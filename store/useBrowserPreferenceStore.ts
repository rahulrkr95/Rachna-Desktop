// store/useBrowserPreferenceStore.ts
//
// Drives the in-app "choose your browser" modal used by openDefaultBrowserTool
// when no saved preference exists (or the user asked to change it).
//
// Mirrors useTerminalPermissionStore's design: at most one pending request is
// tracked at a time, and requestPreference() returns a Promise that the agent
// tool awaits. The resolve callback is stashed here and invoked by the modal
// (BrowserPreferenceModal.tsx) when the user submits or cancels — so the
// agent loop is genuinely paused mid-tool-call until the user responds, and
// no browser is ever launched before that happens.

import { create } from 'zustand'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface BrowserPreferenceSelection {
  browser: string
  profile: string
  /** False when the user unchecked "remember this selection". */
  remember: boolean
}

export interface PendingBrowserPreferenceRequest {
  resolve: (selection: BrowserPreferenceSelection | null) => void
}

interface BrowserPreferenceState {
  pendingRequest: PendingBrowserPreferenceRequest | null

  /**
   * Opens the browser/profile picker modal and returns a Promise that
   * resolves once the user submits (Continue) or cancels/closes it.
   * Also brings the Rachna AI Studio window to the foreground so the user
   * isn't left waiting on a paused agent without realizing input is needed.
   */
  requestPreference: () => Promise<BrowserPreferenceSelection | null>

  /** Called by the modal when the user clicks Continue. */
  submit: (selection: BrowserPreferenceSelection) => void

  /** Called by the modal on Cancel, Escape, or closing the overlay. */
  cancel: () => void
}

export const useBrowserPreferenceStore = create<BrowserPreferenceState>((set, get) => ({
  pendingRequest: null,

  requestPreference(): Promise<BrowserPreferenceSelection | null> {
    return new Promise<BrowserPreferenceSelection | null>((resolve) => {
      set({ pendingRequest: { resolve } })

      // Best-effort: keep the app window focused/foregrounded while the
      // agent is paused waiting on this modal. Never blocks the prompt on
      // failure (e.g. non-Tauri/dev contexts).
      getCurrentWindow()
        .setFocus()
        .catch(() => { /* not running under Tauri, or focus unavailable */ })
    })
  },

  submit(selection: BrowserPreferenceSelection) {
    const req = get().pendingRequest
    if (!req) return
    set({ pendingRequest: null })
    req.resolve(selection)
  },

  cancel() {
    const req = get().pendingRequest
    if (!req) return
    set({ pendingRequest: null })
    req.resolve(null)
  },
}))
