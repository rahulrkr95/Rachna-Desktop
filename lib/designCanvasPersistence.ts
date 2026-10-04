// lib/designCanvasPersistence.ts
//
// Persists Design Canvas view state (pan/zoom transform + each frame's
// position on the board) per project, to localStorage — same convention
// as store/useGitSettingsStore.ts. Keyed by the project's real disk path
// (projectRoot), which is stable for the lifetime of a saved project, so
// reopening a project restores the board exactly as the user left it:
// same zoom level, same pan position, same frame arrangement.
//
// Written on every pan/zoom/drag (debounced) rather than only on an
// explicit "save project" action — there is no separate save step for an
// already-on-disk project (files save individually), so "save the canvas
// view when the project is saved" is satisfied by keeping this always in
// sync rather than gating it behind a save button that may never fire.

const STORAGE_PREFIX = 'rachna-design-canvas:'

export interface DesignCanvasTransform {
  x: number
  y: number
  scale: number
}

export interface DesignCanvasPersistedState {
  transform: DesignCanvasTransform
  /** Frame positions keyed by absolute file path. */
  positions: Record<string, { x: number; y: number }>
}

function keyFor(projectRoot: string): string {
  return `${STORAGE_PREFIX}${projectRoot}`
}

export function loadDesignCanvasState(projectRoot: string): DesignCanvasPersistedState | null {
  try {
    const raw = localStorage.getItem(keyFor(projectRoot))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      transform: {
        x: Number(parsed.transform?.x) || 0,
        y: Number(parsed.transform?.y) || 0,
        scale: Number(parsed.transform?.scale) || 1,
      },
      positions: parsed.positions && typeof parsed.positions === 'object' ? parsed.positions : {},
    }
  } catch {
    return null
  }
}

export function saveDesignCanvasState(projectRoot: string, state: DesignCanvasPersistedState): void {
  try {
    localStorage.setItem(keyFor(projectRoot), JSON.stringify(state))
  } catch {
    // localStorage unavailable — silently ignore, matching useGitSettingsStore's convention
  }
}
