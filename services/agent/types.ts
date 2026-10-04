// services/agent/types.ts
// Shared types for the agentic tool-calling layer.
// No React, no Tauri, no provider-specific imports — unit-testable in isolation.

import type { ProviderFunctionDeclaration } from '../../lib/providers/types'
import { z } from 'zod'

// ── Environment awareness ────────────────────────────────────────────────────
//
// Detected once per session (see lib/systemInfo.ts) and threaded through the
// ToolContext so that agent tools — and the system prompt — can generate
// commands appropriate for the user's actual OS/shell combination.

/** Operating system the renderer/Tauri host is running on. */
export type DetectedOS = 'windows' | 'linux' | 'macos' | 'unknown'

/** Shell that `run_terminal_command` will execute commands through. */
export type DetectedShell = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'unknown'

export interface SystemInfo {
  /** Machine-readable OS identifier. */
  os: DetectedOS
  /** Human-readable OS label, e.g. "Windows 11", "macOS", "Ubuntu Linux". */
  osLabel: string
  /** Machine-readable shell identifier. */
  shell: DetectedShell
  /** Human-readable shell label, e.g. "PowerShell", "Bash". */
  shellLabel: string
}

export interface ToolContext {
  projectRoot: string | null
  /**
   * Detected OS + shell for the current session. Optional for backwards
   * compatibility — tools should fall back to conservative, cross-platform
   * behaviour when this is absent.
   */
  systemInfo?: SystemInfo
  /**
   * git_action's commit/push confirmation gate. Optional — gitAgentTool
   * falls back to DEFAULT_GIT_TOOL_SETTINGS (commit auto-allowed, push and
   * direct-to-main both require explicit opt-in) when absent.
   */
  gitSettings?: GitToolSettings
  /**
   * Permission gate for run_terminal_command.
   *
   * When set, terminalTool will call this before executing ANY command.
   * The callback should show a UI prompt and return a Promise that resolves
   * to 'approve' or 'deny'. Returning 'deny' causes the tool to return an
   * error without executing the command.
   *
   * When absent (e.g. in unit tests), the tool falls back to the legacy
   * allowlist-based behaviour.
   */
  requestTerminalPermission?: (command: string) => Promise<'approve' | 'deny'>
  /**
   * Requests the browser/profile used by openDefaultBrowser on first use (or
   * when the user explicitly asks to change it). The UI owns the prompt so
   * agent tools stay independent of React and remain straightforward to test.
   *
   * Resolves to null if the user cancels/closes the prompt without
   * selecting anything — openDefaultBrowserTool treats that as "abort, do
   * not launch anything". `remember` is optional for backwards
   * compatibility with callers that don't offer a "remember" choice; when
   * omitted, the selection is saved (matching prior behavior). When
   * present and false, the selection is used for this call only and is
   * not persisted.
   */
  requestBrowserPreference?: () => Promise<{ browser: string; profile: string; remember?: boolean } | null>
  /**
   * desktop_task's open_path action: called instead of the OS's own file
   * manager when the resolved path is a directory. Should open/focus the
   * in-app Disk Viewer navigated to `path`. Optional — falls back to
   * handing the path to the OS if absent (e.g. in unit tests).
   */
  openDiskViewer?: (path: string) => void
  /**
   * Set when the current turn is a DESKTOP_TASK:files (or other
   * outside-a-project) filesystem operation, as opposed to a coding/project
   * turn. Tools that create or open files (create_file, open_file,
   * open_in_explorer) use this to pick their path-resolution strategy:
   *   - false/absent (default): paths are resolved relative to the open
   *     project root, same as always — coding/project behavior.
   *   - true: paths may be absolute OS paths anywhere on disk, and a
   *     relative path (e.g. "Desktop\\notes.txt") falls back to resolving
   *     against the OS home directory instead of requiring a project to be
   *     open — see resolveSystemPath in pathUtils.ts.
   * A project being open still always takes precedence over the home-dir
   * fallback even when this flag is set.
   */
  allowExternalPaths?: boolean
  /**
   * open_project_folder tool: closes the current workspace and opens a new
   * folder as the active project, waiting until repository indexing is
   * complete before resolving. Wired at the useChat/IDELayout level.
   *
   * - Pass a non-empty path string to open a specific folder directly.
   * - Pass `null` to show a native folder-picker dialog.
   *
   * Resolves to the canonical project root path, or `null` if the user
   * cancelled the picker or the supplied path was invalid/not a directory.
   * The promise MUST NOT resolve until the workspace is fully loaded and
   * the repository index has reached `status === 'ready'`.
   */
  openProjectFolder?: (path: string | null) => Promise<string | null>
}

