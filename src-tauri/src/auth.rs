// src-tauri/src/auth.rs
//
// Authentication helpers for Rachna IDE.
//
// IMPORTANT: a Rachna account is ONLY needed for Rachna Cloud AI. Nothing in
// this file is on the app's startup path any more — the IDE opens and works
// fully (own API keys, local models, MCP, terminal, ...) without ever signing
// in. These commands are called only when the person chooses to use Rachna
// Cloud, via the sign-in dialog (components/LoginScreen.tsx).
//
// `verify_session` re-validates a cached session in the background: the
// session token minted by the backend is an opaque UUID (not a JWT), so the
// frontend can't decode account data out of it locally — this command fetches
// the real user info from the one endpoint that has it, GET /api/auth/me.

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://mirage-be-1.onrender.com";

/// User information returned by a successful token verification.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo {
    pub email: String,
    pub plan: String,
    pub coins: f64,
    #[serde(flatten)]
    pub entitlements: AccountEntitlements,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntitlements {
    #[serde(default)] pub can_configure_actions: bool,
    #[serde(default)] pub can_configure_permissions: bool,
}

// Shape of GET /api/auth/me — see models.AuthResponse / UserDTO in the Go
// backend. Only the fields we need are declared; serde ignores the rest.
#[derive(Debug, Deserialize)]
struct MeUserDto {
    email: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeResponse {
    user: MeUserDto,
    plan: String,
    #[serde(default)]
    daily_tokens: f64,
    #[serde(default)]
    permanent_tokens: f64,
    #[serde(flatten)]
    entitlements: AccountEntitlements,
}

/// Verify a session token against the Rachna auth endpoint.
///
/// Returns:
/// - `Ok(UserInfo)` — token is valid, server returned user data
/// - `Err("NETWORK_ERROR:<detail>")` — server unreachable / timeout (>90 s)
/// - `Err("INVALID_TOKEN")` — server rejected the token as unauthenticated
///   (401/403). This is the ONLY outcome that should ever cost the user
///   their session — see the module doc below.
/// - `Err("HTTP_ERROR:<code>")` — server responded but with some other
///   non-success status (e.g. 500, 503). This is a backend problem, not a
///   verdict on the token, and must NOT be treated like `INVALID_TOKEN` by
///   callers.
/// - `Err("PARSE_ERROR:<detail>")` — unexpected response shape
#[tauri::command]
pub async fn verify_session(token: String) -> Result<UserInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    let resp = client
        .get(format!("{API_BASE}/api/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    let status = resp.status();

    if status.is_success() {
        let me: MeResponse = resp
            .json()
            .await
            .map_err(|e| format!("PARSE_ERROR:{e}"))?;
        Ok(UserInfo {
            email: me.user.email,
            plan: me.plan,
            // The existing auth contract exposes the two spendable balance
            // buckets separately. The IDE presents their sum as Coins while
            // the backend remains authoritative for accounting/deduction.
            coins: me.daily_tokens + me.permanent_tokens,
            entitlements: me.entitlements,
        })
    } else {
        match status.as_u16() {
            // Only these mean "this token is not/no-longer valid". Anything
            // else (500, 502, 503, 429, ...) is the backend having a bad
            // moment and must not be conflated with an auth failure.
            401 | 403 => Err("INVALID_TOKEN".to_string()),
            code => Err(format!("HTTP_ERROR:{code}")),
        }
    }
}

// ── Login (email + password, direct API call) ───────────────────────────────
//
// Rachna IDE signs in by calling the backend's own POST /api/auth/login
// directly (see models.AuthResponse in the Go backend) — there is no
// browser/deep-link handoff involved. Reuses the same DTO shape as
// `verify_session`'s MeResponse (they're both models.AuthResponse) plus the
// login-only `accessToken` field.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponseDto {
    access_token: String,
    user: MeUserDto,
    plan: String,
    #[serde(default)]
    daily_tokens: f64,
    #[serde(default)]
    permanent_tokens: f64,
    #[serde(flatten)]
    entitlements: AccountEntitlements,
}

/// Result of a successful login: the opaque session token plus the same
/// account info shape `verify_session` returns, so both flow into
/// `useAuthStore.setSession()` identically.
#[derive(Debug, Serialize)]
pub struct LoginResult {
    pub token: String,
    pub user: UserInfo,
}

/// Sign in with email + password against POST /api/auth/login.
///
/// Returns:
/// - `Ok(LoginResult)` — credentials accepted, session token + account info
/// - `Err("INVALID_CREDENTIALS")` — server rejected the email/password (401)
/// - `Err("ACCOUNT_SUSPENDED")` — server rejected because the account is
///   suspended (401 with a matching message)
/// - `Err("UPGRADE_REQUIRED:<json>")` — server rejected with 426 because
///   `app_version` is too old to sign in; `<json>` is the raw response body
///   (message/latestVersion/minSupportedVersion) for the caller to parse
/// - `Err("NETWORK_ERROR:<detail>")` — server unreachable / timeout
/// - `Err("HTTP_ERROR:<code>:<body>")` — any other non-success status
/// - `Err("PARSE_ERROR:<detail>")` — unexpected response shape
#[tauri::command]
pub async fn login(email: String, password: String, app_version: String) -> Result<LoginResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    let resp = client
        .post(format!("{API_BASE}/api/auth/login"))
        .json(&serde_json::json!({
            "email": email,
            "password": password,
            "appVersion": app_version,
            "client": "ide",
        }))
        .send()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    finish_auth_response(status.as_u16(), &raw, "INVALID_CREDENTIALS")
}

