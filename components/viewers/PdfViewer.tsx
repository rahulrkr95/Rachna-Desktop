// components/viewers/PdfViewer.tsx
import React from 'react'
import styles from './Viewers.module.css'
import { toDataUrl } from './ViewerRegistry'

interface Props {
  name:    string
  mime:    string
  content: string // base64
}

export default function PdfViewer({ name, mime, content }: Props) {
  if (!content) {
    return <div className={styles.emptyState}>No preview available for {name}</div>
  }

  const src = toDataUrl(mime || 'application/pdf', content)

  return (
    <div className={styles.previewSurface}>
      <object data={src} type="application/pdf" className={styles.pdfFrame}>
        <div className={styles.emptyState}>
          PDF preview isn't supported in this view.{' '}
          <a href={src} download={name} className={styles.link}>Download {name}</a>
        </div>
      </object>
    </div>
  )
}
