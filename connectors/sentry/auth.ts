// connectors/sentry/auth.ts
//
// Persists the Sentry auth token + org slug in the OS keychain, following
// the same pattern as connectors/github/auth.ts. The org slug isn't a
// secret but is stored alongside the token so both travel together and
// stay in sync through re-auth.

import { keychainSet, keychainGet, keychainDelete } from '../../lib/keychain'

const TOKEN_KEYCHAIN_ID = 'connector_sentry_token'
const ORG_KEYCHAIN_ID = 'connector_sentry_org'

export async function getSentryCredentials(): Promise<{ token: string | null; org: string | null }> {
  const [token, org] = await Promise.all([
    keychainGet(TOKEN_KEYCHAIN_ID),
    keychainGet(ORG_KEYCHAIN_ID),
  ])
  return { token, org }
}

export async function setSentryCredentials(token: string, org: string): Promise<void> {
  await Promise.all([
    keychainSet(TOKEN_KEYCHAIN_ID, token),
    keychainSet(ORG_KEYCHAIN_ID, org),
  ])
}

export async function clearSentryCredentials(): Promise<void> {
  await Promise.all([
    keychainDelete(TOKEN_KEYCHAIN_ID),
    keychainDelete(ORG_KEYCHAIN_ID),
  ])
}
