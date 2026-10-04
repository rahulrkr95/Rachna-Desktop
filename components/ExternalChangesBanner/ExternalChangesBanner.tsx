// components/ExternalChangesBanner/ExternalChangesBanner.tsx
//
// Top-bar notification shown when the file watcher detects changes made
// OUTSIDE the IDE (another editor, `git checkout`, a CLI tool, a build
// script, etc). The app's own writes never reach this banner — see
// selfWriteTracker.ts / useFileWatcher.ts for how those are filtered out.
//
// The index is intentionally NOT auto-refreshed on external changes; the
// user decides when to pay the reindex cost by clicking "Reindex".

import React from 'react'
import { useExternalChangesStore } from '../../services/externalChanges/ExternalChangesStore'
import styles from './ExternalChangesBanner.module.css'

export default function ExternalChangesBanner() {
  const visible      = useExternalChangesStore(s => s.visible)
  const pendingPaths = useExternalChangesStore(s => s.pendingPaths)
  const reindexing   = useExternalChangesStore(s => s.reindexing)
  const reindexNow    = useExternalChangesStore(s => s.reindexNow)
  const dismiss        = useExternalChangesStore(s => s.dismiss)

  if (!visible || pendingPaths.length === 0) return null

  const fileWord = pendingPaths.length === 1 ? 'file' : 'files'
  const firstName = pendingPaths[0].replace(/\\/g, '/').split('/').pop()
  const detail = pendingPaths.length === 1
    ? firstName
    : `${firstName} + ${pendingPaths.length - 1} more`

  return (
    <div className={styles.banner} role="status">
      <span className={styles.icon}>⟲</span>
      <span className={styles.text}>
        <strong>{pendingPaths.length}</strong> {fileWord} changed outside the editor
        <span className={styles.detail} title={pendingPaths.join('\n')}> · {detail}</span>
      </span>
      <div className={styles.actions}>
        <button
          className={`${styles.btnReindex} ${reindexing ? styles.reindexing : ''}`}
          onClick={() => reindexNow()}
          disabled={reindexing}
        >
          {reindexing ? <><span className={styles.spinner} /> Reindexing…</> : '⟲ Reindex'}
        </button>
        <button
          className={styles.btnDismiss}
          onClick={dismiss}
          disabled={reindexing}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
