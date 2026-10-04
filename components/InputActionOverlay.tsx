// components/InputActionOverlay.tsx
//
// Always-on-top, purely cosmetic overlay for the desktop-automation tools in
// services/agent/tools/inputControlTools.ts:
//   - mouse_click        -> an expanding ring + dot at the click point
//   - mouse_drag_path    -> the drag's curve, traced over the drag's own
//                           duration, with a moving head marker
//   - press_key (text)   -> a top bar: "Type: <text>"
//   - press_key (keys),
//     press_key sequence,
//     press_key_sequence -> a top bar: "Keys: <chord(s)>"
//
// Mounted once at the root of the render tree (see App.tsx) so it sits above
// every view/panel/modal in the app (CompactView, IDELayout, dialogs, …) —
// it does not belong to any one view, it just always renders on top.
//
// This component NEVER influences tool behavior — it only reads from
// useInputActionOverlayStore, which inputControlTools.ts writes to purely
// for display. See that store's header comment for the input-blocking
// caveat (it blocks input to Rachna's own UI only, not other applications).

import React, { useEffect, useRef, useState } from 'react'
import { useInputActionOverlayStore, type OverlayAction } from '../store/useInputActionOverlayStore'
import styles from './InputActionOverlay.module.css'

const CLICK_DURATION_MS = 600
const DRAG_EXTRA_MS = 300
const KEYBAR_MIN_MS = 900
const KEYBAR_MAX_MS = 4000
const KEYBAR_FADE_MS = 220

function keyBarDuration(text: string): number {
  return Math.min(KEYBAR_MAX_MS, Math.max(KEYBAR_MIN_MS, 300 + text.length * 40))
}

function pathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

/** Auto-clears the current action after it has had time to play out, so a
 *  new action always starts from a clean slate. Keyed on action.id so a
 *  fresh action of the same kind restarts the timer correctly. */
function useAutoClear(action: OverlayAction | null, clear: () => void) {
  useEffect(() => {
    if (!action) return
    let ms: number
    switch (action.kind) {
      case 'click':
        ms = CLICK_DURATION_MS
        break
      case 'drag':
        ms = action.durationMs + DRAG_EXTRA_MS
        break
      case 'typing':
        ms = keyBarDuration(action.text)
        break
      case 'keys':
        ms = keyBarDuration(action.label)
        break
    }
    const timer = setTimeout(clear, ms)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action?.id])
}

/** While `blocking` is true, swallows mouse/keyboard events aimed at
 *  Rachna's own window (capture phase, so it runs before any app handler).
 *  Does not (and cannot from inside a webview) block input to other
 *  applications on the desktop. */
function useInputBlock(blocking: boolean) {
  useEffect(() => {
    if (!blocking) return
    const swallow = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
    }
    const opts: AddEventListenerOptions = { capture: true }
    const mouseEvents: (keyof WindowEventMap)[] = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel']
    const keyEvents: (keyof WindowEventMap)[] = ['keydown', 'keyup', 'keypress']
    for (const evt of [...mouseEvents, ...keyEvents]) {
      window.addEventListener(evt, swallow, opts)
    }
    return () => {
      for (const evt of [...mouseEvents, ...keyEvents]) {
        window.removeEventListener(evt, swallow, opts)
      }
    }
  }, [blocking])
}

function KeyBar({ label, value }: { label: string; value: string }) {
  const [fadingOut, setFadingOut] = useState(false)
  useEffect(() => {
    setFadingOut(false)
    const dur = keyBarDuration(value)
    const timer = setTimeout(() => setFadingOut(true), Math.max(0, dur - KEYBAR_FADE_MS))
    return () => clearTimeout(timer)
  }, [label, value])

  return (
    <div className={`${styles.keyBar} ${fadingOut ? styles.keyBarFadeOut : ''}`}>
      <span className={styles.keyBarLabel}>{label}:</span>
      <span className={styles.keyBarValue}>{value}</span>
    </div>
  )
}

function DragPath({ points, durationMs }: { points: { x: number; y: number }[]; durationMs: number }) {
  const pathRef = useRef<SVGPathElement>(null)
  const d = pathD(points)
  if (points.length < 2) return null
  const head = points[points.length - 1]
  const dragBounds = `0 0 ${window.innerWidth} ${window.innerHeight}`

  return (
    <svg className={styles.dragSvg} viewBox={dragBounds} preserveAspectRatio="none">
      <path ref={pathRef} className={styles.dragPath} d={d} />
      <circle className={styles.dragHead} r={7} cx={points[0].x} cy={points[0].y}>
        <animateMotion dur={`${durationMs}ms`} repeatCount="1" path={d} fill="freeze" />
      </circle>
      {/* Head-end marker fades in once the motion finishes, so the drag's
          endpoint stays visible for the rest of the animation window. */}
      <circle
        className={styles.dragHead}
        r={9}
        cx={head.x}
        cy={head.y}
        opacity={0}
      >
        <animate attributeName="opacity" from="0" to="0.9" begin={`${durationMs}ms`} dur="150ms" fill="freeze" />
      </circle>
    </svg>
  )
}

export default function InputActionOverlay() {
  const action = useInputActionOverlayStore((s) => s.action)
  const blocking = useInputActionOverlayStore((s) => s.blocking)
  const clear = useInputActionOverlayStore((s) => s.clear)

  useAutoClear(action, clear)
  useInputBlock(blocking)

  if (!action && !blocking) return null

  return (
    <div className={styles.root} aria-hidden="true">
      {blocking && <div className={styles.captureLayer} />}

      {action?.kind === 'click' && (
        <>
          <div className={styles.clickRing} style={{ left: action.x, top: action.y }} />
          <div className={styles.clickDot} style={{ left: action.x, top: action.y }} />
        </>
      )}

      {action?.kind === 'drag' && <DragPath points={action.points} durationMs={action.durationMs} />}

      {action?.kind === 'typing' && <KeyBar label="Type" value={action.text} />}

      {action?.kind === 'keys' && <KeyBar label="Keys" value={action.label} />}
    </div>
  )
}
