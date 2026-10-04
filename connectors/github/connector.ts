// connectors/github/connector.ts
//
// GitHub is the first connector built on the generic connector framework.
// It contains the only GitHub-specific code in the app: the manifest and
// this thin glue class. Everything else (spawning the MCP server, tool
// discovery/execution, health tracking) is shared via BaseMcpStdioConnector.

import { BaseMcpStdioConnector } from '../../services/connectors/BaseMcpStdioConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'
import { getGitHubToken, setGitHubToken, clearGitHubToken } from './auth'

export class GitHubConnector extends BaseMcpStdioConnector {
  readonly manifest = manifestJson as ConnectorManifest

  async isAuthenticated(): Promise<boolean> {
    const token = await getGitHubToken()
    return !!token
  }

  async authenticate(fields: Record<string, string>): Promise<void> {
    const token = fields.token?.trim()
    if (!token) throw new Error('A personal access token is required.')
    await setGitHubToken(token)
  }

  async clearAuth(): Promise<void> {
    await clearGitHubToken()
  }

  protected async resolveAuthEnv(): Promise<Record<string, string>> {
    const token = await getGitHubToken()
    if (!token) throw new Error('GitHub is not authenticated.')
    return { GITHUB_PERSONAL_ACCESS_TOKEN: token }
  }
}
