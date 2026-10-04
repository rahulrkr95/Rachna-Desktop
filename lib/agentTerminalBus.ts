// lib/agentTerminalBus.ts
//
// Lightweight typed event bus (mirrors lib/llmCallBus.ts) that lets the
// agent's `run_terminal_command` tool — services/agent/tools/terminalTool.ts,
// several layers away from any component — surface what it's running in the
// actual in-app Terminal panel (components/Terminal) instead of executing
// invisibly in the background and only reporting back as text in the chat.
//
// Three channels:
//   onRun/announceRun — "a command is about to run": IDELayout listens for
//     this at the top level (always mounted, regardless of whether the
//     Terminal panel is currently open) to reveal the panel and select the
//     pinned "Agent Terminal" tab, exactly the way DoctorPanel's
//     onCheckStart does for the "Doctor Check" tab.
//   onLog/log — one chunk of output (a command line, stdout, stderr, or a
//     completion summary) for that tab to render.
//   onLaunch/announceLaunch — "open a fresh interactive terminal tab and
//     run this command in it, don't wait for it to exit". Used for
//     long-running dev servers (npm run dev, vite, next dev, ...) — see
//     isLongRunningDevCommand() in terminalTool.ts. IDELayout listens for
//     this the same way it wires up RunConfigPanel's "Run" button
//     (handleRunCommand), so the command lands in a real PTY tab with a
//     live localhost link instead of being run-and-waited via
//     run_terminal_command / Rust's spawn-and-collect-output path.
//
// A small buffer replays recent lines to a listener that subscribes after
// some lines were already emitted (e.g. the "$ command" line logged the
// instant a run starts, before React has finished mounting the tab that
// will display it) — without this, that first line would just be dropped.

const MAX_BUFFER_LINES = 2000

export interface AgentTerminalRunEvent {
  /** Increments on every agent terminal command — lets IDELayout know a
   *  fresh run happened even if the nonce value itself isn't inspected. */
  nonce: number
}

export interface AgentTerminalLogEvent {
  /** May contain embedded newlines — subscribers split before rendering. */
  line: string
}

export interface AgentTerminalLaunchEvent {
  /** The full shell command to run, e.g. "npm run dev". */
  command: string
  /** Working directory, relative to project root or absolute. Optional. */
  cwd?: string
  /** Increments on every launch request. */
  nonce: number
}

type RunListener = (event: AgentTerminalRunEvent) => void
type LogListener = (event: AgentTerminalLogEvent) => void
type LaunchListener = (event: AgentTerminalLaunchEvent) => void

const runListeners = new Set<RunListener>()
const logListeners = new Set<LogListener>()
const launchListeners = new Set<LaunchListener>()

let runNonce = 0
let launchNonce = 0
let buffer: string[] = []

export const agentTerminalBus = {
  onRun(listener: RunListener): () => void {
    runListeners.add(listener)
    return () => runListeners.delete(listener)
  },

  onLaunch(listener: LaunchListener): () => void {
    launchListeners.add(listener)
    return () => launchListeners.delete(listener)
  },

  /** Call once per long-running dev-server command instead of executing it
   *  through run_terminal_command — opens a fresh interactive terminal tab
   *  and returns control immediately; the tab keeps running the server. */
  announceLaunch(command: string, cwd?: string): void {
    launchNonce += 1
    const event: AgentTerminalLaunchEvent = { command, cwd, nonce: launchNonce }
    launchListeners.forEach(fn => {
      try { fn(event) } catch { /* never break the agent loop */ }
    })
  },

  /** Subscribes to future log lines, immediately replaying any buffered
   *  history first so a newly-mounted tab isn't missing earlier output. */
  onLog(listener: LogListener): () => void {
    if (buffer.length > 0) {
      try { listener({ line: buffer.join('\n') }) } catch { /* never break the caller */ }
    }
    logListeners.add(listener)
    return () => logListeners.delete(listener)
  },

  /** Call once per agent terminal command, before execution starts. */
  announceRun(): void {
    runNonce += 1
    const event: AgentTerminalRunEvent = { nonce: runNonce }
    runListeners.forEach(fn => {
      try { fn(event) } catch { /* never break the agent loop */ }
    })
  },

  /** Appends a chunk of output (one or more lines) to the Agent Terminal tab. */
  log(line: string): void {
    buffer.push(...line.split(/\r?\n/))
    if (buffer.length > MAX_BUFFER_LINES) buffer = buffer.slice(-MAX_BUFFER_LINES)
    logListeners.forEach(fn => {
      try { fn({ line }) } catch { /* never break the agent loop */ }
    })
  },
}
