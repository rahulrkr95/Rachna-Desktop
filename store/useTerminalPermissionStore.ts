// store/useTerminalPermissionStore.ts
//
// Manages terminal command permission state for the permission-prompt model.
//
// Design:
//   - Session-remembered approvals: commands the user approved with
//     "remember for this session" are stored here and auto-approved on
//     subsequent requests in the same app session (cleared on reload).
//   - Pending request: at most one permission dialog is shown at a time.
//     The agent loop awaits the user's decision via a Promise; the resolve
//     callback is stored here and called by the UI when the user decides.
//
// Thread safety note: the agent loop runs sequential tool calls one at a
// time, so there will never be two overlapping permission requests.
//
// Notification nudge: every permission request in the app — terminal
// commands, open_app/close_app/kill_process (desktopControlTools.ts),
// mouse/keyboard input (inputControlTools.ts) — funnels through this one
// `requestPermission()` (via ctx.requestTerminalPermission), so it's the
// single place to nudge the user with an OS notification when they're not
// looking at the app. services/notify.ts no-ops if the window is focused.
// The notification itself carries real Approve/Reject buttons (Windows) —
// see initPermissionNotificationActions() at the bottom of this file for
// how a click on one of those routes back into approve()/deny() below.

import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { nudgeWithActions } from '../services/notify'
import { useActionAutoApproveStore } from './useActionAutoApproveStore'

export type PermissionDecision = 'approve' | 'deny'

/**
 * Commands whose *description text* alone is not a reliable signal that
 * it's safe to skip the dialog next time — the screen (and, for
 * mouse_click, the exact target under the cursor) can be completely
 * different even when the description happens to read identically, e.g.
 * two "press_key: down" steps in a menu-navigation sequence, or a bare
 * "take_screenshot" call repeated later in the same session. These always
 * show the dialog: no exact-match memory, no "remember for session"
 * prefix carve-out, regardless of what the checkbox says.
 *
 * The Settings > Auto-Approve toggles (useActionAutoApproveStore) are the
 * one explicit exception to that rule — see isAutoApprovedByCategory below.
 */
const ALWAYS_ASK_PREFIXES = ['take_screenshot', 'mouse_click:', 'press_key:']
const SCREENSHOT_PREFIX = 'take_screenshot'
const INPUT_CONTROL_PREFIXES = ['mouse_click:', 'press_key:']

