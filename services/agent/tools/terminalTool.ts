// services/agent/tools/terminalTool.ts
//
// Tool: run_terminal_command
//
// Executes an arbitrary shell command from the workspace root and returns
// stdout, stderr, exit code, and a status flag. Any command may be
// requested; the user is prompted to approve it before execution (via the
// permission-prompt model — see useTerminalPermissionStore).
//
// Security:
//   - Every command requires explicit user approval via ctx.requestTerminalPermission.
//     The user may optionally "remember" approval for a tool prefix for the
//     session, which auto-approves future identical-prefix invocations.
//   - When ctx.requestTerminalPermission is absent (unit tests), commands
//     execute directly — the test harness is trusted.
//   - projectRoot must be set in ToolContext — commands are rejected otherwise.
//   - A configurable timeout (default 60 s) kills the process on expiry.
//
// Design note: the actual execution goes through the Tauri `run_terminal_command`
// Rust command, which now also receives the detected shell (`powershell`,
// `cmd`, `bash`, `zsh`, or `sh`) and runs the command through it — this is
// what makes shell-specific syntax (PowerShell cmdlets, cmd builtins) work.
// The TS layer validates and serialises arguments and picks the shell.

import { invoke } from '@tauri-apps/api/core'
import { toolOk, toolErr, toolErrDenied, type AgentTool, type ToolContext, type DetectedShell, type SystemInfo } from '../types'
import { agentTerminalBus } from '../../../lib/agentTerminalBus'
import { getDefaultCwd } from '../../../lib/defaultCwd'

// ── cwd resolution ──────────────────────────────────────────────────────────
//
// `cwd` is documented as "relative to the project root", but models
// sometimes pass back an already-absolute path (e.g. echoing projectRoot
// verbatim, or a path read from get_repo_overview/list_directory output).
// Naively joining `${projectRoot}/${cwd}` in that case doubles the path
// (e.g. "D:\...\HireHelperAI/D:/.../HireHelperAI") and Rust's cwd.exists()
// check then fails with a confusing "Working directory does not exist"
// error. Detect absolute paths first (drive-letter or POSIX-rooted) and use
// them as-is instead of joining.
const ABSOLUTE_PATH_RE = /^([a-zA-Z]:)?[\\/]/

async function resolveCwd(projectRoot: string | null, rawCwd: string | undefined): Promise<string | { error: string }> {
  if (rawCwd) {
    if (ABSOLUTE_PATH_RE.test(rawCwd)) return rawCwd.replace(/[\\/]+$/, '')
    if (projectRoot) return `${projectRoot}/${rawCwd}`.replace(/\/+$/, '')
    // No project open AND a relative cwd was given — nothing to resolve it
    // against. Fail explicitly rather than guessing.
    return { error: `Cannot resolve relative cwd "${rawCwd}" with no project open. Use an absolute path or omit cwd.` }
  }
  if (projectRoot) return projectRoot
  // No project open, no cwd given — fall back to the user's home directory
  // instead of hard-blocking (see intentClassifier.ts: TERMINAL_TASK is
  // meant to work without a project open).
  return getDefaultCwd()
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RunCommandArgs {
  /** Short, user-facing description of what the command does. */
  label: string
  /**
   * The full shell command to run, e.g. "npm run build" or "pnpm test".
   * Must start with an allowed prefix — see getAllowedPrefixes() below.
   * Use syntax appropriate for the detected shell (see the Environment
   * section of the system prompt): e.g. `Get-ChildItem` on PowerShell,
   * `dir` on cmd.exe, `ls` on Bash/Zsh.
   */
  command: string
  /**
   * Optional working directory relative to the project root.
   * Defaults to the project root itself.
   */
  cwd?: string
  /**
   * Maximum execution time in seconds before the process is killed.
   * Defaults to 60. Max is 300 (5 min).
   */
  timeoutSeconds?: number
}

export interface RunCommandResult {
  command: string
  cwd: string
  /** The shell the command was executed through (e.g. "bash", "powershell"). */
  shell: string
  stdout: string
  stderr: string
  exitCode: number | null
  /** true when the process exited with code 0 */
  success: boolean
  /** true when the process was killed due to timeout */
  timedOut: boolean
  durationMs: number
  /**
   * true when this was a long-running dev-server command that was launched
   * in a fresh interactive terminal tab instead of executed-and-awaited.
   * stdout/stderr/exitCode/durationMs are meaningless in this case — the
   * process is still running in the app's Terminal panel.
   */
  launchedInTerminal?: boolean
}

// ── Long-running dev server detection ───────────────────────────────────────
//
// Commands like `npm run dev` or `vite` start a server and never exit on
// their own — running them through the normal execute-and-wait path
// (invoke('run_terminal_command', ...)) would just block until the
// timeout kills the process. Instead, these are detected here and handed
// off to agentTerminalBus.announceLaunch(), which opens a fresh
// interactive PTY tab (the same mechanism the Run Configuration panel's
// "Run" button uses) and returns control to the agent immediately. The
// server keeps running in that tab; the user gets the localhost link from
// its output and can stop it manually.
//
// This is intentionally a conservative allowlist of well-known dev-server
// invocations rather than a general "does this look long-running" guess —
// false negatives (a dev command that isn't recognised) just fall back to
// the normal execute-and-wait path, which still works, it just waits out
// the timeout; false positives (a one-shot command wrongly treated as a
// server) would be worse, since its real output/exit code would be lost.
const LONG_RUNNING_DEV_COMMAND_PATTERNS: RegExp[] = [
  // npm run dev / start / serve / preview (and the "run" keyword is optional
  // for start, since `npm start` is the common form)
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)(\s|$)/i,
  // Direct dev-server binaries / CLIs, optionally via npx
  /^(npx\s+)?vite(\s|$)/i,
  /^(npx\s+)?next\s+dev(\s|$)/i,
  /^(npx\s+)?astro\s+dev(\s|$)/i,
  /^(npx\s+)?nuxt\s+dev(\s|$)/i,
  /^(npx\s+)?remix\s+dev(\s|$)/i,
  /^(npx\s+)?parcel(\s|$)/i,
  /^(npx\s+)?webpack(-dev-server)?\s+.*--?watch/i,
  /^ng\s+serve(\s|$)/i,
  // Framework/runtime dev servers outside the npm ecosystem
  /^flask\s+run(\s|$)/i,
  /^python[3]?\s+manage\.py\s+runserver(\s|$)/i,
  /^rails\s+server(\s|$)/i,
  /^rails\s+s(\s|$)/i,
  /^php\s+artisan\s+serve(\s|$)/i,
  /^uvicorn\s+.*--reload/i,
  /^cargo\s+watch(\s|$)/i,
]

