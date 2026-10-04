// lib/appVersion.ts
//
// Thin wrapper around Tauri's app-version API so the rest of the app
// doesn't need to import @tauri-apps/api/app directly.

import { getVersion } from '@tauri-apps/api/app'

let cached: string | null = null

/** Returns the running app's version (e.g. "1.0.x"), cached after first read. */
export async function getCurrentAppVersion(): Promise<string> {
  if (cached) return cached
  try {
    cached = await getVersion()
  } catch (e) {
    console.error('[appVersion] Failed to read app version:', e)
    cached = '0.0.0'
  }
  return cached
}

/**
 * Compares two dotted version strings numerically per segment
 * (e.g. "0.10.0" > "0.9.0"). Missing segments are treated as 0.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
