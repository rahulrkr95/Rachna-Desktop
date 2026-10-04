// components/LspSetupPanel.tsx
//
// "Language Servers" panel — the step after Doctor's "Languages" group
// (which gets the compiler/runtime installed). Once a project is open and
// its languages are detected, this is where the matching LSP server
// (hover/go-to-definition/diagnostics) gets downloaded, without leaving
// the app or typing an npm/go/cargo command by hand.
//
// Backed entirely by src-tauri/src/lsp_install.rs's registry — every row
// rendered here comes from `lsp_installer_list`, so adding a language to
// that Rust-side table is the only thing needed to add a row here too.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import styles from './LspSetupPanel.module.css'
import { listLspServers, installLspServer, uninstallLspServer, onLspInstallLog, type LspServerInfo } from '../services/lsp/lspInstaller'

interface Props {
  open: boolean
  onClose: () => void
  projectRoot: string | null
}

const STATUS_META: Record<LspServerInfo['status'], {label: string,  className: string}> = {
  managed:       { label: 'Installed',     className: 'statusOk' },
  path:          { label: 'On PATH',       className: 'statusOk' },
  not_installed: { label: 'Not installed', className: 'statusWarn' },
}
// ── InstallButton ────────────────────────────────────────────────────────
// One per row — handles its own install/uninstall lifecycle and streams
// the backend's progress log (npm/go/cargo output, download progress,
// final ✓/✗ line) into a small scrollable pre block while running.

interface InstallButtonProps {
  server: LspServerInfo
  onChanged: () => void
}

function InstallButton({ server, onChanged }: InstallButtonProps) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const handleInstall = useCallback(async () => {
    setState('running')
    setLog([])
    const unlisten = await onLspInstallLog(server.id, (message) => {
      setLog(prev => [...prev, message])
    })
    try {
      await installLspServer(server.id)
      setState('done')
      setTimeout(onChanged, 800)
    } catch (err) {
      setLog(prev => [...prev, err instanceof Error ? err.message : String(err)])
      setState('error')
    } finally {
      unlisten()
    }
  }, [server.id, onChanged])

  const handleUninstall = useCallback(async () => {
    setState('running')
    try {
      await uninstallLspServer(server.id)
      onChanged()
    } catch (err) {
      setLog([err instanceof Error ? err.message : String(err)])
      setState('error')
    }
  }, [server.id, onChanged])

  const isManual = server.install_method === 'manual'
  const alreadyPresent = server.status !== 'not_installed'

  return (
    <div className={styles.actionWrap}>
      <div className={styles.actionRow}>
        {isManual ? (
          <button
            className={styles.linkBtn}
            onClick={() => window.open(server.official_url, '_blank')}
            title="Open the official install instructions"
          >
            ↗ Official site
          </button>
        ) : !alreadyPresent ? (
          <button
            className={`${styles.installBtn} ${state === 'running' ? styles.running : state === 'error' ? styles.errorBtn : ''}`}
            onClick={handleInstall}
            disabled={state === 'running'}
          >
            {state === 'idle' && '⬇ Download'}
            {state === 'running' && <><span className={styles.spinnerSm} /> Installing…</>}
            {state === 'done' && '✓ Installed'}
            {state === 'error' && '✗ Retry'}
          </button>
        ) : (
          <>
            <span className={styles.presentNote}>
              {server.status === 'path' ? 'Found on system PATH' : 'Downloaded'}
            </span>
            {server.can_uninstall && (
              <button className={styles.uninstallBtn} onClick={handleUninstall} disabled={state === 'running'}>
                {state === 'running' ? '…' : 'Remove'}
              </button>
            )}
          </>
        )}
        <a className={styles.officialLink} href={server.official_url} target="_blank" rel="noreferrer" title="Official project page">
          official ↗
        </a>
      </div>

      {log.length > 0 && (state === 'running' || state === 'error') && (
        <pre ref={logRef} className={`${styles.log} ${state === 'error' ? styles.logError : ''}`}>
          {log.join('\n')}
        </pre>
      )}
    </div>
  )
}

// ── LspSetupPanel ────────────────────────────────────────────────────────

export default function LspSetupPanel({ open, onClose, projectRoot }: Props) {
  const [servers, setServers] = useState<LspServerInfo[] | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listLspServers(projectRoot ?? null)
      setServers(data)
    } catch (err) {
      console.error('Failed to list LSP servers:', err)
      setServers([])
    } finally {
      setLoading(false)
    }
  }, [projectRoot])

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  if (!open) return null

  // Detected-for-this-project rows first, then everything else — same
  // "what matters for you right now" ordering as Doctor's install-all flow.
  const sorted = servers
    ? [...servers].sort((a, b) => Number(b.relevant) - Number(a.relevant) || a.label.localeCompare(b.label))
    : []
  const relevant = sorted.filter(s => s.relevant)
  const other = sorted.filter(s => !s.relevant)

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>🧩</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>Language Servers</div>
            <div className={styles.subtitle}>
              Hover, go-to-definition, and diagnostics for each language — downloaded straight from the official source
            </div>
          </div>
          <button className={styles.refreshBtn} onClick={refresh} disabled={loading}>
            {loading ? 'Checking…' : '↺ Refresh'}
          </button>
          <button className={styles.closeBtn} onClick={onClose} title="Close">✕</button>
        </div>

        <div className={styles.body}>
          {loading && !servers && (
            <div className={styles.loadingRow}>
              <span className={styles.spinner} />
              Checking installed language servers…
            </div>
          )}

          {servers && (
            <>
              {relevant.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>Detected in this project</div>
                  {relevant.map(server => (
                    <ServerRow key={server.id} server={server} onChanged={refresh} />
                  ))}
                </div>
              )}

              <div className={styles.group}>
                <div className={styles.groupLabel}>
                  {relevant.length > 0 ? 'Other languages' : 'All supported languages'}
                </div>
                {other.map(server => (
                  <ServerRow key={server.id} server={server} onChanged={refresh} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ServerRow({ server, onChanged }: { server: LspServerInfo; onChanged: () => void }) {
  const meta = STATUS_META[server.status]
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <span className={`${styles.statusPill} ${styles[meta.className]}`}>{meta.label}</span>
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>{server.label}</div>
          <div className={styles.rowDetail}>{server.lsp_label}{server.location ? ` — ${server.location}` : ''}</div>
        </div>
      </div>
      <InstallButton server={server} onChanged={onChanged} />
    </div>
  )
}
