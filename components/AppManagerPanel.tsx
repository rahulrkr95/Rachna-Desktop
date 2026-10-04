// components/AppManagerPanel.tsx
//
// Viewer/controller for the Running App Manager (services/appManager/) —
// a live snapshot of processes currently running on the machine, each
// with its pid, exe name/path, window title, and visibility/focus state.
// Lets a user see what's running and Focus / Close / Force Quit a process
// by hand — the human-facing counterpart to the agent's list_running_apps
// / focus_app / close_app / kill_process tools.

import React, { useEffect, useMemo, useState } from 'react'
import styles from './AppManagerPanel.module.css'
import { useAppManagerStore } from '../store/useAppManagerStore'
import type { RunningApp } from '../services/appManager/appManager'
import { useChatAppContextStore } from '../store/useChatAppContextStore'

interface Props {
  open: boolean
  onClose: () => void
}

function StatusDot({ status }: { status: 'idle' | 'loading' | 'ready' | 'error' }) {
  const cls =
    status === 'ready'   ? styles.statusDotReady   :
    status === 'loading' ? styles.statusDotLoading :
    status === 'error'   ? styles.statusDotError   :
                            styles.statusDotIdle
  return <span className={`${styles.statusDot} ${cls}`} />
}

/** Top-of-panel banner: "is it working" at a glance, same shape as AppRegistryPanel's StatusBanner. */
function StatusBanner() {
  const status          = useAppManagerStore(s => s.status)
  const apps            = useAppManagerStore(s => s.apps)
  const error           = useAppManagerStore(s => s.error)
  const lastRefreshedAt = useAppManagerStore(s => s.lastRefreshedAt)
  const refresh         = useAppManagerStore(s => s.refresh)

  useEffect(() => {
    if (status === 'idle') refresh()
  }, [status, refresh])

  return (
    <div className={styles.banner} data-status={status}>
      <StatusDot status={status} />
      <div className={styles.bannerText}>
        {status === 'idle' && <span>Not scanned yet.</span>}
        {status === 'loading' && <span>Scanning running apps…</span>}
        {status === 'ready' && (
          <span>
            Working — <strong>{apps.length}</strong> app{apps.length === 1 ? '' : 's'} running.
            {lastRefreshedAt && (
              <span className={styles.bannerMuted}> Last updated {new Date(lastRefreshedAt).toLocaleTimeString()}.</span>
            )}
          </span>
        )}
        {status === 'error' && (
          <span>Not working — the last scan failed{error ? `: ${error}` : '.'}</span>
        )}
      </div>
      <button
        className={styles.btn}
        onClick={() => refresh()}
        disabled={status === 'loading'}
        title="Re-scan running apps"
      >
        {status === 'loading' ? 'Scanning…' : '↺ Refresh'}
      </button>
    </div>
  )
}

function AppRow({ app }: { app: RunningApp }) {
  const pendingPid = useAppManagerStore(s => s.pendingPid)
  const focus      = useAppManagerStore(s => s.focus)
  const close      = useAppManagerStore(s => s.close)
  const kill       = useAppManagerStore(s => s.kill)
  const busy = pendingPid === app.pid
  const addRunningApp = useChatAppContextStore(s => s.addRunningApp)
  const alreadyAdded = useChatAppContextStore(
    s => s.items.some(i => i.id === `running:${app.pid}`)
  )

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.appName} title={app.title || app.exeName}>
          {app.title || app.exeName}
        </span>
        {app.isFocused && <span className={styles.focusBadge}>Focused</span>}
        {!app.isVisible && <span className={styles.hiddenBadge}>Hidden</span>}
        <span className={styles.pidTag}>pid {app.pid}</span>
      </div>
      <div className={styles.exePath} title={app.exePath || app.exeName}>
        {app.exePath || app.exeName}
      </div>
      <div className={styles.cardActions}>
        <button className={styles.btn} onClick={() => focus(app.pid)} disabled={busy}>
          {busy ? '…' : 'Focus'}
        </button>
        <button className={styles.btn} onClick={() => close(app.pid)} disabled={busy}>
          {busy ? '…' : 'Close'}
        </button>
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => kill(app.pid)} disabled={busy}>
          {busy ? '…' : 'Force Quit'}
        </button>
        <button
          className={styles.btn}
          onClick={() => addRunningApp(app)}
          disabled={alreadyAdded}
          title="Add this app's details to the current chat session"
        >
          {alreadyAdded ? '✓ Added to chat' : '+ Add to chat'}
        </button>
      </div>
    </div>
  )
}

export default function AppManagerPanel({ open, onClose }: Props) {
  const status = useAppManagerStore(s => s.status)
  const apps   = useAppManagerStore(s => s.apps)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter(a =>
      a.exeName.toLowerCase().includes(q) ||
      (a.title ?? '').toLowerCase().includes(q) ||
      (a.exePath ?? '').toLowerCase().includes(q)
    )
  }, [apps, query])

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>🗔</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>App Manager</div>
            <div className={styles.subtitle}>
              Apps currently running on your machine — focus, close, or force quit any of them
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          <StatusBanner />

          {apps.length > 0 && (
            <input
              className={styles.searchInput}
              placeholder="Filter by name, title, or path…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          )}

          {status === 'loading' && apps.length === 0 && (
            <div className={styles.empty}>Scanning running apps…</div>
          )}

          {status !== 'loading' && apps.length === 0 && (
            <div className={styles.empty}>No running apps to show yet.</div>
          )}

          {filtered.length === 0 && apps.length > 0 && (
            <div className={styles.empty}>No apps match “{query}”.</div>
          )}

          {filtered.map(app => (
            <AppRow key={app.pid} app={app} />
          ))}
        </div>
      </div>
    </div>
  )
}
