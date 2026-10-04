// components/viewers/AudioViewer.tsx
import React from 'react'
import styles from './Viewers.module.css'
import { toDataUrl } from './ViewerRegistry'

interface Props {
  name:    string
  mime:    string
  content: string // base64
  size?:   number
}

export default function AudioViewer({ name, mime, content, size }: Props) {
  if (!content) {
    return <div className={styles.emptyState}>No preview available for {name}</div>
  }

  const src = toDataUrl(mime || 'audio/mpeg', content)

  return (
    <div className={styles.previewSurface}>
      <div className={styles.mediaCard}>
        <div className={styles.mediaIcon}>♪</div>
        <div className={styles.mediaName}>{name}</div>
        {size != null && <div className={styles.mediaMeta}>{formatBytes(size)}</div>}
        <audio controls src={src} className={styles.audioEl} />
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let val = bytes
  let i = -1
  do { val /= 1024; i++ } while (val >= 1024 && i < units.length - 1)
  return `${val.toFixed(1)} ${units[i]}`
}
