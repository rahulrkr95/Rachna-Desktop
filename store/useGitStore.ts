// store/useGitStore.ts
//
// Zustand store for the Git panel — status, diffs, branches, log, and the
// async actions that call through to services/git/gitService.ts. Follows
// the same shape/conventions as store/useEditorStore.ts.

import { create } from 'zustand'
import * as git from '../services/git/gitService'
import type { GitFileStatus, BranchInfo, CommitInfo } from '../services/git/gitService'
import { getPathInfo } from '../lib/tauriFs'

// ── Toast (transient push/pull/commit result banner) ───────────────────────
export interface GitToast {
  id: string
  kind: 'success' | 'error'
  message: string
}

// ── State shape ──────────────────────────────────────────────────────────────
interface GitState {
  /** Workspace root this store is currently tracking (set by setRoot). */
  root: string | null

  /**
   * Whether `root` contains a `.git` folder. Null while that check is in
   * flight (or before any root has ever been set). Source Control should
   * only be shown/usable when this is true — see IDELayout's activity bar,
   * which gates the Git icon on this flag.
   */
  isRepo: boolean | null

  files: GitFileStatus[]
  branches: BranchInfo[]
  commits: CommitInfo[]

  /** Path of the file currently shown in the diff viewer, or null. */
  selectedFile: string | null
  /** Whether the selected file's diff being viewed is the staged or unstaged version. */
  selectedStaged: boolean
  /** Unified diff text for the currently selected file. */
  diffText: string

  commitMessage: string

  loadingStatus: boolean
  loadingDiff: boolean
  loadingBranches: boolean
  loadingLog: boolean
  pushing: boolean
  pulling: boolean
  committing: boolean

  branchMenuOpen: boolean

  toasts: GitToast[]

  error: string | null

  // ── Actions ────────────────────────────────────────────────────────────
  setRoot: (root: string | null) => void
  refreshAll: () => Promise<void>
  refreshStatus: () => Promise<void>
  refreshBranches: () => Promise<void>
  refreshLog: () => Promise<void>

  selectFile: (path: string, staged: boolean) => Promise<void>
  clearSelection: () => void

  stage: (paths: string[]) => Promise<void>
  unstage: (paths: string[]) => Promise<void>
  stageAll: () => Promise<void>
  unstageAll: () => Promise<void>

  setCommitMessage: (msg: string) => void
  commit: () => Promise<void>

  push: () => Promise<void>
  pull: () => Promise<void>

  switchBranch: (branch: string) => Promise<void>
  createBranch: (name: string) => Promise<void>
  setBranchMenuOpen: (open: boolean) => void

