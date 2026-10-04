// services/oauth/OAuthManager.ts
//
// Provider-agnostic OAuth 2.0 (Authorization Code + PKCE) manager for
// remote MCP servers. Completely independent of the MCP transport layer —
// this file never imports lib/mcp/McpClient.ts or knows what an MCP server
// is; it just produces valid access tokens for a `providerId` on request.
// services/connectors/BaseOAuthMcpConnector.ts is the only thing that
// bridges the two, by handing the token this returns to `mcpConnect`'s
// `authToken` param as an Authorization header.
//
// Responsibilities:
//   1. Start OAuth login — build the authorization URL (+ PKCE challenge)
//      for a registered provider and open it in the system browser.
//   2. Handle the OAuth callback — `rachna-ide://oauth-callback?code=...`,
//      via the same custom-URI-scheme deep-link mechanism the app's own
//      sign-in flow already uses (see App.tsx's `rachna-ide://auth`
//      handler). Works identically on Windows/macOS/Linux since it reuses
//      the already-registered, already cross-platform-tested
//      `rachna-ide://` scheme (src-tauri/tauri.conf.json,
//      tauri-plugin-deep-link, and main.rs's loopback forwarding for the
//      "OS launched a brand-new process" case).
//   3. Exchange the authorization code for tokens (delegates the actual
//      HTTP call to the Rust `oauth_exchange_code` command — see
//      src-tauri/src/oauth.rs — so it isn't constrained by the webview's
//      CSP connect-src allow-list).
//   4. Refresh expired access tokens automatically.
//   5. Persist tokens via the existing secure storage mechanism — the OS
//      keychain, through lib/keychain.ts (same wrapper GitHub's PAT and the
//      app's own session token use).
//   6. Return a valid (refreshed-if-needed) access token on request.
//
// Not in scope here: which providers require OAuth, or what to do with the
// token once obtained — that's OAuthProviderRegistry.ts and
// BaseOAuthMcpConnector.ts, respectively. This file only ever talks about
// `providerId` strings.

import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { keychainSet, keychainGet, keychainDelete } from '../../lib/keychain'
import { oauthProviderRegistry, OAUTH_REDIRECT_URI } from './OAuthProviderRegistry'
import { generateRandomString, deriveCodeChallenge } from './pkce'
import type { OAuthProviderConfig, OAuthTokenSet, OAuthTokenResponseRaw } from '../../types/oauth'

/** How long before actual expiry we treat a token as "needs refresh" —
 *  gives network latency + clock skew some headroom. */
