// connectors/google/connector.ts
//
// Gmail connector, built on the generic mcp-stdio connector framework
// (services/connectors/BaseMcpStdioConnector.ts) - the same pattern
// connectors/github/connector.ts uses. Instead of Google's OAuth flow
// living inside this app (there is no single hosted Google MCP server to
// point an in-app OAuth popup at), we spawn a local Gmail MCP server
// (@gongrzhe/server-gmail-autoauth-mcp) via npx and hand it the path to a
// Google Cloud OAuth client file. That server drives its own one-time
// browser consent screen and caches the resulting token in ~/.gmail-mcp/,
// so subsequent connects are silent.

import { BaseMcpStdioConnector } from '../../services/connectors/BaseMcpStdioConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'
import { getGoogleOAuthKeysPath, setGoogleOAuthKeysPath, clearGoogleOAuthKeysPath } from './auth'

export class GoogleConnector extends BaseMcpStdioConnector {
  readonly manifest = manifestJson as ConnectorManifest

  async isAuthenticated(): Promise<boolean> {
    const path = await getGoogleOAuthKeysPath()
    return !!path
  }

  async authenticate(fields: Record<string, string>): Promise<void> {
    const path = fields.oauthKeysPath?.trim()
    if (!path) throw new Error('Path to gcp-oauth.keys.json is required.')
    await setGoogleOAuthKeysPath(path)
  }

  async clearAuth(): Promise<void> {
    await clearGoogleOAuthKeysPath()
  }

  protected async resolveAuthEnv(): Promise<Record<string, string>> {
    const path = await getGoogleOAuthKeysPath()
    if (!path) throw new Error('Google is not authenticated.')
    return { GMAIL_OAUTH_PATH: path }
  }
}
