// store/useEditorStore.ts
import { create } from 'zustand'
import type { OpenFile, DiffTab } from '../types'
import {
  isUnsavedProjectPath,
  useUnsavedProjectStore,
} from './useUnsavedProjectStore'

// ── State shape ────────────────────────────────────────────────────────────
interface EditorState {
  /** All currently open file tabs */
  tabs: OpenFile[]
  /** All currently open diff tabs (AI edit proposals) */
  diffTabs: DiffTab[]
  /** ID of the active/focused tab (file or diff) */
  activeId: string
  /** Which kind is active: 'file' or 'diff' */
  activeKind: 'file' | 'diff'

  // ── File tab actions ──────────────────────────────────────────────────

  /** Open a file. If already open, just activate it. */
  openTab: (file: Omit<OpenFile, 'active'>) => void

  /** Close a tab by id. Activates an adjacent tab automatically. */
  closeTab: (id: string) => void

  /** Set the active tab by id. */
  setActiveTab: (id: string) => void

  /** Update file content (marks the tab as modified). */
  updateContent: (id: string, content: string) => void

  /** Mark a tab as saved (clears the modified flag). */
  markSaved: (id: string) => void

  /**
   * Renames a tab in place — used by "Save As" to repoint an existing
   * (possibly untitled) tab at a new file path without closing/reopening it.
   * Clears the modified flag. If the renamed tab was active, keeps it active
   * under its new id.
   */
  renameTab: (oldId: string, newId: string, newName: string) => void

  // ── Diff tab actions ──────────────────────────────────────────────────

  /**
   * Open a diff tab for a pending edit.
   * Deduplicates by filePath: if a diff tab for this filePath already
   * exists (regardless of editId), just activate the existing one.
   */
  openDiffTab: (tab: Omit<DiffTab, 'active'>) => void

  /** Close a diff tab by id. */
  closeDiffTab: (id: string) => void

  /** Set the active diff tab by id. */
  setActiveDiffTab: (id: string) => void

  /**
   * Activate the existing diff tab for a given filePath without creating
   * a new one. Called by EditStore.proposeEdit when updating an existing
   * pending edit. No-ops if no diff tab is open for that file.
   */
  activateDiffTabForFile: (filePath: string) => void
}

