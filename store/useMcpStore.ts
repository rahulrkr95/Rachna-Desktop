// store/useMcpStore.ts
//
// Manages user-configured MCP (Model Context Protocol) servers: their
// command/args/env, connection state, and cached tool list. Mirrors
// useApiKeyStore's persistence split — non-sensitive config in
// localStorage, secret env var values (tokens, API keys the MCP server
// itself needs) in the OS keychain via lib/keychain.ts.

import { create } from 'zustand'
import { keychainSet, keychainDelete, keychainGetMany } from '../lib/keychain'
import { mcpConnect, mcpDisconnect, mcpListTools, type McpToolInfo } from '../lib/mcp/McpClient'
import { authenticateGmail, GOOGLE_OAUTH_CLIENT_ENV_KEYS, installGmailOAuthClient, isGmailAuthenticated, validateGoogleOAuthClientFile } from '../lib/mcp/googleStdioCredentials'

// ── Types ────────────────────────────────────────────────────────────────

export interface McpEnvVar {
  key: string
  /** Plaintext value for non-secret vars; empty string when secret. */
  value: string
  /** Secret values are never written to localStorage — only to the OS keychain. */
  secret: boolean
}

export type McpConnectionStatus = 'disconnected' | 'authenticating' | 'connecting' | 'connected' | 'error'

export interface McpServerConfig {
  id: string
  name: string
  /** Executable, e.g. "npx", "node", "/usr/local/bin/github-mcp-server". */
  command: string
  /** Args split as an array, e.g. ["-y", "@modelcontextprotocol/server-github"]. */
  args: string[]
  env: McpEnvVar[]
  /** Working directory; empty = use the open project root. */
  cwd?: string
  /**
   * Remote MCP server URL (Streamable HTTP). When set, `command`/`args`/
   * `cwd` are ignored and mcp_connect dials this URL instead of spawning a
   * local process. Local (stdio) servers leave this unset.
   */
  url?: string
  enabled: boolean
  addedAt: number
}

/** Shape written to localStorage — secret env values are stripped. */
type PersistedServer = Omit<McpServerConfig, 'env'> & {
  env: Array<Omit<McpEnvVar, 'value'> & { value: string }>
}

interface McpRuntimeState {
  status: McpConnectionStatus
  tools: McpToolInfo[]
  error?: string
}

interface McpStore {
  servers: McpServerConfig[]
  runtime: Record<string, McpRuntimeState>

  addServer: (cfg: Omit<McpServerConfig, 'id' | 'addedAt'>) => string
  updateServer: (id: string, patch: Partial<Omit<McpServerConfig, 'id'>>) => void
  removeServer: (id: string) => void

  connectServer: (id: string, projectRoot: string | null) => Promise<void>
  disconnectServer: (id: string) => Promise<void>
  refreshTools: (id: string) => Promise<void>

  /** All tools across every currently connected, enabled server. */
  getConnectedTools: () => Array<{ serverId: string; serverName: string; tool: McpToolInfo }>

  // ── Panel open/close (mirrors useRunConfigStore's panelOpen) ──────────────
  // Lives in the store (not local component state) so useChat.ts's MCP_TASK
  // intent routing — several component layers away, and possibly in either
  // of the two separate welcome-mode / IDE-mode AiChat instances — can open
  // the panel directly instead of needing a prop callback threaded through
  // IDELayout.
  panelOpen: boolean
  /** QUICKSTARTS[].name to pre-select in the Add Server form, if any. */
  suggestedQuickstart: string | null
  /** Short note shown as a banner explaining why the panel was opened. */
  intentNote: string | null
  openPanel: (suggestion?: { quickstart?: string | null; note?: string | null }) => void
  closePanel: () => void
}

// ── Persistence helpers ──────────────────────────────────────────────────

const SERVERS_KEY = 'rachna_ide_mcp_servers'

function envKeychainId(serverId: string, envKey: string): string {
  return `mcp_env_${serverId}_${envKey}`
}

function loadServers(): McpServerConfig[] {
  try {
    const persisted: PersistedServer[] = JSON.parse(localStorage.getItem(SERVERS_KEY) ?? '[]')
    return persisted.map(s => ({
      ...s,
      env: s.env.map(e => ({ ...e, value: e.secret ? '' : e.value })),
    }))
  } catch {
    return []
  }
}

function saveServers(servers: McpServerConfig[]): void {
  const persisted: PersistedServer[] = servers.map(s => ({
    ...s,
    env: s.env.map(e => ({ ...e, value: e.secret ? '' : e.value })),
  }))
  localStorage.setItem(SERVERS_KEY, JSON.stringify(persisted))
}

function makeId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function resolveEnv(env: McpEnvVar[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of env) {
    if (e.key) out[e.key] = e.value
  }
  return out
}

