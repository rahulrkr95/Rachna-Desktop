// components/AiChat/AttachmentViewerPanel.tsx
//
// Slide-over panel for viewing a "code attachment" chip (see MarkdownRenderer's
// CodeBlock). Mounted once at the AiChat root — driven entirely by
// useAttachmentViewer so any message's attachment chip can open it.

import React, { useState } from 'react'
import styles from './AttachmentViewerPanel.module.css'
import { useAttachmentViewer } from '../../store/useAttachmentViewer'
import { useEditorStore } from '../../store/useEditorStore'
import { saveFileAs } from '../../lib/tauriFs'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function AttachmentViewerPanel() {
  const open    = useAttachmentViewer(s => s.open)
  const current = useAttachmentViewer(s => s.current)
  const close   = useAttachmentViewer(s => s.closeAttachment)
  const openTab = useEditorStore(s => s.openTab)

  const [copied, setCopied]     = useState(false)
  const [saving, setSaving]     = useState(false)
  const [saveErr, setSaveErr]   = useState<string | null>(null)

  if (!open || !current) return null

  const { fileName, lang, content, id } = current
  const lines = content.trimEnd().split('\n')

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const handleOpenInEditor = () => {
    openTab({
      id:       `chat-attachment:${id}`,
      name:     fileName,
      lang:     fileName.split('.').pop() || lang || 'txt',
      content,
      modified: false,
      kind:     'text',
      mime:     'text/plain',
      size:     content.length,
    })
    close()
  }

  const handleSaveAs = async () => {
    setSaving(true)
    setSaveErr(null)
    try {
      await saveFileAs(content, fileName)
    } catch (e) {
      setSaveErr(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.backdrop} onClick={close}>
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.icon}>📄</span>
          <div className={styles.headerInfo}>
            <span className={styles.fileName}>{fileName}</span>
            <span className={styles.meta}>{lines.length} lines · {formatSize(content.length)}</span>
          </div>
          <button className={styles.closeBtn} onClick={close} title="Close">✕</button>
        </div>

        <div className={styles.toolbar}>
          <button className={styles.actionBtn} onClick={handleOpenInEditor}>
            Open in Editor
          </button>
          <button className={styles.actionBtn} onClick={handleSaveAs} disabled={saving}>
            {saving ? 'Saving…' : 'Save As…'}
          </button>
          <button className={styles.actionBtn} onClick={handleCopy}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        {saveErr && <div className={styles.error}>{saveErr}</div>}

        <pre className={styles.body}>
          {lines.map((line, i) => (
            <div key={i} className={styles.line}>
              <span className={styles.lineNo}>{i + 1}</span>
              <span className={styles.lineText}>{line || '\u00A0'}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
