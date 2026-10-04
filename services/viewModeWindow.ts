// services/viewModeWindow.ts
//
// Drives the actual OS window across the three views the app can be in
// (see store/useViewModeStore.ts, which only tracks which of these is
// active — this module does the real work against @tauri-apps/api/window).
// The chain is full <--> chat <--> orb; there is no direct full <-> orb
// jump anywhere in here or in the store — App.tsx's goToView is the only
// caller and it enforces that via useViewModeStore's isAdjacent check.
//
//   'full'  the real IDE, maximized — the only resizable size, and the
//           default on launch. Native title bar minimize/maximize/close
//           buttons behave exactly like any other Windows app here.
//   'chat'  a medium always-on-top chat-only window (IDELayout rendered
//           with chatDialogMode, see App.tsx). Reached either by
//           expanding the orb, or automatically whenever the full window
//           loses OS focus (App.tsx's onFocusChanged listener) — clicking
//           away from the full IDE tucks it into this smaller chat dialog
//           instead of leaving the full window sitting behind whatever
//           the user switched to. No native title bar / minimize / close
//           buttons in this mode.
//   'orb'   a tiny always-on-top pill (components/CompactView.tsx) — the
//           "minimal" view. Reached only by collapsing from the chat view
//           (components/ChatDialogHeader.tsx). No native title bar /
//           minimize / close buttons in this mode either.
//
// Only 'full' is resizable; 'chat' and 'orb' are fixed-size always-on-top
// windows (see shrinkTo below). Native window decorations (title bar +
// minimize/maximize/close) are shown only in 'full' — shrinkTo hides them
// (win.setDecorations(false)) and enterFullMode restores them.
//
// Both small views also share a single remembered screen anchor — the
// CENTER point of wherever the window last was (lastSmallWindowCenter
// below) — rather than one each, so toggling between the orb and the chat
// dialog expands/collapses around that same spot instead of jumping to a
// different default corner or leaping sideways because the two views are
// very different sizes.