/// Shared by `login` and `google_sign_in` — both hit an endpoint that returns
/// the same `models.AuthResponse` body and the same error statuses.
/// `unauthorized_code` is what a plain 401 maps to for the calling flow.
fn finish_auth_response(status: u16, raw: &str, unauthorized_code: &str) -> Result<LoginResult, String> {
    if (200..300).contains(&status) {
        let dto: LoginResponseDto =
            serde_json::from_str(raw).map_err(|e| format!("PARSE_ERROR:{e}"))?;
        return Ok(LoginResult {
            token: dto.access_token,
            user: UserInfo {
                email: dto.user.email,
                plan: dto.plan,
                coins: dto.daily_tokens + dto.permanent_tokens,
                entitlements: dto.entitlements,
            },
        });
    }

    match status {
        426 => Err(format!("UPGRADE_REQUIRED:{raw}")),
        401 if raw.to_lowercase().contains("suspended") => Err("ACCOUNT_SUSPENDED".to_string()),
        401 => Err(unauthorized_code.to_string()),
        code => Err(format!("HTTP_ERROR:{code}:{raw}")),
    }
}

// ── Google sign-in (browser + loopback redirect) ────────────────────────────
//
// "Continue with Google" for a Rachna account. Standard installed-app flow
// (RFC 8252 / Google "Desktop app" OAuth client):
//
//   1. Bind a one-shot listener on 127.0.0.1:<random port>.
//   2. Open Google's consent page in the system browser (PKCE + `state`).
//   3. Google redirects the browser to http://127.0.0.1:<port>/callback?code=…;
//      the listener grabs the code and shows a "you can close this tab" page.
//   4. Exchange the code at Google's token endpoint for an ID token.
//   5. POST that ID token to the backend's POST /api/auth/google, which
//      verifies it and returns the same AuthResponse as /api/auth/login.
//
// The OAuth client id (and, because Google still issues one for Desktop
// clients, its non-confidential "secret") come from the frontend's build-time
// env — see .env.example. The backend must list that client id in its
// GOOGLE_CLIENT_IDS allow-list or step 5 is rejected.
//
// Errors (all `Err(String)` codes the frontend maps to friendly messages):
//   GOOGLE_NOT_CONFIGURED, GOOGLE_SIGNIN_CANCELLED, GOOGLE_SIGNIN_TIMEOUT,
//   GOOGLE_STATE_MISMATCH, GOOGLE_SIGNIN_FAILED:<detail>,
//   GOOGLE_TOKEN_ERROR:<status>:<body>, GOOGLE_REJECTED (backend said 401),
//   plus the same ACCOUNT_SUSPENDED / UPGRADE_REQUIRED:<json> / NETWORK_ERROR /
//   HTTP_ERROR / PARSE_ERROR codes as `login`.

