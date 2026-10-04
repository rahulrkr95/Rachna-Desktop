// components/PathViewer/PathViewerBar.tsx
//
// A slim, dockable bar — same visual weight/position as the Terminal panel
// — where the user can type or paste any file path (absolute, or relative
// to the open project) and hit Enter (or click Open) to open it directly in
// the studio, using the same resolution + Monaco/viewer-registry pipeline
// that clicking a file-path link in an AI chat message already uses (see
// components/AiChat/useFileLink.ts). Supports "path:line" and "path#L12"
// suffixes to jump straight to a line in text files.

import React, { useCallback, useRef, useState } from 'react'
import { useOpenFileLink, useFileLinkStatus } from '../AiChat/useFileLink'
import styles from './PathViewerBar.module.css'

interface PathViewerBarProps {
  onClose: () => void
}

/**
 * Splits a raw "path:line" or "path#L12" token into its path and (optional)
 * line number. Anchored at the end so Windows drive letters ("C:\...")
 * elsewhere in the string aren't mistaken for a line-number separator.
 */
function splitPathAndLine(raw: string): { path: string; line?: number } {
  const match = raw.match(/^(.*?)(?::(\d+)|#L(\d+))$/)
  if (!match) return { path: raw }
  const line = Number(match[2] ?? match[3])
  return { path: match[1], line: Number.isFinite(line) ? line : undefined }
}

const PathViewerBar: React.FC<PathViewerBarProps> = ({ onClose }) => {
  const [value, setValue] = useState('')
  const [recent, setRecent] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const openFile = useOpenFileLink()
  const { path: candidatePath } = splitPathAndLine(value.trim())
  const status = useFileLinkStatus(candidatePath)

  const handleOpen = useCallback(() => {
    const raw = value.trim()
    if (!raw) return
    const { path, line } = splitPathAndLine(raw)
    openFile(path, line)
    setRecent(prev => [raw, ...prev.filter(p => p !== raw)].slice(0, 8))
  }, [value, openFile])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleOpen()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }, [handleOpen, onClose])

  return (
    <div className={styles.bar}>
      <span className={styles.icon} aria-hidden="true">⌘</span>
      <input
        ref={inputRef}
        className={styles.input}
        placeholder="Open a file path… e.g. src/App.tsx or src/App.tsx:42"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
        spellCheck={false}
      />

      {value.trim() && (
        <span
          className={`${styles.status} ${
            status === 'exists' ? styles.statusOk : status === 'missing' ? styles.statusMissing : styles.statusUnknown
          }`}
        >
          {status === 'exists' ? '✓ found' : status === 'missing' ? '✗ not found' : '…'}
        </span>
      )}

      {recent.length > 0 && !value.trim() && (
        <div className={styles.recent}>
          {recent.slice(0, 5).map(p => (
            <button
              key={p}
              className={styles.recentChip}
              onClick={() => { setValue(p); inputRef.current?.focus() }}
              title={`Open ${p} again`}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <button className={styles.openBtn} onClick={handleOpen} disabled={!value.trim()}>
        Open
      </button>
      <button className={styles.closeBtn} onClick={onClose} aria-label="Close path viewer">
        ×
      </button>
    </div>
  )
}

export default PathViewerBar
