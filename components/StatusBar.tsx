import React from 'react'
import styles from './StatusBar.module.css'
import { useRepoIndex } from '../store/useRepoIndex'
import { useAutocompleteStore } from '../store/useAutocompleteStore'
import { useAppUpdateStore, restartToApplyUpdate } from '../store/useAppUpdateStore'
import { useAppRegistryStore } from '../store/useAppRegistryStore'

interface Props {
  branch:            string
  language:          string
  onTerminalToggle?: () => void
  terminalOpen?:     boolean
  onPathViewerToggle?: () => void
  pathViewerOpen?:     boolean
}

export default function StatusBar({ branch, language, onTerminalToggle, terminalOpen, onPathViewerToggle, pathViewerOpen }: Props) {
  const indexStatus    = useRepoIndex(s => s.status)
  const indexError     = useRepoIndex(s => s.error)
  const parseErrCount  = useRepoIndex(s => s.parseErrorCount)
  const lastIndexedAt  = useRepoIndex(s => s.lastIndexedAt)

  const acEnabled = useAutocompleteStore(s => s.enabled)
  const acToggle  = useAutocompleteStore(s => s.toggle)

  const appRegistryStatus   = useAppRegistryStore(s => s.status)
  const appRegistryAppCount = useAppRegistryStore(s => s.apps.length)
  const appRegistryError    = useAppRegistryStore(s => s.error)
  const openAppRegistryPanel = useAppRegistryStore(s => s.openPanel)

  const appUpdateStatus   = useAppUpdateStore(s => s.status)
  const appUpdateVersion  = useAppUpdateStore(s => s.version)
  const appUpdateProgress = useAppUpdateStore(s => s.progressPercent)
  const installUpdate     = useAppUpdateStore(s => s.installUpdate)

  const autoUpdateActive = appUpdateStatus !== 'idle' && appUpdateStatus !== 'up-to-date' && appUpdateStatus !== 'error'

  // ── Index status segment ─────────────────────────────────────────────────
  const indexLabel =
    indexStatus === 'indexing'   ? '⟳ indexing…' :
    indexStatus === 'refreshing' ? '⟳ refreshing…' :
    indexStatus === 'ready'      ? '✦ indexed' :
    indexStatus === 'error'      ? '⚠ index error' :
    null

  const indexTitle =
    indexStatus === 'error'
      ? (indexError ?? 'Repo index failed')
      : lastIndexedAt
        ? `Last indexed: ${new Date(lastIndexedAt).toLocaleTimeString()}`
        : 'Repo index'

  // ── Installed App Registry status segment ───────────────────────────────
  // Surfaces whether the agent's `open_app` backing scan (Win32 +
  // Microsoft Store/packaged apps) actually succeeded — see
  // store/useAppRegistryStore.ts / components/AppRegistryPanel.tsx.
  const appRegistryLabel =
    appRegistryStatus === 'loading' ? '⟳ scanning apps…' :
    appRegistryStatus === 'ready'   ? `✦ ${appRegistryAppCount} app${appRegistryAppCount === 1 ? '' : 's'}` :
    appRegistryStatus === 'error'   ? '⚠ app registry error' :
    null

  const appRegistryTitle =
    appRegistryStatus === 'error'
      ? (appRegistryError ?? 'Installed App Registry scan failed')
      : appRegistryStatus === 'ready'
        ? `Installed App Registry: working — ${appRegistryAppCount} app${appRegistryAppCount === 1 ? '' : 's'} found. Click to view.`
        : 'Installed App Registry — click to view'

  return (
    <div className={styles.bar}>
      {/* Branch */}
      <div className={styles.item}>
        <span className={`${styles.dot} ${styles.dotGreen}`} />
        <span className={styles.branch}>⎇ {branch}</span>
      </div>

      {/* Repo index status — only when a folder is open */}
      {indexLabel && (
        <div
          className={`${styles.item} ${styles.indexItem}`}
          data-status={indexStatus}
          title={indexTitle}
        >
          <span
            className={`${styles.dot} ${
              indexStatus === 'ready'      ? styles.dotGreen :
              indexStatus === 'error'      ? styles.dotRed   :
              /* indexing / refreshing */    styles.dotAmber
            }`}
          />
          <span className={styles.indexLabel}>{indexLabel}</span>
        </div>
      )}

      {/* Per-file parse errors from ts-morph (shown when > 0) */}
      {indexStatus === 'ready' && parseErrCount > 0 && (
        <div
          className={`${styles.item} ${styles.parseErrItem}`}
          title={`${parseErrCount} file${parseErrCount === 1 ? '' : 's'} failed to parse during indexing`}
        >
          <span className={`${styles.dot} ${styles.dotAmber}`} />
          {parseErrCount} parse {parseErrCount === 1 ? 'error' : 'errors'}
        </div>
      )}

      <div className={styles.spacer} />

      {autoUpdateActive && (
        <div
          className={`${styles.item} ${styles.updateItem}`}
          title={
            appUpdateStatus === 'available'   ? `Update to ${appUpdateVersion} — click to download` :
            appUpdateStatus === 'downloading' ? `Downloading update${appUpdateProgress != null ? ` — ${appUpdateProgress}%` : '…'}` :
            /* ready */                          'Update downloaded — click to restart and apply'
          }
          onClick={() => {
            if (appUpdateStatus === 'available') installUpdate().catch(e => console.error('[StatusBar] update install failed:', e))
            if (appUpdateStatus === 'ready') restartToApplyUpdate().catch(e => console.error('[StatusBar] restart failed:', e))
          }}
          role="button"
          tabIndex={0}
          onKeyDown={e => {
            if (e.key !== 'Enter') return
            if (appUpdateStatus === 'available') installUpdate().catch(err => console.error('[StatusBar] update install failed:', err))
            if (appUpdateStatus === 'ready') restartToApplyUpdate().catch(err => console.error('[StatusBar] restart failed:', err))
          }}
          style={{ cursor: appUpdateStatus === 'downloading' ? 'default' : 'pointer' }}
        >
          <span className={`${styles.dot} ${styles.dotCyan}`} />
          {appUpdateStatus === 'available' && `Update to ${appUpdateVersion} available`}
          {appUpdateStatus === 'downloading' && `Downloading update${appUpdateProgress != null ? ` ${appUpdateProgress}%` : '…'}`}
          {appUpdateStatus === 'ready' && 'Restart to update'}
        </div>
      )}

      {/* AI Autocomplete toggle */}
      <div
        className={`${styles.item} ${styles.acToggle} ${acEnabled ? styles.acOn : styles.acOff}`}
        onClick={acToggle}
        title={acEnabled ? 'AI autocomplete ON — click to disable' : 'AI autocomplete OFF — click to enable'}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && acToggle()}
        style={{ cursor: 'pointer', userSelect: 'none' }}
      >
        <span className={`${styles.dot} ${acEnabled ? styles.dotCyan : styles.dotGray}`} />
        AI
      </div>

      <div className={styles.item}>UTF-8</div>
      <div className={styles.item}>{language ? language.toUpperCase() : ''}</div>
      <div className={styles.item}>Spaces: 2</div>

      {/* Path Viewer toggle button — open any file path directly in the studio */}
      {onPathViewerToggle && (
        <div
          className={`${styles.item} ${styles.terminalToggle} ${pathViewerOpen ? styles.terminalOn : ''}`}
          onClick={onPathViewerToggle}
          title={pathViewerOpen ? 'Hide path viewer (Ctrl+Shift+O)' : 'Open a file path (Ctrl+Shift+O)'}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && onPathViewerToggle()}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          📄 Open Path
        </div>
      )}

      {/* Terminal toggle button */}
      {onTerminalToggle && (
        <div
          className={`${styles.item} ${styles.terminalToggle} ${terminalOpen ? styles.terminalOn : ''}`}
          onClick={onTerminalToggle}
          title={terminalOpen ? 'Hide terminal (Ctrl+`)' : 'Open terminal (Ctrl+`)'}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && onTerminalToggle()}
          style={{ cursor: 'pointer', userSelect: 'none' }}
        >
          ⌨ Terminal
        </div>
      )}
    </div>
  )
}