export function isAlwaysAskCommand(command: string): boolean {
  const trimmed = command.trimStart()
  return ALWAYS_ASK_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

/**
 * Checks the user's durable Settings > Auto-Approve toggles for the
 * category this command falls into (terminal / screenshot / mouse &
 * keyboard). Unlike the session-remember mechanism, this applies even to
 * screenshots and mouse/keyboard input — the user has explicitly opted in
 * ahead of time, category by category, rather than the app inferring
 * "this looks the same as before".
 */
export function isAutoApprovedByCategory(command: string): boolean {
  const trimmed = command.trimStart()
  const {
    autoApproveTerminal,
    autoApproveScreenshots,
    autoApproveInputControl,
  } = useActionAutoApproveStore.getState()

  if (trimmed.startsWith(SCREENSHOT_PREFIX)) return autoApproveScreenshots
  if (INPUT_CONTROL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return autoApproveInputControl
  return autoApproveTerminal
}

export interface PendingPermissionRequest {
  /** The full shell command the agent wants to run. */
  command: string
  /** Resolves the awaiting promise in terminalTool.execute. */
  resolve: (decision: PermissionDecision) => void
}

interface TerminalPermissionState {
  // ── Session memory ─────────────────────────────────────────────────────────
  /** Exact command strings approved with "remember for this session". */
  sessionApprovedCommands: Set<string>
  /** Approved command *prefixes* (first word, e.g. "npm") remembered for session. */
  sessionApprovedPrefixes: Set<string>

  // ── Pending dialog ────────────────────────────────────────────────────────
  pendingRequest: PendingPermissionRequest | null

  // ── Actions ───────────────────────────────────────────────────────────────
  /**
   * Returns true if the command is already session-approved and no dialog
   * should be shown. Checks both exact match and remembered prefixes.
   */
  isSessionApproved: (command: string) => boolean

  /**
   * Opens the permission dialog for the given command. Returns a Promise
   * that resolves when the user makes a decision.
   */
  requestPermission: (command: string) => Promise<PermissionDecision>

  /**
   * Called by the PermissionModal when the user approves.
   * If `remember` is true, the command's first token (executable name) is
   * added to the session-approved prefix set so all future invocations of
   * the same tool are auto-approved.
   */
  approve: (remember: boolean) => void

  /** Called by the PermissionModal when the user denies. */
  deny: () => void
}

export const useTerminalPermissionStore = create<TerminalPermissionState>((set, get) => ({
  sessionApprovedCommands: new Set(),
  sessionApprovedPrefixes: new Set(),
  pendingRequest: null,

  isSessionApproved(command: string): boolean {
    if (isAutoApprovedByCategory(command)) return true
    if (isAlwaysAskCommand(command)) return false
    const { sessionApprovedCommands, sessionApprovedPrefixes } = get()
    if (sessionApprovedCommands.has(command)) return true
    const prefix = command.trimStart().split(/\s+/)[0] ?? ''
    return sessionApprovedPrefixes.has(prefix)
  },

  requestPermission(command: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>(resolve => {
      set({ pendingRequest: { command, resolve } })

      const toolName = command.trimStart().split(/\s+/)[0] || 'an action'
      nudgeWithActions(
        'Rachna AI Studio needs your approval',
        `The agent wants to run "${toolName}".`,
        ['Approve', 'Reject'],
      )
    })
  },

  approve(remember: boolean) {
    const req = get().pendingRequest
    if (!req) return

    if (isAlwaysAskCommand(req.command)) {
      // Never memorized — every screenshot/click/keypress asks again next time.
      set({ pendingRequest: null })
      req.resolve('approve')
      return
    }

    if (remember) {
      // Remember the executable prefix so the same tool is auto-approved all session
      const prefix = req.command.trimStart().split(/\s+/)[0] ?? ''
      set(state => ({
        sessionApprovedPrefixes: new Set([...state.sessionApprovedPrefixes, prefix]),
        pendingRequest: null,
      }))
    } else {
      // Remember only this exact invocation
      set(state => ({
        sessionApprovedCommands: new Set([...state.sessionApprovedCommands, req.command]),
        pendingRequest: null,
      }))
    }

    req.resolve('approve')
  },

  deny() {
    const req = get().pendingRequest
    if (!req) return
    set({ pendingRequest: null })
    req.resolve('deny')
  },
}))

// ── Notification button → approve()/deny() ─────────────────────────────────
//
// requestPermission() above fires an OS notification with real Approve/
// Reject buttons (nudgeWithActions → src-tauri/src/action_notifications.rs,
// Windows only — other platforms fall back to plain text and this listener
// just never receives anything for them). Clicking one emits a
// `notification-action` Tauri event carrying that button's label; this
// listener maps it straight onto the same approve()/deny() the in-app
// modal's own buttons call, so either path resolves the one pending
// request the same way. If the request was already resolved via the
// in-app modal by the time a (now-stale) notification is clicked,
// approve()/deny() above are no-ops against a null pendingRequest, so this
// is safe either way.
//
// Call once from App.tsx, mirroring services/notify.ts's
// initNotifyFocusTracking().
let notificationActionListenerInitialized = false

export async function initPermissionNotificationActions(): Promise<void> {
  if (notificationActionListenerInitialized) return
  notificationActionListenerInitialized = true

  try {
    await listen<string>('notification-action', ({ payload: action }) => {
      const store = useTerminalPermissionStore.getState()
      if (action === 'Approve') store.approve(false)
      else if (action === 'Reject') store.deny()
    })
  } catch (e) {
    console.warn('[terminal-permission] failed to attach notification-action listener:', e)
  }
}
