// store/useInputActionDelayStore.ts
//
// Persisted user preference for how long the desktop-automation tools
// (mouse_click / mouse_drag_path / press_key / press_key_sequence, see
// services/agent/tools/inputControlTools.ts) wait AFTER showing their
// visual cue (the InputActionOverlay ring / key bar / drag path — see
// components/InputActionOverlay.tsx) and BEFORE actually performing the
// real click/keystroke.
//
// The overlay is purely cosmetic and, on its own, doesn't guarantee the
// user has had time to notice it before the real input fires. This delay
// closes that gap: it's a plain `await new Promise(r => setTimeout(r, ms))`
// inserted between "show the cue" and "invoke the real native action" in
// inputControlTools.ts.
//
// Defaults to 1000ms (1 second). Configurable in Settings > Actions.
// Persisted to localStorage so the choice survives app restarts.

import { create } from 'zustand'

const STORAGE_KEY = 'rachna-input-action-delay'

/** Keep this sane — 0 disables the wait entirely, 10s is a generous upper
 *  bound so a mistyped value can't stall the agent indefinitely. */
export const INPUT_ACTION_DELAY_MIN_MS = 0
export const INPUT_ACTION_DELAY_MAX_MS = 10_000
export const DEFAULT_INPUT_ACTION_DELAY_MS = 1000

interface InputActionDelaySettings {
  /** Milliseconds to wait after the visual cue appears before the real
   *  mouse_click / press_key / press_key_sequence action is performed. */
  delayMs: number
}

const DEFAULT_INPUT_ACTION_DELAY: InputActionDelaySettings = {
  delayMs: DEFAULT_INPUT_ACTION_DELAY_MS,
}

function clamp(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_INPUT_ACTION_DELAY_MS
  return Math.min(INPUT_ACTION_DELAY_MAX_MS, Math.max(INPUT_ACTION_DELAY_MIN_MS, Math.round(ms)))
}

function load(): InputActionDelaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_INPUT_ACTION_DELAY }
    const parsed = JSON.parse(raw)
    return { delayMs: clamp(parsed?.delayMs ?? DEFAULT_INPUT_ACTION_DELAY_MS) }
  } catch {
    return { ...DEFAULT_INPUT_ACTION_DELAY }
  }
}

function save(s: InputActionDelaySettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

interface InputActionDelayState extends InputActionDelaySettings {
  setDelayMs: (ms: number) => void
}

export const useInputActionDelayStore = create<InputActionDelayState>((set, get) => {
  const initial = load()
  return {
    ...initial,

    setDelayMs: (ms) => {
      set({ delayMs: clamp(ms) })
      save(get())
    },
  }
})

/** Non-hook accessor for use outside React components (e.g. from
 *  inputControlTools.ts, which isn't itself a component). */
export function getInputActionDelayMs(): number {
  return useInputActionDelayStore.getState().delayMs
}
