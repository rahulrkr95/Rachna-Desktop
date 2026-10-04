// connectors/filesystem/connector.ts
//
// Filesystem is a local-only MCP server (no external account, no token) —
// it just needs a project root to serve, which BaseMcpStdioConnector
// already threads through as `cwd` via setProjectRoot(). Because
// isAuthenticated() always resolves true, the app's startup auto-connect
// loop (see IDELayout.tsx's "Connector framework startup" effect) picks it
// up and connects it automatically on launch — this is what makes it
// enabled "by default" with no user action required.

import { BaseMcpStdioConnector } from '../../services/connectors/BaseMcpStdioConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'

export class FilesystemConnector extends BaseMcpStdioConnector {
  readonly manifest = manifestJson as ConnectorManifest

  async isAuthenticated(): Promise<boolean> {
    return true
  }

  async authenticate(): Promise<void> {
    /* nothing to authenticate — local process, no credentials */
  }

  async clearAuth(): Promise<void> {
    /* no-op */
  }

  protected async resolveAuthEnv(): Promise<Record<string, string>> {
    return {}
  }
}