use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_SIGNIN_TIMEOUT: Duration = Duration::from_secs(180);

/// Wakes any in-flight `google_sign_in` so it can stop waiting for the
/// browser (user closed the dialog). `notify_waiters` stores no permit, so a
/// cancel with nothing in flight can never poison the next attempt.
static GOOGLE_SIGNIN_CANCEL: tokio::sync::Notify = tokio::sync::Notify::const_new();

#[derive(Debug, Deserialize)]
struct GoogleTokenResponse {
    id_token: Option<String>,
}

async fn write_http_page(stream: &mut TcpStream, status: &str, title: &str, message: &str) {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0d0d0f;color:#e6e6f0;\
         display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}\
         div{{text-align:center;max-width:420px;padding:0 1.5rem}}h1{{font-size:1.2rem;margin:0 0 .6rem}}\
         p{{color:#8a8aa0;font-size:.9rem;line-height:1.5;margin:0}}</style></head>\
         <body><div><h1>{title}</h1><p>{message}</p></div></body></html>"
    );
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Accepts connections until one carries the OAuth redirect (`code` or
/// `error`), ignoring unrelated requests such as /favicon.ico.
async fn await_google_callback(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => continue,
        };
        let request = String::from_utf8_lossy(&buf[..n]).into_owned();
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");
        let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else {
            write_http_page(&mut stream, "400 Bad Request", "Bad request", "You can close this tab.").await;
            continue;
        };

        let (mut code, mut state, mut error) = (None, None, None);
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "code" => code = Some(value.into_owned()),
                "state" => state = Some(value.into_owned()),
                "error" => error = Some(value.into_owned()),
                _ => {}
            }
        }
        if code.is_none() && error.is_none() {
            write_http_page(&mut stream, "404 Not Found", "Not found", "").await;
            continue;
        }
        if state.as_deref() != Some(expected_state) {
            write_http_page(&mut stream, "400 Bad Request", "Sign-in failed", "This sign-in request did not match. Close this tab and try again from Rachna IDE.").await;
            return Err("GOOGLE_STATE_MISMATCH".to_string());
        }
        if let Some(error) = error {
            write_http_page(&mut stream, "200 OK", "Sign-in cancelled", "You can close this tab and return to Rachna IDE.").await;
            return Err(if error == "access_denied" {
                "GOOGLE_SIGNIN_CANCELLED".to_string()
            } else {
                format!("GOOGLE_SIGNIN_FAILED:{error}")
            });
        }
        write_http_page(&mut stream, "200 OK", "You're signed in", "You can close this tab and return to Rachna IDE.").await;
        return Ok(code.unwrap_or_default());
    }
}