export interface ToolSuccess<T = unknown> {
  ok: true
  data: T
}

/**
 * Machine-readable key for a git_action safety gate blocked in Settings →
 * Git. Kept alongside ToolFailure (rather than only as a free-text error)
 * so the UI layer can offer a direct, one-click way to flip the setting —
 * e.g. an inline toggle in chat — instead of asking the user to go dig
 * through Settings and then type a free-text confirmation back to the
 * agent (see PendingToggleCard / useChat's resolvePendingToggle).
 */
export type GitSettingKey = 'autoAllowCommit' | 'autoAllowPush' | 'allowDirectPushToMain'

export interface ToolFailure {
  ok: false
  error: string
  /**
   * Set only when this failure was caused by a Settings → Git toggle being
   * off (commit/push/direct-push-to-main gates in gitAgentTool). Lets the
   * caller render a one-click "enable & retry" affordance instead of a
   * dead-end error message.
   */
  blockedSetting?: GitSettingKey
  /**
   * Set only when this failure was caused by the user explicitly denying a
   * permission prompt (terminal command, system/desktop-control action,
   * etc.) — as opposed to an ordinary tool error the model might reasonably
   * retry or work around. Lets AgentLoop pause the turn right here (same
   * "Continue from failed step" affordance as a hard error) instead of
   * feeding the denial back to the model and letting it try again.
   */
  permissionDenied?: boolean
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolFailure

export function toolOk<T>(data: T): ToolSuccess<T> {
  return { ok: true, data }
}

export function toolErr(error: string): ToolFailure {
  return { ok: false, error }
}

/** Same as toolErr, but tags the failure with the Settings → Git toggle
 *  that's blocking it so the UI can offer a direct fix. */
export function toolErrBlocked(error: string, blockedSetting: GitSettingKey): ToolFailure {
  return { ok: false, error, blockedSetting }
}

/** Same as toolErr, but tags the failure as a user-denied permission prompt
 *  so AgentLoop pauses the turn here instead of letting the model retry. */
export function toolErrDenied(error: string): ToolFailure {
  return { ok: false, error, permissionDenied: true }
}

/** Human-readable label for each git safety toggle — shared by the tool's
 *  error messages and the chat UI's PendingToggleCard. */
export const GIT_SETTING_LABELS: Record<GitSettingKey, string> = {
  autoAllowCommit:        'Auto-allow agent commits',
  autoAllowPush:          'Auto-allow agent push',
  allowDirectPushToMain:  'Allow direct push to main',
}

export interface AgentTool<TArgs = Record<string, unknown>, TResult = unknown> {
  declaration: ProviderFunctionDeclaration
  execute: (args: TArgs, ctx: ToolContext) => Promise<ToolResult<TResult>>
  describeCall: (args: TArgs) => string
}

export type AgentActivityArtifact =
  | {
      type: 'screenshot'
      path: string
      width: number
      height: number
      monitor?: string
      monitorIndex?: number
      monitorCount?: number
    }

export interface AgentActivity {
  id: string
  tool: string
  label: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: string
  /**
   * 'tool' (default, implicit) is a regular agent tool call. 'ai_call'
   * marks a step where the agent itself called out to the LLM provider —
   * rendered in AgentActivityPanel with an "AI call" flair chip that opens
   * a scrollable overlay showing the prompt sent and the response received.
   */
  kind?: 'tool' | 'ai_call'
  /** Present only when kind === 'ai_call'. `response` fills in as chunks
   *  stream back, so the overlay can show a live-updating answer. */
  aiCall?: {
    providerName: string
    model?: string
    prompt: string
    systemInstruction?: string
    response: string
    parsedResponse?: unknown
    startedAt?: string
    completedAt?: string
    latencyMs?: number
    tokenUsage?: {
      promptTokens: number
      completionTokens: number
      totalTokens: number
      estimated: boolean
    }
    error?: string
  }
  /**
   * UX-001 — Agent Execution Timeline. Set to 2+ when this call is a retry
   * of the same tool immediately after that tool's previous invocation
   * ended in 'error' (see AgentLoop's retry tracking). Omitted / 1 for a
   * normal first attempt. Lets the timeline show "Retry 2" style badges
   * instead of silently repeating the same step.
   */
  attempt?: number
  /**
   * UX-001 — Agent Execution Timeline. A short (~1 sentence) excerpt of the
   * model's reasoning/response for this step, shown inline in the timeline
   * log without requiring the user to open the full AiCallOverlay. Populated
   * for 'ai_call' activities once the response is available.
   */
  reasoningSummary?: string
  /** Optional rich artifact rendered in the agent log (for example, a clickable screenshot banner). */
  artifact?: AgentActivityArtifact
}

// ── Todo / Plan tracker (manage_todos) ──────────────────────────────────────
//
// Zod schemas + inferred types for the agent's self-managed task list. Kept
// here alongside the rest of the shared agent types so both the tool
// (services/agent/tools/todoTool.ts) and the store (store/useTodoStore.ts)
// can import a single source of truth.

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: TodoStatusSchema,
  /** Present-continuous form shown while this item is in_progress, e.g. "Refactoring auth module". */
  activeForm: z.string().min(1),
})
export type TodoItem = z.infer<typeof TodoItemSchema>

