// services/agent/AgentLoop.ts

import type { AIProvider, ChatOptions, ProviderFunctionDeclaration, ProviderMessage, ProviderAgentTurn } from '../../lib/providers/types'
import type { ChatIntent, AgentSubIntent } from '../../lib/intentClassifier'
// getToolNamesForIntent is re-exported by ToolRegistry.ts, but its actual
// (Intent, SubIntent) -> allowed-tool-names mapping lives in
// lib/intentRegistry.ts, paired there with the intent prompt the SAME
// pair resolves to (see IntentRegistry's file header) — this is the
// registry this authoritative, execution-time gate resolves through.
import { getToolDeclarations, getToolNamesForIntent } from './ToolRegistry'
import { executeToolCalls, type ExecutedTool } from './ToolExecutor'
import type { ToolContext, AgentActivity, ToolResult, GitSettingKey, AgentActivityArtifact } from './types'
import { GIT_SETTING_LABELS } from './types'
import { getMcpToolDeclarations, executeMcpTool, isMcpToolName } from './mcpTools'
import { getConnectorToolDeclarations, executeConnectorToolCall, isConnectorToolName } from '../connectors/IntentRouter'
import { loggedAgentTurn, loggedStream } from '../../lib/llmCallLogger'
import { pendingAttachmentsStore } from '../../lib/pendingAttachments'
import {
  createGateState,
  recordExecutedTools,
  needsForcedRound,
  hasUnresolvedAfterCap,
  runForcedVerificationRound,
  buildCapReachedNotice,
} from './verificationGate'

export interface AgentLoopCallbacks {
  onActivityStart: (activity: AgentActivity) => void
  onActivityEnd: (activityId: string, status: 'done' | 'error', resultSummary: string, artifact?: AgentActivityArtifact) => void
  /**
   * Fired repeatedly for an 'ai_call' activity (see AgentActivity.kind) as
   * the response streams in, so the AgentActivityPanel's "AI call" overlay
   * can show the answer live instead of only after the call finishes.
   */
  onAiCallUpdate: (activityId: string, response: string) => void
  onChunk: (chunk: string) => void
  onDone: (fullText: string) => void
  onBlockedSetting?: (settingKey: GitSettingKey, label: string) => void
  onError: (error: Error, resumeState?: unknown[]) => void
}

export interface AgentLoopOptions extends ChatOptions {
  maxIterations?: number
  intent?: ChatIntent
  subIntent?: AgentSubIntent
}

const DEFAULT_MAX_ITERATIONS = 50

/**
 * Produces the inspectable request shown by the chat's API-call chip.
 * This mirrors the complete provider-facing message list and tool declarations
 * passed to agentTurn(), while replacing image base64 with safe metadata so the
 * conversation transcript is not flooded with binary data.
 */
export function formatAiCallRequest(
  messages: ProviderMessage[],
  tools: ProviderFunctionDeclaration[] = [],
): string {
  const inspectableMessages = messages.map(message => ({
    role: message.role,
    content: message.content,
    ...(message.images?.length
      ? { images: message.images.map(image => ({ mimeType: image.mimeType, base64Bytes: image.base64.length })) }
      : {}),
  }))

  return JSON.stringify({
    messages: inspectableMessages,
    ...(tools.length ? { tools } : {}),
  }, null, 2)
}

/** Preserve the actual structured response returned by an agent/tool call. */
export function formatAgentTurnResponse(turn: ProviderAgentTurn): string {
  if (turn.functionCalls.length === 0) return turn.text
  return JSON.stringify({
    text: turn.text,
    functionCalls: turn.functionCalls,
  }, null, 2)
}
const PARALLEL_SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_codebase',
  'semantic_search_codebase',
  'get_diagnostics',
  'find_dependencies',
  'find_dependents',
  'trace_import_chain',
  'find_component_usage',
  'find_hook_usage',
  'curl_request',
  'browser_check',
  'web_search',
  'search_stackoverflow',
  'get_package_changelog',
])

const GIT_PARALLEL_SAFE_ACTIONS = new Set(['status', 'diff', 'log', 'branches'])

/**
 * Returns true when a tool call is safe to execute concurrently with other
 * parallel-safe calls. Pure read-only tools are always safe; git_action is
 * safe only for its read-only sub-actions (status/diff/log/branches).
 *
 * Exported so callers can test the classification in isolation.
 */
