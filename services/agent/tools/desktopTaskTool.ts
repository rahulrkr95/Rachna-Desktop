// services/agent/tools/desktopTaskTool.ts
//
// Tool: desktop_task
//
// A single dispatcher tool covering broad OS-level actions the agent can
// take beyond the file/terminal tools: opening files/folders/URLs with the
// OS default handler, launching an application, listing/killing processes,
// showing a desktop notification, and reading/writing the clipboard.
//
// Design: one tool with an `action` enum + action-specific optional fields,
// rather than seven separate tool declarations — mirrors gitAgentTool /
// manageTodosTool's shape and keeps the model's tool list shorter. Each
// action maps to its own Tauri command (see src-tauri/src/desktop_task.rs).
//
// Safety: `launch_app`, `kill_process`, and `open_app` can start arbitrary
// programs or terminate running ones, so — same as run_terminal_command —
// they are gated behind the user's terminal-permission approval flow
// (ctx.requestTerminalPermission / useTerminalPermissionStore) before the
// underlying Tauri command is ever invoked. `open_path` (handing a path to
// the OS's own file/URL handler, or to the in-app Disk Viewer for
// directories), `list_processes`, `notify`, and the clipboard actions are
// read-only or benign enough to run without a prompt.

import { invoke } from '@tauri-apps/api/core'
import { isBlockedTerminalTarget, TERMINAL_BLOCK_MESSAGE } from '../terminalSafety'
import { resolveWorkspacePath } from '../pathUtils'
import { getPathInfo } from '../../../lib/tauriFs'
import { resolveAndOpenApp } from '../../appRegistry/openApp'
import { toolOk, toolErr, toolErrDenied, type AgentTool, type ToolContext } from '../types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type DesktopTaskAction =
  | 'open_path'
  | 'open_app'
  | 'launch_app'
  | 'list_processes'
  | 'kill_process'
  | 'notify'
  | 'clipboard_read'
  | 'clipboard_write'

export interface DesktopTaskArgs {
  action: DesktopTaskAction
  /** open_path: file/folder path or URL to open with the OS default handler. */
  path?: string
  /** open_app: friendly application name to search for and launch, e.g. "chrome", "notepad". */
  appName?: string
  /** launch_app: path to the executable to launch. */
  appPath?: string
  /** launch_app: command-line arguments for the launched executable. */
  args?: string[]
  /** list_processes: optional case-insensitive substring filter on process name. */
  nameFilter?: string
  /** kill_process: the process id to terminate. */
  pid?: number
  /** notify: notification title. */
  title?: string
  /** notify: notification body. */
  body?: string
  /** clipboard_write: text to place on the system clipboard. */
  text?: string
}

export type DesktopTaskResult =
  | { action: 'open_path'; path: string }
  | { action: 'open_app'; appName: string; launched?: AppMatch; matches?: AppMatch[] }
  | { action: 'launch_app'; appPath: string; pid: number }
  | { action: 'list_processes'; count: number; processes: ProcessInfo[] }
  | { action: 'kill_process'; pid: number; killed: boolean }
  | { action: 'notify'; title: string; body: string }
  | { action: 'clipboard_read'; text: string }
  | { action: 'clipboard_write'; text: string }

export interface ProcessInfo {
  pid: number
  name: string
  exe: string | null
  cpuUsage: number
  memoryBytes: number
}

/** A candidate application, either from the Installed App Registry
 *  (services/appRegistry — 'installed_registry') or the legacy Rust
 *  `resolve_app` command ('start_menu' | 'app_paths'), which open_app
 *  falls back to when the registry isn't loaded or has no confident
 *  match. See services/appRegistry/openApp.ts. */
export interface AppMatch {
  name: string
  path: string
  source: 'start_menu' | 'app_paths' | 'installed_registry'
}

// ── Tauri IPC payload shapes (snake_case as returned from Rust) ─────────────

interface TauriProcessInfo {
  pid: number
  name: string
  exe: string | null
  cpu_usage: number
  memory_bytes: number
}

