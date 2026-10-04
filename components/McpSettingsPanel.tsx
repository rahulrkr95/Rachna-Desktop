// components/McpSettingsPanel.tsx
//
// Settings panel for configuring MCP (Model Context Protocol) servers.
// Users define a server by command + args + optional env vars, then
// connect / disconnect it. Connected server tools are picked up by the
// agent loop in the next chat turn automatically.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import styles from './McpSettingsPanel.module.css'
import { useMcpStore, type McpServerConfig, type McpEnvVar } from '../store/useMcpStore'
import { useRepoIndex } from '../store/useRepoIndex'
import {
  resolveGoogleStdioEnvDefaults,
  hasGoogleStdioCredentials,
  googleStdioServiceForEnvKey,
  GOOGLE_OAUTH_CLIENT_ENV_KEYS,
  saveGoogleOAuthClientPath,
  validateGoogleOAuthClientFile,
  installGmailOAuthClient,
} from '../lib/mcp/googleStdioCredentials'
import { pickFile } from '../lib/tauriFs'

// ── Quickstart templates ───────────────────────────────────────────────────
// Pre-filled configs for the most common MCP servers so users don't have to
// look up the npm package names. These are purely UI sugar — no special
// backend treatment.

interface QuickstartTemplate {
  name: string
  desc: string
  command: string
  args: string[]
  env: McpEnvVar[]
  /** Streamable HTTP endpoint. Remote servers are bridged into the existing
   * stdio client with mcp-remote, so tool execution keeps one code path. */
  remoteUrl?: string
  /**
   * Optional hook for env defaults that can only be computed at apply-time
   * (e.g. a persistent on-disk path resolved via a Tauri command) rather
   * than baked into the static `env` array above. Only overrides `env`
   * rows whose `key` is already present — never adds new rows — so this
   * stays purely additive to what the user sees/can edit. Best-effort: if
   * it throws (e.g. not running under Tauri), the quickstart still applies
   * with blank values the user can fill in by hand.
   */
  resolveEnvDefaults?: () => Promise<Record<string, string>>
  /** Extra setup / first-run-auth instructions shown once this template is
   *  selected — for quickstarts whose env vars need a bit more context
   *  than a placeholder can carry (e.g. where to get an OAuth client). */
  notes?: string
}

