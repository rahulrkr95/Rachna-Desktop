// lib/mcp/googleStdioCredentials.ts
//
// Gmail and Google Calendar are configured in this app as *local* MCP
// servers spawned over stdio (see the "Gmail" / "Google Calendar"
// QUICKSTARTS entries in components/McpSettingsPanel.tsx), not as remote
// (mcp-http) servers — that's a deliberate, permanent split, not a
// stopgap:
//
//   • connectors/google/ (Google Drive today) is an OAuth-over-HTTP
//     connector. It's built on services/connectors/BaseOAuthMcpConnector.ts,
//     which asks services/oauth/OAuthManager.ts for a bearer token and
//     hands it to a *remote* MCP server. OAuthManager's whole design —
//     opening the system browser to an authorization URL, then catching
//     the redirect back on this app's own `rachna-ide://oauth-callback`
//     custom URI scheme — assumes there's a browser-facing app on the
//     other end of that redirect. That's true for a remote server, which
//     this app dials into over HTTP once it has a token.
//
//   • Gmail and Google Calendar's official MCP servers
//     (@gongrzhe/server-gmail-autoauth-mcp, @cocal/google-calendar-mcp)
//     are the opposite shape: local child *processes* this app spawns
//     over stdio (see services/agent/mcpTools.ts /
//     store/useMcpStore.ts / src-tauri/src/mcp.rs). They are not a
//     website OAuthManager could redirect a browser back to — they
//     handle their own Google sign-in internally: on first run, with no
//     cached token, each one opens the system browser *itself*, drives
//     the OAuth consent screen against the Google Cloud OAuth client the
//     user configured, and caches the resulting token to a file on disk
//     — then reuses that file on every later spawn without prompting
//     again. Routing that through OAuthManager would mean duplicating an
//     OAuth flow the server already implements, for a redirect target
//     (rachna-ide://oauth-callback) the server was never told to use.
//
// So this module intentionally does NOT touch services/oauth/* at all.
// Its only job is making sure the *path* each server caches its token at
// is a stable one — one that survives the app restarting and doesn't
// depend on which project happens to be open (unlike the per-connection
// `cwd` MCP servers otherwise spawn with) — so "first-run auth in the
// browser" really only ever happens once. See
// src-tauri/src/commands.rs's `get_mcp_credentials_dir` for where that
// directory actually lives on disk.
//
// What this module deliberately does NOT do: store or generate the
// user's Google OAuth *client* (id/secret). That has to come from a
// Google Cloud project the user (or their org) controls — there is no
// value we could hardcode here that would work for every install, and
// baking a shared client secret into a shipped desktop app would defeat
// the point of it being a secret. The user downloads their own OAuth
// client credentials JSON from Google Cloud Console and points the
// quickstart's *_OAUTH_PATH / *_OAUTH_CREDENTIALS env var at it — same
// pattern already used for the "Google Drive" quickstart's
// GDRIVE_CREDENTIALS_PATH.

import { createFolder, getHomeDir, getPathInfo, getMcpCredentialsDir, readFile } from '../tauriFs'
import { keychainGet, keychainSet } from '../keychain'
import { invoke } from '@tauri-apps/api/core'

export type GoogleStdioService = 'gmail' | 'google-calendar'

interface ServiceFiles {
  /** Sub-directory (under the shared MCP credentials root) for this service. */
  dirName: string
  /** Filename the server itself writes its cached OAuth token to, once
   *  first-run browser sign-in completes. */
  credentialsFile: string
  /** The env var each server reads that path from — see each package's
   *  README: @gongrzhe/server-gmail-autoauth-mcp honors
   *  `GMAIL_CREDENTIALS_PATH`; @cocal/google-calendar-mcp honors
   *  `GOOGLE_CALENDAR_MCP_TOKEN_PATH`. */
  credentialsEnvKey: string
  /** The env var each server reads the user's own OAuth *client* JSON
   *  path from (downloaded from Google Cloud Console) — see each
   *  package's README: @gongrzhe/server-gmail-autoauth-mcp honors
   *  `GMAIL_OAUTH_PATH`; @cocal/google-calendar-mcp honors
   *  `GOOGLE_OAUTH_CREDENTIALS`. */
  oauthClientEnvKey: string
}

const SERVICE_FILES: Record<GoogleStdioService, ServiceFiles> = {
  gmail: {
    dirName: 'gmail',
    credentialsFile: 'credentials.json',
    credentialsEnvKey: 'GMAIL_CREDENTIALS_PATH',
    oauthClientEnvKey: 'GMAIL_OAUTH_PATH',
  },
  'google-calendar': {
    dirName: 'google-calendar',
    credentialsFile: 'tokens.json',
    credentialsEnvKey: 'GOOGLE_CALENDAR_MCP_TOKEN_PATH',
    oauthClientEnvKey: 'GOOGLE_OAUTH_CREDENTIALS',
  },
}

