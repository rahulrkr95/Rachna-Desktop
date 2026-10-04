// store/useTerminalSettingsStore.ts
//
// Persisted user preference for how links clicked inside the in-app
// terminal are opened (see WebLinksAddon wiring in TerminalPanel.tsx and
// the `open_terminal_link` Tauri command).
//
// By default the Playwright-driven Chromium window opens in the foreground
// so the user clearly sees the page they just clicked through to. Checking
// "Open links in the background" keeps the window out of the way (it's
// launched then immediately minimized) instead of stealing focus.
//
// Persisted to localStorage so the choice survives app restarts.

import { create } from 'zustand'

const STORAGE_KEY = 'rachna-terminal-settings'

interface TerminalSettings {
  openLinksInBackground: boolean
}

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  openLinksInBackground: false,
}

function load(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_TERMINAL_SETTINGS }
    return { ...DEFAULT_TERMINAL_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_TERMINAL_SETTINGS }
  }
}

function save(s: TerminalSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

interface TerminalSettingsState extends TerminalSettings {
  setOpenLinksInBackground: (v: boolean) => void
}

export const useTerminalSettingsStore = create<TerminalSettingsState>((set, get) => {
  const initial = load()
  return {
    ...initial,

    setOpenLinksInBackground: (v) => {
      set({ openLinksInBackground: v })
      save(get())
    },
  }
})