const QUICKSTARTS: QuickstartTemplate[] = [
  {
    name: 'GitHub',
    desc: 'Read issues, PRs, repos',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '', secret: true }],
  },
  {
    name: 'PostgreSQL',
    desc: 'Query a Postgres database',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: [{ key: 'POSTGRES_CONNECTION_STRING', value: '', secret: true }],
  },
  {
    name: 'Sentry',
    desc: 'Read errors and events',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sentry'],
    env: [{ key: 'SENTRY_AUTH_TOKEN', value: '', secret: true }, { key: 'SENTRY_ORG', value: '', secret: false }],
  },
  {
    name: 'Figma Desktop',
    desc: 'Use the server built into Figma Desktop',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'http://127.0.0.1:3845/mcp'],
    remoteUrl: 'http://127.0.0.1:3845/mcp',
    env: [],
  },
  {
    name: 'Figma Remote',
    desc: 'Connect to Figma’s hosted server',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.figma.com/mcp'],
    remoteUrl: 'https://mcp.figma.com/mcp',
    env: [],
  },
  {
    name: 'Slack',
    desc: 'Search and work with Slack',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.slack.com/mcp'],
    remoteUrl: 'https://mcp.slack.com/mcp',
    env: [],
  },
  {
    name: 'Notion',
    desc: 'Search and update Notion workspaces',
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
    remoteUrl: 'https://mcp.notion.com/mcp',
    env: [],
  },
  {
    name: 'Google Drive',
    desc: 'Search and read Drive files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    env: [{ key: 'GDRIVE_CREDENTIALS_PATH', value: '', secret: false }],
  },
  {
    name: 'Gmail',
    desc: 'Search, read, and send email',
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    // This server manages its own Google sign-in — it is a local process,
    // not a remote server, so it's intentionally NOT wired through
    // services/oauth/OAuthManager.ts (see lib/mcp/googleStdioCredentials.ts
    // for why that split is permanent, not a gap to fill in later).
    // GMAIL_OAUTH_PATH: the user's own Google Cloud OAuth client (Desktop
    // app type) — never fabricated/hardcoded here, see `notes` below.
    // GMAIL_CREDENTIALS_PATH: where the server should cache the token it
    // obtains from its own first-run browser sign-in — pre-filled with a
    // stable, app-managed path so later connections reuse it instead of
    // prompting again.
    env: [
      { key: 'GMAIL_OAUTH_PATH', value: '', secret: false },
      { key: 'GMAIL_CREDENTIALS_PATH', value: '', secret: false },
    ],
    resolveEnvDefaults: () => resolveGoogleStdioEnvDefaults('gmail'),
    notes:
      'Needs a Google Cloud OAuth client of your own: in Google Cloud Console, create an OAuth 2.0 Client ID ' +
      '(Application type: Desktop app) with the Gmail API enabled, download its JSON, and set GMAIL_OAUTH_PATH ' +
      'to that file\u2019s path. GMAIL_CREDENTIALS_PATH is pre-filled — leave it as-is. On first Connect, your ' +
      'browser opens to sign in with Google; once you approve access, the token is cached at that path, so later ' +
      'connections won\u2019t prompt again.',
  },
  {
    name: 'Google Calendar',
    desc: 'Read and manage calendar events',
    command: 'npx',
    args: ['-y', '@cocal/google-calendar-mcp'],
    // Same shape as Gmail above: a local stdio process that drives its own
    // browser-based Google sign-in, not routed through OAuthManager.
    // GOOGLE_OAUTH_CREDENTIALS: the user's own Google Cloud OAuth client.
    // GOOGLE_CALENDAR_MCP_TOKEN_PATH: stable, app-managed token cache path.
    env: [
      { key: 'GOOGLE_OAUTH_CREDENTIALS', value: '', secret: false },
      { key: 'GOOGLE_CALENDAR_MCP_TOKEN_PATH', value: '', secret: false },
    ],
    resolveEnvDefaults: () => resolveGoogleStdioEnvDefaults('google-calendar'),
    notes:
      'Needs a Google Cloud OAuth client of your own: in Google Cloud Console, create an OAuth 2.0 Client ID ' +
      '(Application type: Desktop app) with the Google Calendar API enabled, download its JSON, and set ' +
      'GOOGLE_OAUTH_CREDENTIALS to that file\u2019s path. GOOGLE_CALENDAR_MCP_TOKEN_PATH is pre-filled — leave it ' +
      'as-is. On first Connect, your browser opens to sign in with Google; once you approve access, the token is ' +
      'cached at that path, so later connections won\u2019t prompt again.',
  },
  {
    name: 'Remote Server',
    desc: 'Connect to any Streamable HTTP server',
    command: 'npx',
    args: ['-y', 'mcp-remote'],
    remoteUrl: '',
    env: [],
  },
  {
    name: 'Filesystem',
    desc: 'Browse and read local files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    env: [],
  },
  {
    name: 'Custom',
    desc: 'Define your own server',
    command: '',
    args: [],
    env: [],
  },
]

// ── ServerCard ─────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'connected'    ? styles.statusDotConnected    :
    status === 'connecting' || status === 'authenticating' ? styles.statusDotConnecting :
    status === 'error'        ? styles.statusDotError        :
                                styles.statusDotDisconnected

  return <span className={`${styles.statusDot} ${cls}`} />
}

interface ServerCardProps {
  server: McpServerConfig
  projectRoot: string | null
}

