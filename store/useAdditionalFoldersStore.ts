// store/useAdditionalFoldersStore.ts
//
// Tracks the extra folders a user has added to the File Explorer beyond
// the primary open project (see useRepoIndex's `projectRoot`). This lets
// someone browse/open files across several related repos (e.g. a frontend
// + a backend service) side by side, and lets AiChat send each one to the
// model as its own labeled "Repo Context for Folder N: <name>" block (see
// components/AiChat/prompts.ts / useRetrieval.ts) so composite tasks that
// span multiple projects have visibility into all of them.
//
// The primary project (folder 1) stays driven by useRepoIndex/indexFolder
// as before — full dependency-graph indexing, git, terminal cwd, run
// config, etc. all still key off that one root. Additional folders here
// are lighter-weight: browsable and readable (agent tools resolve
// absolute paths fine regardless of which root they're under — see
// services/agent/fileValidation.ts), but not separately indexed.

import { create } from 'zustand'
import type { FolderEntry } from '../lib/tauriFs'

export interface AdditionalFolder {
  path: string
  name: string
  root: FolderEntry
}

interface AdditionalFoldersStoreState {
  folders: AdditionalFolder[]
  addFolder: (root: FolderEntry) => void
  removeFolder: (path: string) => void
  clear: () => void
}

export const useAdditionalFoldersStore = create<AdditionalFoldersStoreState>((set, get) => ({
  folders: [],

  addFolder(root: FolderEntry) {
    // Ignore duplicates (same path added twice) and the no-op of adding
    // a folder that's already tracked — just refresh its tree in place.
    const existing = get().folders.some(f => f.path === root.path)
    if (existing) {
      set({ folders: get().folders.map(f => f.path === root.path ? { ...f, root } : f) })
      return
    }
    set({ folders: [...get().folders, { path: root.path, name: root.name, root }] })
  },

  removeFolder(path: string) {
    set({ folders: get().folders.filter(f => f.path !== path) })
  },

  clear() {
    set({ folders: [] })
  },
}))
