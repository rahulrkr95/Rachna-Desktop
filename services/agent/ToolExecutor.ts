// services/agent/ToolExecutor.ts
// Executes tool calls against the ToolRegistry.
// Never throws — all failures become ToolFailure results so the agent
// loop can feed them back to the model as functionResponse parts.

import { getTool } from './ToolRegistry'
import type { ToolContext, ToolResult } from './types'

// Provider-agnostic function call shape
export interface ProviderFunctionCallInput {
  name: string
  args: Record<string, unknown>
}

// ── Args normalization (belt-and-suspenders) ─────────────────────────────────
//
// Tool args are supposed to already be a parsed object by the time they
// reach here (each provider is responsible for turning its own wire format
// into Record<string, unknown> — see lib/providers/*.ts). In practice,
// though, some models emit malformed function-call payloads (a bare JSON
// string like `"push"` instead of `{"action":"push"}`), and a provider-level
// parsing edge case can let that leak through as a raw string/array/etc.
// instead of an object. Rather than trust every call site upstream, we
// normalize right before execution so a tool's Zod schema always sees a
// real object — recovering automatically when the value is itself valid
// JSON for an object, and falling back to {} (which schemas will reject
// with a specific, actionable message) otherwise.
function normalizeArgs(name: string, rawArgs: unknown): Record<string, unknown> {
  if (rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>
  }

  if (typeof rawArgs === 'string') {
    // Try to recover — the string may itself be un-parsed JSON for an object.
    try {
      const parsed = JSON.parse(rawArgs)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        console.warn(`[ToolExecutor] "${name}" received args as a JSON string instead of an object — auto-parsed it.`)
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON at all — fall through to the warning + empty-object fallback below.
    }
  }

  console.warn(`[ToolExecutor] "${name}" received non-object args (${typeof rawArgs}) — falling back to {}.`)
  return {}
}

export interface ExecutedTool {
  name: string
  args: Record<string, unknown>
  label: string
  result: ToolResult
}

// ── Serial edit queue ────────────────────────────────────────────────────────
//
// When the agent batches multiple `propose_edit` calls to the SAME file in a
// single turn, each call must execute only after the previous one has fully
// completed — otherwise both reads hit the same stale disk content and the
// second patch applies against the wrong baseline.
//
// The queue is a Map<filePath, Promise<void>>. Each new propose_edit for a
// given path chains onto the tail of the existing promise so calls are
// strictly serialised per file. Calls to different files are unaffected and
// still run concurrently.
//
// The queue is module-level (session-scoped) which is intentional: it
// persists across agent turns so a slow async edit from turn N can't race
// with a fast edit from turn N+1 on the same file.

const editQueue = new Map<string, Promise<void>>()

/**
 * Enqueue `editFn` so that it only starts after any in-flight edit for
 * `filePath` has finished. Returns a promise that resolves to the same
 * value `editFn` returns.
 */
function queuedEdit<T>(filePath: string, editFn: () => Promise<T>): Promise<T> {
  const prev = editQueue.get(filePath) ?? Promise.resolve()

  // resultPromise resolves/rejects with editFn's value once the previous
  // edit completes. We wrap in a separate variable so the queue slot itself
  // never rejects (which would poison subsequent .then() chains).
  let resolveSlot!: () => void
  const slot = new Promise<void>(res => { resolveSlot = res })

  const resultPromise: Promise<T> = prev.then(() => editFn()).finally(resolveSlot)

  // Register the slot (not the result) as the next "tail" so a rejection in
  // editFn doesn't cause the next queued edit to see a rejected predecessor.
  editQueue.set(filePath, slot)

  return resultPromise
}

// ── Core execution helpers ───────────────────────────────────────────────────

export async function executeToolCall(
  rawCall: ProviderFunctionCallInput,
  ctx: ToolContext
): Promise<ExecutedTool> {
  // Normalize once, up front, so every branch below (and every tool's
  // Zod schema) always operates on a real object.
  const call: ProviderFunctionCallInput = {
    name: rawCall.name,
    args: normalizeArgs(rawCall.name, rawCall.args),
  }

  const tool = getTool(call.name)

  if (!tool) {
    return {
      name: call.name,
      args: call.args,
      label: `Calling ${call.name}…`,
      result: { ok: false, error: `Unknown tool: "${call.name}"` },
    }
  }

  const label = safeDescribe(tool, call.args)

  // `propose_edit` calls targeting the same file must be serialised so each
  // one reads the content that the previous edit left in the EditStore —
  // not the stale on-disk bytes that were current at call-site construction.
  if (call.name === 'propose_edit') {
    const filePath = (call.args.filePath ?? '') as string
    try {
      const result = await queuedEdit(filePath, () => tool.execute(call.args, ctx))
      return { name: call.name, args: call.args, label, result }
    } catch (err) {
      return {
        name: call.name,
        args: call.args,
        label,
        result: {
          ok: false,
          error: err instanceof Error ? err.message : `Tool "propose_edit" failed unexpectedly.`,
        },
      }
    }
  }

  // `batch_propose_edits` — serialise each file path in the batch independently,
  // then run the whole tool sequentially (it's already classified as SEQUENTIAL_ONLY
  // in AgentLoop, so it never races with other tool calls; we still queue per-file
  // in case a prior `propose_edit` on the same path is in flight).
  if (call.name === 'batch_propose_edits') {
    const edits = Array.isArray(call.args.edits) ? call.args.edits as Array<{ filePath?: string }> : []
    const filePaths = edits.map(e => (e.filePath ?? '') as string).filter(Boolean)
    try {
      // Chain all file paths so any in-flight edits for those files must finish first
      const chainedResult = await filePaths.reduce(
        (chain, fp) => chain.then(() => queuedEdit(fp, () => Promise.resolve())),
        Promise.resolve()
      ).then(() => tool.execute(call.args, ctx))
      return { name: call.name, args: call.args, label, result: chainedResult }
    } catch (err) {
      return {
        name: call.name,
        args: call.args,
        label,
        result: {
          ok: false,
          error: err instanceof Error ? err.message : `Tool "batch_propose_edits" failed unexpectedly.`,
        },
      }
    }
  }

  try {
    const result = await tool.execute(call.args, ctx)
    return { name: call.name, args: call.args, label, result }
  } catch (err) {
    return {
      name: call.name,
      args: call.args,
      label,
      result: {
        ok: false,
        error: err instanceof Error ? err.message : `Tool "${call.name}" failed unexpectedly.`,
      },
    }
  }
}

export async function executeToolCalls(
  calls: ProviderFunctionCallInput[],
  ctx: ToolContext
): Promise<ExecutedTool[]> {
  const results: ExecutedTool[] = []
  for (const call of calls) {
    results.push(await executeToolCall(call, ctx))
  }
  return results
}

/**
 * Clear the edit queue for a specific file path (or all files if no path
 * given). Useful in tests or when a project is closed.
 */
export function clearEditQueue(filePath?: string): void {
  if (filePath !== undefined) {
    editQueue.delete(filePath)
  } else {
    editQueue.clear()
  }
}

function safeDescribe(
  tool: { describeCall: (args: Record<string, unknown>) => string },
  args: Record<string, unknown>
): string {
  try {
    return tool.describeCall(args)
  } catch {
    return 'Running tool…'
  }
}