import { getCurrentWindow, currentMonitor, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'

export const ORB_WIDTH = 100
export const ORB_HEIGHT = 100
export const CHAT_WIDTH = 400
export const CHAT_HEIGHT = 600
const SCREEN_MARGIN = 20
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800


type SmallView = 'orb' | 'chat'

export type AnchorCorner = 'top-right' | 'bottom-left' | 'top-left' | 'bottom-right'

// Default anchor corner the FIRST time each small view is entered in a
// session. Both orb and chat dialog default to top-right. Both windows
// stay freely movable afterwards (native drag, see attachDragClamp below)
// — this is only the starting position.
const DEFAULT_ANCHOR: Record<SmallView, AnchorCorner> = {
  orb: 'top-right',
  chat: 'top-right',
}

// Remembers the CENTER POINT of wherever the user last left the small
// window, shared across BOTH small views ('orb' and 'chat') so that
// expanding the orb into the chat dialog (or collapsing back) grows/shrinks
// around that same spot on screen — like a chat bubble expanding in place —
// instead of keeping a fixed top-left corner (which, given orb and chat are
// very different sizes, made the window visibly leap sideways/downward on
// every transition). Populated by attachDragClamp's onMoved handler and by
// shrinkTo itself right after positioning.
let lastSmallWindowCenter: { x: number; y: number } | null = null

// Tracked purely so attachDragClamp knows whether to clamp/remember drag
// position (it no-ops in 'full'). Kept private to this module — the
// canonical mode lives in useViewModeStore; this is just a same-process
// mirror the drag listener can read synchronously without importing the
// store into a plain service module.
let lastEnteredView: SmallView | 'full' = 'full'

function anchorPosition(
  corner: AnchorCorner,
  width: number,
  height: number,
  workWidth: number,
  workHeight: number,
): { x: number; y: number } {
  const x = corner.endsWith('right') ? workWidth - width - SCREEN_MARGIN : SCREEN_MARGIN
  const y = corner.startsWith('bottom') ? workHeight - height - SCREEN_MARGIN : SCREEN_MARGIN
  return { x: Math.max(0, x), y: Math.max(0, y) }
}

// Sets the window to (width, height) and confirms it actually landed there,
// re-issuing setSize a few times if not. This matters specifically for the
// full → chat transition: unmaximize() can resolve before Windows' restore
// animation has actually finished, so a setSize call that fires too early
// loses the race — the OS finishes animating back to the maximized window's
// pre-maximize rect (e.g. ~1400x900) *after* our resize, silently
// overwriting it. That produced a chat window visibly bigger than the
// requested 400x600. Polling+re-asserting here catches and corrects that
// instead of trusting a single blind setSize + fixed delay.
//
// A single matching read isn't enough on its own — it can land on a frame
// in the MIDDLE of that same restore animation that happens to pass through
// (width, height) on its way to the wrong final size. Requiring two
// consecutive matching reads (with a short gap between them) filters that
// out: a truly settled window still matches on the second read, an
// in-flight animation usually doesn't.
async function ensureSize(win: ReturnType<typeof getCurrentWindow>, width: number, height: number): Promise<void> {
  const matchesTarget = async (): Promise<boolean> => {
    const scale = await win.scaleFactor().catch(() => 1)
    const actual = await win.innerSize()
    return Math.abs(actual.width / scale - width) < 2 && Math.abs(actual.height / scale - height) < 2
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    await win.setSize(new LogicalSize(width, height))
    await new Promise(resolve => setTimeout(resolve, 60))

    if (await matchesTarget()) {
      // Confirm it's still there a moment later, not just a passing frame.
      await new Promise(resolve => setTimeout(resolve, 60))
      if (await matchesTarget()) return
    }
  }
  console.warn('[viewModeWindow] size did not settle at', width, height)
}

async function shrinkTo(width: number, height: number, view: SmallView, focus: boolean = true): Promise<void> {
  const win = getCurrentWindow()
  const monitor = await currentMonitor()
  const scale = monitor?.scaleFactor ?? 1
  const workWidth = monitor ? monitor.size.width / scale : DEFAULT_WIDTH
  const workHeight = monitor ? monitor.size.height / scale : DEFAULT_HEIGHT

  const { x, y } = lastSmallWindowCenter
    ? {
        // Re-derive top-left from the remembered center so the window
        // expands/collapses around that same point rather than keeping a
        // fixed corner — then clamp so a big chat window centered near a
        // screen edge doesn't get pushed off-screen.
        x: Math.min(Math.max(lastSmallWindowCenter.x - width / 2, 0), Math.max(0, workWidth - width)),
        y: Math.min(Math.max(lastSmallWindowCenter.y - height / 2, 0), Math.max(0, workHeight - height)),
      }
    : anchorPosition(DEFAULT_ANCHOR[view], width, height, workWidth, workHeight)

  await win.setResizable(true)
  // Drop the 800x600 floor from tauri.conf.json before resizing — otherwise
  // setSize below gets clamped up to it regardless of the width/height
  // passed in, and 'orb' (100x100) and 'chat' (400x600) both end up at the
  // same clamped size.
  await win.setMinSize(null)

  // Position + the OS-level window-style change (always-on-top) happens
  // BEFORE the final size settle-check below — it can itself trigger a
  // native reflow/redraw on Windows that silently reverts a size set
  // beforehand (the same class of race documented on ensureSize above).
  // Previously this ran AFTER ensureSize, so a reflow triggered by
  // setAlwaysOnTop could undo the resize we'd just confirmed — leaving
  // the window visibly bigger than the requested size with no further
  // check to catch it. Doing it first means ensureSize's settle-check is
  // genuinely the LAST thing that can move the window's size.
  //
  // Deliberately NOT calling setSkipTaskbar(true) here: it's the same
  // single app window whether it's full, chat, or orb, and hiding it
  // from the taskbar the moment it auto-tucks to chat (e.g. on focus
  // loss — see App.tsx's onFocusChanged) made Rachna effectively
  // disappear from the taskbar for as long as the user wasn't actively
  // focused on the full IDE, which made it hard to locate/switch back
  // to (WIN-001). Keeping the taskbar entry in every view means it's
  // always there to click back to, regardless of how small it's shrunk.
  await win.setPosition(new LogicalPosition(x, y))
  await win.setAlwaysOnTop(true)

  await ensureSize(win, width, height)

  // Re-assert position once more — setSize can itself nudge a window's
  // origin (e.g. resizing from a corner/edge anchor), so re-clamp after
  // the final size is confirmed rather than trusting the position set
  // above, before size settling.
  await win.setPosition(new LogicalPosition(x, y))

  // Only lock size AFTER final dimensions (and position) are established
  await win.setResizable(false)

  // Remember this as the new shared center point, so the *next* transition
  // (orb <-> chat) expands/collapses around here too — matters the first
  // time a small view is entered (from the default corner anchor above)
  // and after any resize where lastSmallWindowCenter was reused as-is.
  lastSmallWindowCenter = { x: x + width / 2, y: y + height / 2 }

  if (focus) {
    await win.setFocus()
  }

  lastEnteredView = view
}

/**
 * Shrinks the real OS window down to a small always-on-top pill (the
 * "orb"). Anchored to the top-right corner of the screen by default;
 * freely movable afterwards (native title-bar / app-region drag, clamped
 * to the screen — see attachDragClamp), and remembers wherever the user
 * last dragged it to. Only ever called from the chat view — see
 * App.tsx's goToView / useViewModeStore's ADJACENT table.
 */
/**
 * Pass `{ focus: false }` when entering orb mode as part of an automated
 * shrink/restore around a desktop-control tool call (see
 * services/agent/desktopViewModeGuard.ts) — the whole point of that
 * shrink is to get the real OS window out of the way of whatever app the
 * agent is about to click/type into, so stealing focus back to the
 * (now tiny) orb would immediately undo the refocus the tool is about to
 * do. Defaults to stealing focus, which is what a deliberate user click
 * (collapsing the chat dialog) should do — matches enterChatMode's
 * existing `{ focus? }` option.
 */
export async function enterOrbMode(options?: { focus?: boolean }): Promise<void> {
  const win = getCurrentWindow()
  try {
    // if (await win.isFullscreen()) {
    //   await win.setFullscreen(false)
    // }
    await win.setDecorations(false)
    await shrinkTo(ORB_WIDTH, ORB_HEIGHT, 'orb', options?.focus ?? true)
  } catch (e) {
    console.warn('[viewModeWindow] failed to enter orb mode:', e)
  }
}

/**
 * Grows/shrinks the window into a medium, chat-only always-on-top window.
 * Reached from either 'full' (auto, on focus loss, or the orb's expand
 * click) or 'orb' (its expand click) — never from anywhere else.
 *
 * Pass `{ focus: false }` when entering chat mode automatically because the
 * full window just lost OS focus (see App.tsx) — resizes/repositions the
 * window without stealing focus back from whatever the user switched to.
 * Defaults to stealing focus, which is what a deliberate user click (e.g.
 * expanding the orb) should do.
 */
export async function enterChatMode(options?: { focus?: boolean }): Promise<void> {
  const win = getCurrentWindow()

  try {
    if (await win.isFullscreen()) {
      await win.setFullscreen(false)
    }
    // await win.setMaximizable(true)
    // if (await win.isMaximized()) {
    //   await win.unmaximize()
    //   // unmaximize()'s promise can resolve before Windows' restore animation
    //   // actually finishes. Poll briefly for isMaximized() to actually flip
    //   // false rather than trusting a single fixed delay — see ensureSize's
    //   // comment above for why a premature resize here loses the race.
    //   for (let i = 0; i < 10 && (await win.isMaximized()); i++) {
    //     await new Promise(resolve => setTimeout(resolve, 30))
    //   }
    // }
    await win.setMaximizable(false)

    await win.setDecorations(true)
    await win.setResizable(true)

    // Give Windows one more frame to settle before we resize.
    await new Promise(resolve => setTimeout(resolve, 50))

    await shrinkTo(CHAT_WIDTH, CHAT_HEIGHT, 'chat', options?.focus ?? true)
  } catch (e) {
    console.warn('[viewModeWindow] failed to enter chat mode:', e)
  }
}

/**
 * Restores the window from the orb/chat dialog back to the full IDE —
 * always maximized (full screen), regardless of what size the window was
 * before it was shrunk down. Drops always-on-top either way. The window
 * stays registered in the Windows taskbar the whole time (see shrinkTo) so
 * this doesn't need to touch skip-taskbar at all.
 * Only ever called from the chat view — never directly from the orb.
 */
export async function enterFullMode(): Promise<void> {
  const win = getCurrentWindow()

  try {
    await win.setAlwaysOnTop(false)

    // Native window decorations (title bar + minimize/maximize/close) are
    // shown only in 'full' — see this module's top-of-file doc.
    // enterOrbMode/enterChatMode both explicitly hide them
    // (setDecorations(false)) since those views draw their own floating
    // controls (the orb body / ChatDialogHeader's ⤢ and ⌄ buttons) in the
    // same top-right corner the native title bar would occupy.
    await win.setDecorations(false)

    await win.setResizable(true)
    await win.setMaximizable(true)
    if (!await win.isFullscreen()) {
      await win.setFullscreen(true)
    }
    // Restore the floor cleared in shrinkTo() — the full IDE should still
    // refuse to be dragged smaller than its designed minimum.
    await win.setMinSize(new LogicalSize(DEFAULT_WIDTH, DEFAULT_HEIGHT))

    await win.maximize()
    await win.setMaximizable(false)

    await win.setFocus()

    lastEnteredView = 'full'
  } catch (e) {
    console.warn('[viewModeWindow] failed to enter full mode:', e)
  }
}

/**
 * Keeps the orb/chat window from being dragged off-screen. Native
 * decorations mean the user can drag the window by its title bar (and the
 * orb body itself is `-webkit-app-region: drag`), so on every move we
 * clamp the window back within the current monitor's work area whenever
 * we're in one of the small, always-on-top views. No-ops while 'full'.
 *
 * Call once from App.tsx and hold onto the returned unlisten function.
 */
export async function attachDragClamp(): Promise<() => void> {
  const win = getCurrentWindow()

  const unlisten = await win.onMoved(async () => {
    if (lastEnteredView === 'full') return

    try {
      const monitor = await currentMonitor()
      if (!monitor) return
      const scale = monitor.scaleFactor ?? 1
      const workWidth = monitor.size.width / scale
      const workHeight = monitor.size.height / scale

      const pos = await win.outerPosition()
      const size = await win.outerSize()
      const x = pos.x / scale
      const y = pos.y / scale
      const width = size.width / scale
      const height = size.height / scale

      const clampedX = Math.min(Math.max(x, 0), Math.max(0, workWidth - width))
      const clampedY = Math.min(Math.max(y, 0), Math.max(0, workHeight - height))

      if (Math.abs(clampedX - x) > 0.5 || Math.abs(clampedY - y) > 0.5) {
        await win.setPosition(new LogicalPosition(clampedX, clampedY))
      }

      // Remember the CENTER of where the user left this window (shared
      // between 'orb' and 'chat') so the next time either small view is
      // entered — whether that's re-entering the same view or switching
      // to the other one — it expands/collapses around this same point
      // instead of snapping to a different corner.
      lastSmallWindowCenter = { x: clampedX + width / 2, y: clampedY + height / 2 }
    } catch (e) {
      console.warn('[viewModeWindow] drag clamp failed:', e)
    }
  })

  return unlisten
}
