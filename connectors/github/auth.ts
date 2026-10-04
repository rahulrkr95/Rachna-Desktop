// connectors/github/auth.ts
//
// Persists the GitHub PAT in the OS keychain, following the same pattern
// as store/useMcpStore.ts's env-secret handling. Kept separate from
// connector.ts so the auth storage mechanism can be swapped (e.g. to real
// OAuth) without touching connection/tool logic.

import { keychainSet, keychainGet, keychainDelete } from '../../lib/keychain'

const KEYCHAIN_ID = 'connector_github_token'

export async function getGitHubToken(): Promise<string | null> {
  return keychainGet(KEYCHAIN_ID)
}

export async function setGitHubToken(token: string): Promise<void> {
  await keychainSet(KEYCHAIN_ID, token)
}

export async function clearGitHubToken(): Promise<void> {
  await keychainDelete(KEYCHAIN_ID)
}
