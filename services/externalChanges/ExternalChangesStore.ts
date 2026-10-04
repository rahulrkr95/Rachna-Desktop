// services/externalChanges/ExternalChangesStore.ts
//
// Backs the top-bar "files changed outside the editor" notification.
//
// The file watcher (useFileWatcher.ts) reports batches of changed paths.
// Paths that turn out to be the app's own writes (see selfWriteTracker.ts)
// are filtered out before they ever reach this store — everything that
// lands here is a genuinely external change (another editor, a CLI tool,
// `git checkout`, a build script, etc).
//
// Unlike the old behaviour (silently auto-reindexing on every watcher
// event), external changes are surfaced to the user via a dismissible
// banner and only reindexed when the user clicks "Reindex".

import { create } from 'zustand'
import { useRepoIndex } from '../../store/useRepoIndex'

interface ExternalChangesState {
  /** Absolute paths changed externally since the last reindex/dismiss. */
  pendingPaths: string[]
  /** Whether the banner should currently be shown. */
  visible: boolean
  /** True while a user-triggered reindex of the pending paths is running. */
  reindexing: boolean

  /** Called by useFileWatcher with newly-detected external paths. */
  reportExternalChanges: (paths: string[]) => void
  /** User clicked "Reindex" — re-scans the pending paths, then clears. */
  reindexNow: () => Promise<void>
  /** User dismissed the banner without reindexing. */
  dismiss: () => void
  /** Reset all state — called when the project is closed / switched. */
  reset: () => void
}

export const useExternalChangesStore = create<ExternalChangesState>((set, get) => ({
  pendingPaths: [],
  visible: false,
  reindexing: false,

  reportExternalChanges: (paths) => {
    if (paths.length === 0) return
    set(state => {
      const merged = new Set([...state.pendingPaths, ...paths])
      return { pendingPaths: Array.from(merged), visible: true }
    })
  },

  reindexNow: async () => {
    const { pendingPaths, reindexing } = get()
    if (reindexing || pendingPaths.length === 0) {
      set({ visible: false, pendingPaths: [] })
      return
    }

    set({ reindexing: true })
    try {
      await useRepoIndex.getState().reindexChangedFiles(pendingPaths)
    } finally {
      set({ reindexing: false, visible: false, pendingPaths: [] })
    }
  },

  dismiss: () => {
    set({ visible: false, pendingPaths: [] })
  },

  reset: () => {
    set({ pendingPaths: [], visible: false, reindexing: false })
  },
}))

export const selectExternalChangeCount = (s: ExternalChangesState): number =>
  s.pendingPaths.length
