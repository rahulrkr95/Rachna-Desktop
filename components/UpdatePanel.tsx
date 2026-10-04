// components/UpdatePanel.tsx
//
// The single UI surface for app updates. Both the "Check for Updates…"
// Help-menu item and the toolbar Update button (next to the Git branch
// chip in Header.tsx) open this same panel — neither has any update logic
// of its own. All state and actions (check / download+install / restart)
// come from the one centralized store, useAppUpdateStore, so there is
// exactly one place that talks to the Tauri updater plugin.
//
// Behavior:
//   • On open, if nothing has run yet (or the last run finished/failed),
//     kick off a fresh check — this is what makes a *manual* "Check for
//     Updates…" click show "you're up to date" rather than silently
//     reusing whatever the background startup check last saw.
//   • While a check/download is already in flight, opening the panel just
//     shows its current progress instead of restarting it.
//   • Update actions (Check again / Download & Install) are disabled
//     while status is 'checking' or 'downloading', per the requirement
//     that update actions can't be re-triggered mid-flight.

import React, { useEffect } from 'react'
import styles from './UpdatePanel.module.css'
import { useAppUpdateStore, restartToApplyUpdate } from '../store/useAppUpdateStore'

interface Props {
  open: boolean
  onClose: () => void
}

export default function UpdatePanel({ open, onClose }: Props) {
  const status          = useAppUpdateStore(s => s.status)
  const version          = useAppUpdateStore(s => s.version)
  const notes            = useAppUpdateStore(s => s.notes)
  const progressPercent  = useAppUpdateStore(s => s.progressPercent)
  const error             = useAppUpdateStore(s => s.error)
  const checkForUpdate    = useAppUpdateStore(s => s.checkForUpdate)
  const installUpdate     = useAppUpdateStore(s => s.installUpdate)

  const busy = status === 'checking' || status === 'downloading'

  // Fresh manual check on open — but only if nothing is already in
  // progress or already resolved to something worth showing (available /
  // ready). Re-checking on top of an in-flight download would restart it
  // for no reason; re-checking on top of 'available'/'ready' would also
  // just be noise since the user already sees that state.
  useEffect(() => {
    if (!open) return
    if (status === 'idle' || status === 'up-to-date' || status === 'error') {
      checkForUpdate()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const handleRestart = () => {
    restartToApplyUpdate().catch(e => console.error('[UpdatePanel] restart failed:', e))
  }

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>⬆</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>Software Update</div>
            <div className={styles.subtitle}>Rachna AI Studio</div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          {status === 'checking' && (
            <div className={styles.stateRow}>
              <span className={styles.spinner} />
              Checking for updates…
            </div>
          )}

          {status === 'up-to-date' && (
            <div className={styles.stateRow}>
              <span className={styles.checkIcon}>✓</span>
              Rachna AI Studio is up to date.
            </div>
          )}

          {status === 'error' && (
            <>
              <div className={`${styles.stateRow} ${styles.errorRow}`}>
                <span className={styles.errorIcon}>⚠</span>
                Couldn't check for updates.
              </div>
              {error && <div className={styles.errorDetail}>{error}</div>}
            </>
          )}

          {status === 'available' && (
            <>
              <div className={styles.stateRow}>
                <span className={styles.updateIcon}>⬆</span>
                Version {version} is available.
              </div>
              {notes && (
                <div className={styles.notesBox}>
                  <div className={styles.notesLabel}>Release notes</div>
                  <div className={styles.notesText}>{notes}</div>
                </div>
              )}
            </>
          )}

          {status === 'downloading' && (
            <>
              <div className={styles.stateRow}>
                <span className={styles.spinner} />
                Downloading update{version ? ` ${version}` : ''}…
              </div>
              <div className={styles.progressWrap}>
                <div
                  className={styles.progressBar}
                  style={{ width: `${progressPercent ?? 0}%` }}
                />
              </div>
              <div className={styles.progressLabel}>
                {progressPercent != null ? `${progressPercent}%` : 'Starting…'}
              </div>
            </>
          )}

          {status === 'ready' && (
            <div className={styles.stateRow}>
              <span className={styles.checkIcon}>✓</span>
              Update downloaded. Restart to finish installing{version ? ` version ${version}` : ''}.
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className={styles.footer}>
          {(status === 'up-to-date' || status === 'error') && (
            <button className={styles.primaryBtn} onClick={() => checkForUpdate()} disabled={busy}>
              {status === 'error' ? 'Retry' : 'Check Again'}
            </button>
          )}

          {status === 'available' && (
            <button className={styles.primaryBtn} onClick={() => installUpdate()} disabled={busy}>
              Download &amp; Install
            </button>
          )}

          {status === 'downloading' && (
            <button className={styles.primaryBtn} disabled>
              Downloading…
            </button>
          )}

          {status === 'ready' && (
            <>
              <button className={styles.secondaryBtn} onClick={onClose}>Later</button>
              <button className={styles.primaryBtn} onClick={handleRestart}>Restart Now</button>
            </>
          )}

          {status !== 'ready' && (
            <button className={styles.secondaryBtn} onClick={onClose}>
              {status === 'downloading' ? 'Continue in Background' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