const EXPIRY_SKEW_MS = 60_000
/** How long a pending login waits for the browser round-trip before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000

const KEYCHAIN_PREFIX = 'oauth_token_'

function keychainId(providerId: string): string {
  return `${KEYCHAIN_PREFIX}${providerId}`
}

interface PendingLogin {
  providerId: string
  codeVerifier?: string
  resolve: (token: OAuthTokenSet) => void
  reject: (err: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

function rawToTokenSet(raw: OAuthTokenResponseRaw, previousRefreshToken?: string): OAuthTokenSet {
  return {
    accessToken: raw.access_token,
    // Not every provider re-issues a refresh_token on refresh — fall back
    // to the one we already had so it isn't lost.
    refreshToken: raw.refresh_token ?? previousRefreshToken,
    expiresAt: typeof raw.expires_in === 'number' ? Date.now() + raw.expires_in * 1000 : undefined,
    tokenType: raw.token_type ?? undefined,
    scope: raw.scope ?? undefined,
  }
}

class OAuthManager {
  private pendingByState = new Map<string, PendingLogin>()
  private listenerReady: Promise<void> | null = null

  // ── Callback plumbing ────────────────────────────────────────────────

  /** Idempotent — safe to call from every `startLogin`. Registers exactly
   *  once per app session. */
  private ensureCallbackListener(): Promise<void> {
    if (!this.listenerReady) {
      this.listenerReady = this.registerCallbackListener()
    }
    return this.listenerReady
  }

  private async registerCallbackListener(): Promise<void> {
    const handle = (url: string) => this.handleCallbackUrl(url)

    // Cold-start edge case: shouldn't normally happen for OAuth (unlike the
    // app's own sign-in, a login can only be *started* while the app is
    // already running), but harmless to check.
    try {
      const current = await getCurrent()
      if (current) {
        const url = Array.isArray(current) ? current[0] : current
        if (url) handle(url)
      }
    } catch {
      /* getCurrent() throws when there's no pending URL — expected, ignore. */
    }

    try {
      await onOpenUrl((urls: string[]) => { for (const u of urls) handle(u) })
    } catch (e) {
      console.error('[OAuthManager] Failed to register onOpenUrl listener:', e)
    }

    // Windows/Linux fallback: a second OS-launched process forwards its
    // rachna-ide:// URL to this running instance over the app's existing
    // loopback handoff (see src-tauri/src/main.rs), which re-emits it as
    // `deep-link-urls` — the same event App.tsx listens to for its own
    // `rachna-ide://auth` flow. Both listeners simply ignore URLs that
    // don't match their own prefix.
    try {
      await listen<string[]>('deep-link-urls', ({ payload }) => { for (const u of payload) handle(u) })
    } catch (e) {
      console.error('[OAuthManager] Failed to register deep-link-urls listener:', e)
    }
  }

  private handleCallbackUrl(url: string): void {
    if (!url.startsWith(OAUTH_REDIRECT_URI)) return

    let params: URLSearchParams
    try {
      params = new URL(url).searchParams
    } catch {
      return
    }

    const state = params.get('state')
    if (!state) return
    const pending = this.pendingByState.get(state)
    if (!pending) return // stale/replayed/foreign callback — ignore

    this.pendingByState.delete(state)
    clearTimeout(pending.timeoutId)

    const error = params.get('error')
    if (error) {
      pending.reject(new Error(`${pending.providerId} OAuth error: ${error}${params.get('error_description') ? ` — ${params.get('error_description')}` : ''}`))
      return
    }

    const code = params.get('code')
    if (!code) {
      pending.reject(new Error(`${pending.providerId} OAuth callback missing "code"`))
      return
    }

    this.exchangeCode(pending.providerId, code, pending.codeVerifier)
      .then(tokenSet => pending.resolve(tokenSet))
      .catch(err => pending.reject(err instanceof Error ? err : new Error(String(err))))
  }

  // ── 1. Start OAuth login ────────────────────────────────────────────

  /**
   * Opens the system browser to the provider's authorization page and
   * resolves once the resulting `rachna-ide://oauth-callback` has been
   * received and exchanged for a token set (which is also persisted to the
   * keychain before this resolves). Rejects on user-denied consent,
   * timeout, or a token-exchange failure.
   */
  async startLogin(providerId: string): Promise<OAuthTokenSet> {
    const config = oauthProviderRegistry.require(providerId)
    if (!config.clientId) {
      throw new Error(
        `${config.displayName} OAuth is not configured (missing client id). ` +
        `Set VITE_${providerId.toUpperCase()}_OAUTH_CLIENT_ID and rebuild.`
      )
    }

    await this.ensureCallbackListener()

    const state = generateRandomString()
    const codeVerifier = config.usePkce ? generateRandomString() : undefined

    const authUrl = await this.buildAuthorizationUrl(config, state, codeVerifier)

    const tokenSet = await new Promise<OAuthTokenSet>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingByState.delete(state)
        reject(new Error(`${config.displayName} sign-in timed out. Please try again.`))
      }, LOGIN_TIMEOUT_MS)

      this.pendingByState.set(state, { providerId, codeVerifier, resolve, reject, timeoutId })
    })

    return tokenSet
  }

  private async buildAuthorizationUrl(
    config: OAuthProviderConfig,
    state: string,
    codeVerifier: string | undefined
  ): Promise<string> {
    const url = new URL(config.authorizationUrl)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', config.redirectUri ?? OAUTH_REDIRECT_URI)
    url.searchParams.set('state', state)
    if (config.scopes.length > 0) {
      url.searchParams.set('scope', config.scopes.join(config.scopeSeparator ?? ' '))
    }
    if (codeVerifier) {
      url.searchParams.set('code_challenge', await deriveCodeChallenge(codeVerifier))
      url.searchParams.set('code_challenge_method', 'S256')
    }
    for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
      url.searchParams.set(key, value)
    }

    try {
      await open(url.toString())
    } catch (e) {
      throw new Error(`Failed to open browser for ${config.displayName} sign-in: ${e instanceof Error ? e.message : String(e)}`)
    }

    return url.toString()
  }

  // ── 3. Exchange code for tokens ─────────────────────────────────────

  private async exchangeCode(providerId: string, code: string, codeVerifier: string | undefined): Promise<OAuthTokenSet> {
    const config = oauthProviderRegistry.require(providerId)
    const raw = await invoke<OAuthTokenResponseRaw>('oauth_exchange_code', {
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret ?? null,
      code,
      redirectUri: config.redirectUri ?? OAUTH_REDIRECT_URI,
      codeVerifier: codeVerifier ?? null,
    })
    const tokenSet = rawToTokenSet(raw)
    await this.saveToken(providerId, tokenSet)
    return tokenSet
  }

  // ── 4. Refresh ───────────────────────────────────────────────────────

  private async refreshAccessToken(providerId: string, current: OAuthTokenSet): Promise<OAuthTokenSet> {
    if (!current.refreshToken) {
      throw new Error(`No refresh token stored for ${providerId}; re-authentication required.`)
    }
    const config = oauthProviderRegistry.require(providerId)
    const raw = await invoke<OAuthTokenResponseRaw>('oauth_refresh_token', {
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret ?? null,
      refreshToken: current.refreshToken,
    })
    const tokenSet = rawToTokenSet(raw, current.refreshToken)
    await this.saveToken(providerId, tokenSet)
    return tokenSet
  }

  // ── 5. Secure storage (OS keychain, via lib/keychain.ts) ───────────

  private async saveToken(providerId: string, tokenSet: OAuthTokenSet): Promise<void> {
    await keychainSet(keychainId(providerId), JSON.stringify(tokenSet))
  }

  private async loadToken(providerId: string): Promise<OAuthTokenSet | null> {
    const raw = await keychainGet(keychainId(providerId))
    if (!raw) return null
    try {
      return JSON.parse(raw) as OAuthTokenSet
    } catch {
      return null
    }
  }

  async clearToken(providerId: string): Promise<void> {
    await keychainDelete(keychainId(providerId))
  }

  // ── Public surface used by connectors ───────────────────────────────

  /** Whether *some* token (possibly expired) is stored for this provider. */
  async isAuthenticated(providerId: string): Promise<boolean> {
    const token = await this.loadToken(providerId)
    return !!token?.accessToken
  }

  /**
   * 6. Returns a valid, non-expired access token — refreshing first if
   * needed. Throws if there's no stored token (never logged in) or if
   * refreshing fails (stale/revoked refresh token) — callers should treat
   * either as "needs to (re-)authenticate" (see BaseOAuthMcpConnector).
   */
  async getValidAccessToken(providerId: string): Promise<string> {
    let token = await this.loadToken(providerId)
    if (!token?.accessToken) {
      throw new Error(`Not authenticated with ${providerId}. Connect it first.`)
    }

    const isExpiring = typeof token.expiresAt === 'number' && token.expiresAt - EXPIRY_SKEW_MS <= Date.now()
    if (isExpiring) {
      try {
        token = await this.refreshAccessToken(providerId, token)
      } catch (err) {
        // A dead refresh token means the stored session is no longer
        // usable — drop it so `isAuthenticated` correctly reports false
        // and the UI prompts to reconnect, rather than retrying forever.
        await this.clearToken(providerId)
        throw err instanceof Error ? err : new Error(String(err))
      }
    }

    return token.accessToken
  }

  /**
   * Full login flow: starts the browser-based OAuth login and returns once
   * a token has been obtained and persisted. Used by
   * BaseOAuthMcpConnector.authenticate().
   */
  async login(providerId: string): Promise<OAuthTokenSet> {
    return this.startLogin(providerId)
  }
}

/** Singleton — one OAuthManager (and one set of pending logins) per app session. */
export const oauthManager = new OAuthManager()
