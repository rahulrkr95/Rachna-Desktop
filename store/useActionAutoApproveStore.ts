// store/useActionAutoApproveStore.ts
//
// Persisted user preferences for skipping the permission dialog entirely
// for whole categories of agent actions:
//   - Terminal commands        (run_terminal_command)
//   - Screenshots              (take_screenshot)
//   - Mouse clicks & keystrokes (mouse_click / press_key, see inputControlTools.ts)
//
// These are distinct from — and sit "above" — useTerminalPermissionStore's
// existing per-session "remember this" checkbox: that remembers individual
// commands/prefixes for the current app session only, and (by design, see
// ALWAYS_ASK_PREFIXES) never remembers screenshots or mouse/keyboard input
// at all, since the same description can mean something completely
// different from one call to the next. The toggles here are an explicit,
// durable opt-in the user sets in Settings — once enabled, the matching
// category is auto-approved every time, no dialog, until turned back off.
//
// All three default to ON. Screenshots and mouse/keyboard control in
// particular can expose or interact with whatever is on screen, so users
// who'd rather be asked first can flip any of these off in Settings > Actions.
//
// Persisted to localStorage so the choice survives app restarts.

import { create } from 'zustand'

const STORAGE_KEY = 'rachna-action-auto-approve'

interface ActionAutoApproveSettings {
  /** Skip the permission dialog for run_terminal_command calls. */
  autoApproveTerminal: boolean
  /** Skip the permission dialog for take_screenshot calls. */
  autoApproveScreenshots: boolean
  /** Skip the permission dialog for mouse_click / press_key calls. */
  autoApproveInputControl: boolean
}

const DEFAULT_ACTION_AUTO_APPROVE: ActionAutoApproveSettings = {
  autoApproveTerminal:     true,
  autoApproveScreenshots:  true,
  autoApproveInputControl: true,
}

function load(): ActionAutoApproveSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_ACTION_AUTO_APPROVE }
    return { ...DEFAULT_ACTION_AUTO_APPROVE, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_ACTION_AUTO_APPROVE }
  }
}

function save(s: ActionAutoApproveSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

interface ActionAutoApproveState extends ActionAutoApproveSettings {
  setAutoApproveTerminal:     (v: boolean) => void
  setAutoApproveScreenshots:  (v: boolean) => void
  setAutoApproveInputControl: (v: boolean) => void
}

export const useActionAutoApproveStore = create<ActionAutoApproveState>((set, get) => {
  const initial = load()
  return {
    ...initial,

    setAutoApproveTerminal: (v) => {
      set({ autoApproveTerminal: v })
      save(get())
    },
    setAutoApproveScreenshots: (v) => {
      set({ autoApproveScreenshots: v })
      save(get())
    },
    setAutoApproveInputControl: (v) => {
      set({ autoApproveInputControl: v })
      save(get())
    },
  }
})