function ServerCard({ server, projectRoot }: ServerCardProps) {
  const runtime     = useMcpStore(s => s.runtime[server.id])
  const connect     = useMcpStore(s => s.connectServer)
  const disconnect  = useMcpStore(s => s.disconnectServer)
  const remove      = useMcpStore(s => s.removeServer)
  const refresh     = useMcpStore(s => s.refreshTools)
  const updateServer = useMcpStore(s => s.updateServer)

  const status   = runtime?.status   ?? 'disconnected'
  const tools    = runtime?.tools    ?? []
  const errMsg   = runtime?.error

  const argsDisplay = [server.command, ...server.args].join(' ')

  // Gmail / Google Calendar (or any hand-configured server reusing their
  // env var names) manage their own first-run Google sign-in — see
  // lib/mcp/googleStdioCredentials.ts. Surface whether that's already
  // happened so "Connect" doesn't come as a surprise browser popup.
  const googleService = server.env.map(e => googleStdioServiceForEnvKey(e.key)).find(Boolean) ?? null
  const [googleAuthed, setGoogleAuthed] = useState<boolean | null>(null)
  useEffect(() => {
    if (!googleService) return
    let cancelled = false
    hasGoogleStdioCredentials(googleService).then(v => { if (!cancelled) setGoogleAuthed(v) })
    return () => { cancelled = true }
  }, [googleService, status])

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <StatusDot status={status} />
        <span className={styles.serverName}>{server.name}</span>
        <span className={styles.statusText}>{status === 'authenticating' ? 'Google authentication required' : status}</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={server.enabled}
            onChange={e => updateServer(server.id, { enabled: e.target.checked })}
          />
          <span className={styles.statusText}>Auto-connect</span>
        </label>
      </div>

      <div className={styles.command}>{argsDisplay}</div>

      {googleService && status !== 'connected' && googleAuthed !== null && (
        <div className={styles.hint}>
          {googleAuthed
            ? '🔑 Reusing your saved Google sign-in — Connect won\u2019t prompt again.'
            : '🌐 First-run sign-in: Connect opens your browser to sign in with Google.'}
        </div>
      )}

      {errMsg && <div className={styles.errorText}>{errMsg}</div>}

      {tools.length > 0 && (
        <div className={styles.toolsList}>
          {tools.slice(0, 12).map(t => (
            <span key={t.name} className={styles.toolPill} title={t.description}>{t.name}</span>
          ))}
          {tools.length > 12 && (
            <span className={styles.toolPill}>+{tools.length - 12} more</span>
          )}
        </div>
      )}

      <div className={styles.cardActions}>
        {status === 'connected' ? (
          <>
            <button className={styles.btn} onClick={() => refresh(server.id)}>↺ Refresh tools</button>
            <button className={styles.btn} onClick={() => disconnect(server.id)}>Disconnect</button>
          </>
        ) : (
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={status === 'connecting'}
            onClick={() => connect(server.id, projectRoot)}
          >
            {status === 'connecting' ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => remove(server.id)}>Remove</button>
      </div>
    </div>
  )
}

// ── AddServerForm ──────────────────────────────────────────────────────────

function blankEnvVar(): McpEnvVar { return { key: '', value: '', secret: false } }

interface FormState {
  name: string
  command: string
  argsRaw: string   // space-separated, user edits as a single string
  cwd: string
  env: McpEnvVar[]
  enabled: boolean
  transport: 'stdio' | 'remote'
  remoteUrl: string
}

function blankForm(): FormState {
  return { name: '', command: '', argsRaw: '', cwd: '', env: [], enabled: true, transport: 'stdio', remoteUrl: '' }
}

function formFromTemplate(t: QuickstartTemplate): FormState {
  return {
    name: t.name === 'Custom' ? '' : t.name,
    command: t.command,
    argsRaw: t.args.join(' '),
    cwd: '',
    env: t.env.map(e => ({ ...e })),
    enabled: true,
    transport: t.remoteUrl !== undefined ? 'remote' : 'stdio',
    remoteUrl: t.remoteUrl ?? '',
  }
}

function isValidRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

interface AddServerFormProps {
  onDone: () => void
  projectRoot: string | null
  /** QUICKSTARTS[].name to pre-apply on mount — set when the panel was
   *  opened by the MCP_TASK chat intent with a keyword match (see
   *  lib/mcpCatalog.ts). */
  initialTemplateName?: string | null
}

function AddServerForm({ onDone, projectRoot, initialTemplateName }: AddServerFormProps) {
  const addServer     = useMcpStore(s => s.addServer)
  const connectServer = useMcpStore(s => s.connectServer)
  const [form, setForm] = useState<FormState>(() => {
    const initial = initialTemplateName
      ? QUICKSTARTS.find(t => t.name === initialTemplateName)
      : undefined
    return initial ? formFromTemplate(initial) : blankForm()
  })
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(initialTemplateName ?? null)
  // Mirrors `selectedTemplate` synchronously (state updates aren't visible
  // to the async .then() below until the next render) — lets a stale
  // resolveEnvDefaults() result from a previously-selected template detect
  // that the user has since picked a different one and avoid overwriting it.
  const selectedTemplateRef = useRef(selectedTemplate)
  selectedTemplateRef.current = selectedTemplate

  const applyTemplate = useCallback((t: QuickstartTemplate) => {
    setForm(formFromTemplate(t))
    setSelectedTemplate(t.name)
    if (t.resolveEnvDefaults) {
      t.resolveEnvDefaults()
        .then(defaults => {
          setForm(prev => {
            // Bail if the user has since switched to a different template —
            // don't clobber whatever they're looking at now with a stale
            // async result.
            if (selectedTemplateRef.current !== t.name) return prev
            return { ...prev, env: prev.env.map(e => (e.key in defaults ? { ...e, value: defaults[e.key] } : e)) }
          })
        })
        .catch(() => {
          /* best-effort — user can still fill the path in by hand */
        })
    }
  }, [])

  // The initial template (when the panel was deep-linked in with a
  // pre-selected quickstart — see McpSettingsPanel's `suggestedQuickstart`)
  // is applied directly in `useState(...)` above, bypassing `applyTemplate`
  // — so its async env defaults (if any) need a separate kick on mount.
  useEffect(() => {
    if (!initialTemplateName) return
    const t = QUICKSTARTS.find(q => q.name === initialTemplateName)
    if (t?.resolveEnvDefaults) applyTemplate(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setField = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm(prev => ({ ...prev, [k]: v }))
  }, [])

  const setEnvField = useCallback((idx: number, patch: Partial<McpEnvVar>) => {
    setForm(prev => {
      const env = [...prev.env]
      env[idx] = { ...env[idx], ...patch }
      return { ...prev, env }
    })
  }, [])

  const addEnvRow = useCallback(() => setForm(prev => ({ ...prev, env: [...prev.env, blankEnvVar()] })), [])
  const removeEnvRow = useCallback((idx: number) => {
    setForm(prev => ({ ...prev, env: prev.env.filter((_, i) => i !== idx) }))
  }, [])

  // ── Google OAuth client JSON: file picker + live validation ─────────────
  // GMAIL_OAUTH_PATH / GOOGLE_OAUTH_CREDENTIALS point at a file the user
  // downloads from their own Google Cloud Console project — offer a native
  // file picker instead of a freeform path field, and surface a clear
  // exists/looks-valid check as they pick or type, on top of the pre-flight
  // check useMcpStore.connectServer also runs right before spawning.
  const [oauthFileStatus, setOauthFileStatus] = useState<Record<string, { checking: boolean; error: string | null }>>({})
  const oauthEnvSignature = form.env
    .filter(e => GOOGLE_OAUTH_CLIENT_ENV_KEYS.includes(e.key))
    .map(e => `${e.key}=${e.value}`)
    .join('\u241F')

  useEffect(() => {
    const rows = form.env.filter(e => GOOGLE_OAUTH_CLIENT_ENV_KEYS.includes(e.key) && e.value.trim())
    if (rows.length === 0) return
    let cancelled = false
    setOauthFileStatus(prev => {
      const next = { ...prev }
      for (const r of rows) next[r.key] = { checking: true, error: null }
      return next
    })
    const timer = setTimeout(() => {
      Promise.all(rows.map(async r => [r.key, await validateGoogleOAuthClientFile(r.value)] as const))
        .then(results => {
          if (cancelled) return
          setOauthFileStatus(prev => {
            const next = { ...prev }
            for (const [key, error] of results) next[key] = { checking: false, error }
            return next
          })
        })
        .catch(() => {})
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oauthEnvSignature])

  const browseForOauthClientFile = useCallback((idx: number) => {
    pickFile({
      title: 'Select Google OAuth Client JSON',
      filterName: 'Google OAuth client (JSON)',
      filterExtensions: ['json'],
    }).then(async path => {
      if (!path) return
      const key = form.env[idx]?.key
      const storedPath = key === 'GMAIL_OAUTH_PATH' ? await installGmailOAuthClient(path) : path
      setEnvField(idx, { value: storedPath })
      // Shared across Gmail + Google Calendar — see resolveGoogleStdioEnvDefaults.
      saveGoogleOAuthClientPath(storedPath).catch(() => {})
    }).catch(() => {
      /* dialog cancelled/unavailable — leave the field as-is */
    })
  }, [setEnvField])

  const handleAdd = useCallback(() => {
    if (form.transport === 'remote' ? !isValidRemoteUrl(form.remoteUrl) : !form.command.trim()) return
    const command = form.transport === 'remote' ? 'npx' : form.command.trim()
    const args = form.transport === 'remote'
      ? ['-y', 'mcp-remote', form.remoteUrl.trim()]
      : (form.argsRaw.trim() ? form.argsRaw.trim().split(/\s+/) : [])
    const id = addServer({
      name: form.name || (form.transport === 'remote' ? new URL(form.remoteUrl).hostname : command),
      command,
      args,
      env: form.env.filter(e => e.key.trim()),
      cwd: form.cwd.trim() || undefined,
      enabled: form.enabled,
    })
    if (form.enabled) connectServer(id, projectRoot).catch(() => {})
    onDone()
  }, [form, addServer, connectServer, projectRoot, onDone])

  return (
    <div className={styles.form}>
      <div className={styles.formTitle}>Add MCP Server</div>

      {/* Quickstart templates */}
      <div className={styles.quickstarts}>
        <div className={styles.quickstartTitle}>Quickstart</div>
        <div className={styles.quickstartGrid}>
          {QUICKSTARTS.map(t => (
            <button
              key={t.name}
              className={styles.quickstartCard}
              onClick={() => applyTemplate(t)}
              style={selectedTemplate === t.name ? { borderColor: 'var(--cyan)' } : undefined}
            >
              <div className={styles.quickstartName}>{t.name}</div>
              <div className={styles.quickstartDesc}>{t.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {(() => {
        const activeNotes = QUICKSTARTS.find(t => t.name === selectedTemplate)?.notes
        return activeNotes ? <div className={styles.hint} style={{ marginTop: 10 }}>ℹ️ {activeNotes}</div> : null
      })()}

      <div className={styles.divider} />

      <div className={styles.field}>
        <label className={styles.label}>Transport</label>
        <div className={styles.transportToggle}>
          <button type="button" className={`${styles.btn} ${form.transport === 'stdio' ? styles.btnSelected : ''}`} onClick={() => setField('transport', 'stdio')}>Local (stdio)</button>
          <button type="button" className={`${styles.btn} ${form.transport === 'remote' ? styles.btnSelected : ''}`} onClick={() => setField('transport', 'remote')}>Remote (HTTP)</button>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Display name</label>
        <input
          className={styles.input}
          placeholder="e.g. My Notion Server"
          value={form.name}
          onChange={e => setField('name', e.target.value)}
        />
      </div>

      {form.transport === 'remote' ? (
      <div className={styles.field}>
        <label className={styles.label}>Server URL *</label>
        <input className={styles.input} type="url" placeholder="https://example.com/mcp" value={form.remoteUrl} onChange={e => setField('remoteUrl', e.target.value)} />
        <div className={styles.hint}>OAuth-capable servers open their sign-in flow when you connect.</div>
      </div>
      ) : <>
      <div className={styles.field}>
        <label className={styles.label}>Command *</label>
        <input
          className={styles.input}
          placeholder="e.g. npx, node, /usr/local/bin/my-mcp-server"
          value={form.command}
          onChange={e => setField('command', e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Arguments (space-separated)</label>
        <input
          className={styles.input}
          placeholder="e.g. -y @modelcontextprotocol/server-github"
          value={form.argsRaw}
          onChange={e => setField('argsRaw', e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Working directory (optional — defaults to project root)</label>
        <input
          className={styles.input}
          placeholder="Leave blank to use the open project folder"
          value={form.cwd}
          onChange={e => setField('cwd', e.target.value)}
        />
      </div>
      </>}

      {/* Environment variables */}
      <div className={styles.field}>
        <label className={styles.label}>
          Environment variables
          <button
            type="button"
            className={styles.btn}
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 10 }}
            onClick={addEnvRow}
          >
            + Add
          </button>
        </label>
        {form.env.map((e, idx) => {
          const isGoogleOauthClientRow = GOOGLE_OAUTH_CLIENT_ENV_KEYS.includes(e.key)
          const rowStatus = oauthFileStatus[e.key]
          return (
          <div key={idx}>
            <div className={styles.envRow}>
              <input
                className={styles.input}
                placeholder="KEY"
                value={e.key}
                onChange={ev => setEnvField(idx, { key: ev.target.value })}
              />
              <input
                className={styles.input}
                placeholder={
                  isGoogleOauthClientRow
                    ? 'Use Browse… to pick the file'
                    : e.secret ? '••••••• (stored in OS keychain)' : 'value'
                }
                type={e.secret ? 'password' : 'text'}
                value={e.value}
                onChange={ev => setEnvField(idx, { value: ev.target.value })}
              />
              {isGoogleOauthClientRow && (
                <button
                  type="button"
                  className={styles.btn}
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => browseForOauthClientFile(idx)}
                >
                  Browse…
                </button>
              )}
              <label className={styles.secretToggle}>
                <input
                  type="checkbox"
                  checked={e.secret}
                  onChange={ev => setEnvField(idx, { secret: ev.target.checked })}
                />
                secret
              </label>
              <button className={styles.removeEnvBtn} onClick={() => removeEnvRow(idx)} title="Remove">✕</button>
            </div>
            {isGoogleOauthClientRow && rowStatus && (
              <div className={rowStatus.error ? styles.errorText : styles.hint}>
                {rowStatus.checking
                  ? 'Checking file…'
                  : rowStatus.error
                    ? `⚠️ ${rowStatus.error}`
                    : '✅ Looks like a valid Google OAuth client JSON.'}
              </div>
            )}
          </div>
          )
        })}
        <div className={styles.hint}>
          Secret values are stored in the OS keychain, not in localStorage.
        </div>
      </div>

      <div className={styles.formActions}>
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={
            (form.transport === 'remote' ? !isValidRemoteUrl(form.remoteUrl) : !form.command.trim()) ||
            // Only blocks *immediate* connect attempts — a known-bad/still-
            // checking OAuth client file would otherwise just bounce back
            // as a connection error a moment later anyway.
            (form.enabled && Object.values(oauthFileStatus).some(s => s.checking || s.error))
          }
          onClick={handleAdd}
        >
          Add &amp; Connect
        </button>
        <button className={styles.btn} onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

// ── McpSettingsPanel ───────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  /** Render inside Settings instead of creating a second modal/backdrop. */
  embedded?: boolean
}

export default function McpSettingsPanel({ open, onClose, embedded = false }: Props) {
  const servers             = useMcpStore(s => s.servers)
  const suggestedQuickstart = useMcpStore(s => s.suggestedQuickstart)
  const intentNote          = useMcpStore(s => s.intentNote)
  const projectRoot = useRepoIndex(s => s.projectRoot)
  const [adding, setAdding] = useState(false)
  // Opened by the MCP_TASK chat intent (a chat message needed an external
  // service and no matching server was connected yet) — jump straight into
  // the Add Server form instead of the empty-state list.
  useEffect(() => {
    if (open && (suggestedQuickstart || intentNote)) setAdding(true)
  }, [open, suggestedQuickstart, intentNote])

  if (!open) return null

  const content = (
      <div className={embedded ? styles.embedded : styles.modal}>
        <div className={styles.header}>
          <span style={{ fontSize: 18 }}>🔌</span>
          <div style={{ flex: 1 }}>
            <div className={styles.title}>MCP Servers</div>
            <div className={styles.subtitle}>
              Connect external tools via the Model Context Protocol
            </div>
          </div>
          {!adding && (
            <button className={styles.addBtn} onClick={() => setAdding(true)}>+ Add Server</button>
          )}
          {!embedded && <button className={styles.closeBtn} onClick={onClose}>✕</button>}
        </div>

        <div className={styles.body}>
          <>
          {intentNote && (
            <div className={styles.hint} style={{ marginBottom: 12 }}>
              🔌 Your request looks like it needs an MCP connector — suggested: <strong>{intentNote}</strong>.
              Install it below (or pick a different one) and I'll pick the request back up.
            </div>
          )}

          {adding && (
            <AddServerForm
              projectRoot={projectRoot}
              onDone={() => setAdding(false)}
              initialTemplateName={suggestedQuickstart}
            />
          )}

          {servers.length === 0 && !adding ? (
            <div className={styles.empty}>
              No MCP servers configured yet.<br />
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                style={{ marginTop: 14 }}
                onClick={() => setAdding(true)}
              >
                + Add your first server
              </button>
            </div>
          ) : (
            servers.map(server => (
              <ServerCard key={server.id} server={server} projectRoot={projectRoot} />
            ))
          )}
          </>
        </div>
      </div>
  )

  if (embedded) return content

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      {content}
    </div>
  )
}
