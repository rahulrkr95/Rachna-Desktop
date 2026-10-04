// components/Terminal/TerminalBar.tsx
//
// Tab bar sitting above the terminal panel area. Shows one tab per PTY session.
// "+" adds a new session; "×" on a tab kills that session.

import React from 'react'
import styles from './TerminalBar.module.css'

export interface TerminalTab {
  id: string
  title: string
  /**
   * Display number for regular ('pty') terminal tabs, used to compute the
   * next free number when a new tab is added (see nextTerminalNumber in
   * TerminalPane.tsx). Pinned tabs (Doctor Check / Agent Terminal) leave
   * this undefined since they aren't part of the numbering sequence.
   */
  number?: number
  /** Auto-typed into the shell once the PTY spawns (see TerminalPanel). */
  initialCommand?: string
  /** Overrides the pane's default cwd for just this tab. */
  cwdOverride?: string
  /**
   * 'pty' (default) is a real interactive shell. 'doctor-log' is a
   * read-only tab fed by the Doctor Check backend event — no PTY is
   * spawned and the user can't type into it. 'agent-log' is the same idea,
   * fed by the AI agent's terminal-command bus (lib/agentTerminalBus.ts).
   */
  source?: 'pty' | 'doctor-log' | 'agent-log'
}

interface TerminalBarProps {
  tabs: TerminalTab[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
}

const TerminalBar: React.FC<TerminalBarProps> = ({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onClose,
}) => (
  <div className={styles.bar}>
    <div className={styles.tabs}>
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={`${styles.tab} ${tab.id === activeId ? styles.active : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          <span className={styles.tabTitle}>{tab.title}</span>
          <button
            className={styles.closeBtn}
            onClick={e => { e.stopPropagation(); onClose(tab.id) }}
            aria-label="Close terminal"
          >
            ×
          </button>
        </div>
      ))}
      <button className={styles.addBtn} onClick={onAdd} aria-label="New terminal">
        +
      </button>
    </div>
    <span className={styles.label}>TERMINAL</span>
  </div>
)

export default TerminalBar
