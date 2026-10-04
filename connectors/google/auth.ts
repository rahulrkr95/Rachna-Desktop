// connectors/google/auth.ts
//
// Persists the path to the user's downloaded Google OAuth client file
// (gcp-oauth.keys.json) in the OS keychain, following the same pattern as
// connectors/github/auth.ts. We only ever store a filesystem path here -
// the actual Google access/refresh tokens are cached by the Gmail MCP
// server itself (in ~/.gmail-mcp/) after the first browser-based consent.

import { keychainSet, keychainGet, keychainDelete } from '../../lib/keychain'

const KEYCHAIN_ID = 'connector_google_oauth_keys_path'

export async function getGoogleOAuthKeysPath(): Promise<string | null> {
  return keychainGet(KEYCHAIN_ID)
}

export async function setGoogleOAuthKeysPath(path: string): Promise<void> {
  await keychainSet(KEYCHAIN_ID, path)
}

export async function clearGoogleOAuthKeysPath(): Promise<void> {
  await keychainDelete(KEYCHAIN_ID)
}
