// components/viewers/HtmlDesignView.tsx
//
// Dual view for .html/.htm files: a "Code" mode (the normal Monaco editor)
// and a "Design" mode that renders the current buffer through the same
// Playwright sidecar the agent's browser_check tool uses
// (lib/browser-tool/run.js via render_html_design_preview), so the design
// shows exactly what a real browser would paint — headless here, so it never
// pops up a visible OS window the way browser_check intentionally does.
//
// Design mode renders on-demand (first switch to it, or the Refresh button)
// rather than on every keystroke, since each render is a real subprocess
// screenshot rather than something instant like an iframe reflow.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import styles from './HtmlDesignView.module.css'
import MonacoEditor, { extToLang } from '../MonacoEditor'
import { renderHtmlDesignPreview } from '../../lib/htmlDesignPreview'

type Mode = 'code' | 'design'

interface Props {
  filePath: string
  content: string
  onChange: (value: string) => void
  fontSize: number
  theme: 'dark' | 'light'
  autocompleteEnabled?: boolean
}

/** Directory containing `filePath`, or null for unsaved in-memory files
 *  (see useUnsavedProjectStore's `unsaved://` virtual paths) which have no
 *  real folder — render_html_design_preview falls back to the OS temp dir. */
function dirnameOrNull(filePath: string): string | null {
  if (filePath.startsWith('unsaved://')) return null
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? null : normalized.slice(0, idx)
}

export default function HtmlDesignView({
  filePath,
  content,
  onChange,
  fontSize,
  theme,
  autocompleteEnabled = true,
}: Props) {
  const [mode, setMode]       = useState<Mode>('code')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  // Guards against a stale render landing after the user has already
  // switched files or triggered a newer render.
  const requestIdRef = useRef(0)

  const runRender = useCallback(async () => {
    const thisRequest = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await renderHtmlDesignPreview({
        content,
        baseDir: dirnameOrNull(filePath),
      })
      if (requestIdRef.current !== thisRequest) return
      if (result.ok && result.screenshotBase64) {
        setScreenshot(result.screenshotBase64)
      } else {
        setError(result.error || 'Failed to render preview.')
      }
    } catch (err) {
      if (requestIdRef.current !== thisRequest) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestIdRef.current === thisRequest) setLoading(false)
    }
  }, [content, filePath])

  // Render once whenever the user switches into Design mode.
  useEffect(() => {
    if (mode === 'design') runRender()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, filePath])

  return (
    <div className={styles.wrap}>
      <div className={styles.toggleBar}>
        <div className={styles.toggleGroup}>
          <button
            className={`${styles.toggleBtn} ${mode === 'code' ? styles.toggleBtnActive : ''}`}
            onClick={() => setMode('code')}
          >
            Code
          </button>
          <button
            className={`${styles.toggleBtn} ${mode === 'design' ? styles.toggleBtnActive : ''}`}
            onClick={() => setMode('design')}
          >
            Design
          </button>
        </div>
        {mode === 'design' && (
          <button className={styles.refreshBtn} onClick={runRender} disabled={loading}>
            {loading ? 'Rendering…' : '⟳ Refresh'}
          </button>
        )}
      </div>

      <div className={styles.surface}>
        {mode === 'code' ? (
          <MonacoEditor
            key={filePath}
            value={content}
            language={extToLang(filePath.split('.').pop() ?? 'html')}
            filePath={filePath}
            onChange={onChange}
            fontSize={fontSize}
            theme={theme}
            autocompleteEnabled={autocompleteEnabled}
          />
        ) : (
          <div className={styles.designSurface}>
            {loading && !screenshot && (
              <div className={styles.statusMsg}>Rendering design…</div>
            )}
            {error && (
              <div className={styles.errorMsg}>
                Couldn't render the design preview: {error}
              </div>
            )}
            {screenshot && (
              <div className={styles.designImageWrap}>
                <img
                  src={`data:image/png;base64,${screenshot}`}
                  alt={`Design preview of ${filePath}`}
                  className={styles.designImage}
                  draggable={false}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
