// store/useAutocompleteStore.ts
// Persists inline autocomplete preferences across sessions.

import { create } from 'zustand'

const STORAGE_KEY = 'rachna_ide_autocomplete'

interface AutocompleteState {
  /** Whether AI ghost-text autocomplete is enabled globally. */
  enabled: boolean
  toggle: () => void
  setEnabled: (v: boolean) => void
}

function loadEnabled(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === null) return true  // on by default
    return JSON.parse(stored) === true
  } catch {
    return true
  }
}

export const useAutocompleteStore = create<AutocompleteState>((set, get) => ({
  enabled: loadEnabled(),

  toggle() {
    const next = !get().enabled
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    set({ enabled: next })
  },

  setEnabled(v) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
    set({ enabled: v })
  },
}))
