// services/agent/desktopViewModeGuard.ts
//
// Wraps a desktop-control tool's native invoke() call (mouse_click,
// mouse_drag_path, press_key/press_key_sequence, take_screenshot) so
// Rachna's own OS window is shrunk down to the 100x100 orb — the
// smallest, least obtrusive view — for the duration of that single native
// call, then restored to whatever view it was in before.
//
// Why: approving the permission dialog for one of these tools necessarily
// brings the full Rachna window to the foreground (the user just clicked
// Approve in it). If the full IDE window is still large when the
// subsequent mouse_click/press_key fires, it can sit on top of — or
// simply occupy so much screen that the target app's real window is
// awkward to reach around — the app the agent is trying to click into.
// Shrinking to the orb gets Rachna almost entirely out of the way before
// the target app is refocused (see inputControlTools.ts's refocusTarget),
// without closing/hiding the window entirely (still visible, still
// clickable if the user wants to intervene).
//
// Must be called AFTER permission approval, never wrapping it — the
// permission dialog itself is rendered inside the chat UI (IDELayout in
// chatDialogMode / the full IDE), which doesn't exist in the 100x100 orb
// view. Shrinking before the dialog renders would make it impossible for
// the user to see or click Approve/Deny at all.
//
// Every transition here passes `{ focus: false }` — this is an automated,
// momentary UI shrink/restore around a native call the agent is making,
// not a user-initiated view change, so it must never steal OS focus away
// from the target app the tool is about to (or just did) act on.

import { goToView } from '../viewModeController'
import { useViewModeStore } from '../../store/useViewModeStore'
import type { ViewMode } from '../../store/useViewModeStore'

// Mirrors the adjacency chain in useViewModeStore.ts — full <-> chat <->
// orb, no direct full <-> orb jump. Walking this one hop at a time (rather
// than trying to jump straight to 'orb') is what keeps every transition
// legal through goToView's own isAdjacent check.
const TOWARD_ORB: Record<ViewMode, ViewMode | null> = {
  full: 'chat',
  chat: 'orb',
  orb: null,
}

async function walkTo(target: ViewMode): Promise<void> {
  while (true) {
    const current = useViewModeStore.getState().mode
    if (current === target) return
    // Only 'orb' is ever walked toward automatically (see withOrbView
    // below) — chase along TOWARD_ORB one hop at a time, focus:false at
    // every hop.
    const next = TOWARD_ORB[current]
    if (!next) return // already as close to 'orb' as this chain gets
    await goToView(next, { focus: false })
  }
}

async function walkBackTo(target: ViewMode): Promise<void> {
  // Walking "back up" from orb/chat toward the mode the window was in
  // before withOrbView ran. Only full/chat/orb exist and the chain is
  // linear, so retracing is just walking TOWARD_ORB's chain in reverse —
  // i.e. repeatedly moving toward `target` via the one adjacent mode that
  // gets closer to it.
  const order: ViewMode[] = ['orb', 'chat', 'full']
  const targetIdx = order.indexOf(target)
  while (true) {
    const current = useViewModeStore.getState().mode
    const currentIdx = order.indexOf(current)
    if (currentIdx === targetIdx) return
    const next = currentIdx < targetIdx ? order[currentIdx + 1] : order[currentIdx - 1]
    await goToView(next, { focus: false })
  }
}

/**
 * Runs `fn` with Rachna's own OS window shrunk down to the orb, restoring
 * whatever view was active beforehand once `fn` settles (success or
 * failure alike). Call this AFTER permission approval and immediately
 * before the native mouse/key/screenshot invoke() call — see module doc
 * comment above for why the ordering matters.
 *
 * No-ops (runs `fn` directly) if already in 'orb' — nothing to shrink.
 */
export async function withOrbView<T>(fn: () => Promise<T>): Promise<T> {
  const previousMode = useViewModeStore.getState().mode

  try {
    await walkTo('orb')
  } catch (e) {
    console.warn('[desktopViewModeGuard] failed to shrink to orb, proceeding anyway:', e)
  }

  try {
    return await fn()
  } finally {
    try {
      await walkBackTo(previousMode)
    } catch (e) {
      console.warn('[desktopViewModeGuard] failed to restore previous view:', e)
    }
  }
}
