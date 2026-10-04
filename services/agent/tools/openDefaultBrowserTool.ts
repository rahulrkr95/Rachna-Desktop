import { invoke } from '@tauri-apps/api/core'
import { resolveAndOpenApp } from '../../appRegistry/openApp'
import { toolErr, toolOk, type AgentTool, type ToolContext } from '../types'

export const DEFAULT_BROWSER_PREFERENCE_KEY = 'rachna.desktopTask.defaultBrowser'

export interface BrowserPreference {
  browser: string
  profile: string
}

interface OpenDefaultBrowserArgs {
  /** Set true when the user asks to change their saved browser/profile. */
  updatePreference?: boolean
}

interface OpenDefaultBrowserResult extends BrowserPreference {
  fallbackToSystemDefault?: boolean
  preferenceNeedsUpdate?: boolean
}

function readPreference(): BrowserPreference | null {
  try {
    const value = localStorage.getItem(DEFAULT_BROWSER_PREFERENCE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<BrowserPreference>
    return typeof parsed.browser === 'string' && typeof parsed.profile === 'string'
      ? { browser: parsed.browser, profile: parsed.profile }
      : null
  } catch {
    return null
  }
}

function savePreference(value: BrowserPreference): void {
  try { localStorage.setItem(DEFAULT_BROWSER_PREFERENCE_KEY, JSON.stringify(value)) } catch { /* storage may be disabled */ }
}

// Kept browser-family based rather than Chrome-specific so another Chromium
// browser can opt into the same launch convention without changing the app
// registry or native launcher.
const CHROMIUM_BROWSER_NAMES = ['chrome', 'chromium', 'edge', 'brave']

function launchArgumentsFor(preference: BrowserPreference): string[] {
  const browser = preference.browser.toLowerCase()
  if (!CHROMIUM_BROWSER_NAMES.some((name) => browser.includes(name))) return []
  return [`--profile-directory=${preference.profile}`]
}

async function choosePreference(ctx: ToolContext): Promise<BrowserPreference | null> {
  if (!ctx.requestBrowserPreference) return null
  // This awaits the UI's modal Promise directly, so execution genuinely
  // pauses here — nothing below this line runs (and no browser launches)
  // until the user submits or cancels the in-app browser/profile picker.
  const selected = await ctx.requestBrowserPreference()
  if (!selected) return null
  const preference = {
    browser: selected.browser.trim() || 'System Default',
    profile: selected.profile.trim() || 'Default',
  }
  // `remember` defaults to true when the caller doesn't specify one, to
  // preserve prior always-save behavior for simpler ctx implementations.
  if (selected.remember !== false) savePreference(preference)
  return preference
}

async function openSystemDefault(): Promise<void> {
  // about:blank opens a browser without navigating the user to an arbitrary site.
  await invoke('open_path', { path: 'about:blank' })
}

/** Opens the preferred browser, prompting exactly once until the preference is changed. */
export const openDefaultBrowserTool: AgentTool<OpenDefaultBrowserArgs, OpenDefaultBrowserResult> = {
  declaration: {
    name: 'openDefaultBrowser',
    description:
      "Open the user's preferred web browser with preferred profile. Cannot be executed parallel to any other tool call.",
    parameters: {
      type: 'object',
      properties: {
        updatePreference: {
          type: 'boolean',
          description: 'True only when the user explicitly asks to update/change their browser preference.',
        },
      },
    },
  },
  describeCall: () => 'Opening preferred browser',
  execute: async (args, ctx: ToolContext) => {
    let preference = args.updatePreference ? null : readPreference()
    if (!preference) {
      if (!ctx.requestBrowserPreference) {
        return toolErr('Choose a browser and profile before using openDefaultBrowser.')
      }
      preference = await choosePreference(ctx)
      if (!preference) return toolErr('Browser selection was cancelled.')
    }

    if (preference.browser.toLowerCase() === 'system default') {
      await openSystemDefault()
      return toolOk({ ...preference })
    }

    try {
      const resolution = await resolveAndOpenApp(
        preference.browser,
        undefined,
        launchArgumentsFor(preference)
      )
      if (resolution.status === 'launched') return toolOk({ ...preference })
    } catch {
      // Treat registry/launch failures exactly like an app that was removed.
    }

    // The browser or profile may have been removed since it was saved. Ask once
    // for a replacement, persist it, and retry rather than repeatedly showing a
    // browser's profile picker or silently discarding the user's preference.
    const replacement = await choosePreference(ctx)
    if (replacement) {
      if (replacement.browser.toLowerCase() === 'system default') {
        await openSystemDefault()
        return toolOk({ ...replacement })
      }
      try {
        const resolution = await resolveAndOpenApp(
          replacement.browser,
          undefined,
          launchArgumentsFor(replacement)
        )
        if (resolution.status === 'launched') return toolOk({ ...replacement })
      } catch {
        // Fall through to the guaranteed system-default escape hatch.
      }
    }

    // An unavailable selection must never make this action a dead end.
    await openSystemDefault()
    return toolOk({
      browser: 'System Default',
      profile: 'Default',
      fallbackToSystemDefault: true,
      preferenceNeedsUpdate: true,
    })
  },
}
