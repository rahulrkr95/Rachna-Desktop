// connectors/registry.ts
//
// Registers every built-in connector with the Connector Manager. To add a
// new connector (Notion, Slack, Figma, Gmail, Jira, Google Drive, ...):
//   1. Create connectors/<id>/ with manifest.json, connector.ts, auth.ts
//   2. Implement IConnector (or extend BaseMcpStdioConnector for MCP-over-stdio
//      PAT/API-key connectors, or BaseOAuthMcpConnector for OAuth-authenticated
//      remote/mcp-http connectors)
//   3. Add one line below
// No other file in the app needs to change.

import { connectorManager } from '../services/connectors/ConnectorManager'
import { registerBuiltInOAuthProviders } from '../services/oauth/OAuthProviderRegistry'
import { GitHubConnector } from './github/connector'
import { GoogleConnector } from './google/connector'
import { FigmaConnector } from './figma/connector'
import { SlackConnector } from './slack/connector'
import { NotionConnector } from './notion/connector'
import { FilesystemConnector } from './filesystem/connector'
import { PostgreSQLConnector } from './postgresql/connector'
import { SentryConnector } from './sentry/connector'

let registered = false

export function registerBuiltInConnectors(): void {
  if (registered) return
  registered = true

  // OAuth provider configs (client id/secret, endpoints, scopes) must be
  // registered before any OAuth connector's connect()/authenticate() runs.
  registerBuiltInOAuthProviders()

  connectorManager.register(new GitHubConnector())
  connectorManager.register(new GoogleConnector())
  connectorManager.register(new FigmaConnector())
  connectorManager.register(new SlackConnector())
  connectorManager.register(new NotionConnector())
  connectorManager.register(new PostgreSQLConnector())
  connectorManager.register(new SentryConnector())
  // Filesystem needs no credentials (isAuthenticated() always resolves
  // true), so IDELayout's startup auto-connect effect picks it up and
  // connects it right away — this is what makes it enabled by default.
  connectorManager.register(new FilesystemConnector())
}
