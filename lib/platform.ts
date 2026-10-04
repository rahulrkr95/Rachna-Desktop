// lib/platform.ts
//
// Thin wrapper around @tauri-apps/plugin-os's `platform()` — used for the
// handful of places the UI needs to differ per-OS. Currently just
// Header.tsx, which hides its own in-app logo/title on Windows because the
// native (decorated) window title bar already shows the app icon + name
// there, and rendering both stacked on top of each other reads as a
// visible duplicate. macOS/Linux title bars don't show that combination
// the same way, so they keep the in-app logo.
//
// `platform()` itself is synchronous (resolved at compile time by the
// plugin), but callers still go through this async wrapper so call sites
// don't need to special-case failures — e.g. this code running outside a
// Tauri webview (tests, storybook, etc.) where the global the plugin reads
// from isn't present.

import { platform, type Platform } from '@tauri-apps/plugin-os'

let cached: Platform | null = null

export async function getPlatform(): Promise<Platform> {
  if (cached) return cached
  try {
    cached = platform()
  } catch (e) {
    console.error('[platform] Failed to read platform:', e)
    // Fall back to something that keeps existing (non-Windows) UI
    // behaviour unchanged if the plugin call fails for any reason.
    cached = 'linux'
  }
  return cached
}
