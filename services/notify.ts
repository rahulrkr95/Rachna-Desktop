// services/notify.ts
//
// Single choke point for "the app wants the user's attention right now, but
// they may not be looking at it" — used for permission-approval prompts
// (useTerminalPermissionStore) and agent task-completion pings.
//
// Reuses the existing `show_notification` Tauri command (src-tauri/src/
// desktop_task.rs), which is already wired up for the agent's own
// desktop_task notification tool — we just call the same command from the
// app shell itself instead of only from agent tool calls.
//
// Focus tracking:
//   - `initNotifyFocusTracking()` is called once from App.tsx and wires up
//     a Tauri window `onFocusChanged` listener. It's the source of truth
//     for "is the OS actually looking at our window" — cheaper and more
//     reliable than `document.hasFocus()`, which doesn't reflect OS-level
//     focus/minimized/compact state consistently across platforms.
//   - The orb/chat views (services/viewModeWindow.ts) count as focused whenever
//     the OS reports focus on it — the point of a nudge is to pull the
//     user back when they're looking at something else entirely, not to
//     spam them while the mini widget itself has focus.

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

let focused = true
let initialized = false

/** Wires up OS-level focus tracking. Safe to call multiple times — only the first call attaches the listener. */
export async function initNotifyFocusTracking(): Promise<void> {
  if (initialized) return
  initialized = true

  try {
    const win = getCurrentWindow()
    focused = await win.isFocused()
    await win.onFocusChanged(({ payload }) => {
      focused = payload
    })
  } catch (e) {
    // Non-Tauri/dev-browser context, or the API isn't available — fall back
    // to assuming focused, so we never nudge annoyingly in environments we
    // can't verify.
    console.warn('[notify] focus tracking unavailable:', e)
  }
}

/**
 * Shows a native OS notification nudging the user back to the app, but
 * only when the window doesn't currently have OS focus — never spams a
 * notification on top of an already-visible app.
 */
export async function nudge(title: string, body: string): Promise<void> {
  if (focused) return
  try {
    await invoke('show_notification', { title, body })
  } catch (e) {
    console.warn('[notify] failed to show notification:', e)
  }
}

/** Automation notifications are shown even while focused; optional sound respects both global and per-job settings. */
export async function notify(title: string, body: string, soundEnabled = true): Promise<void> {
  try {
    await invoke('show_notification', { title, body })
    if (soundEnabled && localStorage.getItem('rachna_ide_automation_sound') !== 'false') {
      const audio = new Audio('data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA')
      await audio.play().catch(() => undefined)
    }
  } catch (e) {
    console.warn('[notify] failed to show automation notification:', e)
  }
}

/**
 * Same as `nudge`, but for prompts that need the user to pick one of a
 * small set of choices — e.g. `['Approve', 'Reject']` for a terminal-
 * permission request. On Windows this renders as real, clickable buttons
 * on the notification itself (see src-tauri/src/action_notifications.rs);
 * clicking one fires a `notification-action` Tauri event with that
 * button's label, which `initPermissionNotificationActions()` in
 * store/useTerminalPermissionStore.ts turns into the same approve()/deny()
 * call the in-app modal's own buttons use. On platforms without native
 * button support, the choices are appended to the body text instead, same
 * as before — the user still has to switch back to the app to act on it.
 */
export async function nudgeWithActions(title: string, body: string, actions: string[]): Promise<void> {
  if (focused) return
  try {
    await invoke('show_action_notification', { title, body, actions })
  } catch (e) {
    console.warn('[notify] failed to show action notification:', e)
  }
}
