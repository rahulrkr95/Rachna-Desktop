// components/ConnectorsSettingsPanel.tsx
//
// Settings → Connectors. Shows every registered connector (built-in
// framework, see connectors/registry.ts) as a square tile in a grid —
// mirroring the AI Providers tab's tile grid — with live status. Selecting
// a tile drills down into connect/disconnect, (re)authenticate, and
// permission details for that one connector. Entirely provider-agnostic —
// nothing here mentions GitHub by name.

import React, { useEffect, useState } from 'react'
import { connectorManager, useConnectorManagerRevision } from '../services/connectors/ConnectorManager'
import { registerBuiltInConnectors } from '../connectors/registry'
import type { ConnectorManifest, ConnectorHealth } from '../types/connector'
import { GitHubLogo, GmailLogo, PostgreSQLLogo, SentryLogo, FilesystemLogo } from './ConnectorIcons'
import styles from './ConnectorsSettingsPanel.module.css'

/** Real brand logos for the connectors we actually support today. Anything
 *  not listed here falls back to a plain initial letter. */
function ConnectorIcon({ manifest }: { manifest: ConnectorManifest }) {
  switch (manifest.id) {
    case 'github': return <GitHubLogo size={22} />
    case 'google': return <GmailLogo size={26} />
    case 'postgresql': return <PostgreSQLLogo size={22} />
    case 'sentry': return <SentryLogo size={22} />
    case 'filesystem': return <FilesystemLogo size={22} />
    default: return <>{manifest.icon ?? manifest.name[0]}</>
  }
}

function statusLabel(health: ConnectorHealth | undefined): string {
  switch (health?.status) {
    case 'connected': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'error': return 'Error'
    case 'unauthenticated': return 'Not authenticated'
    default: return 'Disconnected'
  }
}

function statusDotClass(health: ConnectorHealth | undefined): string {
  if (health?.status === 'connected') return styles.dotConnected ?? ''
  if (health?.status === 'connecting') return styles.dotConnecting ?? ''
  if (health?.status === 'error') return styles.dotError ?? ''
  return styles.dotDisconnected ?? ''
}

interface AuthFormProps {
  manifest: ConnectorManifest
  onSubmit: (fields: Record<string, string>) => void
  onCancel: () => void
  busy: boolean
}

