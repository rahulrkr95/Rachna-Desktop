// connectors/postgresql/auth.ts
//
// Persists the Postgres connection string in the OS keychain, following
// the same pattern as connectors/github/auth.ts.

import { keychainSet, keychainGet, keychainDelete } from '../../lib/keychain'

const KEYCHAIN_ID = 'connector_postgresql_connection_string'

export async function getPostgresConnectionString(): Promise<string | null> {
  return keychainGet(KEYCHAIN_ID)
}

export async function setPostgresConnectionString(value: string): Promise<void> {
  await keychainSet(KEYCHAIN_ID, value)
}

export async function clearPostgresConnectionString(): Promise<void> {
  await keychainDelete(KEYCHAIN_ID)
}
