// components/Terminal/TerminalPanel.tsx
//
// VS Code-style interactive PTY terminal panel.
// Each instance owns one PTY session on the Rust side (pty_create / pty_write).
// Output is streamed back via a Tauri event: `terminal-output-{id}`.
//
// Architecture:
//   • xterm.js renders the terminal UI (full VT100/ANSI support)
//   • FitAddon auto-resizes the terminal to fill its container
//   • User keystrokes  → invoke('pty_write', { id, data })
//   • Rust PTY stdout  → listen('terminal-output-{id}') → xterm.write()
//   • Ctrl+C           → invoke('pty_resize', used to send SIGINT via data
//   • Tab switching    → multiple TerminalPanel instances managed by parent

import React, { useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import styles from './TerminalPanel.module.css'
import { agentTerminalBus } from '../../lib/agentTerminalBus'
import { useTerminalSettingsStore } from '../../store/useTerminalSettingsStore'
import { useBrowserStore } from '../../store/useBrowserStore'

// ── Props ──────────────────────────────────────────────────────────────────
export interface TerminalPanelProps {
  /** Stable ID for this terminal instance — used for the Tauri event channel */
  id: string
  /** Whether this panel is currently visible (hidden panels stay mounted) */
  active: boolean
  /** Current working directory to start the shell in */
  cwd?: string
  /**
   * Command to auto-type + submit once the shell has spawned — used by
   * "Run" in the Run Configuration panel to launch a dev server / long-
   * running process in a fresh interactive tab (a one-shot exec via
   * run_terminal_command isn't right for processes that don't exit).
   */
  initialCommand?: string
  /** Called when the panel has fully initialised */
  onReady?: () => void
  /** VS Code dark / light theme forwarded from IDELayout */
  theme: 'dark' | 'light'
  /**
   * 'pty' (default) spawns a real interactive shell. 'doctor-log' renders
   * a read-only log fed entirely by the backend's `doctor-log` event —
   * no PTY is spawned, and keystrokes are disabled. Used for the "Doctor
   * Check" tab so environment-check commands are visible in the app's own
   * Terminal panel instead of an OS terminal window. 'agent-log' is the
   * same idea for the AI agent's `run_terminal_command` tool calls — a
   * read-only tab fed by lib/agentTerminalBus.ts instead of a PTY, so
   * commands the agent runs are visible in the app's own Terminal panel
   * rather than executing invisibly in the background.
   */
  source?: 'pty' | 'doctor-log' | 'agent-log'
}

// ── Xterm theme maps ───────────────────────────────────────────────────────
const DARK_THEME = {
  background:  '#071A17',
  foreground:  '#ECFDF5',
  cursor:      '#10B981',
  cursorAccent:'#071A17',
  selectionBackground: 'rgba(79,157,255,0.25)',
  black:       '#0B1815',
  red:         'var(--error)r)',
  green:       '#10B981',
  yellow:      '#EAB308',
  blue:        '#10B981',
  magenta:     '#10B981',
  cyan:        '#10B981',
  white:       '#ECFDF5',
  brightBlack: '#23433B',
  brightRed:   'var(--error)r)',
  brightGreen: '#10B981',
  brightYellow:'#EAB308',
  brightBlue:  '#10B981',
  brightMagenta:'#10B981',
  brightCyan:  '#10B981',
  brightWhite: '#ffffff',
}

const LIGHT_THEME = {
  background:  '#F6FFFC',
  foreground:  '#18181B',
  cursor:      '#10B981',
  cursorAccent:'#F6FFFC',
  selectionBackground: 'rgba(79,157,255,0.3)',
  black:       '#0F172A',
  red:         '#dc2626',
  green:       '#059669',
  yellow:      '#d97706',
  blue:        '#059669',
  magenta:     '#10B981',
  cyan:        '#059669',
  white:       '#f4f4f5',
  brightBlack: '#52525b',
  brightRed:   'var(--error)r)',
  brightGreen: '#10B981',
  brightYellow:'#f59e0b',
  brightBlue:  '#3b82f6',
  brightMagenta:'#8b5cf6',
  brightCyan:  '#06b6d4',
  brightWhite: '#ffffff',
}

// ── Terminal link click handler ─────────────────────────────────────────────
// Terminal links share the persistent embedded browser session rather than
// launching a separate OS/Chromium window and pulling focus away from the IDE.
function handleTerminalLinkClick(_term: Terminal, uri: string, background: boolean) {
  useBrowserStore.getState().open(uri, background)
}

// ── Component ──────────────────────────────────────────────────────────────
const TerminalPanel: React.FC<TerminalPanelProps> = ({
  id,
  active,
  cwd,
  initialCommand,
  onReady,
  theme,
  source = 'pty',
}) => {
  const readOnly = source === 'doctor-log' || source === 'agent-log'
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef      = useRef<Terminal | null>(null)
  const fitRef       = useRef<FitAddon | null>(null)
  const readyRef     = useRef(false)
  const unlistenRef  = useRef<(() => void) | null>(null)
  const openLinksInBackground = useTerminalSettingsStore(s => s.openLinksInBackground)
  // Kept in a ref so the link-click handler (bound once, inside the
  // init effect below) always reads the current setting rather than a
  // stale value captured at mount time.
  const openLinksInBackgroundRef = useRef(openLinksInBackground)
  openLinksInBackgroundRef.current = openLinksInBackground

  // ── Initialise xterm + PTY ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || readyRef.current) return
    readyRef.current = true

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      fontSize:    13,
      lineHeight:  1.4,
      cursorStyle: 'bar',
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      theme:       theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      allowTransparency: false,
      scrollback:  10000,
      convertEol:  false,
    })

    const fitAddon   = new FitAddon()
    const linksAddon = new WebLinksAddon((event: MouseEvent, uri: string) => {
      handleTerminalLinkClick(term, uri, openLinksInBackgroundRef.current)
    })

    term.loadAddon(fitAddon)
    term.loadAddon(linksAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitRef.current  = fitAddon

    // ── Doctor Check / Agent Terminal tabs: read-only log, no PTY at all ────
    // Every command Doctor runs is emitted by the backend as a `doctor-log`
    // event (see doctor_check in commands.rs); every command the AI agent
    // runs is emitted by the frontend-only agentTerminalBus (see
    // lib/agentTerminalBus.ts and services/agent/tools/terminalTool.ts).
    // Either way we just render each line — neither ever spawns a real
    // shell process or touches the OS terminal, only this in-app panel.
    if (readOnly) {
      const label = source === 'doctor-log'
        ? 'Doctor Check output — read-only'
        : 'Agent Terminal — commands the AI runs, read-only'
      term.writeln(`\x1b[90m${label}\x1b[0m`)

      if (source === 'doctor-log') {
        listen<{ line: string }>('doctor-log', ({ payload }) => {
          term.writeln(payload.line)
        }).then(unlisten => {
          unlistenRef.current = unlisten
        })
      } else {
        unlistenRef.current = agentTerminalBus.onLog(({ line }) => {
          line.split(/\r?\n/).forEach(l => term.writeln(l))
        })
      }
      onReady?.()

      const ro = new ResizeObserver(() => {
        try { fitAddon.fit() } catch {}
      })
      ro.observe(containerRef.current)

      return () => {
        ro.disconnect()
        unlistenRef.current?.()
        term.dispose()
        readyRef.current = false
      }
    }

    // ── Listen for PTY output from Rust ───────────────────────────────────
    const eventName = `terminal-output-${id}`
    listen<string>(eventName, ({ payload }) => {
      term.write(payload)
    }).then(unlisten => {
      unlistenRef.current = unlisten
    })

    // ── Forward keystrokes to Rust PTY ────────────────────────────────────
    term.onData((data: string) => {
      invoke('pty_write', { id, data }).catch(() => {
        // PTY may have closed — silently ignore
      })
    })

    // ── Resize notification ───────────────────────────────────────────────
    term.onResize(({ cols, rows }) => {
      invoke('pty_resize', { id, cols, rows }).catch(() => {})
    })

    // ── Spawn the actual PTY process on the Rust side ─────────────────────
    invoke('pty_create', { id, cwd: cwd ?? null }).then(() => {
      onReady?.()
      if (initialCommand) {
        // Small delay so the shell has finished initialising (prompt
        // rendered) before we push keystrokes at it — avoids the command
        // text landing before the shell's own startup output/profile scripts.
        setTimeout(() => {
          invoke('pty_write', { id, data: `${initialCommand}\r` }).catch(() => {})
        }, 400)
      }
    }).catch((err: unknown) => {
      term.writeln(`\r\n\x1b[31m[Terminal] Failed to start shell: ${err}\x1b[0m\r\n`)
    })

    // ── Resize observer ───────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit() } catch {}
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      unlistenRef.current?.()
      invoke('pty_kill', { id }).catch(() => {})
      term.dispose()
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // ── Theme updates ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.theme = theme === 'dark' ? DARK_THEME : LIGHT_THEME
  }, [theme])

  // ── Fit whenever this tab becomes active ──────────────────────────────
  useEffect(() => {
    if (active && fitRef.current) {
      // Small delay so the container has finished any CSS transition
      const t = setTimeout(() => {
        try { fitRef.current?.fit() } catch {}
        termRef.current?.focus()
      }, 60)
      return () => clearTimeout(t)
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      className={styles.terminalContainer}
      style={{ display: active ? 'flex' : 'none' }}
    />
  )
}

export default TerminalPanel