export function isLongRunningDevCommand(command: string): boolean {
  const trimmed = command.trim()
  return LONG_RUNNING_DEV_COMMAND_PATTERNS.some(p => p.test(trimmed))
}

// ── Tauri IPC payload ─────────────────────────────────────────────────────────

interface TauriCommandResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  duration_ms: number
}

/**
 * Resolves the shell identifier to pass to the Tauri `run_terminal_command`
 * command. Falls back to a sensible default based on OS when shell detection
 * didn't produce a known shell.
 */
function resolveShell(systemInfo: SystemInfo | undefined): DetectedShell {
  if (systemInfo?.shell && systemInfo.shell !== 'unknown') return systemInfo.shell
  if (systemInfo?.os === 'windows') return 'powershell'
  if (systemInfo?.os === 'macos') return 'zsh'
  return 'bash'
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const terminalTool: AgentTool<RunCommandArgs, RunCommandResult> = {
  declaration: {
    name: 'run_terminal_command',
    description:
      'Run a shell command in the project workspace and return stdout, stderr, ' +
      'exit code, and execution status. Use this to run builds (npm run build), ' +
      'tests (npm test), linters (eslint .), type-checks (tsc --noEmit), install ' +
      'packages, or inspect the file system with any shell command. The command ' +
      'runs in the project root by default. Use syntax appropriate for the detected ' +
      'OS and shell (see the "Environment" section of the system prompt). ' +
      'The user will be prompted to approve any command before it runs — ' +
      'they may also choose to remember approval for the session. ' +
      'Always check exit code and stderr — non-zero exit means the command failed. ' +
      'Long-running dev servers (npm run dev, npm start, vite, next dev, astro dev, ' +
      'and similar) are detected automatically and launched in a fresh interactive ' +
      'terminal tab instead of being waited on — this call returns immediately with ' +
      'launchedInTerminal: true, so just call it the same way you would any other command.',
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description:
            'A short, plain-language title describing what the command does, ' +
            'for example "Run the test suite" or "List TypeScript files". ' +
            'Do not include the command itself.',
        },
        command: {
          type: 'string',
          description:
            'The shell command to run, in syntax appropriate for the detected ' +
            'OS/shell (see the Environment section of the system prompt), ' +
            'e.g. "npm run build", "Get-ChildItem -Recurse" on PowerShell, ' +
            '"dir /s" on cmd.exe, or "ls -la" on Bash/Zsh.',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory. Relative paths resolve against the project root ' +
            'when a project is open. Absolute paths are used as-is. Omit to default ' +
            "to the project root (or, if no project is open, the user's home directory).",
        },
        timeoutSeconds: {
          type: 'number',
          description:
            'Seconds before the process is forcibly killed. ' +
            'Default 60. Maximum 300.',
        },
      },
      required: ['label', 'command'],
    },
  },

  describeCall: (args) => (args.label ?? '').trim() || 'Running terminal command',

  execute: async (args, ctx: ToolContext) => {
    // ── Validate context ────────────────────────────────────────────────────
    const command = (args.command ?? '').trim()
    if (!command) {
      return toolErr('command must not be empty.')
    }

    // ── Permission gate ──────────────────────────────────────────────────────
    //
    // When a requestTerminalPermission callback is provided (i.e. the IDE UI
    // is active), pause here and wait for explicit user approval. The callback
    // shows a dialog; the user can approve once or remember for the session.
    //
    // If no callback is provided (unit tests, CLI usage), fall through and
    // execute the command directly — the caller is responsible for security.
    if (ctx.requestTerminalPermission) {
      const decision = await ctx.requestTerminalPermission(command)
      if (decision === 'deny') {
        return toolErrDenied(
          `Command denied by user: "${command}". ` +
          'The user chose not to allow this command.'
        )
      }
    }

    // ── Long-running dev server? Launch in a terminal tab, don't wait ──────
    //
    // Permission was already gated above (same as any other command). Once
    // approved, hand off to agentTerminalBus.announceLaunch() — IDELayout
    // opens a fresh interactive PTY tab (reusing the same mechanism as the
    // Run Configuration panel's "Run" button) and the process keeps running
    // there after this tool call returns. No Rust invoke, no timeout, no
    // stdout/stderr collection — the user watches/stops it in the tab.
    if (isLongRunningDevCommand(command)) {
      agentTerminalBus.announceLaunch(command, args.cwd)
      return toolOk<RunCommandResult>({
        command,
        cwd: (await resolveCwd(ctx.projectRoot, args.cwd)) as string,
        shell: resolveShell(ctx.systemInfo),
        stdout: '',
        stderr: '',
        exitCode: null,
        success: true,
        timedOut: false,
        durationMs: 0,
        launchedInTerminal: true,
      })
    }

    // ── Timeout ─────────────────────────────────────────────────────────────
    const rawTimeout = typeof args.timeoutSeconds === 'number'
      ? args.timeoutSeconds
      : 60
    const timeoutSeconds = Math.min(Math.max(1, rawTimeout), 300)

    // ── Resolve cwd ─────────────────────────────────────────────────────────
    const cwdResult = await resolveCwd(ctx.projectRoot, args.cwd)
    if (typeof cwdResult !== 'string') {
      return toolErr(cwdResult.error)
    }
    const cwd = cwdResult

    // ── Resolve shell ────────────────────────────────────────────────────────
    const shell = resolveShell(ctx.systemInfo)

    // ── Surface this run in the actual in-app Terminal panel ─────────────────
    // Rather than executing invisibly in the background and only reporting
    // back as text once the agent's turn finishes, mirror the command (and
    // its output) into the pinned "Agent Terminal" tab as it happens — see
    // lib/agentTerminalBus.ts. Fire-and-forget: a bus hiccup must never
    // block or fail the actual command execution.
    agentTerminalBus.announceRun()
    agentTerminalBus.log(`$ ${command}`)

    // ── Invoke Tauri command ────────────────────────────────────────────────
    let raw: TauriCommandResult
    try {
      raw = await invoke<TauriCommandResult>('run_terminal_command', {
        command,
        cwd,
        timeoutSeconds,
        shell,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      agentTerminalBus.log(`[error] ${message}`)
      return toolErr(`Failed to execute command: ${message}`)
    }

    if (raw.stdout) agentTerminalBus.log(raw.stdout.replace(/\n+$/, ''))
    if (raw.stderr) agentTerminalBus.log(raw.stderr.replace(/\n+$/, ''))
    agentTerminalBus.log(
      raw.timed_out
        ? `[timed out after ${timeoutSeconds}s]`
        : `[exit ${raw.exit_code ?? 'unknown'}] (${raw.duration_ms}ms)`
    )

    const result: RunCommandResult = {
      command,
      cwd,
      shell,
      stdout: raw.stdout,
      stderr: raw.stderr,
      exitCode: raw.exit_code,
      success: raw.exit_code === 0 && !raw.timed_out,
      timedOut: raw.timed_out,
      durationMs: raw.duration_ms,
    }

    return toolOk(result)
  },
}
