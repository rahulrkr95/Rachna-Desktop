// src-tauri/src/oauth.rs
//
// Generic OAuth 2.0 (Authorization Code + PKCE) token exchange/refresh for
// the frontend's provider-agnostic `OAuthManager`
// (services/oauth/OAuthManager.ts). This is *not* GitHub-specific and does
// not touch anything GitHub's PAT auth uses (keychain.rs, connectors/github/).
//
// Division of responsibility:
//   - The renderer builds the authorization URL, opens the system browser
//     (`@tauri-apps/plugin-shell`'s `open()`), and receives the
//     `rachna-ide://oauth-callback?...` redirect via the deep-link plugin
//     (same mechanism `App.tsx` already uses for the app's own sign-in).
//   - The renderer hands the resulting `code` (+ PKCE `code_verifier`) to
//     `oauth_exchange_code` here, which does the actual POST to the
//     provider's token endpoint over reqwest — kept in Rust rather than a
//     renderer `fetch()` so it isn't constrained by the webview's CSP
//     `connect-src` allow-list (see tauri.conf.json) and so a confidential
//     client secret, if a provider requires one, never has to touch the
//     page's fetch stack.
//   - Resulting tokens are handed back to the renderer, which persists them
//     via the existing OS-keychain commands in keychain.rs (same mechanism
//     the GitHub PAT and the app's own session token use) — this file never
//     itself writes to the keychain.
//
// Providers are NOT hardcoded here: `token_url`, `client_id`, etc. are all
// passed in from the frontend's `OAuthProviderRegistry`
// (services/oauth/OAuthProviderRegistry.ts). Adding a new OAuth provider
// never requires touching this file.

use std::time::Duration;

use serde::{Deserialize, Serialize};

type CmdResult<T> = Result<T, String>;

const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Normalized shape of a provider's token-endpoint response. Extra fields
/// providers send back (e.g. Slack's `authed_user`, `team`, `bot_user_id`)
/// are intentionally not modeled — MCP auth only needs a bearer token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds from now until the access token expires, per RFC 6749 §5.1.
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

fn http_client() -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TOKEN_REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{e}"))
}

/// Shared response handling for both the code exchange and refresh calls.
/// OAuth token endpoints are supposed to return JSON on both success and
/// error (RFC 6749 §5.2), but not every real-world provider is well
/// behaved, so failures carry the raw response body for diagnostics rather
/// than swallowing it.
async fn parse_token_response(resp: reqwest::Response) -> CmdResult<OAuthTokenResponse> {
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    if !status.is_success() {
        return Err(format!(
            "HTTP_ERROR:{}:{}",
            status.as_u16(),
            body.chars().take(2000).collect::<String>()
        ));
    }

    serde_json::from_str::<OAuthTokenResponse>(&body)
        .map_err(|e| format!("PARSE_ERROR:{e}:{}", body.chars().take(2000).collect::<String>()))
}

/// Exchanges an authorization `code` (from the OAuth redirect) for an
/// access/refresh token pair, per RFC 6749 §4.1.3 (+ PKCE, RFC 7636 §4.5
/// when `code_verifier` is set).
///
/// `client_secret` is optional: providers that support PKCE-only "public"
/// clients (e.g. Google's "installed app" client type) don't need one —
/// omit it. Providers that still require a confidential secret for desktop
/// apps are a known limitation of the native-app OAuth model; if supplied,
/// it's sent from here (never exposed to the webview's own network stack).
#[tauri::command]
pub async fn oauth_exchange_code(
    token_url: String,
    client_id: String,
    client_secret: Option<String>,
    code: String,
    redirect_uri: String,
    code_verifier: Option<String>,
) -> CmdResult<OAuthTokenResponse> {
    let mut params: Vec<(&str, String)> = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret.filter(|s| !s.is_empty()) {
        params.push(("client_secret", secret));
    }
    if let Some(verifier) = code_verifier.filter(|v| !v.is_empty()) {
        params.push(("code_verifier", verifier));
    }

    let resp = http_client()?
        .post(&token_url)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    parse_token_response(resp).await
}

/// Refreshes an expired access token, per RFC 6749 §6. Some providers
/// rotate the refresh token on every use and some don't — callers
/// (`OAuthManager.refreshAccessToken`) keep the old refresh token around as
/// a fallback when the response omits a new one.
#[tauri::command]
pub async fn oauth_refresh_token(
    token_url: String,
    client_id: String,
    client_secret: Option<String>,
    refresh_token: String,
) -> CmdResult<OAuthTokenResponse> {
    let mut params: Vec<(&str, String)> = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret.filter(|s| !s.is_empty()) {
        params.push(("client_secret", secret));
    }

    let resp = http_client()?
        .post(&token_url)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    parse_token_response(resp).await
}
