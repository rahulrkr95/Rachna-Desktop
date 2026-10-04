// components/AiChat/PendingToggleCard.tsx
//
// Rendered inside an AI chat message when a git_action tool call was
// blocked by a Settings → Git safety toggle (autoAllowCommit / autoAllowPush /
// allowDirectPushToMain).
//
// Why this exists: previously the agent would just ask the user, in prose,
// to go flip a setting and reply back ("Done" / "Enabled" / "I enabled it").
// That free-text reply was then run through intent classification like any
// other new message and frequently got misrouted (e.g. into DESKTOP_TASK),
// silently abandoning the pending git operation.
//
// Instead, a blocked tool call attaches structured `pendingToggle` data to
// the message. This component renders an actual toggle switch — flipping it
// updates the real setting AND automatically resumes the exact same workflow
// (see useChat's resolvePendingToggle), with zero free-text round-trip and
// therefore nothing for the intent classifier to misinterpret.

import React from 'react'
import styles from './PendingToggleCard.module.css'

interface Props {
  msgId:       string
  settingKey:  'autoAllowCommit' | 'autoAllowPush' | 'allowDirectPushToMain'
  label:       string
  resolved:    boolean
  disabled:    boolean
  /**
   * True when this seat lacks `canConfigurePermissions`. The toggle switch
   * is replaced with a locked notice. This is the
   * same permission setting Settings → Git gates, reached through this
   * alternate in-chat path, so it must be gated identically. `onResolve` is
   * never wired up to fire in this state.
   */
  locked?:     boolean
  onResolve:   (msgId: string, settingKey: 'autoAllowCommit' | 'autoAllowPush' | 'allowDirectPushToMain') => void
}

export function PendingToggleCard({ msgId, settingKey, label, resolved, disabled, locked = false, onResolve }: Props) {
  return (
    <div className={`${styles.card} ${resolved ? styles.cardResolved : ''}`}>
      <div className={styles.row}>
        <div className={styles.textCol}>
          <span className={styles.icon}>{resolved ? '✓' : '🔒'}</span>
          <div>
            <div className={styles.title}>
              {resolved
                ? `"${label}" enabled`
                : locked
                  ? 'Action needs a permission change'
                  : 'Action needs your approval'}
            </div>
            <div className={styles.subtitle}>
              {resolved
                ? 'Resuming the pending git action…'
                : locked
                  ? `Permission configuration is not available for this account. Ask an administrator to enable "${label}".`
                  : `Turn on "${label}" in Settings → Git to let the agent continue.`}
            </div>
          </div>
        </div>

        {!resolved && (
          locked ? (
            <span className={styles.icon} title="Permission configuration is unavailable">🔒</span>
          ) : (
            <button
              type="button"
              role="switch"
              aria-checked={false}
              aria-label={`Enable ${label}`}
              className={styles.toggle}
              disabled={disabled}
              onClick={() => onResolve(msgId, settingKey)}
              title={`Enable "${label}" and retry`}
            >
              <span className={styles.toggleKnob} />
            </button>
          )
        )}
      </div>
    </div>
  )
}
