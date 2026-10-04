// components/Terminal/TerminalPane.tsx
//
// Wraps TerminalBar + one TerminalPanel per tab.
// Handles tab creation / deletion and persists panel height.

import React, { useState, useCallback, useEffect, useRef } from 'react'
import TerminalBar, { TerminalTab } from './TerminalBar'
import TerminalPanel from './TerminalPanel'
import styles from './TerminalPane.module.css'

/** A command the parent (IDELayout, via the Run Configuration panel) wants
 *  executed in a fresh interactive terminal tab. `nonce` must change on
 *  every request, even for the same command, so repeats aren't ignored. */
export interface PendingRunRequest {
  command: string
  cwd?: string
  nonce: number
}

interface TerminalPaneProps {
  /** Forwarded from IDELayout */
  theme: 'dark' | 'light'
  /** Project root so new tabs start in the right directory */
  cwd?: string
  /** Height in px, controlled by the parent resize handle */
  height: number
  /** Increments when the parent requests a new embedded terminal tab */
  newTerminalRequest?: number
  /** Set when the Run Configuration panel wants a command run in a new tab */
  pendingRun?: PendingRunRequest | null
  /**
   * Increments whenever a Doctor Check run starts (see DoctorPanel /
   * IDELayout). Opens (or switches to) the pinned read-only "Doctor Check"
   * tab so the commands Doctor runs are visible in the app terminal.
   */
  doctorCheckRequest?: number
  /**
   * Increments whenever the AI agent runs a terminal command (see
   * IDELayout's agentTerminalBus.onRun subscription). Opens (or switches
   * to) the pinned read-only "Agent Terminal" tab so commands the agent
   * runs are visible in the app terminal instead of executing invisibly.
   */
  agentRunRequest?: number
}

const DOCTOR_TAB_ID = 'doctor-check'
const AGENT_TAB_ID = 'agent-terminal'

function makeDoctorTab(): TerminalTab {
  return { id: DOCTOR_TAB_ID, title: 'Doctor Check', source: 'doctor-log' }
}

function makeAgentTab(): TerminalTab {
  return { id: AGENT_TAB_ID, title: 'Agent Terminal', source: 'agent-log' }
}

let tabIdCounter = 1

/**
 * Returns the smallest positive integer not already in use by an existing
 * "regular" (pty) terminal tab. This is what gives terminal numbers their
 * "reuse the freed slot" behaviour: closing Terminal 1 while Terminal 2 and
 * 3 stay open means the next new terminal becomes Terminal 1 again, not 4.
 * Pinned tabs (Doctor Check / Agent Terminal) don't have a `number` and are
 * ignored here.
 */
function nextTerminalNumber(tabs: TerminalTab[]): number {
  const used = new Set(
    tabs.map(t => t.number).filter((n): n is number => typeof n === 'number')
  )
  let n = 1
  while (used.has(n)) n++
  return n
}

function makeTab(tabs: TerminalTab[], initialCommand?: string, cwdOverride?: string): TerminalTab {
  const number = nextTerminalNumber(tabs)
  return {
    id: `term-${Date.now()}-${tabIdCounter++}`,
    title: `Terminal ${number}`,
    number,
    initialCommand,
    cwdOverride,
  }
}

const TerminalPane: React.FC<TerminalPaneProps> = ({ theme, cwd, height, newTerminalRequest = 0, pendingRun = null, doctorCheckRequest = 0, agentRunRequest = 0 }) => {
  // No terminal is open by default when the app/pane first mounts — the
  // user opens one explicitly via the "+" button (or Run Configuration).
  const [tabs,     setTabs]     = useState<TerminalTab[]>(() => [])
  const [activeId, setActiveId] = useState<string>('')
  const lastRunNonce = useRef<number | null>(null)
  const lastDoctorNonce = useRef<number | null>(null)
  const lastAgentNonce = useRef<number | null>(null)

  const addTab = useCallback(() => {
    setTabs(prev => {
      const tab = makeTab(prev)
      setActiveId(tab.id)
      return [...prev, tab]
    })
  }, [])

  useEffect(() => {
    if (newTerminalRequest > 0) addTab()
  }, [addTab, newTerminalRequest])

  // ── Doctor Check requests ────────────────────────────────────────────────
  // Reuse the pinned "doctor-check" tab across runs instead of spawning a
  // new one every time — Refresh / re-opening the panel just re-selects it.
  useEffect(() => {
    if (doctorCheckRequest <= 0 || doctorCheckRequest === lastDoctorNonce.current) return
    lastDoctorNonce.current = doctorCheckRequest
    setTabs(prev => (prev.some(t => t.id === DOCTOR_TAB_ID) ? prev : [...prev, makeDoctorTab()]))
    setActiveId(DOCTOR_TAB_ID)
  }, [doctorCheckRequest])

  // ── Run Configuration "Run" requests ─────────────────────────────────────
  // Always opens a brand-new tab rather than reusing one, so a still-running
  // previous process is never killed/overwritten by a fresh run.
  useEffect(() => {
    if (!pendingRun || pendingRun.nonce === lastRunNonce.current) return
    lastRunNonce.current = pendingRun.nonce
    setTabs(prev => {
      const tab = makeTab(prev, pendingRun.command, pendingRun.cwd)
      setActiveId(tab.id)
      return [...prev, tab]
    })
  }, [pendingRun])

  // ── Agent Terminal requests ──────────────────────────────────────────────
  // Same pattern as Doctor Check above: reuse one pinned tab across runs so
  // consecutive agent commands land in the same place instead of spawning
  // a new tab (and stealing focus) every time.
  useEffect(() => {
    if (agentRunRequest <= 0 || agentRunRequest === lastAgentNonce.current) return
    lastAgentNonce.current = agentRunRequest
    setTabs(prev => (prev.some(t => t.id === AGENT_TAB_ID) ? prev : [...prev, makeAgentTab()]))
    setActiveId(AGENT_TAB_ID)
  }, [agentRunRequest])

  const closeTab = useCallback((id: string) => {
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      if (id === activeId) {
        setActiveId(next.length > 0 ? next[next.length - 1].id : '')
      }
      return next
    })
  }, [activeId])

  return (
    <div className={styles.pane} style={{ height }}>
      <TerminalBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={addTab}
        onClose={closeTab}
      />
      <div className={styles.panels}>
        {tabs.length === 0 && (
          <div className={styles.emptyState}>
            No terminal running. Click <strong>+</strong> ' to start one.
          </div>
        )}
        {tabs.map(tab => (
          <TerminalPanel
            key={tab.id}
            id={tab.id}
            active={tab.id === activeId}
            cwd={tab.cwdOverride ?? cwd}
            initialCommand={tab.initialCommand}
            theme={theme}
            source={tab.source}
          />
        ))}
      </div>
    </div>
  )
}

export default TerminalPane