/// Sign in with Google. `code_challenge` / `code_verifier` are the PKCE pair
/// and `state` the CSRF token, all generated by the frontend (pkce.ts).
#[tauri::command]
pub async fn google_sign_in(
    client_id: String,
    client_secret: Option<String>,
    code_challenge: String,
    code_verifier: String,
    state: String,
    app_version: String,
) -> Result<LoginResult, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("GOOGLE_NOT_CONFIGURED".to_string());
    }

    // Registered before the browser opens so a cancel can never be missed.
    let cancelled = GOOGLE_SIGNIN_CANCEL.notified();
    tokio::pin!(cancelled);

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = reqwest::Url::parse_with_params(
        GOOGLE_AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("code_challenge", code_challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|e| format!("GOOGLE_SIGNIN_FAILED:{e}"))?;
    open::that(auth_url.as_str()).map_err(|e| format!("GOOGLE_SIGNIN_FAILED:could not open browser: {e}"))?;

    let code = tokio::select! {
        result = await_google_callback(&listener, &state) => result?,
        _ = tokio::time::sleep(GOOGLE_SIGNIN_TIMEOUT) => return Err("GOOGLE_SIGNIN_TIMEOUT".to_string()),
        _ = &mut cancelled => return Err("GOOGLE_SIGNIN_CANCELLED".to_string()),
    };
    drop(listener);

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;

    // Code → ID token.
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", code_verifier),
    ];
    if let Some(secret) = client_secret.filter(|s| !s.trim().is_empty()) {
        form.push(("client_secret", secret));
    }
    let token_resp = http
        .post(GOOGLE_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;
    let token_status = token_resp.status();
    let token_body = token_resp.text().await.unwrap_or_default();
    if !token_status.is_success() {
        return Err(format!(
            "GOOGLE_TOKEN_ERROR:{}:{}",
            token_status.as_u16(),
            token_body.chars().take(500).collect::<String>()
        ));
    }
    let id_token = serde_json::from_str::<GoogleTokenResponse>(&token_body)
        .map_err(|e| format!("PARSE_ERROR:{e}"))?
        .id_token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "PARSE_ERROR:Google did not return an ID token".to_string())?;

    // ID token → Rachna session.
    let resp = http
        .post(format!("{API_BASE}/api/auth/google"))
        .json(&serde_json::json!({
            "idToken": id_token,
            "appVersion": app_version,
            "client": "ide",
        }))
        .send()
        .await
        .map_err(|e| format!("NETWORK_ERROR:{e}"))?;
    let status = resp.status().as_u16();
    let raw = resp.text().await.unwrap_or_default();
    finish_auth_response(status, &raw, "GOOGLE_REJECTED")
}

/// Stop waiting for the browser (the person closed the sign-in dialog). No-op
/// if no Google sign-in is in flight.
#[tauri::command]
pub fn google_sign_in_cancel() {
    GOOGLE_SIGNIN_CANCEL.notify_waiters();
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudAiGenerateRequest {
    pub prompt: String,
}

/// Authenticated transport for the existing POST /api/ai/cloud-provider
/// contract. Provider behavior stays in the TypeScript AIProvider adapter;
/// this command only avoids webview CSP/CORS constraints and never persists
/// the token.
#[tauri::command]
pub async fn cloud_ai_generate(
    token: String,
    request: CloudAiGenerateRequest,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "CLOUD_AI_NETWORK".to_string())?;

    // Rachna Cloud AI is served by POST /api/ai/cloud-provider (see
    // handlers.AIHandler.CloudProvider in the Go backend) — there is no
    // /api/ai/generate route.
    let response = client
        .post(format!("{API_BASE}/api/ai/cloud-provider"))
        .bearer_auth(&token)
        .json(&request)
        .send()
        .await
        .map_err(|_| "CLOUD_AI_NETWORK".to_string())?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let lower = body.to_lowercase();
        let code = match status.as_u16() {
            401 => "CLOUD_AI_AUTHENTICATION",
            402 => "CLOUD_AI_INSUFFICIENT_COINS",
            403 if lower.contains("insufficient") || lower.contains("balance") || lower.contains("coin") => "CLOUD_AI_INSUFFICIENT_COINS",
            403 => "CLOUD_AI_PERMISSION",
            429 => "CLOUD_AI_RATE_LIMITED",
            500..=599 => "CLOUD_AI_SERVER",
            _ if lower.contains("insufficient") || lower.contains("balance") || lower.contains("coin") => "CLOUD_AI_INSUFFICIENT_COINS",
            _ => "CLOUD_AI_REQUEST",
        };
        return Err(code.to_string());
    }

    serde_json::from_str(&body).map_err(|_| "CLOUD_AI_RESPONSE".to_string())
}

