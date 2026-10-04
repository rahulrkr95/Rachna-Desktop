// connectors/figma/connector.ts
//
// Figma connector, built on the OAuth connector framework. See
// connectors/google/connector.ts for the shared design notes — the same
// applies here: everything Figma-specific is this file + manifest.json.
//
// `manifest.json`'s `transport.url` is a placeholder — point it at your
// deployed Figma remote MCP server before shipping. Figma's OAuth app
// registration requires a confidential client secret even for this flow
// (it doesn't support a pure public/PKCE-only client type); set
// VITE_FIGMA_OAUTH_CLIENT_SECRET alongside VITE_FIGMA_OAUTH_CLIENT_ID if
// your registration needs it (see OAuthProviderRegistry.ts).

import { BaseOAuthMcpConnector } from '../../services/connectors/BaseOAuthMcpConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'

export class FigmaConnector extends BaseOAuthMcpConnector {
  readonly manifest = manifestJson as ConnectorManifest
}
