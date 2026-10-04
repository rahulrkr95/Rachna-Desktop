// store/useFolderChipsStore.ts
//
// Tracks which open-folder chips (see the "ACTIONS" bar in AiChat.tsx) are
// currently selected. Every open folder — the primary project
// (store/useRepoIndex.ts's `projectRoot`) plus any additional folders
// added via the File Explorer (store/useAdditionalFoldersStore.ts) — gets
// its own chip, keyed by its absolute path.
//
// Selecting one or more chips is a per-turn override, handled in
// components/AiChat/useChat.ts's executeSend:
//   1. General request refinement/routing is
//      skipped entirely for the next Send — the turn is treated as
//      AGENTIC unconditionally, no CHAT/AUTOMATION branch possible.
//   2. The Task Planner (lib/planGenerator.ts) is called
//      directly, with repo context built ONLY from the selected
//      folder(s) — not the primary project's context unless its own chip
//      is selected, and not any additional folder that isn't selected.
//
// Selection is intentionally NOT persisted to localStorage — it's a
// live "use this folder for the next task" signal tied to whichever
// folders happen to be open in this session, not a durable preference.
// Stale entries (a folder that's since been closed/removed) are pruned
// by the caller via pruneToKnownPaths whenever the open-folder set
// changes — see the effect in AiChat.tsx.

import { create } from 'zustand'

interface FolderChipsState {
  /** Absolute paths of every currently-selected folder chip. */
  selectedPaths: string[]
  /** Flips a single folder's chip on/off. */
  toggleFolder: (path: string) => void
  /** Convenience read helper for a single chip's render state. */
  isSelected: (path: string) => boolean
  /** Clears every selection (e.g. after a project switch/close). */
  clear: () => void
  /**
   * Drops any selected path that's no longer among the currently-open
   * folders — e.g. the primary project was switched, or an additional
   * folder was removed from the File Explorer. Called from AiChat.tsx
   * whenever the open-folder set changes.
   */
  pruneToKnownPaths: (knownPaths: string[]) => void
}

export const useFolderChipsStore = create<FolderChipsState>((set, get) => ({
  selectedPaths: [],

  toggleFolder(path) {
    const current = get().selectedPaths
    set({
      selectedPaths: current.includes(path)
        ? current.filter(p => p !== path)
        : [...current, path],
    })
  },

  isSelected(path) {
    return get().selectedPaths.includes(path)
  },

  clear() {
    set({ selectedPaths: [] })
  },

  pruneToKnownPaths(knownPaths) {
    const known = new Set(knownPaths)
    const current = get().selectedPaths
    const pruned = current.filter(p => known.has(p))
    if (pruned.length !== current.length) set({ selectedPaths: pruned })
  },
}))
