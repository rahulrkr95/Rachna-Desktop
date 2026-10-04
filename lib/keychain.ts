// lib/keychain.ts
// Thin wrapper around the Rust-side OS keychain commands (see
// src-tauri/src/keychain.rs). API key *values* should never be written to
// localStorage — only these functions should ever see/persist a raw secret.

import { invoke } from '@tauri-apps/api/core'

export async function keychainSet(id: string, value: string): Promise<void> {
  await invoke('keychain_set', { id, value })
}

export async function keychainGet(id: string): Promise<string | null> {
  try {
    return await invoke<string | null>('keychain_get', { id })
  } catch {
    return null
  }
}

export async function keychainDelete(id: string): Promise<void> {
  try {
    await invoke('keychain_delete', { id })
  } catch {
    /* best-effort */
  }
}

export async function keychainGetMany(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {}
  try {
    return await invoke<Record<string, string>>('keychain_get_many', { ids })
  } catch {
    return {}
  }
}
