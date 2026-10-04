// store/useInputActionOverlayStore.ts
//
// Drives <InputActionOverlay> (components/InputActionOverlay.tsx) — a
// purely cosmetic, always-on-top overlay that shows the user what the
// mouse_click / mouse_drag_path / press_key / press_key_sequence tools
// (services/agent/tools/inputControlTools.ts) are about to do:
//   - mouse_click            -> an expanding ring at the click point
//   - mouse_drag_path        -> the drag's curve/outline, traced over the
//                               same duration as the real drag
//   - press_key (text)       -> a top bar reading "Type: <text>"
//   - press_key / sequence /
//     press_key_sequence     -> a top bar reading "Keys: <chord(s)>"
//
// This store holds ONLY presentation state. Nothing here feeds back into
// tool execution, retries, or decisions — inputControlTools.ts calls these
// setters purely to drive what's on screen, exactly as requested ("just
// visual feedback, it should not drive any decision").
//
// `blocking` additionally drives the overlay's full-viewport input-capture
// layer, which swallows mouse/keyboard events aimed at the Rachna app's own
// UI while an input-control action is in flight, so the user can't collide
// with the agent (e.g. clicking Send again, or typing into the editor)
// mid-action. It intentionally only affects Rachna's own window — there is
// no OS-level input grab here, so it can't block input to *other*
// applications on the desktop (the actual target of most of these tools).

import { create } from 'zustand'

export type OverlayAction =
  | { kind: 'click'; id: number; x: number; y: number; button: string; double?: boolean }
  | { kind: 'drag'; id: number; points: { x: number; y: number }[]; durationMs: number; button: string }
  | { kind: 'typing'; id: number; text: string }
  | { kind: 'keys'; id: number; label: string }

interface InputActionOverlayState {
  action: OverlayAction | null
  blocking: boolean
  showClick: (x: number, y: number, button: string, double?: boolean) => void
  showDrag: (points: { x: number; y: number }[], durationMs: number, button: string) => void
  showTyping: (text: string) => void
  showKeys: (label: string) => void
  clear: () => void
  setBlocking: (blocking: boolean) => void
}

let nextActionId = 1

export const useInputActionOverlayStore = create<InputActionOverlayState>((set) => ({
  action: null,
  blocking: false,

  showClick: (x, y, button, double) =>
    set({ action: { kind: 'click', id: nextActionId++, x, y, button, double } }),

  showDrag: (points, durationMs, button) =>
    set({ action: { kind: 'drag', id: nextActionId++, points, durationMs, button } }),

  showTyping: (text) => set({ action: { kind: 'typing', id: nextActionId++, text } }),

  showKeys: (label) => set({ action: { kind: 'keys', id: nextActionId++, label } }),

  clear: () => set({ action: null }),

  setBlocking: (blocking) => set({ blocking }),
}))
