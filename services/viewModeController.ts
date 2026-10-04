// services/viewModeController.ts
//
// The one place transitions between the app's three window views (full /
// chat / orb) are requested from — lifted out of App.tsx so it's callable
// from plain, non-React tool code too (see services/agent/
// desktopViewModeGuard.ts, which drives the window down to the orb and
// back around a desktop-control tool call). App.tsx's own handlers
// (handleExpandToChat / handleCollapseToOrb / handleExpandToFull) and its
// auto-chat-on-focus-loss effect all call this same function, unchanged
// from when goToView lived inline in App.tsx — behavior here is identical,
// just relocated so it has exactly one implementation instead of two.
//
// It's the only place that (a) checks the move is actually legal via
// isAdjacent (full <-> chat <-> orb only, never full <-> orb directly) and
// (b) drives the matching OS window change. Having one gate here means a
// future caller (button or tool) can never accidentally wire up an invalid
// jump — it would just be silently rejected and logged.

import { useViewModeStore, isAdjacent } from '../store/useViewModeStore'
import type { ViewMode } from '../store/useViewModeStore'
import { enterOrbMode, enterChatMode, enterFullMode } from './viewModeWindow'

export async function goToView(target: ViewMode, options?: { focus?: boolean }): Promise<void> {
  const state = useViewModeStore.getState()
  if (state.isTransitioning) return
  if (state.mode === target) return
  if (!isAdjacent(state.mode, target)) {
    console.warn(`[view-mode] blocked invalid transition ${state.mode} -> ${target}`)
    return
  }

  state.setTransitioning(true)
  try {
    if (target === 'full') await enterFullMode()
    else if (target === 'chat') await enterChatMode(options)
    else if (target === 'orb') await enterOrbMode(options)
    state.setMode(target)
  } finally {
    state.setTransitioning(false)
  }
}
