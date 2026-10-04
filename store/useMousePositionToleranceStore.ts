// store/useMousePositionToleranceStore.ts
//
// Persisted user preference for how many pixels of slop the desktop-
// automation tools (mouse_click / mouse_drag_path, see
// services/agent/tools/inputControlTools.ts) allow between where a click or
// drag was told to land and where the OS actually reports the cursor,
// before treating the move as verified.
//
// The verification itself is local and deterministic — no model call — and
// lives in the Rust command layer (src-tauri/src/input_control.rs,
// move_and_verify_position): move the cursor, read the OS cursor position
// back, compare within this tolerance, retry a bounded number of times, and
// refuse to click/drag if it never lands within tolerance. This store only
// controls the tolerance knob, not whether verification happens — it's not
// exposed to the model via the tool schema, so the agent can't loosen it.
//
// Defaults to 3px (middle of the requested 2–5px range). Persisted to
// localStorage so the choice survives app restarts.

import { create } from 'zustand'

const STORAGE_KEY = 'rachna-mouse-position-tolerance'

/** Mirrors MIN/MAX_POSITION_TOLERANCE_PX in input_control.rs — kept in sync
 *  so a value this store allows can never be rejected/re-clamped oddly on
 *  the Rust side. */
export const MOUSE_POSITION_TOLERANCE_MIN_PX = 1
export const MOUSE_POSITION_TOLERANCE_MAX_PX = 25
export const DEFAULT_MOUSE_POSITION_TOLERANCE_PX = 3

interface MousePositionToleranceSettings {
  /** Max allowed pixel distance (per axis) between the requested target and
   *  the OS-reported cursor position for a move to count as verified. */
  tolerancePx: number
}

const DEFAULT_MOUSE_POSITION_TOLERANCE: MousePositionToleranceSettings = {
  tolerancePx: DEFAULT_MOUSE_POSITION_TOLERANCE_PX,
}

function clamp(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_MOUSE_POSITION_TOLERANCE_PX
  return Math.min(
    MOUSE_POSITION_TOLERANCE_MAX_PX,
    Math.max(MOUSE_POSITION_TOLERANCE_MIN_PX, Math.round(px))
  )
}

function load(): MousePositionToleranceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_MOUSE_POSITION_TOLERANCE }
    const parsed = JSON.parse(raw)
    return { tolerancePx: clamp(parsed?.tolerancePx ?? DEFAULT_MOUSE_POSITION_TOLERANCE_PX) }
  } catch {
    return { ...DEFAULT_MOUSE_POSITION_TOLERANCE }
  }
}

function save(s: MousePositionToleranceSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // localStorage unavailable — silently ignore
  }
}

interface MousePositionToleranceState extends MousePositionToleranceSettings {
  setTolerancePx: (px: number) => void
}

export const useMousePositionToleranceStore = create<MousePositionToleranceState>((set, get) => {
  const initial = load()
  return {
    ...initial,

    setTolerancePx: (px) => {
      set({ tolerancePx: clamp(px) })
      save(get())
    },
  }
})

/** Non-hook accessor for use outside React components (e.g. from
 *  inputControlTools.ts, which isn't itself a component). */
export function getMousePositionTolerancePx(): number {
  return useMousePositionToleranceStore.getState().tolerancePx
}
