// services/oauth/OAuthProviderRegistry.ts
//
// Registry of OAuth provider configs, consumed by OAuthManager. Adding a
// new OAuth-authenticated remote MCP provider is a pure registration —
// exactly one `register(...)` call with the provider's endpoints/scopes,
// no changes to OAuthManager, BaseOAuthMcpConnector, or the MCP transport
// layer. Mirrors connectors/registry.ts's "register once, no other file
// changes" shape.
//
// Client ids below are read from Vite env vars (`VITE_<PROVIDER>_OAUTH_CLIENT_ID`,
// set at build time — see .env.example) rather than hardcoded, since the
// real ids depend on which OAuth app registration the shipping build
// belongs to. An empty string means "not configured"; OAuthManager surfaces
// a clear error instead of silently sending a blank client_id.

import type { OAuthProviderConfig } from '../../types/oauth'

/** Every provider redirects back here — one shared redirect URI, routed to
 *  the right pending login by the `state` parameter. Registered as part of
 *  the app's existing `rachna-ide://` deep-link scheme (see
 *  src-tauri/tauri.conf.json`plugins.deep-link` and main.rs's deep-link
 *  forwarding, which is already scheme-wide, not path-specific). Kept
 *  distinct from `rachna-ide://auth` (the app's own sign-in redirect,
 *  handled separately in App.tsx) so the two flows can never collide. */
export const OAUTH_REDIRECT_URI = 'rachna-ide://oauth-callback'

function env(key: string): string {
  try {
    // Vite injects `import.meta.env` at build time; guarded for any
    // non-Vite test/build context that might import this module.
    return (import.meta as unknown as { env?: Record<string, string> }).env?.[key] ?? ''
  } catch {
    return ''
  }
}

class OAuthProviderRegistry {
  private providers = new Map<string, OAuthProviderConfig>()

  register(config: OAuthProviderConfig): void {
    this.providers.set(config.providerId, config)
  }

  get(providerId: string): OAuthProviderConfig | undefined {
    return this.providers.get(providerId)
  }

  require(providerId: string): OAuthProviderConfig {
    const config = this.providers.get(providerId)
    if (!config) throw new Error(`No OAuth provider registered for id "${providerId}"`)
    return config
  }

  list(): OAuthProviderConfig[] {
    return Array.from(this.providers.values())
  }
}

/** Singleton — one registry for the whole app. */
export const oauthProviderRegistry = new OAuthProviderRegistry()

// ── Built-in providers ──────────────────────────────────────────────────
//
// Endpoints/scopes below are each provider's standard OAuth 2.0
// authorization-code documentation. Some providers (Figma, Slack, Notion's
// classic "public integration" OAuth) require a confidential client secret
// even for native apps — set the matching `VITE_*_OAUTH_CLIENT_SECRET` env
// var only if your provider registration requires it; leave it unset to
// rely on PKCE alone wherever the provider allows a public client.

let registered = false

export function registerBuiltInOAuthProviders(): void {
  if (registered) return
  registered = true

  // Google — Gmail / Drive / Calendar all live under one Google Cloud
  // OAuth client; scope for whichever APIs the remote MCP server you point
  // the Google connector at actually needs.
  oauthProviderRegistry.register({
    providerId: 'google',
    displayName: 'Google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    clientId: env('VITE_GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: env('VITE_GOOGLE_OAUTH_CLIENT_SECRET') || undefined,
    usePkce: true,
    // Without these, Google only returns a refresh_token on the very first
    // consent — offline access + forcing the consent screen every time
    // guarantees OAuthManager always gets one to store.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  })

  // Figma — https://www.figma.com/developers/api#oauth2
  oauthProviderRegistry.register({
    providerId: 'figma',
    displayName: 'Figma',
    authorizationUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    scopes: ['file_read'],
    clientId: env('VITE_FIGMA_OAUTH_CLIENT_ID'),
    clientSecret: env('VITE_FIGMA_OAUTH_CLIENT_SECRET') || undefined,
    usePkce: true,
  })

  // Slack — https://api.slack.com/authentication/oauth-v2
  oauthProviderRegistry.register({
    providerId: 'slack',
    displayName: 'Slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'channels:history', 'chat:write', 'search:read'],
    scopeSeparator: ',',
    clientId: env('VITE_SLACK_OAUTH_CLIENT_ID'),
    clientSecret: env('VITE_SLACK_OAUTH_CLIENT_SECRET') || undefined,
    usePkce: true,
  })

  // Notion — classic "public integration" OAuth
  // (https://developers.notion.com/docs/authorization). Notion's own
  // *hosted* remote MCP server (mcp.notion.com) actually speaks the newer
  // MCP-native OAuth (dynamic client registration, no static client_id) —
  // if you point the Notion connector at that server instead of a
  // self-hosted one, swap this registration for that flow. This
  // registration covers the general "provider requires OAuth" case the
  // framework is built for.
  oauthProviderRegistry.register({
    providerId: 'notion',
    displayName: 'Notion',
    authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    clientId: env('VITE_NOTION_OAUTH_CLIENT_ID'),
    clientSecret: env('VITE_NOTION_OAUTH_CLIENT_SECRET') || undefined,
    usePkce: false,
    extraAuthParams: { owner: 'user' },
  })
}