// ── Store ──────────────────────────────────────────────────────────────────
export const useEditorStore = create<EditorState>((set, get) => ({
  tabs:       [],
  diffTabs:   [],
  activeId:   '',
  activeKind: 'file',

  // ── openTab ──────────────────────────────────────────────────────────────
  openTab: (file) => {
    const { tabs } = get()
    const existing = tabs.find(t => t.id === file.id)

    if (existing) {
      set({ activeId: file.id, activeKind: 'file' })
      return
    }

    set({
      tabs: [...tabs, { ...file, active: true }],
      activeId: file.id,
      activeKind: 'file',
    })
  },

  // ── closeTab ─────────────────────────────────────────────────────────────
  closeTab: (id) => {
    const { tabs, diffTabs, activeId } = get()
    const remaining = tabs.filter(t => t.id !== id)

    const allRemaining = [...remaining.map(t => t.id), ...diffTabs.map(t => t.id)]

    if (allRemaining.length === 0) {
      set({ tabs: remaining, activeId: '', activeKind: 'file' })
      return
    }

    let nextActiveId = activeId
    let nextKind: 'file' | 'diff' = get().activeKind

    if (activeId === id) {
      const closedIndex = tabs.findIndex(t => t.id === id)
      const nextFile = tabs[closedIndex + 1] ?? tabs[closedIndex - 1] ?? remaining[0]
      if (nextFile) {
        nextActiveId = nextFile.id
        nextKind = 'file'
      } else if (diffTabs.length > 0) {
        nextActiveId = diffTabs[diffTabs.length - 1].id
        nextKind = 'diff'
      } else {
        nextActiveId = ''
        nextKind = 'file'
      }
    }

    set({ tabs: remaining, activeId: nextActiveId, activeKind: nextKind })
  },

  // ── setActiveTab ─────────────────────────────────────────────────────────
  setActiveTab: (id) => {
    set({ activeId: id, activeKind: 'file' })
  },

  // ── updateContent ────────────────────────────────────────────────────────
  updateContent: (id, content) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? { ...tab, content, modified: true }
          : tab
      ),
    }))

    if (isUnsavedProjectPath(id)) {
      useUnsavedProjectStore
        .getState()
        .updateFile(id, content)
    }
  },

  // ── markSaved ────────────────────────────────────────────────────────────
  markSaved: (id) => {
    set(state => ({
      tabs: state.tabs.map(t =>
        t.id === id ? { ...t, modified: false } : t
      ),
    }))
  },

  // ── renameTab ────────────────────────────────────────────────────────────
  renameTab: (oldId, newId, newName) => {
    set(state => ({
      tabs: state.tabs.map(t =>
        t.id === oldId ? { ...t, id: newId, name: newName, modified: false } : t
      ),
      activeId: state.activeId === oldId && state.activeKind === 'file' ? newId : state.activeId,
    }))
  },

  // ── openDiffTab ──────────────────────────────────────────────────────────
  // Deduplicates by filePath: only one diff tab may exist per file at a time.
  // If a tab already exists for this filePath, activate it instead of creating
  // a duplicate (even if the editId has changed due to an upsert).
  openDiffTab: (tab) => {
    const { diffTabs } = get()

    // Primary dedup: by filePath (enforces one diff tab per file)
    const existingByPath = diffTabs.find(t => t.filePath === tab.filePath)
    if (existingByPath) {
      set({ activeId: existingByPath.id, activeKind: 'diff' })
      return
    }

    // Secondary dedup: by editId (safety net for any direct callers)
    const existingByEdit = diffTabs.find(t => t.editId === tab.editId)
    if (existingByEdit) {
      set({ activeId: existingByEdit.id, activeKind: 'diff' })
      return
    }

    set({
      diffTabs: [...diffTabs, { ...tab, active: true }],
      activeId: tab.id,
      activeKind: 'diff',
    })
  },

  // ── activateDiffTabForFile ────────────────────────────────────────────────
  // Focuses the existing diff tab for filePath, if one is open.
  // Called by EditStore when a pending edit is updated (not created).
  activateDiffTabForFile: (filePath) => {
    const existing = get().diffTabs.find(t => t.filePath === filePath)
    if (existing) {
      set({ activeId: existing.id, activeKind: 'diff' })
    }
  },

  // ── closeDiffTab ─────────────────────────────────────────────────────────
  closeDiffTab: (id) => {
    const { tabs, diffTabs, activeId } = get()
    const remaining = diffTabs.filter(t => t.id !== id)

    let nextActiveId = activeId
    let nextKind: 'file' | 'diff' = get().activeKind

    if (activeId === id) {
      const closedIndex = diffTabs.findIndex(t => t.id === id)
      const nextDiff = diffTabs[closedIndex + 1] ?? diffTabs[closedIndex - 1] ?? remaining[0]
      if (nextDiff) {
        nextActiveId = nextDiff.id
        nextKind = 'diff'
      } else if (tabs.length > 0) {
        nextActiveId = tabs[tabs.length - 1].id
        nextKind = 'file'
      } else {
        nextActiveId = ''
        nextKind = 'file'
      }
    }

    set({ diffTabs: remaining, activeId: nextActiveId, activeKind: nextKind })
  },

  // ── setActiveDiffTab ─────────────────────────────────────────────────────
  setActiveDiffTab: (id) => {
    set({ activeId: id, activeKind: 'diff' })
  },
}))

// ── Convenience selectors ─────────────────────────────────────────────────
/** Returns the currently active OpenFile, or undefined. */
export const selectActiveFile = (state: EditorState): OpenFile | undefined => {
  if (state.activeKind !== 'file') return undefined
  return state.tabs.find(t => t.id === state.activeId)
}

/** Returns the currently active DiffTab, or undefined. */
export const selectActiveDiffTab = (state: EditorState): DiffTab | undefined => {
  if (state.activeKind !== 'diff') return undefined
  return state.diffTabs.find(t => t.id === state.activeId)
}
