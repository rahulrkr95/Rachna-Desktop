// types/connector.ts
//
// Provider-agnostic connector contract. Any external service (GitHub,
// Notion, Slack, Figma, Gmail, Jira, Google Drive, ...) is exposed to the
// app the same way: implement IConnector, ship a manifest.json, register
// it. Nothing outside a connector's own folder should know how that
// connector talks to its backend (MCP over stdio, a REST API, a local
// process, etc).

export type ConnectorTransportKind = 'mcp-stdio' | 'mcp-http' | 'rest' | 'local'

export type ConnectorAuthType = 'none' | 'pat' | 'oauth' | 'api-key'

export interface ConnectorAuthField {
  key: string
  label: string
  secret: boolean
  placeholder?: string
}

export interface ConnectorAuthSpec {
  type: ConnectorAuthType
  /** Fields the user must supply (e.g. a PAT). Empty for 'none'/'oauth'. */
  fields?: ConnectorAuthField[]
  /** Short human-readable setup instructions shown in Settings. */
  instructions?: string
  /** Link to the provider's token/app creation page. */
  helpUrl?: string
  /**
   * Only for `type: 'oauth'` — the id of the OAuthProviderConfig this
   * connector authenticates with (see services/oauth/OAuthProviderRegistry.ts).
   * Connectors extending BaseOAuthMcpConnector read this to know which
   * registered provider to drive; unused (and should be omitted) for every
   * other auth type, including GitHub's 'pat'.
   */
  oauthProviderId?: string
}

export interface ConnectorTransportSpec {
  kind: ConnectorTransportKind
  /** For mcp-stdio: the executable, e.g. "npx". */
  command?: string
  /** For mcp-stdio: args, e.g. ["-y", "@modelcontextprotocol/server-github"]. */
  args?: string[]
  /** Names of auth field keys that should be injected as env vars. */
  envFromAuth?: string[]
  /** For mcp-http: the Streamable HTTP endpoint. */
  url?: string
}

export interface ConnectorCapabilities {
  tools: boolean
  resources: boolean
  prompts: boolean
}

/** Static manifest describing a connector. Lives in connectors/<id>/manifest.json. */
export interface ConnectorManifest {
  id: string
  name: string
  description: string
  version: string
  icon?: string
  vendor?: string
  auth: ConnectorAuthSpec
  transport: ConnectorTransportSpec
  capabilities: ConnectorCapabilities
  /** Human-readable permission scopes requested, shown in Settings. */
  permissions: string[]
  /**
   * When true, this connector is shown in the grid but disabled — a
   * "Coming soon" tag/overlay is rendered over it and it isn't clickable.
   * Used to advertise connectors we plan to support without letting users
   * attempt to configure ones that aren't wired up yet.
   */
  comingSoon?: boolean
}

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'unauthenticated'

export interface ConnectorHealth {
  status: ConnectorStatus
  lastConnectedAt?: number
  lastSyncAt?: number
  lastError?: string
}

export interface ConnectorTool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

export interface ConnectorResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface ConnectorResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface ConnectorPrompt {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface ConnectorToolResult {
  ok: boolean
  text: string
}

/**
 * Common interface every connector must implement. The Connector Manager
 * only ever talks to connectors through this surface — never to a
 * connector's underlying transport (MCP server, REST client, ...) directly.
 */
export interface IConnector {
  readonly manifest: ConnectorManifest

  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean

  getCapabilities(): ConnectorCapabilities
  getHealth(): ConnectorHealth

  listTools(): Promise<ConnectorTool[]>
  executeTool(name: string, args: Record<string, unknown>): Promise<ConnectorToolResult>

  listResources(): Promise<ConnectorResource[]>
  readResource(uri: string): Promise<ConnectorResourceContent>

  listPrompts(): Promise<ConnectorPrompt[]>

  // ── Auth ──────────────────────────────────────────────────────────────
  isAuthenticated(): Promise<boolean>
  authenticate(fields: Record<string, string>): Promise<void>
  reauthenticate(fields: Record<string, string>): Promise<void>
  clearAuth(): Promise<void>
}
