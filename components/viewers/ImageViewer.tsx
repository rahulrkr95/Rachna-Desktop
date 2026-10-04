// components/viewers/ImageViewer.tsx
import React from 'react'
import styles from './Viewers.module.css'
import { toDataUrl } from './ViewerRegistry'

interface Props {
  name:    string
  mime:    string
  content: string // base64
}

export default function ImageViewer({ name, mime, content }: Props) {
  if (!content) {
    return <div className={styles.emptyState}>No preview available for {name}</div>
  }

  const src = toDataUrl(mime, content)

  return (
    <div className={styles.previewSurface}>
      <div className={styles.imageWrap}>
        <img src={src} alt={name} className={styles.image} draggable={false} />
      </div>
    </div>
  )
}
