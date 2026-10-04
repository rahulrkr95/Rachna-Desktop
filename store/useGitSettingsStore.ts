// store/useGitSettingsStore.ts
//
// Persisted user preferences for the agent's git_action tool.
// These control which git operations the agent may perform automatically vs.
// which require explicit user approval (via UI toggle in Settings > Git).
//
// Persisted to localStorage so the user's choices survive app restarts.

import { create } from 'zustand'
import type { GitToolSettings } from '../services/agent/types'
import { DEFAULT_GIT_TOOL_SETTINGS } from '../services/agent/types'

const STORAGE_KEY = 'rachna-git-tool-settings'

function load(): GitToolSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_GIT_TOOL_SETTINGS }
    return { ...DEFAULT_GIT_TOOL_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_GIT_TOOL_SETTINGS }
  }
}

function save(s: GitToolSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

interface GitSettingsState extends GitToolSettings {
  setAutoAllowCommit: (v: boolean) => void
  setAutoAllowPush: (v: boolean) => void
  setAllowDirectPushToMain: (v: boolean) => void
  /** Returns a plain GitToolSettings snapshot — used to populate ToolContext. */
  snapshot: () => GitToolSettings
}

export const useGitSettingsStore = create<GitSettingsState>((set, get) => {
  const initial = load()
  return {
    ...initial,

    setAutoAllowCommit: (v) => {
      set({ autoAllowCommit: v })
      save(get())
    },
    setAutoAllowPush: (v) => {
      set({ autoAllowPush: v })
      save(get())
    },
    setAllowDirectPushToMain: (v) => {
      set({ allowDirectPushToMain: v })
      save(get())
    },
    snapshot: () => {
      const { autoAllowCommit, autoAllowPush, allowDirectPushToMain } = get()
      return { autoAllowCommit, autoAllowPush, allowDirectPushToMain }
    },
  }
})