// ── Store ────────────────────────────────────────────────────────────────

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: loadServers(),
  runtime: {},
  panelOpen: false,
  suggestedQuickstart: null,
  intentNote: null,

  openPanel(suggestion) {
    set({
      panelOpen: true,
      suggestedQuickstart: suggestion?.quickstart ?? null,
      intentNote: suggestion?.note ?? null,
    })
  },

  closePanel() {
    set({ panelOpen: false, suggestedQuickstart: null, intentNote: null })
  },

  addServer(cfg) {
    const id = makeId()
    const newServer: McpServerConfig = { ...cfg, id, addedAt: Date.now() }
    const updated = [...get().servers, newServer]
    saveServers(updated)
    set({ servers: updated })
    for (const e of newServer.env) {
      if (e.secret && e.value) {
        keychainSet(envKeychainId(id, e.key), e.value).catch(err =>
          console.error('Failed to store MCP env secret in OS keychain:', err)
        )
      }
    }
    return id
  },

  updateServer(id, patch) {
    const updated = get().servers.map(s => (s.id === id ? { ...s, ...patch } : s))
    saveServers(updated)
    set({ servers: updated })
    if (patch.env) {
      for (const e of patch.env) {
        if (e.secret && e.value) {
          keychainSet(envKeychainId(id, e.key), e.value).catch(err =>
            console.error('Failed to update MCP env secret in OS keychain:', err)
          )
        }
      }
    }
  },

  removeServer(id) {
    const server = get().servers.find(s => s.id === id)
    const updated = get().servers.filter(s => s.id !== id)
    saveServers(updated)
    set(state => {
      const runtime = { ...state.runtime }
      delete runtime[id]
      return { servers: updated, runtime }
    })
    mcpDisconnect(id).catch(() => {})
    if (server) {
      for (const e of server.env) {
        if (e.secret) keychainDelete(envKeychainId(id, e.key)).catch(() => {})
      }
    }
  },

  async connectServer(id, projectRoot) {
    const server = get().servers.find(s => s.id === id)
    if (!server) return

    // ── Google OAuth client file pre-flight (stdio servers only) ────────
    // Gmail / Google Calendar drive their own first-run browser sign-in
    // (see lib/mcp/googleStdioCredentials.ts) using an OAuth client JSON
    // the user points them at via GMAIL_OAUTH_PATH / GOOGLE_OAUTH_CREDENTIALS.
    // Check that file exists and looks right *before* spawning the process
    // — a missing/invalid file otherwise only surfaces as an opaque
    // child-process stderr dump after the browser flow (or the spawn
    // itself) fails. Only applies to these two local stdio quickstarts;
    // remote/OAuthManager-backed servers (e.g. Google Drive) are untouched.
    const oauthClientEnv = server.url
      ? undefined
      : server.env.find(e => GOOGLE_OAUTH_CLIENT_ENV_KEYS.includes(e.key))
    if (oauthClientEnv) {
      const problem = await validateGoogleOAuthClientFile(oauthClientEnv.value)
      if (problem) {
        set(state => ({
          runtime: { ...state.runtime, [id]: { status: 'error', tools: state.runtime[id]?.tools ?? [], error: problem } },
        }))
        return
      }
      if (oauthClientEnv.key === 'GMAIL_OAUTH_PATH') {
        try {
          const installedPath = await installGmailOAuthClient(oauthClientEnv.value)
          oauthClientEnv.value = installedPath
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          set(state => ({ runtime: { ...state.runtime, [id]: { status: 'error', tools: [], error: message } } }))
          return
        }
      }
    }

    const isGmail = !server.url && server.args.includes('@gongrzhe/server-gmail-autoauth-mcp')
    if (isGmail) {
      try {
        if (!(await isGmailAuthenticated())) {
          set(state => ({
            runtime: { ...state.runtime, [id]: { status: 'authenticating', tools: state.runtime[id]?.tools ?? [] } },
          }))
          await authenticateGmail(server.command, server.args, resolveEnv(server.env))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        set(state => ({ runtime: { ...state.runtime, [id]: { status: 'error', tools: [], error: message } } }))
        return
      }
    }

    set(state => ({
      runtime: { ...state.runtime, [id]: { status: 'connecting', tools: state.runtime[id]?.tools ?? [] } },
    }))
    try {
      const tools = await mcpConnect({
        serverId: id,
        command: server.command,
        args: server.args,
        env: resolveEnv(server.env),
        cwd: server.cwd || projectRoot || undefined,
        url: server.url || undefined,
      })
      set(state => ({ runtime: { ...state.runtime, [id]: { status: 'connected', tools } } }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set(state => ({ runtime: { ...state.runtime, [id]: { status: 'error', tools: [], error: message } } }))
    }
  },

  async disconnectServer(id) {
    await mcpDisconnect(id).catch(() => {})
    set(state => ({ runtime: { ...state.runtime, [id]: { status: 'disconnected', tools: [] } } }))
  },

  async refreshTools(id) {
    const current = get().runtime[id]
    if (!current || current.status !== 'connected') return
    try {
      const tools = await mcpListTools(id)
      set(state => ({ runtime: { ...state.runtime, [id]: { ...state.runtime[id], tools } } }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set(state => ({ runtime: { ...state.runtime, [id]: { status: 'error', tools: [], error: message } } }))
    }
  },

  getConnectedTools() {
    const { servers, runtime } = get()
    const out: Array<{ serverId: string; serverName: string; tool: McpToolInfo }> = []
    for (const server of servers) {
      if (!server.enabled) continue
      const rt = runtime[server.id]
      if (!rt || rt.status !== 'connected') continue
      for (const tool of rt.tools) {
        out.push({ serverId: server.id, serverName: server.name, tool })
      }
    }
    return out
  },
}))

// ── Startup helpers ──────────────────────────────────────────────────────

/**
 * Pull secret env values back out of the OS keychain into the in-memory
 * store. Call once at app startup (same pattern as useApiKeyStore's hydration).
 */
export async function hydrateMcpSecretsFromKeychain(): Promise<void> {
  const { servers } = useMcpStore.getState()
  const secretIds: string[] = []
  for (const s of servers) {
    for (const e of s.env) {
      if (e.secret) secretIds.push(envKeychainId(s.id, e.key))
    }
  }
  if (secretIds.length === 0) return

  const values = await keychainGetMany(secretIds)
  const updated = useMcpStore.getState().servers.map(s => ({
    ...s,
    env: s.env.map(e =>
      e.secret ? { ...e, value: values[envKeychainId(s.id, e.key)] ?? '' } : e
    ),
  }))
  useMcpStore.setState({ servers: updated })
}