// ── Cached session (stay-signed-in) ─────────────────────────────────────────
//
// Rachna IDE used to require signing in on every launch (see the note that
// used to live at the top of store/useAuthStore.ts). That's now relaxed
// further than a simple time window: the cached token has NO local expiry
// at all. A restart, a reboot, a sleep/wake cycle, days of not opening the
// app — none of it signs the user out on its own. The backend is the only
// source of truth for whether a session is still good:
//
//   - On launch, the frontend loads whatever is cached here and asks the
//     server (`verify_session` / GET /api/auth/me) whether it's still
//     valid.
//   - Only a real auth rejection (401/403 → `INVALID_TOKEN`) clears the
//     cache and sends the user back to sign-in.
//   - A temporary backend problem (500s, timeouts, DNS failure, the API
//     host being asleep/offline, etc.) must NOT clear the cache — the user
//     stays signed in with their last-known session and the app just
//     retries verification on a future launch.
//
// The token is written to the OS-native credential store (Keychain /
// Credential Manager / Secret Service) via the `keyring` crate under the
// SAME service+key that `ensure_managed_node` (commands.rs) already reads
// from — that function was wired up to read a cached token but nothing was
// ever writing one, which is also why the managed Node.js download never
// actually ran. `save_cached_session` below is the missing write side.
//
// Alongside the token we also cache the last-known `UserInfo`,
// purely so that if a launch happens while the backend is temporarily
// unreachable, the app can still open normally showing the last-known
// account details instead of blocking on a fresh network round-trip.

const SESSION_SERVICE: &str = "com.rachnaai.ide";
const SESSION_TOKEN_KEY: &str = "rachna_session_token";
const SESSION_USER_KEY: &str = "rachna_session_user";

/// A cached token plus whatever user info we last knew about it (if any).
/// `user` may be `None` for a token cached by an older build that predates
/// this field, or if the user-info write failed at save time — callers
/// should treat that as "we don't have a last-known identity to show", not
/// as a reason to distrust the token itself.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CachedSession {
    pub token: String,
    pub user: Option<UserInfo>,
}

fn session_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SESSION_SERVICE, key).map_err(|e| e.to_string())
}

