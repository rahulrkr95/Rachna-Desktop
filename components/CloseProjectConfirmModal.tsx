// components/CloseProjectConfirmModal.tsx
//
// Blocking confirmation shown before a project is actually closed (see
// FileExplorer.tsx's close button). Closing a project tears down the repo
// index and every open tab, and the AI agent loses all of that project's
// context for the rest of the session — this is a destructive, easy-to
// -misclick action (it lives right next to "Add folder"/"Open folder" in
// the toolbar), so it gets an explicit confirm step rather than firing
// immediately on click.
//
// Purely presentational + control flow: FileExplorer owns whether it's
// open and what happens on confirm.

import React, { useEffect, useRef } from 'react'
import styles from './CloseProjectConfirmModal.module.css'

interface Props {
  projectName: string
  onConfirm: () => void
  onCancel:  () => void
}

export function CloseProjectConfirmModal({ projectName, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setTimeout(() => confirmRef.current?.focus(), 50)
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  return (
    <div
      className={styles.backdrop}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm close project"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className={styles.dialog}>
        <div className={styles.header}>
          <span className={styles.icon}>⚠</span>
          <span className={styles.title}>Close project?</span>
        </div>

        <p className={styles.body}>
          You're about to close <strong className={styles.projectName}>{projectName}</strong>.
          This will close all open files and disconnect the workspace — the AI will
          lose all context about this project's code for the rest of the session.
        </p>
        <p className={styles.hint}>
          Your files on disk are not affected, and you can reopen the folder at any time.
        </p>

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} className={styles.confirmBtn} onClick={onConfirm}>
            Close Project
          </button>
        </div>
      </div>
    </div>
  )
}
