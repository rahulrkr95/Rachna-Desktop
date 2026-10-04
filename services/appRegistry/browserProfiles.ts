// services/appRegistry/browserProfiles.ts
//
// Best-effort discovery of a browser's user profiles, backing
// BrowserPreferenceModal's profile picker. Wraps the Rust
// `list_browser_profiles` command (src-tauri/src/browser_profiles.rs),
// which reads the browser's own "Local State" file directly rather than
// requiring the browser to be running.
//
// Deliberately forgiving: any failure (command error, browser not
// recognized, no profiles found) resolves to an empty array rather than
// throwing, so callers can treat "discovery unavailable" and "nothing
// found" identically — see BrowserPreferenceModal.tsx, which falls back
// to manual profile entry whenever this resolves empty.

import { invoke } from '@tauri-apps/api/core'

export interface BrowserProfile {
  /** Internal folder name (e.g. "Default", "Profile 2") — what actually
   *  gets passed to the browser at launch (unchanged from before this
   *  discovery existed; see openDefaultBrowserTool.ts's launchArgumentsFor). */
  id: string
  /** User-facing profile name shown in the browser's own switcher. */
  name: string
}

/**
 * Attempts to enumerate the given browser's profiles. Only Chromium-family
 * browsers (Chrome, Edge, Brave, Vivaldi, Arc) are currently recognized on
 * the Rust side; anything else — including "System Default" or a typed-in
 * browser name discovery doesn't recognize — simply resolves to `[]`.
 */
export async function discoverBrowserProfiles(browser: string): Promise<BrowserProfile[]> {
  const trimmed = browser.trim()
  if (!trimmed || trimmed.toLowerCase() === 'system default') return []

  try {
    const profiles = await invoke<BrowserProfile[]>('list_browser_profiles', { browser: trimmed })
    return Array.isArray(profiles) ? profiles : []
  } catch {
    // Command unavailable (e.g. non-Tauri/dev context) or a genuine
    // failure reading the browser's files — either way, the caller falls
    // back to manual entry rather than surfacing an error.
    return []
  }
}