export function isParallelSafe(name: string, args: Record<string, unknown>): boolean {
  if (PARALLEL_SAFE_TOOLS.has(name)) return true
  if (name === 'git_action') {
    const action = typeof args?.action === 'string' ? args.action : ''
    return GIT_PARALLEL_SAFE_ACTIONS.has(action)
  }
  return false
}

// ── Batch builder ─────────────────────────────────────────────────────────────

interface CallBatch {
  calls: Array<{ name: string; args: Record<string, unknown> }>
  /** True when every call in this batch is parallel-safe and may run concurrently. */
  parallel: boolean
}

/**
 * Groups consecutive parallel-safe calls into batches that can run with
 * Promise.all. Any sequential-only call becomes a singleton batch.
 *
 * Example:
 *   [read_file, read_file, run_terminal_command, read_file]
 *   → [{parallel:true, calls:[read_file, read_file]},
 *      {parallel:false, calls:[run_terminal_command]},
 *      {parallel:true, calls:[read_file]}]
 */
function buildBatches(
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>
): CallBatch[] {
  const batches: CallBatch[] = []

  for (const call of functionCalls) {
    const safe = isParallelSafe(call.name, call.args)
    const last = batches[batches.length - 1]

    if (last && last.parallel && safe) {
      // Extend the current parallel batch
      last.calls.push(call)
    } else {
      batches.push({ calls: [call], parallel: safe })
    }
  }

  return batches
}

/**
 * Runs the agent loop for a single user turn using any AIProvider.
 *
 * `messages` should be in the provider's internal format (use
 * provider.toInternalMessages() to convert from ProviderMessage[]).
 */