  pushToast: (kind: GitToast['kind'], message: string) => void
  dismissToast: (id: string) => void
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function errMessage(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

let toastCounter = 0
function nextToastId(): string {
  toastCounter += 1
  return `git-toast-${Date.now()}-${toastCounter}`
}

// ── Store ──────────────────────────────────────────────────────────────────
export const useGitStore = create<GitState>((set, get) => ({
  root: null,
  isRepo: null,

  files: [],
  branches: [],
  commits: [],

  selectedFile: null,
  selectedStaged: false,
  diffText: '',

  commitMessage: '',

  loadingStatus: false,
  loadingDiff: false,
  loadingBranches: false,
  loadingLog: false,
  pushing: false,
  pulling: false,
  committing: false,

  branchMenuOpen: false,

  toasts: [],

  error: null,

  // ── setRoot ────────────────────────────────────────────────────────────
  setRoot: (root) => {
    if (get().root === root) return
    set({
      root,
      isRepo: null,
      files: [],
      branches: [],
      commits: [],
      selectedFile: null,
      diffText: '',
      error: null,
    })
    if (root) {
      // Only wire up git status/branches/log once we've confirmed a .git
      // folder actually exists at the root — running these against a
      // non-repo folder just surfaces confusing CLI errors, and the
      // Source Control UI should stay hidden entirely in that case.
      getPathInfo(`${root.replace(/[\\/]+$/, '')}/.git`)
        .then(info => {
          if (get().root !== root) return // root changed while we were checking
          set({ isRepo: info.exists })
          if (info.exists) get().refreshAll()
        })
        .catch(() => {
          if (get().root === root) set({ isRepo: false })
        })
    }
  },

  // ── refreshAll ─────────────────────────────────────────────────────────
  refreshAll: async () => {
    await Promise.all([
      get().refreshStatus(),
      get().refreshBranches(),
      get().refreshLog(),
    ])
  },

  // ── refreshStatus ──────────────────────────────────────────────────────
  refreshStatus: async () => {
    const { root } = get()
    if (!root) return
    set({ loadingStatus: true, error: null })
    try {
      const files = await git.getStatus(root)
      set({ files, loadingStatus: false })

      // If the file currently shown in the diff viewer no longer has a
      // change of the selected kind, clear the viewer.
      const { selectedFile, selectedStaged } = get()
      if (selectedFile) {
        const stillChanged = files.some(
          f => f.path === selectedFile && f.staged === selectedStaged,
        )
        if (!stillChanged) {
          set({ selectedFile: null, diffText: '' })
        }
      }
    } catch (e) {
      set({ loadingStatus: false, error: errMessage(e) })
    }
  },

  // ── refreshBranches ────────────────────────────────────────────────────
  refreshBranches: async () => {
    const { root } = get()
    if (!root) return
    set({ loadingBranches: true })
    try {
      const branches = await git.getBranches(root)
      set({ branches, loadingBranches: false })
    } catch (e) {
      set({ loadingBranches: false, error: errMessage(e) })
    }
  },

  // ── refreshLog ─────────────────────────────────────────────────────────
  refreshLog: async () => {
    const { root } = get()
    if (!root) return
    set({ loadingLog: true })
    try {
      const commits = await git.getLog(root, 50)
      set({ commits, loadingLog: false })
    } catch (e) {
      set({ loadingLog: false, error: errMessage(e) })
    }
  },

  // ── selectFile ─────────────────────────────────────────────────────────
  selectFile: async (path, staged) => {
    const { root } = get()
    if (!root) return
    set({ selectedFile: path, selectedStaged: staged, loadingDiff: true, diffText: '' })
    try {
      const diffText = await git.getDiff(root, path, staged)
      // Bail out if the selection changed while the diff was loading.
      if (get().selectedFile !== path || get().selectedStaged !== staged) return
      set({ diffText, loadingDiff: false })
    } catch (e) {
      set({ loadingDiff: false, diffText: '', error: errMessage(e) })
    }
  },

  clearSelection: () => set({ selectedFile: null, diffText: '' }),

  // ── stage / unstage ────────────────────────────────────────────────────
  stage: async (paths) => {
    const { root } = get()
    if (!root || paths.length === 0) return
    try {
      await git.stageFiles(root, paths)
      await get().refreshStatus()
    } catch (e) {
      get().pushToast('error', errMessage(e))
    }
  },

  unstage: async (paths) => {
    const { root } = get()
    if (!root || paths.length === 0) return
    try {
      await git.unstageFiles(root, paths)
      await get().refreshStatus()
    } catch (e) {
      get().pushToast('error', errMessage(e))
    }
  },

  stageAll: async () => {
    const unstagedPaths = get().files.filter(f => !f.staged).map(f => f.path)
    await get().stage(unstagedPaths)
  },

  unstageAll: async () => {
    const stagedPaths = get().files.filter(f => f.staged).map(f => f.path)
    await get().unstage(stagedPaths)
  },

  // ── commit message / commit ────────────────────────────────────────────
  setCommitMessage: (msg) => set({ commitMessage: msg }),

  commit: async () => {
    const { root, commitMessage } = get()
    if (!root || !commitMessage.trim()) return
    set({ committing: true })
    try {
      await git.commit(root, commitMessage.trim())
      set({ committing: false, commitMessage: '' })
      get().pushToast('success', 'Commit created')
      await get().refreshAll()
    } catch (e) {
      set({ committing: false })
      get().pushToast('error', errMessage(e))
    }
  },

  // ── push / pull ─────────────────────────────────────────────────────────
  push: async () => {
    const { root } = get()
    if (!root) return
    set({ pushing: true })
    try {
      const output = await git.push(root)
      set({ pushing: false })
      get().pushToast('success', output.trim() || 'Pushed')
      await get().refreshAll()
    } catch (e) {
      set({ pushing: false })
      get().pushToast('error', errMessage(e))
    }
  },

  pull: async () => {
    const { root } = get()
    if (!root) return
    set({ pulling: true })
    try {
      const output = await git.pull(root)
      set({ pulling: false })
      get().pushToast('success', output.trim() || 'Pulled')
      await get().refreshAll()
    } catch (e) {
      set({ pulling: false })
      get().pushToast('error', errMessage(e))
    }
  },

  // ── branches ───────────────────────────────────────────────────────────
  switchBranch: async (branch) => {
    const { root } = get()
    if (!root) return
    try {
      await git.switchBranch(root, branch)
      set({ branchMenuOpen: false })
      get().pushToast('success', `Switched to ${branch}`)
      await get().refreshAll()
    } catch (e) {
      get().pushToast('error', errMessage(e))
    }
  },

  createBranch: async (name) => {
    const { root } = get()
    if (!root || !name.trim()) return
    try {
      await git.createBranch(root, name.trim())
      set({ branchMenuOpen: false })
      get().pushToast('success', `Created and switched to ${name.trim()}`)
      await get().refreshAll()
    } catch (e) {
      get().pushToast('error', errMessage(e))
    }
  },

  setBranchMenuOpen: (open) => set({ branchMenuOpen: open }),

  // ── toasts ─────────────────────────────────────────────────────────────
  pushToast: (kind, message) => {
    const id = nextToastId()
    set(state => ({ toasts: [...state.toasts, { id, kind, message }] }))
    // Auto-dismiss after a few seconds.
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) => {
    set(state => ({ toasts: state.toasts.filter(t => t.id !== id) }))
  },
}))

// ── Convenience selectors ───────────────────────────────────────────────────
export const selectStagedFiles = (state: GitState): GitFileStatus[] =>
  state.files.filter(f => f.staged)

export const selectUnstagedFiles = (state: GitState): GitFileStatus[] =>
  state.files.filter(f => !f.staged)

export const selectCurrentBranch = (state: GitState): BranchInfo | undefined =>
  state.branches.find(b => b.is_current)
