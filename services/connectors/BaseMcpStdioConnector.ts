// services/connectors/BaseMcpStdioConnector.ts
//
// Shared implementation of IConnector for any connector whose transport is
// an MCP server spawned over stdio (the common case: GitHub, Notion, Slack,
// Figma, Jira, Google Drive MCP servers all ship as npx-launched stdio
// servers). Concrete connectors (connectors/github/connector.ts, etc.)
// extend this and only need to supply their manifest + auth persistence —
// no GitHub-specific (or any provider-specific) logic lives here.
//
// A connector for a non-MCP backend (a plain REST API, a local tool) would
// implement IConnector directly instead of extending this class.

import type {
  IConnector,
  ConnectorManifest,
  ConnectorCapabilities,
  ConnectorHealth,
  ConnectorStatus,
  ConnectorTool,
  ConnectorToolResult,
  ConnectorResource,
  ConnectorResourceContent,
  ConnectorPrompt,
} from '../../types/connector'
import {
  mcpConnect,
  mcpDisconnect,
  mcpListTools,
  mcpCallTool,
  mcpListResources,
  mcpReadResource,
  mcpListPrompts,
  flattenMcpResult,
} from '../../lib/mcp/McpClient'

export abstract class BaseMcpStdioConnector implements IConnector {
  abstract readonly manifest: ConnectorManifest

  private status: ConnectorStatus = 'disconnected'
  private lastConnectedAt?: number
  private lastSyncAt?: number
  private lastError?: string
  private cachedTools: ConnectorTool[] = []

  /** Project root / cwd for the spawned server; connectors may override. */
  protected projectRoot: string | null = null
  setProjectRoot(root: string | null): void {
    this.projectRoot = root
  }

  // ── Auth persistence — subclasses provide storage (keychain, etc). ─────
  abstract isAuthenticated(): Promise<boolean>
  abstract authenticate(fields: Record<string, string>): Promise<void>
  abstract clearAuth(): Promise<void>
  /** Resolve current auth field values into the env vars the MCP server needs. */
  protected abstract resolveAuthEnv(): Promise<Record<string, string>>

  async reauthenticate(fields: Record<string, string>): Promise<void> {
    await this.clearAuth()
    await this.authenticate(fields)
    if (this.isConnected()) {
      await this.disconnect()
      await this.connect()
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const authed = await this.isAuthenticated()
    if (!authed) {
      this.status = 'unauthenticated'
      this.lastError = `${this.manifest.name} is not authenticated yet.`
      throw new Error(this.lastError)
    }

    const { transport } = this.manifest
    if (transport.kind !== 'mcp-stdio' || !transport.command) {
      throw new Error(`${this.manifest.name}: not configured as an mcp-stdio connector`)
    }

    this.status = 'connecting'
    try {
      const env = await this.resolveAuthEnv()
      const tools = await mcpConnect({
        serverId: this.manifest.id,
        command: transport.command,
        args: transport.args ?? [],
        env,
        cwd: this.projectRoot ?? undefined,
      })
      this.cachedTools = tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
      this.status = 'connected'
      this.lastConnectedAt = Date.now()
      this.lastSyncAt = Date.now()
      this.lastError = undefined
    } catch (err) {
      this.status = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    }
  }

  async disconnect(): Promise<void> {
    await mcpDisconnect(this.manifest.id).catch(() => {})
    this.status = 'disconnected'
    this.cachedTools = []
  }

  isConnected(): boolean {
    return this.status === 'connected'
  }

  getCapabilities(): ConnectorCapabilities {
    return this.manifest.capabilities
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.status,
      lastConnectedAt: this.lastConnectedAt,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────

  async listTools(): Promise<ConnectorTool[]> {
    if (!this.isConnected()) return []
    try {
      const tools = await mcpListTools(this.manifest.id)
      this.cachedTools = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      this.lastSyncAt = Date.now()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    }
    return this.cachedTools
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<ConnectorToolResult> {
    if (!this.isConnected()) {
      return { ok: false, text: `${this.manifest.name} is not connected.` }
    }
    try {
      const result = await mcpCallTool(this.manifest.id, name, args)
      this.lastSyncAt = Date.now()
      const text = flattenMcpResult(result)
      return { ok: !result.isError, text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.lastError = message
      return { ok: false, text: message }
    }
  }

  // ── Resources / Prompts ─────────────────────────────────────────────
  // Most current MCP servers (including the GitHub server) only advertise
  // tools, so these commonly resolve to empty lists — but they now go
  // through the real rmcp-backed resources/list, resources/read, and
  // prompts/list calls for servers that do advertise them, instead of
  // being permanently stubbed out.

  async listResources(): Promise<ConnectorResource[]> {
    try {
      return await mcpListResources(this.manifest.id)
    } catch {
      return []
    }
  }

  async readResource(uri: string): Promise<ConnectorResourceContent> {
    try {
      const result = await mcpReadResource(this.manifest.id, uri)
      const first = result.contents?.[0]
      return { uri, mimeType: first?.mimeType, text: first?.text ?? '', blob: first?.blob }
    } catch {
      return { uri, text: '' }
    }
  }

  async listPrompts(): Promise<ConnectorPrompt[]> {
    try {
      return await mcpListPrompts(this.manifest.id)
    } catch {
      return []
    }
  }
}