export async function runAgentLoop(
  provider: AIProvider,
  apiKey: string,
  messages: unknown[],
  ctx: ToolContext,
  callbacks: AgentLoopCallbacks,
  opts: AgentLoopOptions = {}
): Promise<void> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS

  const entitledIntent = opts.intent
  const entitledSubIntent = opts.subIntent
  // Merge built-in tools with any live MCP server tools — MCP set is
  // re-evaluated each turn so newly connected servers are reflected immediately.
  const toolNames = getToolNamesForIntent(entitledIntent, entitledSubIntent)
  // MCP tool schemas are intentionally disclosed only to the executor step
  // that the approved planner classified as MCP_TASK. Other agentic intents
  // must not receive the connected server catalog merely because MCP happens
  // to be configured.
  const connectorTools = entitledIntent !== 'mcp_task' ? [] : await getConnectorToolDeclarations()
  const tools: ProviderFunctionDeclaration[] = [
    ...getToolDeclarations(toolNames),
    ...(entitledIntent !== 'mcp_task' ? [] : getMcpToolDeclarations()),
    ...connectorTools,
  ]
  const conversation: unknown[] = [...messages]
  if (tools.length > 0 && provider.supportsToolCalling?.() === false) {
    callbacks.onError(
      new Error(`${provider.displayName} does not currently support agent tools. Select a tool-capable direct provider for this action.`),
      conversation,
    )
    return
  }
  const signal = opts.signal
  // UX-001 — Agent Execution Timeline: tracks consecutive same-tool attempts
  // across iterations of the loop below so the timeline can show "Retry 2"
  // style badges instead of silently repeating a step that just failed.
  // Keyed by tool name; reset to 1 on success, incremented on error.
  const retryTracker = new Map<string, number>()

  // ── Enforced Agent Verification Loop ─────────────────────────────────────
  // Tracks file changes made during this turn and forces a deterministic
  // verification round (diagnostics/build/lint/test) before the model is
  // allowed to finalize. See ./verificationGate.ts for the full design.
  const gate = createGateState()

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal?.aborted) return

      // ── AI call activity (agent log flair chip) ────────────────────────
      const requestMessages = provider.fromInternalMessages(conversation)
      const aiCallId = `ai-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      callbacks.onActivityStart({
        id: aiCallId,
        tool: 'ai_call',
        label: iteration === 0 ? 'Analyzing your request' : 'Reviewing results & deciding next step',
        args: {},
        status: 'running',
        kind: 'ai_call',
        aiCall: {
          providerName: provider.displayName,
          model: opts.model,
          prompt: formatAiCallRequest(requestMessages, tools),
          systemInstruction: opts.systemInstruction,
          response: '',
        },
      })

      let turn: Awaited<ReturnType<typeof provider.agentTurn>>
      const pendingAttachments = pendingAttachmentsStore.getAll()
      const turnOpts = pendingAttachments.length > 0 ? { ...opts, attachments: pendingAttachments } : opts
      try {
        turn = await loggedAgentTurn('agent_reasoning', provider, apiKey, conversation, tools, turnOpts, iteration)
      } catch (err) {
        callbacks.onActivityEnd(aiCallId, 'error', err instanceof Error ? err.message : String(err))
        throw err
      } finally {
        // Attachments are single-use — queued for exactly the request that
        // just ran (success or failure), never silently resent on retry/next
        // iteration.
        if (pendingAttachments.length > 0) pendingAttachmentsStore.clear()
      }

      if (signal?.aborted) return

      {
        const responseText = formatAgentTurnResponse(turn)
        callbacks.onAiCallUpdate(aiCallId, responseText)
        callbacks.onActivityEnd(aiCallId, 'done', turn.functionCalls.length ? `${turn.functionCalls.length} tool call(s)` : 'done')
      }


      if (turn.functionCalls.length === 0) {
        // The model wants to end its turn. If it changed any files since the
        // last verification round, do NOT stream the final answer yet —
        // deterministically run diagnostics/build/lint/test ourselves and
        // force another iteration so the model has to respond to real
        // results instead of assuming its edit worked.
        const projectRoot = ctx.projectRoot
        if (projectRoot && needsForcedRound(gate)) {
          const report = await runForcedVerificationRound(gate, projectRoot, ctx)

          const gateActivityId = `verification-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          callbacks.onActivityStart({
            id: gateActivityId,
            tool: 'verification_gate',
            label: `Enforced verification — round ${report.round} (${report.changedFiles.length} file(s) changed)…`,
            args: { changedFiles: report.changedFiles },
            status: 'running',
          })
          callbacks.onActivityEnd(
            gateActivityId,
            report.overallOk ? 'done' : 'error',
            report.outcomes.map(o => `${o.label}: ${o.status}`).join(' · ')
          )

          // Keep the model's premature "final" turn in history for
          // continuity, then inject the verification report as a new user
          // turn so the next agentTurn() call sees it immediately.
          conversation.push(turn.modelTurn)
          conversation.push(...provider.toInternalMessages([{ role: 'user', content: report.markdown }]))
          continue
        }

        if (projectRoot && hasUnresolvedAfterCap(gate)) {
          // Safety net: the change set never settled after MAX_FORCED_ROUNDS
          // rounds. Don't loop forever — let the model finalize, but force a
          // visible disclosure into the context first.
          conversation.push(turn.modelTurn)
          conversation.push(...provider.toInternalMessages([{ role: 'user', content: buildCapReachedNotice(gate) }]))
          gate.pendingFiles.clear()
          continue
        }

        // Final turn — stream it
        await streamFinalAnswer(provider, apiKey, conversation, turn.text, callbacks, opts)
        return
      }

      // Append model's tool-call message to internal history
      const historyWithModel = [...conversation, turn.modelTurn]

      // Execute tools
      const executed = await executeWithActivity(turn.functionCalls, ctx, callbacks, signal, retryTracker)
      if (signal?.aborted) return

      // ── Enforced verification bookkeeping ─────────────────────────────────
      // Record which files were just changed (or whether verification was
      // explicitly skipped) so the finalize check above has up-to-date state.
      recordExecutedTools(gate, executed)

      // ── Settings-gated git safety check ─────────────────────────────────
      // If any tool call in this batch was blocked by a Settings → Git
      // toggle, surface it once so the UI can offer a direct "enable &
      // retry" affordance instead of the agent having to ask in prose and
      // the user having to reply in prose (the source of the follow-up
      // context-loss bug — see onBlockedSetting's doc comment).
      if (callbacks.onBlockedSetting) {
        for (const e of executed) {
          if (!e.result.ok && e.result.blockedSetting) {
            callbacks.onBlockedSetting(e.result.blockedSetting, GIT_SETTING_LABELS[e.result.blockedSetting])
            break
          }
        }
      }

      // Append tool results — format depends on provider
      const results = executed.map(e => ({
        name: e.name,
        result: e.result.ok
          ? { result: e.result.data as Record<string, unknown> }
          : { error: e.result.error },
      }))

      const newHistory = provider.appendToolResults(historyWithModel, turn.modelTurn, results)
      conversation.length = 0
      conversation.push(...newHistory)

      // ── User-denied permission prompt: pause here ─────────────────────────
      // A denied terminal command / system / desktop-control action isn't an
      // ordinary tool error the model should paper over by trying something
      // else — the user explicitly said no. Stop the turn right at this step
      // (same "Continue from failed step" resumable-error path a hard
      // failure takes) instead of feeding the denial back in and letting the
      // model attempt a workaround on its own.
      if (!signal?.aborted) {
        for (const e of executed) {
          if (!e.result.ok && e.result.permissionDenied) {
            callbacks.onError(new Error(e.result.error), conversation)
            return
          }
        }
      }
    }

    if (!signal?.aborted) {
      callbacks.onError(
        new Error(`Agent loop exceeded ${maxIterations} iterations without a final answer.`),
        conversation
      )
    }
  } catch (err) {
    if (provider.isAbortError(err)) return
    // `conversation` reflects every iteration that completed successfully
    // before this failure — e.g. all prior tool calls/results are already
    // appended. Hand it back so the caller can offer a "Continue" / "Retry"
    // action that resumes here instead of re-running the whole turn.
    //
    // Always pass it back — even when nothing progressed yet (the very
    // first LLM call of the turn failed, e.g. a transient network error or
    // timeout) — so the user always has a retry affordance and can use it
    // repeatedly. When nothing progressed, `conversation` is equivalent to
    // `messages`, so retrying just re-issues the same call rather than
    // resuming mid-turn — but the user should never be left with a dead
    // end and no way to retry a failed step.
    callbacks.onError(err instanceof Error ? err : new Error(String(err)), conversation)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Executes a list of function calls with activity lifecycle notifications.
 *
 * Scheduling strategy:
 * - Consecutive parallel-safe calls are batched and executed with Promise.all.
 *   onActivityStart fires for ALL calls in a batch before any is awaited, so
 *   the UI shows all of them as "running" simultaneously. onActivityEnd fires
 *   individually as each promise resolves — the UI reflects real progress
 *   rather than waiting for the slowest sibling.
 * - Sequential-only calls (mutating tools) run alone: start → await → end.
 *   They never overlap with any neighbour.
 * - signal.aborted is checked before each batch. Calls already in-flight
 *   within a batch complete naturally; new batches are skipped with a
 *   "Cancelled" placeholder.
 * - Output order always matches input order regardless of resolve order.
 */
async function executeWithActivity(
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>,
  ctx: ToolContext,
  callbacks: AgentLoopCallbacks,
  signal?: AbortSignal,
  retryTracker: Map<string, number> = new Map()
): Promise<ExecutedTool[]> {
  const batches = buildBatches(functionCalls)
  const results: ExecutedTool[] = []

  for (const batch of batches) {
    // Check abort before kicking off a new batch.
    // Calls already in-flight within a batch complete naturally.
    if (signal?.aborted) {
      for (const call of batch.calls) {
        results.push({
          name: call.name,
          args: call.args,
          label: `Cancelled ${call.name}`,
          result: { ok: false, error: 'Cancelled by user' },
        })
      }
      continue
    }

    if (batch.parallel) {
      // ── Parallel batch ───────────────────────────────────────────────────
      // 1. Assign stable IDs for all calls before any I/O starts.
      // 2. Fire onActivityStart for ALL calls immediately — the UI sees them
      //    all as "running" before any individual promise is awaited.
      // 3. Promise.all preserves input order: batchResults[i] corresponds to
      //    batch.calls[i] regardless of which promise resolves first.
      // 4. Each promise fires onActivityEnd as soon as it individually resolves.
      //    executeToolCalls / executeMcpTool never throw — they return
      //    {ok:false, error} — so Promise.all is safe without allSettled.

      const activityIds = batch.calls.map(
        call => `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      )

      // Fire all starts before awaiting anything
      for (let i = 0; i < batch.calls.length; i++) {
        const call = batch.calls[i]
        const attempt = retryTracker.get(call.name) ?? 1
        callbacks.onActivityStart({
          id: activityIds[i],
          tool: call.name,
          label: describeBeforeExecution(call),
          args: call.args,
          status: 'running',
          ...(attempt > 1 ? { attempt } : {}),
        })
      }

      const batchResults = await Promise.all(
        batch.calls.map(async (call, i): Promise<ExecutedTool> => {
          let executed: ExecutedTool

          if (isConnectorToolName(call.name)) {
            const result = await executeConnectorToolCall(call.name, call.args)
            executed = {
              name: call.name,
              args: call.args,
              label: describeBeforeExecution(call),
              result,
            }
          } else if (isMcpToolName(call.name)) {
            const result = await executeMcpTool(call.name, call.args)
            executed = {
              name: call.name,
              args: call.args,
              label: describeBeforeExecution(call),
              result,
            }
          } else {
            const [res] = await executeToolCalls([call], ctx)
            executed = res
          }

          // Fire end as soon as this individual call resolves — don't wait
          // for the rest of the batch.
          if (executed.result.ok) {
            retryTracker.delete(call.name)
          } else {
            retryTracker.set(call.name, (retryTracker.get(call.name) ?? 1) + 1)
          }
          callbacks.onActivityEnd(
            activityIds[i],
            executed.result.ok ? 'done' : 'error',
            summarizeResult(executed.result, executed.name),
            extractActivityArtifact(executed.result, executed.name)
          )

          return executed
        })
      )

      // batchResults is already in input order (Promise.all guarantee)
      results.push(...batchResults)
    } else {
      // ── Sequential call ──────────────────────────────────────────────────
      // Exactly one call per sequential batch. Keep the original
      // start → await → end behaviour.

      const call = batch.calls[0]
      const activityId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const attempt = retryTracker.get(call.name) ?? 1

      callbacks.onActivityStart({
        id: activityId,
        tool: call.name,
        label: describeBeforeExecution(call),
        args: call.args,
        status: 'running',
        ...(attempt > 1 ? { attempt } : {}),
      })

      let executed: ExecutedTool
      if (isConnectorToolName(call.name)) {
        const result = await executeConnectorToolCall(call.name, call.args)
        executed = {
          name: call.name,
          args: call.args,
          label: describeBeforeExecution(call),
          result,
        }
      } else if (isMcpToolName(call.name)) {
        const result = await executeMcpTool(call.name, call.args)
        executed = {
          name: call.name,
          args: call.args,
          label: describeBeforeExecution(call),
          result,
        }
      } else {
        const [res] = await executeToolCalls([call], ctx)
        executed = res
      }
      results.push(executed)

      if (executed.result.ok) {
        retryTracker.delete(call.name)
      } else {
        retryTracker.set(call.name, attempt + 1)
      }

      callbacks.onActivityEnd(
        activityId,
        executed.result.ok ? 'done' : 'error',
        summarizeResult(executed.result, executed.name),
        extractActivityArtifact(executed.result, executed.name)
      )
    }
  }

  return results
}

function describeBeforeExecution(call: { name: string; args: Record<string, unknown> }): string {
  const path  = call.args?.path
  const query = call.args?.query
  if (call.name === 'read_file' && typeof path === 'string') return `Reading ${path}…`
  if (call.name === 'list_directory' && typeof path === 'string') {
    return `Listing ${path === '.' ? 'project root' : path}…`
  }
  if (call.name === 'search_codebase' && typeof query === 'string') {
    return `Searching codebase for "${query}"…`
  }
  if (call.name === 'get_diagnostics') {
    const p = call.args?.path
    return typeof p === 'string' ? `Checking diagnostics for ${p}…` : 'Checking diagnostics…'
  }
  if (call.name === 'propose_edit') {
    const fp = call.args?.filePath
    return typeof fp === 'string' ? `Proposing edit to ${fp}…` : 'Proposing edit…'
  }
  if (call.name === 'create_file') {
    const fp = call.args?.filePath
    return typeof fp === 'string' ? `Creating ${fp}…` : 'Creating file…'
  }
  if (call.name === 'rename_file') {
    const op = call.args?.oldPath
    const np = call.args?.newPath
    return typeof op === 'string' && typeof np === 'string'
      ? `Renaming ${op} → ${np}…`
      : 'Renaming file…'
  }
  if (call.name === 'delete_file') {
    const fp = call.args?.filePath
    return typeof fp === 'string' ? `Deleting ${fp}…` : 'Deleting file…'
  }
  if (call.name === 'copy_file') {
    const sp = call.args?.sourcePath
    const dp = call.args?.destinationPath
    return typeof sp === 'string' && typeof dp === 'string'
      ? `Copying ${sp} → ${dp}…`
      : 'Copying file…'
  }
  if (call.name === 'copy_folder') {
    const sp = call.args?.sourcePath
    const dp = call.args?.destinationPath
    return typeof sp === 'string' && typeof dp === 'string'
      ? `Copying folder ${sp} → ${dp}…`
      : 'Copying folder…'
  }
  if (call.name === 'move_folder') {
    const op = call.args?.oldPath
    const np = call.args?.newPath
    return typeof op === 'string' && typeof np === 'string'
      ? `Moving folder ${op} → ${np}…`
      : 'Moving folder…'
  }
  if (call.name === 'delete_folder') {
    const fp = call.args?.folderPath
    return typeof fp === 'string' ? `Deleting folder ${fp}…` : 'Deleting folder…'
  }
  if (call.name === 'create_folder') {
    const fp = call.args?.folderPath
    return typeof fp === 'string' ? `Creating folder ${fp}…` : 'Creating folder…'
  }
  if (call.name === 'run_terminal_command') {
    const label = call.args?.label
    return typeof label === 'string' && label.trim()
      ? label.trim()
      : 'Running terminal command'
  }
  if (call.name === 'manage_todos') {
    const action = call.args?.action
    if (action === 'write') {
      const n = Array.isArray(call.args?.todos) ? call.args.todos.length : 0
      return `Writing plan (${n} step${n === 1 ? '' : 's'})…`
    }
    if (action === 'update_status') return `Updating todo "${call.args?.id ?? ''}" → ${call.args?.status ?? ''}…`
    if (action === 'read') return 'Reading current plan…'
    return 'Managing plan…'
  }
  if (call.name === 'git_action') {
    const action = call.args?.action
    if (action === 'status')        return 'Checking git status…'
    if (action === 'diff')          return call.args?.filePath ? `Diffing ${call.args.filePath}…` : 'Getting diff…'
    if (action === 'stage')         return `Staging ${Array.isArray(call.args?.files) ? (call.args.files as string[]).join(', ') : '…'}`
    if (action === 'commit')        return `Committing: "${call.args?.message ?? '…'}"`
    if (action === 'branch_create') return `Creating branch "${call.args?.name ?? '…'}"…`
    if (action === 'branch_switch') return `Switching to "${call.args?.name ?? '…'}"…`
    if (action === 'push')          return `Pushing${call.args?.branch ? ` "${call.args.branch}"` : ''}…`
    return 'Running git action…'
  }
  if (call.name === 'skip_verification') {
    const reason = call.args?.reason
    return typeof reason === 'string' ? `Requesting verification skip: ${reason}…` : 'Requesting verification skip…'
  }
  return `Calling ${call.name}…`
}

function isFileNotFoundError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('does not exist') || lower.includes('file not found')
}


function extractActivityArtifact(result: ToolResult, toolName?: string): AgentActivityArtifact | undefined {
  if (!result.ok || toolName !== 'take_screenshot') return undefined
  const data = result.data as Record<string, unknown>
  if (typeof data?.path !== 'string' || typeof data?.width !== 'number' || typeof data?.height !== 'number') {
    return undefined
  }
  return {
    type: 'screenshot',
    path: data.path,
    width: data.width,
    height: data.height,
    monitor: typeof data.monitor === 'string' ? data.monitor : undefined,
    monitorIndex: typeof data.monitorIndex === 'number' ? data.monitorIndex : undefined,
    monitorCount: typeof data.monitorCount === 'number' ? data.monitorCount : undefined,
  }
}

function summarizeResult(result: ToolResult, toolName?: string): string {
  if (!result.ok) {
    if (toolName === 'read_file' && isFileNotFoundError(result.error)) {
      return result.error
    }
    return `Tool Error: ${result.error}`
  }

  // ── Terminal command result ────────────────────────────────────────────────
  if (toolName === 'run_terminal_command') {
    const data = result.data as Record<string, unknown> | undefined
    if (!data) return 'done'
    const exitCode = data.exitCode
    const duration = data.durationMs
    const timedOut = data.timedOut
    const success  = data.success

    if (timedOut) return `⏱ timed out (${duration}ms)`
    if (success)  return `✓ exit code ${exitCode} (${duration}ms)`
    return `⚠ exit code ${exitCode} (${duration}ms)`
  }

  const data = result.data as Record<string, unknown>
  if (toolName === 'take_screenshot' && typeof data?.path === 'string') return 'screenshot captured'
  if (typeof data?.sizeWarning === 'string' && data.sizeWarning) {
    return `⚠ possible content loss — review diff carefully`
  }
  if (Array.isArray(data?.entries)) return `${data.entries.length} item(s) found`
  if (data?.chunks !== undefined || data?.symbols !== undefined) {
    const chunks  = Array.isArray(data.chunks)  ? data.chunks.length  : 0
    const symbols = Array.isArray(data.symbols) ? data.symbols.length : 0
    return `${chunks} chunk(s), ${symbols} symbol(s) found`
  }
  if (typeof data?.content === 'string') return `${data.content.length} chars`
  if (Array.isArray(data?.diagnostics)) return `${data.diagnostics.length} diagnostic(s)`
  return 'done'
}

async function streamFinalAnswer(
  provider: AIProvider,
  apiKey: string,
  conversation: unknown[],
  fallbackText: string,
  callbacks: AgentLoopCallbacks,
  opts: AgentLoopOptions
): Promise<void> {
  // Convert internal history to ProviderMessage[] for streaming
  const messages = provider.fromInternalMessages(conversation)
  const signal = opts.signal
  let receivedAny = false

  // ── AI call activity (agent log flair chip) ─────────────────────────────
  const aiCallId = `ai-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  callbacks.onActivityStart({
    id: aiCallId,
    tool: 'ai_call',
    label: 'Generating final response',
    args: {},
    status: 'running',
    kind: 'ai_call',
    aiCall: {
      providerName: provider.displayName,
      model: opts.model,
      prompt: formatAiCallRequest(messages),
      systemInstruction: opts.systemInstruction,
      response: '',
    },
  })
  let accumulatedResponse = ''

  const pendingAttachments = pendingAttachmentsStore.getAll()
  const streamOpts = pendingAttachments.length > 0 ? { ...opts, attachments: pendingAttachments } : opts

  try {
    await loggedStream(
    'final_response',
    provider,
    apiKey,
    messages,
    {
      onChunk: (chunk) => {
        if (signal?.aborted) return
        receivedAny = true
        accumulatedResponse += chunk
        callbacks.onAiCallUpdate(aiCallId, accumulatedResponse)
        callbacks.onChunk(chunk)
      },
      onDone: (fullText) => {
        if (signal?.aborted) return
        if (!receivedAny && !fullText && fallbackText) {
          // The API returned no response text. The earlier agent-turn text is
          // still used to keep the visible chat reply intact, but it must not
          // be misrepresented in the inspector as this API call's response.
          callbacks.onAiCallUpdate(aiCallId, '')
          callbacks.onActivityEnd(aiCallId, 'done', 'done')
          callbacks.onChunk(fallbackText)
          callbacks.onDone(fallbackText)
        } else {
          callbacks.onAiCallUpdate(aiCallId, fullText || accumulatedResponse)
          callbacks.onActivityEnd(aiCallId, 'done', 'done')
          callbacks.onDone(fullText)
        }
      },
      onError: (err) => {
        if (signal?.aborted) return
        if (fallbackText) {
          callbacks.onAiCallUpdate(aiCallId, fallbackText)
          callbacks.onActivityEnd(aiCallId, 'done', 'done')
          callbacks.onChunk(fallbackText)
          callbacks.onDone(fallbackText)
        } else {
          callbacks.onActivityEnd(aiCallId, 'error', err.message)
          callbacks.onError(err)
        }
      },
    },
    streamOpts
    )
  } finally {
    if (pendingAttachments.length > 0) pendingAttachmentsStore.clear()
  }
}
