// services/connectors/BaseOAuthMcpConnector.ts
//
// Shared implementation of IConnector for any connector whose transport is
// a *remote* MCP server (Streamable HTTP) gated by OAuth — Google, Figma,
// Slack, Notion, or any future OAuth provider. This is the OAuth sibling of
// BaseMcpStdioConnector (which stays untouched — GitHub, and any other
// PAT/API-key stdio connector, keeps working exactly as before).
//
// The only thing this class knows how to do with an OAuth token is ask
// OAuthManager for one and pass it to `mcpConnect`'s `authToken` — it never
// builds authorization URLs, exchanges codes, or touches the keychain
// directly. That keeps OAuth (services/oauth/*) completely independent of
// the MCP transport layer (lib/mcp/McpClient.ts, src-tauri/src/mcp.rs):
// this file is the *only* bridge between the two, and it's a thin one.
//
// Concrete connectors (connectors/google/connector.ts, etc.) extend this
// and only need to supply their manifest — no provider-specific connection
// logic. Adding a new OAuth-based remote MCP provider is:
//   1. Register its OAuthProviderConfig (OAuthProviderRegistry.ts)
//   2. connectors/<id>/manifest.json with auth.type = 'oauth' and
//      auth.oauthProviderId = that provider's id, transport.kind = 'mcp-http'
//   3. connectors/<id>/connector.ts: a two-line class extending this one
//   4. One line in connectors/registry.ts
// No changes to OAuthManager, this file, or the MCP transport layer.

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
import { oauthManager } from '../oauth/OAuthManager'

export abstract class BaseOAuthMcpConnector implements IConnector {
  abstract readonly manifest: ConnectorManifest

  private status: ConnectorStatus = 'disconnected'
  private lastConnectedAt?: number
  private lastSyncAt?: number
  private lastError?: string
  private cachedTools: ConnectorTool[] = []

  /** Kept for interface parity with BaseMcpStdioConnector — remote HTTP
   *  servers don't spawn a local process, so this is a no-op for them. */
  setProjectRoot(_root: string | null): void {
    /* no-op: remote transport has no cwd */
  }

  private get providerId(): string {
    const id = this.manifest.auth.oauthProviderId
    if (!id) {
      throw new Error(`${this.manifest.name}: manifest.auth.oauthProviderId is required for OAuth connectors`)
    }
    return id
  }

  // ── Auth — delegates entirely to OAuthManager ───────────────────────

  async isAuthenticated(): Promise<boolean> {
    return oauthManager.isAuthenticated(this.providerId)
  }

  /** `fields` is part of the shared IConnector signature (PAT connectors
   *  use it for the token the user types in) — OAuth connectors ignore it
   *  and drive the full browser-based login instead. */
  async authenticate(_fields: Record<string, string>): Promise<void> {
    await oauthManager.login(this.providerId)
  }

  async clearAuth(): Promise<void> {
    await oauthManager.clearToken(this.providerId)
  }

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
    const { transport } = this.manifest
    if (transport.kind !== 'mcp-http' || !transport.url) {
      throw new Error(`${this.manifest.name}: not configured as an mcp-http connector`)
    }

    this.status = 'connecting'
    let wasUnauthenticated = false
    try {
      // Resolves (and transparently refreshes, if needed) a valid access
      // token — or throws if the provider has never been authenticated,
      // which we surface as the same 'unauthenticated' status
      // BaseMcpStdioConnector uses for a missing PAT.
      let authToken: string
      try {
        authToken = await oauthManager.getValidAccessToken(this.providerId)
      } catch (err) {
        wasUnauthenticated = true
        this.status = 'unauthenticated'
        this.lastError = err instanceof Error ? err.message : String(err)
        throw new Error(this.lastError)
      }

      const tools = await mcpConnect({
        serverId: this.manifest.id,
        command: '',
        args: [],
        env: {},
        url: transport.url,
        authToken,
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
      if (!wasUnauthenticated) this.status = 'error'
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
