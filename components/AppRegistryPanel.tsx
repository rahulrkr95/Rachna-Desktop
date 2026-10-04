// components/AppRegistryPanel.tsx
//
// Viewer for the Installed App Registry (services/appRegistry/) — the
// session-cached list of installed Windows apps (Win32 + Microsoft
// Store/packaged) that backs the agent's `open_app` tool. Shows whether
// the last scan succeeded, is still running, or failed, plus the full
// list of apps it found so a user can confirm something like "does it see
// my copy of Figma" without going through the chat agent at all.

import React, { useEffect, useMemo, useState } from 'react'
import styles from './AppRegistryPanel.module.css'
import { useAppRegistryStore } from '../store/useAppRegistryStore'
import { launchInstalledApp } from '../services/appRegistry/appRegistryService'
import type { InstalledApp } from '../services/appRegistry/types'
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

/** Top-of-panel banner: this IS "does the app registry work" at a glance — a plain dot + count/last-scan is what most users actually want to know before drilling into the list below. */
function StatusBanner() {
  const status        = useAppRegistryStore(s => s.status)
  const apps           = useAppRegistryStore(s => s.apps)
  const error          = useAppRegistryStore(s => s.error)
  const lastScannedAt  = useAppRegistryStore(s => s.lastScannedAt)
  const load           = useAppRegistryStore(s => s.load)
  const refresh        = useAppRegistryStore(s => s.refresh)

  useEffect(() => {
    // Panel opened before the eager App.tsx startup scan finished (or it
    // never ran — e.g. a fresh reload) — kick it off. load() is a no-op
    // if a scan is already in flight or already succeeded.
    if (status === 'idle') load()
  }, [status, load])

  const isWindowsOnlyEmpty = status === 'ready' && apps.length === 0

  return (
    <div className={styles.banner} data-status={status}>
      <StatusDot status={status} />
      <div className={styles.bannerText}>
        {status === 'idle' && <span>Not scanned yet.</span>}
        {status === 'loading' && <span>Scanning installed apps…</span>}
        {status === 'ready' && !isWindowsOnlyEmpty && (
          <span>
            Working — found <strong>{apps.length}</strong> app{apps.length === 1 ? '' : 's'}.
            {lastScannedAt && (
              <span className={styles.bannerMuted}> Last scanned {new Date(lastScannedAt).toLocaleTimeString()}.</span>
            )}
          </span>
        )}
        {isWindowsOnlyEmpty && (
          <span>
            Scan completed but found no apps. The Installed App Registry currently only scans Windows —
            on other platforms `open_app` falls back to its legacy resolver.
          </span>
        )}
        {status === 'error' && (
          <span>
            Not working — the last scan failed{error ? `: ${error}` : '.'} `open_app` will fall back to its
            legacy resolver in the meantime.
          </span>
        )}
      </div>
      <button
        className={styles.btn}
        onClick={() => refresh()}
        disabled={status === 'loading'}
        title="Re-scan installed apps"
      >
        {status === 'loading' ? 'Scanning…' : '↺ Rescan'}
      </button>
    </div>
  )
}

function KindBadge({ kind }: { kind: InstalledApp['kind'] }) {
  return (
    <span className={`${styles.kindBadge} ${kind === 'packaged' ? styles.kindPackaged : styles.kindWin32}`}>
      {kind === 'packaged' ? 'Packaged' : 'Win32'}
    </span>
  )
}

function AppCard({ app }: { app: InstalledApp }) {
  const [launchState, setLaunchState] = useState<'idle' | 'launching' | 'launched' | 'error'>('idle')
  const addInstalledApp = useChatAppContextStore(s => s.addInstalledApp)
  const alreadyAdded = useChatAppContextStore(
    s => s.items.some(i => i.id === `installed:${app.launchTarget}`)
  )

  const handleLaunch = async () => {
    if (launchState === 'launching') return
    setLaunchState('launching')
    try {
      await launchInstalledApp(app)
      setLaunchState('launched')
    } catch {
      setLaunchState('error')
    } finally {
      setTimeout(() => setLaunchState('idle'), 2000)
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.appName}>{app.name}</span>
        <KindBadge kind={app.kind} />
        <span className={styles.sourceTag}>{app.source}</span>
      </div>
      <div className={styles.launchTarget} title={app.launchTarget}>{app.launchTarget}</div>
      <div className={styles.cardActions}>
        <button className={styles.btn} onClick={handleLaunch} disabled={launchState === 'launching'}>
          {launchState === 'launching' ? 'Launching…' :
           launchState === 'launched'  ? '✓ Launched' :
           launchState === 'error'     ? '⚠ Failed'   :
           'Launch'}
        </button>
        <button
          className={styles.btn}
          onClick={() => addInstalledApp(app)}
          disabled={alreadyAdded}
          title="Add this app's details to the current chat session"
        >
          {alreadyAdded ? '✓ Added to chat' : '+ Add to chat'}
        </button>
      </div>
    </div>
  )
}

export default function AppRegistryPanel({ open, onClose }: Props) {
  const status = useAppRegistryStore(s => s.status)
  const apps   = useAppRegistryStore(s => s.apps)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.source.toLowerCase().includes(q) ||
      a.launchTarget.toLowerCase().includes(q)
    )
  }, [apps, query])

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>🗂</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>Installed App Registry</div>
            <div className={styles.subtitle}>
              Apps the AI agent can open on your machine via <code>open_app</code>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          <StatusBanner />

          {apps.length > 0 && (
            <input
              className={styles.searchInput}
              placeholder="Filter by name, source, or path…"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          )}

          {status === 'loading' && apps.length === 0 && (
            <div className={styles.empty}>Scanning for installed apps…</div>
          )}

          {status !== 'loading' && apps.length === 0 && (
            <div className={styles.empty}>
              No apps to show yet.
            </div>
          )}

          {filtered.length === 0 && apps.length > 0 && (
            <div className={styles.empty}>No apps match “{query}”.</div>
          )}

          {filtered.map(app => (
            <AppCard key={`${app.kind}:${app.launchTarget}`} app={app} />
          ))}
        </div>
      </div>
    </div>
  )
}