/// Persist a freshly-verified session (token + user info) so the next
/// launch can skip the login screen. Called right after a successful
/// deep-link sign-in, and again after every successful `verify_session` on
/// launch so the cached user info stays fresh.
///
/// Best-effort by design at the call site: a failure here should not block
/// the user from using the app they just signed into, it just means
/// they'll be asked to sign in again next launch.
#[tauri::command]
pub fn save_cached_session(token: String, user_info: Option<UserInfo>) -> Result<(), String> {
    session_entry(SESSION_TOKEN_KEY)?
        .set_password(&token)
        .map_err(|e| e.to_string())?;

    if let Some(user_info) = user_info {
        let user_json = serde_json::to_string(&user_info).map_err(|e| e.to_string())?;
        session_entry(SESSION_USER_KEY)?
            .set_password(&user_json)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns the cached token (plus last-known user info, if any), or `None`
/// if nothing has ever been cached. Deliberately does NOT apply any
/// time-based or reboot-based expiry — there is no local notion of "too
/// old" anymore. Callers (useAuthStore.initAuth) are expected to still call
/// `verify_session` against the returned token before trusting it fully —
/// this only answers "here's what we have on disk", not "is it definitely
/// valid" (the server may have revoked it independently, e.g. signed out
/// elsewhere).
#[tauri::command]
pub fn load_cached_session() -> Result<Option<CachedSession>, String> {
    let token_entry = session_entry(SESSION_TOKEN_KEY)?;
    let token = match token_entry.get_password() {
        Ok(t) => t,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let user = match session_entry(SESSION_USER_KEY)?.get_password() {
        Ok(raw) => serde_json::from_str(&raw).ok(),
        // Missing or corrupt user-info cache is fine — we still have a
        // token worth trying against the server.
        Err(_) => None,
    };

    Ok(Some(CachedSession { token, user }))
}

/// Clear the cached session (sign-out, or a real 401/403 `INVALID_TOKEN`
/// detected elsewhere. Treated as a no-op if
/// nothing was cached. Also best-effort cleans up the legacy
/// `rachna_session_meta` entry written by older builds that used to store
/// a time/boot-time expiry window — harmless if it's not there.
#[tauri::command]
pub fn clear_cached_session() -> Result<(), String> {
    if let Ok(entry) = session_entry(SESSION_TOKEN_KEY) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if let Ok(entry) = session_entry(SESSION_USER_KEY) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    // Legacy key from the old time/boot-based expiry scheme — best-effort,
    // ignore any error (including it simply not existing).
    if let Ok(entry) = session_entry("rachna_session_meta") {
        let _ = entry.delete_credential();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sends one raw HTTP request to the loopback listener and returns the
    /// first line of the response (e.g. "HTTP/1.1 200 OK").
    async fn send(port: u16, target: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
            .await
            .unwrap();
        let mut out = String::new();
        let mut buf = vec![0u8; 4096];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        out.lines().next().unwrap_or("").to_string()
    }

    async fn listener() -> (TcpListener, u16) {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    #[tokio::test]
    async fn callback_returns_code_and_ignores_unrelated_requests() {
        let (l, port) = listener().await;
        let waiter = tokio::spawn(async move { await_google_callback(&l, "state123").await });
        // A browser typically also asks for the favicon — must not end the wait.
        assert!(send(port, "/favicon.ico").await.contains("404"));
        assert!(send(port, "/callback?code=abc%2F123&state=state123").await.contains("200"));
        assert_eq!(waiter.await.unwrap(), Ok("abc/123".to_string()));
    }

    #[tokio::test]
    async fn callback_rejects_a_mismatched_state() {
        let (l, port) = listener().await;
        let waiter = tokio::spawn(async move { await_google_callback(&l, "expected").await });
        assert!(send(port, "/callback?code=abc&state=forged").await.contains("400"));
        assert_eq!(waiter.await.unwrap(), Err("GOOGLE_STATE_MISMATCH".to_string()));
    }

    #[tokio::test]
    async fn callback_maps_user_cancellation() {
        let (l, port) = listener().await;
        let waiter = tokio::spawn(async move { await_google_callback(&l, "s").await });
        send(port, "/callback?error=access_denied&state=s").await;
        assert_eq!(waiter.await.unwrap(), Err("GOOGLE_SIGNIN_CANCELLED".to_string()));
    }

    #[test]
    fn auth_response_statuses_map_to_stable_codes() {
        assert_eq!(finish_auth_response(426, "{}", "X").unwrap_err(), "UPGRADE_REQUIRED:{}");
        assert_eq!(finish_auth_response(401, "{\"error\":\"account suspended\"}", "X").unwrap_err(), "ACCOUNT_SUSPENDED");
        assert_eq!(finish_auth_response(401, "{}", "INVALID_CREDENTIALS").unwrap_err(), "INVALID_CREDENTIALS");
        assert_eq!(finish_auth_response(401, "{}", "GOOGLE_REJECTED").unwrap_err(), "GOOGLE_REJECTED");
        assert!(finish_auth_response(500, "boom", "X").unwrap_err().starts_with("HTTP_ERROR:500"));
    }

    #[test]
    fn auth_response_success_parses_account() {
        let raw = r#"{"accessToken":"tok","user":{"email":"a@b.c"},"plan":"FREE","dailyTokens":3,"permanentTokens":4}"#;
        let ok = finish_auth_response(200, raw, "X").unwrap();
        assert_eq!(ok.token, "tok");
        assert_eq!(ok.user.email, "a@b.c");
        assert_eq!(ok.user.coins, 7.0);
    }
}