export const TodoWriteArgsSchema = z.object({
  action: z.literal('write'),
  todos: z.array(TodoItemSchema),
})
export const TodoUpdateStatusArgsSchema = z.object({
  action: z.literal('update_status'),
  id: z.string().min(1),
  status: TodoStatusSchema,
})
export const TodoReadArgsSchema = z.object({
  action: z.literal('read'),
})
export const ManageTodosArgsSchema = z.discriminatedUnion('action', [
  TodoWriteArgsSchema,
  TodoUpdateStatusArgsSchema,
  TodoReadArgsSchema,
])
export type ManageTodosArgs = z.infer<typeof ManageTodosArgsSchema>

// ── Git agent tool (git_action) ─────────────────────────────────────────────
//
// Zod schemas + inferred types for the agent-driven git tool
// (services/agent/tools/gitAgentTool.ts). Wraps services/git/gitService.ts.

export const GitActionArgsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('diff'), filePath: z.string().optional(), staged: z.boolean().optional() }),
  z.object({ action: z.literal('stage'), files: z.array(z.string().min(1)).min(1) }),
  z.object({ action: z.literal('commit'), message: z.string().min(1), files: z.array(z.string().min(1)).optional() }),
  z.object({ action: z.literal('branch_create'), name: z.string().min(1), from: z.string().optional() }),
  z.object({ action: z.literal('branch_switch'), name: z.string().min(1) }),
  z.object({ action: z.literal('push'), remote: z.string().optional(), branch: z.string().optional() }),
])
export type GitActionArgs = z.infer<typeof GitActionArgsSchema>

/**
 * Settings gate threaded through ToolContext so gitAgentTool can decide
 * whether `commit` / `push` are allowed without extra round-trips to the
 * store — keeps the tool unit-testable with a plain object.
 */
export interface GitToolSettings {
  /** Allow `commit` to run without additional user confirmation. Default true. */
  autoAllowCommit: boolean
  /** Allow `push` to run without additional user confirmation. Default false. */
  autoAllowPush: boolean
  /** Allow `push` directly to main/master. Default false. */
  allowDirectPushToMain: boolean
}

export const DEFAULT_GIT_TOOL_SETTINGS: GitToolSettings = {
  autoAllowCommit: true,
  autoAllowPush: false,
  allowDirectPushToMain: false,
}
