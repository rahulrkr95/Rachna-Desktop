// components/AiChat/TerminalPermissionModal.tsx
//
// Permission notification shown when the agent wants to run an action that
// requires user approval. Matches the existing dark IDE design language.
//
// The notification is rendered at the AiChat level so it
// sits above all chat chrome. It is driven entirely by useTerminalPermissionStore —
// it renders only when pendingRequest is non-null and calls approve/deny when
// the user interacts.
//
// "Remember for this session" checkbox:
//   - Unchecked (default): only this exact command is auto-approved later.
//   - Checked: the tool's executable prefix (first word) is remembered, so
//     all future invocations of the same tool skip the dialog until reload.
//   - Not shown at all for take_screenshot / mouse_click / press_key (see
//     useTerminalPermissionStore's isAlwaysAskCommand) — those always show
//     the dialog, every single time, with no memory of prior approvals in
//     either direction, since two calls with identical-looking descriptions
//     (e.g. "press_key: down" repeated in a menu-navigation sequence) can
//     still be acting on a completely different screen.
//
// Keyboard: Enter → Approve, Escape → Deny.

import React, { useState, useEffect, useRef } from 'react'
import { useTerminalPermissionStore, isAlwaysAskCommand } from '../../store/useTerminalPermissionStore'
import styles from './TerminalPermissionModal.module.css'

export function TerminalPermissionModal() {
  const pendingRequest = useTerminalPermissionStore(s => s.pendingRequest)
  const approve        = useTerminalPermissionStore(s => s.approve)
  const deny           = useTerminalPermissionStore(s => s.deny)
  const [remember, setRemember] = useState(false)
  const approveRef = useRef<HTMLButtonElement>(null)

  // Reset checkbox each time a new request arrives
  useEffect(() => {
    if (pendingRequest) {
      setRemember(false)
      // Focus the approve button so Enter works immediately
      setTimeout(() => approveRef.current?.focus(), 50)
    }
  }, [pendingRequest])

  // Keyboard shortcuts
  useEffect(() => {
    if (!pendingRequest) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); approve(remember) }
      if (e.key === 'Escape')               { e.preventDefault(); deny() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pendingRequest, remember, approve, deny])

  if (!pendingRequest) return null

  const { command } = pendingRequest
  // Derive a human-readable tool name from the first word of the command
  const toolName = command.trimStart().split(/\s+/)[0] ?? 'command'
  const alwaysAsk = isAlwaysAskCommand(command)

  return (
    <div className={styles.notificationWrap} role="alertdialog" aria-live="assertive" aria-label="Agent permission request">
      <div className={styles.notification}>

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className={styles.header}>
          <span className={styles.icon}>⚡</span>
          <span className={styles.title}>Agent permission required</span>
        </div>

        {/* ── Scrollable body ───────────────────────────────────────────
            Everything that can grow with a long/multi-line command lives
            in here. Header above and actions below stay pinned outside
            this scroll container so Approve/Deny never get pushed off
            screen, no matter how long the command is. */}
        <div className={styles.content}>
          <p className={styles.description}>
            The agent wants to perform this action. Review it below and approve or deny from this notification.
          </p>

          <div className={styles.commandBlock}>
            <span className={styles.commandPrompt}>›</span>
            <code className={styles.commandText}>{command}</code>
          </div>

          {/* ── Remember checkbox ────────────────────────────────────── */}
          {alwaysAsk ? (
            <p className={styles.rememberHint}>
              Screenshots, clicks, and key presses always ask — each one can act on a different
              part of the screen, so approving one doesn't cover the next.
            </p>
          ) : (
            <label className={styles.rememberLabel}>
              <input
                type="checkbox"
                className={styles.rememberCheckbox}
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
              />
              <span>
                Remember for this session{' '}
                <span className={styles.rememberHint}>
                  (auto-approve all <code>{toolName}</code> commands until reload)
                </span>
              </span>
            </label>
          )}
        </div>

        {/* ── Actions ────────────────────────────────────────────────── */}
        <div className={styles.actions}>
          <button
            className={styles.denyBtn}
            onClick={deny}
            title="Deny (Esc)"
          >
            ✕ Deny
          </button>
          <button
            ref={approveRef}
            className={styles.approveBtn}
            onClick={() => approve(remember)}
            title="Approve (Enter)"
          >
            ✓ Approve
          </button>
        </div>

        <p className={styles.hint}>Press <kbd>Enter</kbd> to approve · <kbd>Esc</kbd> to deny</p>
      </div>
    </div>
  )
}