interface TauriLaunchAppResult {
  pid: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_PROCESSES_RETURNED = 200

// ── Terminal-app block list ──────────────────────────────────────────────────
//
// The agent must always run shell commands through the in-app terminal
// (run_terminal_command / the embedded xterm.js panel), never by popping
// open an OS-level terminal window. open_app/launch_app/open_path could
// otherwise be used to launch Command Prompt, PowerShell, or Windows
// Terminal directly, so every one of those actions is checked against this
// list before anything is invoked. Matches on either the raw name/path the
// caller supplied or (for open_app) the resolved application's own name/path.
function toProcessInfo(p: TauriProcessInfo): ProcessInfo {
  return {
    pid: p.pid,
    name: p.name,
    exe: p.exe,
    cpuUsage: p.cpu_usage,
    memoryBytes: p.memory_bytes,
  }
}

/** Actions that can start or stop programs and therefore require explicit
 *  user approval before executing — same gate as run_terminal_command. */
const DESTRUCTIVE_ACTIONS: ReadonlySet<DesktopTaskAction> = new Set(['launch_app', 'kill_process', 'open_app'])

function describeForPermission(args: DesktopTaskArgs): string {
  if (args.action === 'launch_app') {
    const argsStr = args.args?.length ? ` ${args.args.join(' ')}` : ''
    return `launch_app: ${args.appPath ?? '(missing path)'}${argsStr}`
  }
  if (args.action === 'kill_process') {
    return `kill_process: pid ${args.pid ?? '(missing pid)'}`
  }
  if (args.action === 'open_app') {
    return `open_app: ${args.appName ?? '(missing app name)'}`
  }
  return args.action
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const desktopTaskTool: AgentTool<DesktopTaskArgs, DesktopTaskResult> = {
  declaration: {
    name: 'desktop_task',
    description:
      'Perform an OS-level system task: open a file/folder/URL (open_path — folders ' +
      'open in the in-app Disk Viewer, files/URLs open with the OS default handler), ' +
      'find and launch an installed application by name (open_app, e.g. "chrome" or ' +
      '"notepad" — no need to know its install path), launch a specific executable ' +
      '(launch_app), list running processes (list_processes), terminate a process ' +
      '(kill_process), show a desktop notification (notify), or read/write the system ' +
      'clipboard (clipboard_read / clipboard_write). Actions that start or stop a program (launch_app, ' +
      'kill_process, open_app) require explicit user approval before they run. ' +
      'None of these actions can be used to open an OS-level terminal (Command Prompt, ' +
      'PowerShell, or Windows Terminal) — that request is always rejected. Use ' +
      'run_terminal_command for any shell command instead.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'open_path',
            'open_app',
            'launch_app',
            'list_processes',
            'kill_process',
            'notify',
            'clipboard_read',
            'clipboard_write',
          ],
          description: 'Which system task to perform.',
        },
        path: {
          type: 'string',
          description:
            'open_path only: file/folder path or URL to open. Folders open in the ' +
            'in-app Disk Viewer; files/URLs open with the OS default handler. ' +
            'e.g. "README.md", "dist/", "R:/SomeFolder", or "https://example.com".',
        },
        appName: {
          type: 'string',
          description:
            'open_app only: a friendly application name to search for and launch, ' +
            'e.g. "chrome", "notepad", "vs code". Resolved against Start Menu ' +
            'shortcuts and installed-app registrations — no install path needed.',
        },
        appPath: {
          type: 'string',
          description:
            'launch_app only: path (or bare executable name on PATH) of the ' +
            'application to launch, e.g. "notepad.exe" or "/Applications/Safari.app".',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'launch_app only: command-line arguments for the launched app.',
        },
        nameFilter: {
          type: 'string',
          description:
            'list_processes only: case-insensitive substring to filter process ' +
            'names by, e.g. "chrome". Omit to list every running process.',
        },
        pid: {
          type: 'number',
          description: 'kill_process only: the process id (pid) to terminate.',
        },
        title: {
          type: 'string',
          description: 'notify only: the notification title.',
        },
        body: {
          type: 'string',
          description: 'notify only: the notification body text.',
        },
        text: {
          type: 'string',
          description: 'clipboard_write only: the text to place on the clipboard.',
        },
      },
      required: ['action'],
    },
  },

  describeCall: (args) => {
    switch (args.action) {
      case 'open_path':        return `Opening ${args.path ?? '…'}`
      case 'open_app':         return `Finding and opening ${args.appName ?? '…'}`
      case 'launch_app':       return `Launching ${args.appPath ?? '…'}`
      case 'list_processes':   return args.nameFilter
        ? `Listing processes matching "${args.nameFilter}"`
        : 'Listing running processes'
      case 'kill_process':     return `Terminating process ${args.pid ?? '…'}`
      case 'notify':           return `Showing notification: ${args.title ?? '…'}`
      case 'clipboard_read':   return 'Reading clipboard'
      case 'clipboard_write':  return 'Writing to clipboard'
      default:                 return 'Running system task'
    }
  },

  execute: async (args, ctx: ToolContext) => {
    // ── Permission gate for destructive actions ───────────────────────────
    if (DESTRUCTIVE_ACTIONS.has(args.action) && ctx.requestTerminalPermission) {
      const decision = await ctx.requestTerminalPermission(describeForPermission(args))
      if (decision === 'deny') {
        return toolErrDenied(
          `Action denied by user: "${describeForPermission(args)}". ` +
          'The user chose not to allow this.'
        )
      }
    }

    try {
      switch (args.action) {
        case 'open_path': {
          const raw = (args.path ?? '').trim()
          if (!raw) return toolErr('path is required for open_path.')
          const resolved = resolveWorkspacePath(raw, ctx.projectRoot)
          // If it doesn't resolve to a workspace-relative path (e.g. it's a
          // URL like "https://…"), fall back to the raw value as-is.
          const target = resolved.ok ? resolved.path : raw

          // Directories open in the in-app Disk Viewer instead of the OS's
          // own file manager (Explorer/Finder). URLs skip the path_info
          // check entirely — path_info would just report "doesn't exist".
          const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
          if (!looksLikeUrl) {
            if (isBlockedTerminalTarget(target)) return toolErr(TERMINAL_BLOCK_MESSAGE)
            const info = await getPathInfo(target).catch(() => null)
            if (info?.is_dir && ctx.openDiskViewer) {
              ctx.openDiskViewer(target)
              return toolOk<DesktopTaskResult>({ action: 'open_path', path: target })
            }
          }

          await invoke('open_path', { path: target })
          return toolOk<DesktopTaskResult>({ action: 'open_path', path: target })
        }

        case 'open_app': {
          const query = (args.appName ?? '').trim()
          if (!query) return toolErr('appName is required for open_app.')
          if (isBlockedTerminalTarget(query)) return toolErr(TERMINAL_BLOCK_MESSAGE)

          // Even if the requested name looked benign, the resolved
          // candidate(s) might still point at a terminal (e.g. a Start Menu
          // shortcut literally named "Command Prompt"). isBlockedTerminalTarget
          // is applied to every candidate regardless of whether it came from
          // the Installed App Registry or the legacy resolve_app fallback —
          // see services/appRegistry/openApp.ts.
          const resolution = await resolveAndOpenApp(query, isBlockedTerminalTarget)

          switch (resolution.status) {
            case 'not_found':
              return toolErr(`No installed application matching "${query}" was found.`)
            case 'blocked':
              return toolErr(TERMINAL_BLOCK_MESSAGE)
            case 'launched':
              return toolOk<DesktopTaskResult>({ action: 'open_app', appName: query, launched: resolution.match })
            case 'ambiguous':
              // Ambiguous — surface the candidates rather than guessing
              // which one the user meant.
              return toolOk<DesktopTaskResult>({ action: 'open_app', appName: query, matches: resolution.matches })
          }
        }

        case 'launch_app': {
          const appPath = (args.appPath ?? '').trim()
          if (!appPath) return toolErr('appPath is required for launch_app.')
          if (isBlockedTerminalTarget(appPath)) return toolErr(TERMINAL_BLOCK_MESSAGE)
          const result = await invoke<TauriLaunchAppResult>('launch_app', {
            appPath,
            args: args.args ?? [],
          })
          return toolOk<DesktopTaskResult>({ action: 'launch_app', appPath, pid: result.pid })
        }

        case 'list_processes': {
          const raw = await invoke<TauriProcessInfo[]>('list_processes', {
            nameFilter: args.nameFilter ?? null,
          })
          const processes = raw.slice(0, MAX_PROCESSES_RETURNED).map(toProcessInfo)
          return toolOk<DesktopTaskResult>({
            action: 'list_processes',
            count: processes.length,
            processes,
          })
        }

        case 'kill_process': {
          if (typeof args.pid !== 'number' || !Number.isFinite(args.pid)) {
            return toolErr('pid is required for kill_process.')
          }
          const killed = await invoke<boolean>('kill_process', { pid: args.pid })
          return toolOk<DesktopTaskResult>({ action: 'kill_process', pid: args.pid, killed })
        }

        case 'notify': {
          const title = args.title ?? 'Rachna AI Studio'
          const body = args.body ?? ''
          await invoke('show_notification', { title, body })
          return toolOk<DesktopTaskResult>({ action: 'notify', title, body })
        }

        case 'clipboard_read': {
          const text = await invoke<string>('read_clipboard')
          return toolOk<DesktopTaskResult>({ action: 'clipboard_read', text })
        }

        case 'clipboard_write': {
          const text = args.text ?? ''
          await invoke('write_clipboard', { text })
          return toolOk<DesktopTaskResult>({ action: 'clipboard_write', text })
        }

        default:
          return toolErr(`Unknown desktop_task action: ${String((args as DesktopTaskArgs).action)}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return toolErr(`desktop_task (${args.action}) failed: ${message}`)
    }
  },
}