function AuthForm({ manifest, onSubmit, onCancel, busy }: AuthFormProps) {
  const [values, setValues] = useState<Record<string, string>>({})
  const fields = manifest.auth.fields ?? []
  // OAuth connectors have no fields to fill in — clicking through opens the
  // browser-based login (see BaseOAuthMcpConnector.authenticate()) instead
  // of saving typed-in values.
  const isOAuth = manifest.auth.type === 'oauth'

  return (
    <div className={styles.addServerForm}>
      {manifest.auth.instructions && <p className={styles.hint}>{manifest.auth.instructions}</p>}
      {fields.map(f => (
        <label key={f.key} className={styles.field}>
          <span>{f.label}</span>
          <input
            type={f.secret ? 'password' : 'text'}
            placeholder={f.placeholder}
            value={values[f.key] ?? ''}
            onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      {manifest.auth.helpUrl && (
        <a href={manifest.auth.helpUrl} target="_blank" rel="noreferrer" className={styles.hint}>
          {isOAuth ? 'Manage access →' : 'Get a token →'}
        </a>
      )}
      <div className={styles.formActions}>
        <button disabled={busy} onClick={() => onSubmit(values)}>
          {busy ? (isOAuth ? 'Opening browser…' : 'Saving…') : (isOAuth ? 'Continue in Browser' : 'Save & Connect')}
        </button>
        <button disabled={busy} onClick={onCancel} className={styles.secondaryBtn}>Cancel</button>
      </div>
    </div>
  )
}

// ── Grid tile (square card) ────────────────────────────────────────────────

interface ConnectorTileProps {
  manifest: ConnectorManifest
  onOpen: () => void
}

function ConnectorTile({ manifest, onOpen }: ConnectorTileProps) {
  useConnectorManagerRevision()
  const health = connectorManager.getHealth(manifest.id)
  const connected = connectorManager.isConnected(manifest.id)
  const comingSoon = !!manifest.comingSoon

  if (comingSoon) {
    return (
      <div
        className={`${styles.connectorTile} ${styles.connectorTileDisabled}`}
        aria-disabled="true"
        title={`${manifest.name} — Coming soon`}
      >
        <div className={styles.comingSoonOverlay}>
          <span className={styles.comingSoonTag}>Coming soon</span>
        </div>

        <div className={styles.connectorTileIcon}>
          <ConnectorIcon manifest={manifest} />
        </div>

        <div className={styles.connectorTileName}>{manifest.name}</div>
        <div className={styles.connectorTileMeta}>Not yet available</div>
      </div>
    )
  }

  return (
    <div
      className={`${styles.connectorTile} ${connected ? styles.connectorTileActive : ''}`}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      role="button"
      tabIndex={0}
      title={`${manifest.name} — ${statusLabel(health)}`}
    >
      <span className={`${styles.connectorTileStatus} ${statusDotClass(health)}`} />

      <div className={styles.connectorTileIcon}>
        <ConnectorIcon manifest={manifest} />
      </div>

      <div className={styles.connectorTileName}>{manifest.name}</div>
      <div className={styles.connectorTileMeta}>{statusLabel(health)}</div>

      <div className={styles.connectorTileBtn}>Details</div>
    </div>
  )
}

// ── Drill-down detail view (connect / reauth / permissions) ────────────────

interface ConnectorDetailProps {
  manifest: ConnectorManifest
  projectRoot: string | null
  onBack: () => void
}

function ConnectorDetail({ manifest, projectRoot, onBack }: ConnectorDetailProps) {
  useConnectorManagerRevision()
  const [authing, setAuthing] = useState(false)
  const [reauthing, setReauthing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [authed, setAuthed] = useState(false)

  const health = connectorManager.getHealth(manifest.id)
  const connected = connectorManager.isConnected(manifest.id)

  useEffect(() => {
    let cancelled = false
    connectorManager.isAuthenticated(manifest.id).then(v => { if (!cancelled) setAuthed(v) })
    return () => { cancelled = true }
  }, [manifest.id, health?.status])

  async function handleConnect() {
    setBusy(true)
    try {
      if (!authed) { setAuthing(true); return }
      await connectorManager.connect(manifest.id, projectRoot)
    } finally {
      setBusy(false)
    }
  }

  async function handleDisconnect() {
    setBusy(true)
    try { await connectorManager.disconnect(manifest.id) } finally { setBusy(false) }
  }

  async function handleAuthSubmit(fields: Record<string, string>) {
    setBusy(true)
    try {
      await connectorManager.authenticate(manifest.id, fields)
      setAuthing(false)
      setAuthed(true)
      await connectorManager.connect(manifest.id, projectRoot)
    } catch (err) {
      // surfaced via health.lastError after the failed connect attempt
    } finally {
      setBusy(false)
    }
  }

  async function handleReauthSubmit(fields: Record<string, string>) {
    setBusy(true)
    try {
      await connectorManager.reauthenticate(manifest.id, fields)
      setReauthing(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.detailPanel}>
      <button className={styles.backBtn} onClick={onBack} type="button">← Back</button>

      <div className={styles.serverCard}>
        <div className={styles.serverHeader}>
          <div className={styles.serverHeaderMain}>
            <span className={`${styles.statusDot} ${statusDotClass(health)}`} />
            <div>
              <div className={styles.serverName}>{manifest.name}</div>
              <div className={styles.serverMeta}>{statusLabel(health)}</div>
            </div>
          </div>
          <div className={styles.serverActions}>
            {connected ? (
              <button disabled={busy} onClick={handleDisconnect}>Disconnect</button>
            ) : (
              <button disabled={busy} onClick={handleConnect}>Connect</button>
            )}
            {authed && (
              <button disabled={busy} onClick={() => setReauthing(true)} className={styles.secondaryBtn}>
                Re-authenticate
              </button>
            )}
          </div>
        </div>

        {authing && !authed && (
          <AuthForm manifest={manifest} busy={busy} onSubmit={handleAuthSubmit} onCancel={() => setAuthing(false)} />
        )}
        {reauthing && (
          <AuthForm manifest={manifest} busy={busy} onSubmit={handleReauthSubmit} onCancel={() => setReauthing(false)} />
        )}

        <div className={styles.serverDetails}>
          <p className={styles.hint}>{manifest.description}</p>
          {health?.lastError && <p className={styles.errorText}>Last error: {health.lastError}</p>}
          {health?.lastConnectedAt && (
            <p className={styles.hint}>Last connected: {new Date(health.lastConnectedAt).toLocaleString()}</p>
          )}
          {health?.lastSyncAt && (
            <p className={styles.hint}>Last sync: {new Date(health.lastSyncAt).toLocaleString()}</p>
          )}
          <div>
            <div className={styles.hint}>Permissions requested:</div>
            <ul>
              {manifest.permissions.map(p => <li key={p}>{p}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ConnectorsSettingsPanel({ projectRoot }: { projectRoot: string | null }) {
  useConnectorManagerRevision()
  useEffect(() => { registerBuiltInConnectors() }, [])
  const manifests = connectorManager.list()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = selectedId ? manifests.find(m => m.id === selectedId) ?? null : null

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <h3>Connectors</h3>
        <p className={styles.hint}>
          Installed connectors let the AI safely reach external services through the Connector
          Manager — the AI never talks to these services directly.
        </p>
      </div>

      {selected ? (
        <ConnectorDetail manifest={selected} projectRoot={projectRoot} onBack={() => setSelectedId(null)} />
      ) : (
        <>
          {manifests.length === 0 && <p className={styles.hint}>No connectors installed.</p>}
          <div className={styles.connectorGrid}>
            {manifests.map(m => (
              <ConnectorTile key={m.id} manifest={m} onOpen={() => setSelectedId(m.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
