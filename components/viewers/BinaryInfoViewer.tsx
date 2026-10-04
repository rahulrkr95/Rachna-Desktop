// components/viewers/BinaryInfoViewer.tsx
import React from 'react'
import styles from './Viewers.module.css'

interface Props {
  name:     string
  mime:     string
  size?:    number
  modified?: number | null
  path:     string
}

export default function BinaryInfoViewer({ name, mime, size, modified, path }: Props) {
  const ext = name.includes('.') ? name.split('.').pop()!.toUpperCase() : '—'

  return (
    <div className={styles.previewSurface}>
      <div className={styles.infoCard}>
        <div className={styles.infoIcon}>{ext.slice(0, 4) || '?'}</div>
        <div className={styles.infoName}>{name}</div>
        <dl className={styles.infoList}>
          <dt>Type</dt>
          <dd>{mime || 'application/octet-stream'}</dd>

          <dt>Size</dt>
          <dd>{size != null ? formatBytes(size) : 'Unknown'}</dd>

          <dt>Modified</dt>
          <dd>{modified ? new Date(modified * 1000).toLocaleString() : 'Unknown'}</dd>

          <dt>Path</dt>
          <dd className={styles.infoPath} title={path}>{path}</dd>
        </dl>
        <div className={styles.infoNote}>
          This file can't be previewed or edited as text.
        </div>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes
  let i = -1
  do { val /= 1024; i++ } while (val >= 1024 && i < units.length - 1)
  return `${val.toFixed(1)} ${units[i]}`
}
