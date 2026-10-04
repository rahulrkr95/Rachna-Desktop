// store/useRepoContextModeStore.ts
//
// Persisted toggle for the "Repo Context" chip shown in the chat actions bar
// whenever a project folder is open. OFF (the default) means every turn is
// treated as fresh — no repo summary, retrieval (FTS/symbols/graph), project
// rules, or rejected-edit memory is built or sent — same as if no project
// were open, even though the folder stays open on disk and tools (file
// read/write, terminal, etc.) keep working normally.
//
// The chip is turned ON automatically once a newly-opened project finishes
// indexing (see useChat.ts), at which point it relabels to "With Repo
// Context" and a notice is posted in chat. The user can still flip it back
// off (or on) manually at any time; every state change — manual or
// automatic — surfaces a warning/notice in chat (see repoContextNotice in
// useChat.ts) so it's never a silent behavior change.
//
// Persisted to localStorage so the choice survives app restarts. Defaults
// to OFF (false).

import { create } from 'zustand'

const STORAGE_KEY = 'rachna-repo-context-mode'

function load(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return false
    return JSON.parse(raw) === true
  } catch {
    return false
  }
}

function save(v: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

interface RepoContextModeState {
  /** True = send repo context as usual ("With Repo Context"). False (default) = treat every turn as fresh, no repo context sent. */
  repoContextEnabled: boolean
  setRepoContextEnabled: (v: boolean) => void
  toggleRepoContextEnabled: () => void
}

export const useRepoContextModeStore = create<RepoContextModeState>((set, get) => ({
  repoContextEnabled: load(),

  setRepoContextEnabled: (v) => {
    set({ repoContextEnabled: v })
    save(v)
  },

  toggleRepoContextEnabled: () => {
    const next = !get().repoContextEnabled
    set({ repoContextEnabled: next })
    save(next)
  },
}))
