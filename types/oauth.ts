// types/oauth.ts
//
// Provider-agnostic OAuth 2.0 (Authorization Code + PKCE) types shared by
// the OAuthProviderRegistry, OAuthManager, and any connector whose
// transport is a remote (mcp-http) MCP server. Nothing here is specific to
// Google/Figma/Slack/Notion — those are just the built-in registrations in
// services/oauth/OAuthProviderRegistry.ts.

/** Static config for one OAuth provider. Registering a new provider is a
 *  pure-data operation — see OAuthProviderRegistry.register(). */
export interface OAuthProviderConfig {
  /** Stable id, e.g. 'google', 'figma', 'slack', 'notion'. Matches the
   *  connector manifest's `auth.oauthProviderId`. */
  providerId: string
  /** Human-readable name shown in error messages / logs. */
  displayName: string
  /** Authorization endpoint the browser is sent to. */
  authorizationUrl: string
  /** Token endpoint used for both the initial exchange and refreshes. */
  tokenUrl: string
  /** Scopes requested, provider-native strings (e.g. 'drive.readonly'). */
  scopes: string[]
  /** How scopes are joined into a single request parameter. Almost always
   *  a space (RFC 6749 §3.3); a few older APIs use a comma. */
  scopeSeparator?: ' ' | ','
  /** OAuth client id. Public/native-app client ids are not really secret
   *  (they're visible in any desktop app's traffic), so these are safe to
   *  ship — see the comment on `clientSecret` below for the one that isn't. */
  clientId: string
  /**
   * Confidential client secret, ONLY for providers that don't support a
   * PKCE-only "public"/native client type. Prefer leaving this unset and
   * using PKCE (`usePkce: true`) wherever the provider allows it — a
   * secret embedded in a shipped desktop app is not really secret. When
   * set, it's sent from the Rust side (oauth.rs) only, never touched by
   * the webview's own fetch/XHR stack.
   */
  clientSecret?: string
  /** Redirect URI registered with the provider. Defaults to the app's
   *  shared OAuth callback (see OAUTH_REDIRECT_URI) if omitted. */
  redirectUri?: string
  /** Whether to use PKCE (RFC 7636). Strongly recommended for every
   *  provider that supports it — all four built-ins do. */
  usePkce: boolean
  /** Extra static query params merged into the authorization request,
   *  e.g. Google's `{ access_type: 'offline', prompt: 'consent' }` to
   *  guarantee a refresh_token comes back. */
  extraAuthParams?: Record<string, string>
}

/** A resolved token set, as persisted (JSON-stringified) in the OS keychain
 *  under `oauth_token_<providerId>` — see services/oauth/OAuthManager.ts. */
export interface OAuthTokenSet {
  accessToken: string
  refreshToken?: string
  /** Epoch ms; absent means "assume long-lived / unknown expiry". */
  expiresAt?: number
  tokenType?: string
  scope?: string
}

/** Raw shape returned by the Rust `oauth_exchange_code` / `oauth_refresh_token`
 *  commands (mirrors `OAuthTokenResponse` in src-tauri/src/oauth.rs). */
export interface OAuthTokenResponseRaw {
  access_token: string
  refresh_token?: string | null
  expires_in?: number | null
  token_type?: string | null
  scope?: string | null
}