/** Every credential-path env key this module hands out, in one place —
 *  used by McpSettingsPanel to recognize a server as "one of the Google
 *  stdio quickstarts" (e.g. to show an auth-status hint) without needing
 *  to hardcode either key at each call site. */
export const GOOGLE_STDIO_CREDENTIALS_ENV_KEYS: readonly string[] =
  Object.values(SERVICE_FILES).map(f => f.credentialsEnvKey)

/** Every OAuth-*client*-path env key this module knows about — used by
 *  McpSettingsPanel to decide which env rows get the file-picker button
 *  and pre-connect existence/shape validation (see
 *  `validateGoogleOAuthClientFile` below). */
export const GOOGLE_OAUTH_CLIENT_ENV_KEYS: readonly string[] =
  Object.values(SERVICE_FILES).map(f => f.oauthClientEnvKey)

async function getServiceDir(service: GoogleStdioService): Promise<string> {
  const root = await getMcpCredentialsDir()
  const dir = `${root}/google/${SERVICE_FILES[service].dirName}`
  await createFolder(dir)
  return dir
}

/**
 * Path the server should cache its own OAuth token at, once it completes
 * its own (self-driven) first-run browser sign-in. Stable across app
 * restarts and across whichever project is currently open — that's what
 * lets a later `mcp_connect` for this server reuse it instead of
 * re-prompting the browser flow. Callers pass this as the value for
 * `SERVICE_FILES[service].credentialsEnvKey` when spawning.
 */
export async function getGoogleStdioCredentialsPath(service: GoogleStdioService): Promise<string> {
  if (service === 'gmail') {
    return `${await getHomeDir()}/.gmail-mcp/${SERVICE_FILES.gmail.credentialsFile}`
  }
  const dir = await getServiceDir(service)
  return `${dir}/${SERVICE_FILES[service].credentialsFile}`
}

/**
 * Env defaults the "Gmail" / "Google Calendar" quickstarts pre-fill when
 * applied in McpSettingsPanel — the credentials/token cache path (the one
 * thing this app can always compute on the user's behalf), plus the OAuth
 * *client* JSON path if the user has already picked one for the other
 * Google stdio service in this app (see `getSavedGoogleOAuthClientPath`
 * below) — so picking the file once for Gmail carries over to Google
 * Calendar (and vice versa) instead of asking the user to browse for the
 * same file twice. Never the OAuth client id/secret *contents* — see the
 * module doc above. Keyed by the exact env var name the target server
 * expects, so the panel can merge this straight into that quickstart's
 * existing `env` rows without McpSettingsPanel needing to know which key
 * belongs to which service.
 */
export async function resolveGoogleStdioEnvDefaults(service: GoogleStdioService): Promise<Record<string, string>> {
  const credentialsPath = await getGoogleStdioCredentialsPath(service)
  const defaults: Record<string, string> = {
    [SERVICE_FILES[service].credentialsEnvKey]: credentialsPath,
  }
  const savedClientPath = await getSavedGoogleOAuthClientPath()
  if (savedClientPath) {
    defaults[SERVICE_FILES[service].oauthClientEnvKey] = savedClientPath
  }
  return defaults
}

// ── OAuth client JSON path: picker + shared storage + validation ──────────
//
// Unlike the token cache path above (an app-managed, app-computed
// location), the OAuth *client* JSON is a file the user downloads from
// their own Google Cloud Console project — this app can't compute its
// path, only remember it once the user has picked it via the native file
// dialog (see McpSettingsPanel's "Browse…" button, `pickFile()` in
// tauriFs.ts). The path itself isn't the client secret, but it does
// pinpoint where that secret lives on disk, so — same as every other
// value this app treats as sensitive (see lib/keychain.ts) — it's kept in
// the OS keychain rather than localStorage, and shared across both Gmail
// and Google Calendar since users typically point both quickstarts at the
// same downloaded file.

const GOOGLE_OAUTH_CLIENT_PATH_KEYCHAIN_ID = 'mcp_google_oauth_client_path'

/** The most recently picked Google OAuth client JSON path, if any — used
 *  to pre-fill the *_OAUTH_PATH / GOOGLE_OAUTH_CREDENTIALS field for
 *  whichever of Gmail / Google Calendar the user sets up second. */
