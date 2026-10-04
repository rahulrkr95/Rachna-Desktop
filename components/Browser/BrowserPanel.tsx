import React, { useEffect, useState } from 'react'
import { useBrowserStore } from '../../store/useBrowserStore'
import styles from './BrowserPanel.module.css'

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export default function BrowserPanel() {
  const tabs = useBrowserStore(s => s.tabs)
  const activeTabId = useBrowserStore(s => s.activeTabId)
  const open = useBrowserStore(s => s.open)
  const close = useBrowserStore(s => s.close)
  const activate = useBrowserStore(s => s.activate)
  const navigate = useBrowserStore(s => s.navigate)
  const active = tabs.find(tab => tab.id === activeTabId)
  const [address, setAddress] = useState(active?.url ?? '')
  const [frameKey, setFrameKey] = useState(0)
  useEffect(() => setAddress(active?.url ?? ''), [active?.url])
  useEffect(() => { if (!active && tabs.length === 0) open() }, [active, tabs.length, open])

  const go = () => active && navigate(active.id, normalizeUrl(address))
  return <section className={styles.panel} aria-label="Embedded browser">
    <div className={styles.tabs}>
      {tabs.map(tab => <button key={tab.id} className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''}`} onClick={() => activate(tab.id)}>
        <span className={styles.tabTitle}>{tab.title || 'New tab'}</span>
        <span className={styles.close} role="button" aria-label={`Close ${tab.title}`} onClick={e => { e.stopPropagation(); close(tab.id) }}>×</span>
      </button>)}
      <button className={styles.newTab} onClick={() => open()} title="New browser tab">＋</button>
    </div>
    <form className={styles.toolbar} onSubmit={e => { e.preventDefault(); go() }}>
      <button type="button" onClick={() => history.back()} title="Back">←</button>
      <button type="button" onClick={() => setFrameKey(k => k + 1)} title="Reload">↻</button>
      <span className={styles.security}>◉</span>
      <input value={address} onChange={e => setAddress(e.target.value)} aria-label="Browser address" spellCheck={false} />
      <button type="submit">Go</button>
      <span className={styles.agentBadge} title="Agent browser session">✦ Agent controlled</span>
    </form>
    <div className={styles.content}>
      {!active ? <div className={styles.empty}>Opening browser…</div> : active.screenshotBase64 ? <>
        <img className={styles.screenshot} src={`data:image/png;base64,${active.screenshotBase64}`} alt={`Agent browser capture of ${active.title}`} />
        <div className={styles.captureBadge}>Live agent capture · reload or navigate to interact</div>
      </> : <iframe key={`${active.id}-${active.url}-${frameKey}`} src={active.url} title={active.title || 'Browser tab'} className={styles.frame} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts allow-downloads" />}
      {active?.error && <div className={styles.error}>{active.error}</div>}
    </div>
  </section>
}
