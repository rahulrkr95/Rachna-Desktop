// components/ChatDialogHeader.tsx
//
// Floating controls shown over IDELayout when chatDialogMode is active (see
// App.tsx / IDELayout.tsx) — the medium always-on-top window shown while
// useViewModeStore's mode is 'chat'. This is the only view with buttons
// going both directions of the chain (full <-> chat <-> orb), since it
// sits in the middle:
//   - '⤢' expands to the full IDE ('chat' -> 'full')
//   - '⌄' collapses down to the orb ('chat' -> 'orb')
// There is deliberately no button here (or anywhere) that jumps straight
// between 'full' and 'orb' — see store/useViewModeStore.ts.
//
// The native OS title bar (and its minimize/maximize/close buttons) is
// hidden while in this mode (see services/viewModeWindow.ts, setDecorations
// (false)), so this renders just an invisible top drag strip (to keep the
// window movable) plus these two small icon buttons floated over the
// top-right corner.

import React from 'react'
import styles from './ChatDialogHeader.module.css'

interface Props {
  onCollapseToOrb: () => void
  onExpandToFull: () => void
}

export default function ChatDialogHeader({ onCollapseToOrb, onExpandToFull }: Props) {
  return (
    <>
    <div className={styles.dragBar} />
    <div className={styles.actions}>
      <button
        className={styles.iconBtn}
        onClick={onExpandToFull}
        title="Expand to full IDE"
        aria-label="Expand to full IDE"
      >
        ⤢
      </button>
      <button
        className={styles.iconBtn}
        onClick={onCollapseToOrb}
        title="Collapse to orb"
        aria-label="Collapse to orb"
      >
        ⌄
      </button>
    </div>
    </>
  )
}
