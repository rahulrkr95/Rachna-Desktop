// store/useRunConfigStore.ts
//
// Zustand store for per-project Run Configurations (build command, run
// command, env vars). Mirrors the shape/conventions of store/useGitStore.ts.
//
// Lifecycle:
//   1. IDELayout calls `loadForProject(projectRoot)` once a project has
//      finished its first successful index (see useRepoIndex's `status`).
//   2. The RunConfigPanel reads/writes configs through this store, which
//      persists via lib/runConfig.ts -> Tauri -> SQLite (db.rs run_configs).
//   3. `detectWithAI(projectRoot)` drives the "Detect from repo using AI"
//      button — see lib/runConfigDetector.ts for the actual detection.

import { create } from 'zustand'
import {
  type RunConfig,
  listRunConfigs,
  saveRunConfig,
  deleteRunConfig,
  setActiveRunConfig,
  entriesToEnvJson,
} from '../lib/runConfig'
import { detectRunConfigWithAI, type DetectedRunConfig } from '../lib/runConfigDetector'

interface RunConfigState {
  projectRoot: string | null
  configs: RunConfig[]
  loading: boolean
  error: string | null

  /** Whether the RunConfigPanel modal is open. Lives here (rather than as
   *  local state in IDELayout) so any part of the app — e.g. the chat's
   *  RUN_PROJECT intent routing in useChat.ts — can open it without a prop
   *  chain back down to IDELayout. */
  panelOpen: boolean

  /** Set while the "Detect from repo using AI" call is in flight. */
  detecting: boolean
  detectError: string | null
  /** Most recent AI detection result, kept around so the panel can show it
   *  in the editor before the user explicitly saves it. */
  lastDetected: DetectedRunConfig | null

  saving: boolean

  /** Loads all saved run configs for `root`. No-op if already loaded for this root. */
  loadForProject: (root: string) => Promise<void>
  /** Force-reloads regardless of the currently loaded root. */
  refresh: () => Promise<void>
  /** Creates a new config (id omitted) or updates an existing one (id provided). */
  save: (params: {
    id?: string | null
    name: string
    buildCommand: string
    runCommand: string
    env: Array<{ key: string; value: string }>
    cwd?: string | null
  }) => Promise<RunConfig | null>
  remove: (id: string) => Promise<void>
  setActive: (id: string) => Promise<void>
  detectWithAI: () => Promise<void>
  clearDetected: () => void
  clearError: () => void
  /** Opens the RunConfigPanel modal. */
  openPanel: () => void
  /** Closes the RunConfigPanel modal. */
  closePanel: () => void
  /** Clears all state — called when the project is closed. */
  reset: () => void
}

export const useRunConfigStore = create<RunConfigState>((set, get) => ({
  projectRoot: null,
  configs: [],
  loading: false,
  error: null,
  panelOpen: false,

  detecting: false,
  detectError: null,
  lastDetected: null,

  saving: false,

  loadForProject: async (root: string) => {
    if (get().projectRoot === root && (get().configs.length > 0 || get().loading)) return
    set({ projectRoot: root, configs: [], loading: true, error: null })
    try {
      const configs = await listRunConfigs(root)
      set({ configs, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  refresh: async () => {
    const { projectRoot } = get()
    if (!projectRoot) return
    set({ loading: true, error: null })
    try {
      const configs = await listRunConfigs(projectRoot)
      set({ configs, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  save: async ({ id, name, buildCommand, runCommand, env, cwd }) => {
    const { projectRoot } = get()
    if (!projectRoot) return null
    set({ saving: true, error: null })
    try {
      const saved = await saveRunConfig({
        id: id ?? null,
        projectRoot,
        name,
        buildCommand,
        runCommand,
        envJson: entriesToEnvJson(env),
        cwd: cwd ?? null,
      })
      set({ saving: false })
      await get().refresh()
      return saved
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  remove: async (id: string) => {
    try {
      await deleteRunConfig(id)
      await get().refresh()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  setActive: async (id: string) => {
    const { projectRoot } = get()
    if (!projectRoot) return
    try {
      await setActiveRunConfig(projectRoot, id)
      await get().refresh()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  detectWithAI: async () => {
    const { projectRoot } = get()
    if (!projectRoot) return
    set({ detecting: true, detectError: null, lastDetected: null })
    try {
      const detected = await detectRunConfigWithAI(projectRoot)
      set({ detecting: false, lastDetected: detected })
    } catch (err) {
      set({ detecting: false, detectError: err instanceof Error ? err.message : String(err) })
    }
  },

  clearDetected: () => set({ lastDetected: null, detectError: null }),
  clearError: () => set({ error: null }),

  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),

  reset: () => set({
    projectRoot: null,
    configs: [],
    loading: false,
    error: null,
    detecting: false,
    detectError: null,
    lastDetected: null,
    saving: false,
    // panelOpen intentionally left as-is — closing the project shouldn't
    // yank an already-open panel shut out from under the user.
  }),
}))

// ── Selectors ─────────────────────────────────────────────────────────────

export const selectActiveRunConfig = (s: RunConfigState): RunConfig | null =>
  s.configs.find(c => c.is_active) ?? s.configs[0] ?? null

export const selectHasAnyRunConfig = (s: RunConfigState): boolean => s.configs.length > 0
