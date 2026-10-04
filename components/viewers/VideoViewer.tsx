// components/viewers/VideoViewer.tsx
import React from 'react'
import styles from './Viewers.module.css'
import { toDataUrl } from './ViewerRegistry'

interface Props {
  name:    string
  mime:    string
  content: string // base64
}

export default function VideoViewer({ name, mime, content }: Props) {
  if (!content) {
    return <div className={styles.emptyState}>No preview available for {name}</div>
  }

  const src = toDataUrl(mime || 'video/mp4', content)

  return (
    <div className={styles.previewSurface}>
      <div className={styles.videoWrap}>
        <video controls src={src} className={styles.videoEl} />
      </div>
    </div>
  )
}
