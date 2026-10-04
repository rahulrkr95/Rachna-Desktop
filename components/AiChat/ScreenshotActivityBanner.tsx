import React, { useState } from 'react'
import type { AgentActivity } from '../../services/agent'
import { readFile } from '../../lib/tauriFs'
import { useEditorStore } from '../../store/useEditorStore'
import styles from '../AiChat.module.css'

interface Props {
  activity: AgentActivity
  compact?: boolean
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || 'screenshot.png'
}

export function ScreenshotActivityBanner({ activity, compact = false }: Props) {
  const artifact = activity.artifact?.type === 'screenshot' ? activity.artifact : null
  const openTab = useEditorStore(s => s.openTab)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!artifact) return null

  const handleOpen = async () => {
    if (opening) return
    setOpening(true)
    setError(null)
    try {
      const file = await readFile(artifact.path)
      const name = fileNameFromPath(file.path)
      openTab({
        id: file.path,
        name,
        lang: name.split('.').pop() || 'png',
        content: file.content,
        modified: false,
        kind: file.kind,
        mime: file.mime || 'image/png',
        size: file.size,
        mtime: file.modified ?? null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  return (
    <button
      type="button"
      className={`${styles.screenshotBanner} ${compact ? styles.screenshotBannerCompact : ''}`}
      onClick={handleOpen}
      title={`Open screenshot in IDE: ${artifact.path}`}
    >
      <span className={styles.screenshotBannerIcon}>🖼️</span>
      <span className={styles.screenshotBannerText}>
        <strong>Screenshot captured</strong>
        <span>{artifact.width}×{artifact.height}{artifact.monitor !== undefined ? ` · monitor ${artifact.monitor}` : ''}</span>
        {error && <span className={styles.screenshotBannerError}>Open failed: {error}</span>}
      </span>
      <span className={styles.screenshotBannerAction}>{opening ? 'Opening…' : 'Open'}</span>
    </button>
  )
}