export async function getSavedGoogleOAuthClientPath(): Promise<string | null> {
  return keychainGet(GOOGLE_OAUTH_CLIENT_PATH_KEYCHAIN_ID)
}

/** Remembers a newly-picked (or manually typed and successfully
 *  validated) Google OAuth client JSON path for reuse by the other
 *  service's quickstart. Best-effort — a keychain write failure shouldn't
 *  block the user from continuing with the path they just picked. */
export async function saveGoogleOAuthClientPath(path: string): Promise<void> {
  try {
    await keychainSet(GOOGLE_OAUTH_CLIENT_PATH_KEYCHAIN_ID, path)
  } catch (err) {
    console.error('Failed to save Google OAuth client path to OS keychain:', err)
  }
}

/**
 * Checks that `path` points at a real, readable file that actually looks
 * like a Google OAuth client JSON (has an `installed` or `web` block with
 * a `client_id` / `client_secret`) — run before `mcp_connect` spawns the
 * Gmail / Google Calendar server, so a missing or malformed file surfaces
 * as one clear message in Settings instead of an opaque child-process
 * stderr dump after the fact.
 *
 * Returns `null` when the file looks valid, or a user-facing error string
 * explaining what's wrong and how to fix it.
 */
export async function validateGoogleOAuthClientFile(path: string): Promise<string | null> {
  const trimmed = path.trim()
  if (!trimmed) {
    return 'Select the OAuth client JSON file you downloaded from Google Cloud Console before connecting.'
  }

  let info: Awaited<ReturnType<typeof getPathInfo>>
  try {
    info = await getPathInfo(trimmed)
  } catch {
    return `Couldn\u2019t check "${trimmed}" — make sure the path is correct and try again.`
  }

  if (!info.exists) {
    return `OAuth client JSON not found at "${trimmed}". Use Browse\u2026 to pick the file you downloaded from Google Cloud Console.`
  }
  if (info.is_dir || !info.is_file) {
    return `"${trimmed}" is a folder, not a file. Use Browse\u2026 to pick the OAuth client .json file itself.`
  }

  try {
    const result = await readFile(trimmed)
    if (result.kind !== 'text') {
      return `"${trimmed}" doesn\u2019t look like a Google OAuth client JSON file. Re-download it from Google Cloud Console and select it again.`
    }
    const parsed = JSON.parse(result.content)
    const client = parsed?.installed ?? parsed?.web
    if (!client?.client_id || !client?.client_secret) {
      return `"${trimmed}" doesn\u2019t look like a Google OAuth client JSON file (missing client_id/client_secret). In Google Cloud Console, download the OAuth 2.0 Client ID\u2019s JSON and select that file.`
    }
  } catch {
    return `"${trimmed}" isn\u2019t valid JSON. Re-download the OAuth client credentials file from Google Cloud Console and select it again.`
  }

  return null
}

/** Validate and copy a selected OAuth client into the exact home-directory
 * location required by @gongrzhe/server-gmail-autoauth-mcp's auth command. */
export async function installGmailOAuthClient(path: string): Promise<string> {
  return invoke<string>('gmail_install_oauth_keys', { sourcePath: path })
}

export async function isGmailAuthenticated(): Promise<boolean> {
  return invoke<boolean>('gmail_is_authenticated')
}

export async function authenticateGmail(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  await invoke<void>('gmail_authenticate', { command, args, env })
}

/**
 * Best-effort signal for whether first-run browser sign-in has already
 * happened for this service — i.e. whether the server previously wrote a
 * token to `getGoogleStdioCredentialsPath(service)`. Not authoritative
 * (the token could be stale or since revoked on Google's side — only the
 * server itself finds that out, the next time it tries to use it), but
 * enough for the Settings UI to say "first sign-in required" vs "reusing
 * your saved Google sign-in" before the user clicks Connect.
 */
export async function hasGoogleStdioCredentials(service: GoogleStdioService): Promise<boolean> {
  try {
    const path = await getGoogleStdioCredentialsPath(service)
    const info = await getPathInfo(path)
    return info.exists && info.is_file
  } catch {
    return false
  }
}

/** Reverse lookup: given an env var key (as configured on an
 *  `McpServerConfig`), which Google stdio service (if any) does it belong
 *  to? Lets the Settings UI show the first-run-auth hint for a server the
 *  user configured by hand (not necessarily via the quickstart button)
 *  too, as long as they used the documented env var name. */
export function googleStdioServiceForEnvKey(envKey: string): GoogleStdioService | null {
  for (const [service, files] of Object.entries(SERVICE_FILES) as Array<[GoogleStdioService, ServiceFiles]>) {
    if (files.credentialsEnvKey === envKey) return service
  }
  return null
}
