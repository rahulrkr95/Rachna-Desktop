// store/useViewModeStore.ts
//
// Single source of truth for which of the app's three window views is
// active, replacing the old useCompactModeStore (isCompact + compactView
// as two separate booleans/enums, which let App.tsx assemble invalid
// combinations and made it easy for a handler to accidentally wire up a
// direct full <-> orb jump).
//
// The app only ever moves along one chain:
//
//     full  <-->  chat  <-->  orb
//
// There is no direct full <-> orb transition. That rule lives in ONE place
// — the ADJACENT table below — instead of being an implicit property of
// "which handlers happen to be wired to which buttons". See
// services/viewModeWindow.ts for the actual OS-window work each transition
// performs, and App.tsx's `goToView` for the only place transitions are
// requested from.

import { create } from 'zustand'

export type ViewMode = 'full' | 'chat' | 'orb'

// The only legal moves. Deliberately does NOT include full <-> orb.
const ADJACENT: Record<ViewMode, ViewMode[]> = {
  full: ['chat'],
  chat: ['full', 'orb'],
  orb: ['chat'],
}

export function isAdjacent(from: ViewMode, to: ViewMode): boolean {
  return ADJACENT[from].includes(to)
}

interface ViewModeState {
  /** Which of the three views is currently shown. */
  mode: ViewMode
  /** True while a transition's window resize/reposition is in flight, to
   *  block a second transition (e.g. a rapid double-click, or the OS focus
   *  listener firing mid-animation) from overlapping the first. */
  isTransitioning: boolean
  setMode: (mode: ViewMode) => void
  setTransitioning: (isTransitioning: boolean) => void
}

export const useViewModeStore = create<ViewModeState>(set => ({
  mode: 'full',
  isTransitioning: false,
  setMode: mode => set({ mode }),
  setTransitioning: isTransitioning => set({ isTransitioning }),
}))
