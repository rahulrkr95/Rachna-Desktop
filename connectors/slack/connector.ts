// connectors/slack/connector.ts
//
// Slack connector, built on the OAuth connector framework. See
// connectors/google/connector.ts for the shared design notes.
//
// `manifest.json`'s `transport.url` is a placeholder — point it at your
// deployed Slack remote MCP server before shipping. Slack's OAuth v2 flow
// requires a confidential client secret; set VITE_SLACK_OAUTH_CLIENT_SECRET
// alongside VITE_SLACK_OAUTH_CLIENT_ID (see OAuthProviderRegistry.ts).

import { BaseOAuthMcpConnector } from '../../services/connectors/BaseOAuthMcpConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'

export class SlackConnector extends BaseOAuthMcpConnector {
  readonly manifest = manifestJson as ConnectorManifest
}
