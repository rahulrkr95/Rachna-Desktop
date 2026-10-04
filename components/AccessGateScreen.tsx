// components/AccessGateScreen.tsx
//
// Full-screen gate for an unsupported Studio version.
//
// Visually mirrors LoginScreen so these feel like part of the same gate
// sequence rather than a bolted-on error page.

import React, { useState } from 'react'
import { open } from '@tauri-apps/plugin-shell'
import { exit } from '@tauri-apps/plugin-process'
import styles from './AccessGateScreen.module.css'

export type AccessGateKind = 'update'

interface Props {
  kind: AccessGateKind
  title: string
  message: string
  /** If provided, renders a primary button that opens this URL in the system browser. */
  actionUrl?: string
  actionLabel?: string
}

const ICONS: Record<AccessGateKind, string> = {
  update: '⇪',
}

export default function AccessGateScreen({ kind, title, message, actionUrl, actionLabel }: Props) {
  const [opening, setOpening] = useState(false)

  const handleAction = async () => {
    if (!actionUrl || opening) return
    setOpening(true)
    try {
      await open(actionUrl)
    } catch (e) {
      console.error('[AccessGateScreen] Failed to open URL:', e)
    } finally {
      setOpening(false)
    }
  }

  const handleQuit = async () => {
    try {
      await exit(0)
    } catch (e) {
      console.error('[AccessGateScreen] Failed to quit:', e)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.logoRow}>
          <div className={styles.logoIcon} aria-hidden>✦</div>
          <span className={styles.logoText}>Rachna</span>
          <span className={styles.logoAccent}>IDE</span>
        </div>

        <div className={styles.badge} data-kind={kind} aria-hidden>{ICONS[kind]}</div>

        <h1 className={styles.title}>{title}</h1>
        <p className={styles.message}>{message}</p>

        <div className={styles.actions}>
          {actionUrl && (
            <button className={styles.primaryBtn} onClick={handleAction} disabled={opening}>
              {opening ? 'Opening…' : (actionLabel || 'Continue')}
            </button>
          )}
        </div>

        <button className={styles.quitBtn} onClick={handleQuit}>Quit</button>

        <p className={styles.version}>Rachna IDE · rachna-ai.in</p>
      </div>
    </div>
  )
}
