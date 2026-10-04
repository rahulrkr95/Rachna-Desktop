// connectors/notion/connector.ts
//
// Notion connector, built on the OAuth connector framework. See
// connectors/google/connector.ts for the shared design notes.
//
// Unlike the other three, manifest.json's `transport.url` points at
// Notion's actual official hosted remote MCP server
// (https://mcp.notion.com/mcp) rather than a placeholder — but note that
// server speaks MCP-native OAuth (dynamic client registration against
// endpoints it advertises itself), not the classic static-client_id OAuth
// this framework's OAuthProviderRegistry models. The 'notion' provider
// registered there (services/oauth/OAuthProviderRegistry.ts) targets
// Notion's classic "public integration" OAuth instead, which is what
// you'd use if you're fronting Notion with your own self-hosted MCP
// server. Swap the registration (or the transport.url here) to match
// whichever Notion MCP deployment you actually use.

import { BaseOAuthMcpConnector } from '../../services/connectors/BaseOAuthMcpConnector'
import type { ConnectorManifest } from '../../types/connector'
import manifestJson from './manifest.json'

export class NotionConnector extends BaseOAuthMcpConnector {
  readonly manifest = manifestJson as ConnectorManifest
}
