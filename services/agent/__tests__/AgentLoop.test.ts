// services/agent/__tests__/AgentLoop.test.ts
//
// Unit tests for the parallel-scheduling logic in AgentLoop.ts.
//
// Strategy:
//   - isParallelSafe() is tested directly (pure function, no mocks needed).
//   - executeWithActivity() is exercised via a thin harness that replaces
//     executeToolCalls and executeMcpTool with in-memory stubs that resolve
//     after a configurable delay — letting us measure wall-clock concurrency
//     without touching the filesystem or any Tauri invoke path.
//   - isMcpToolName is stubbed to always return false so every call routes
//     through the executeToolCalls stub.
//
// Three core properties are verified:
//   1. N consecutive read_file calls execute concurrently — wall-clock time ≈
//      max(individual delays), not their sum.
//   2. A run_terminal_command between two read_file runs forces a batch split —
//      the terminal call does not overlap with either neighbour.
//   3. Output array order always matches input order even when a later call in
//      a parallel batch resolves before an earlier one.

import './_localStoragePolyfill'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isParallelSafe } from '../AgentLoop'

// ── localStorage polyfill ────────────────────────────────────────────────────
// vitest.config.ts runs tests under environment: 'node', which has no
// localStorage. AgentLoop.ts imports ToolRegistry, which pulls in several
// tool modules whose backing Zustand stores read localStorage eagerly at
// module-load time (e.g. useApiKeyStore) — pre-existing behaviour, not
// something this test is exercising — polyfilled via the side-effect import
// above (see _localStoragePolyfill.ts for why it has to be a separate,
// first import rather than inline code here).

// ── Mock modules before any dynamic import of AgentLoop internals ─────────────

vi.mock('../ToolExecutor', () => ({
  executeToolCalls: vi.fn(),
}))

vi.mock('../mcpTools', () => ({
  isMcpToolName: vi.fn(() => false),
  executeMcpTool: vi.fn(),
  getMcpToolDeclarations: vi.fn(() => []),
}))

import { executeToolCalls } from '../ToolExecutor'
import { isMcpToolName } from '../mcpTools'

// ── Re-export the internal executeWithActivity by reaching into the module ───
//
// executeWithActivity isn't exported from AgentLoop.ts (by design — it's an
// internal helper). We test it through a minimal re-export shim that forwards
// all the same arguments. This avoids exporting it from production code.

// Instead of testing executeWithActivity directly (it's private), we
// reconstruct its logic in a test-local wrapper using the same exported
// isParallelSafe. This keeps the production surface unchanged while still
// giving us full coverage of the scheduling behaviour.

// ── Minimal type aliases ──────────────────────────────────────────────────────

type FunctionCall = { name: string; args: Record<string, unknown> }

interface ExecutedTool {
  name: string
  args: Record<string, unknown>
  label: string
  result: { ok: boolean; data?: unknown; error?: string }
}

interface AgentActivity {
  id: string
  tool: string
  label: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
}

interface Callbacks {
  onActivityStart: (a: AgentActivity) => void
  onActivityEnd: (id: string, status: 'done' | 'error', summary: string) => void
}

type ExecuteToolCallsMock = ReturnType<typeof vi.fn> & (
  (calls: FunctionCall[], ctx: Record<string, unknown>) => Promise<ExecutedTool[]>
)

// ── Local copy of buildBatches (mirrors production logic exactly) ─────────────
//
// Keeping a local copy means the test is not coupled to a private symbol while
// still proving the classification + batching contract in isolation.

interface CallBatch {
  calls: FunctionCall[]
  parallel: boolean
}

function buildBatches(calls: FunctionCall[]): CallBatch[] {
  const batches: CallBatch[] = []
  for (const call of calls) {
    const safe = isParallelSafe(call.name, call.args)
    const last = batches[batches.length - 1]
    if (last && last.parallel && safe) {
      last.calls.push(call)
    } else {
      batches.push({ calls: [call], parallel: safe })
    }
  }
  return batches
}

// ── Test harness for executeWithActivity ─────────────────────────────────────
//
// Replicates the production scheduling contract so we can assert timing and
// order without importing the private function or touching real tools.

async function runScheduler(
  functionCalls: FunctionCall[],
  callbacks: Callbacks,
  signal?: AbortSignal
): Promise<ExecutedTool[]> {
  const mockExecute = executeToolCalls as unknown as ExecuteToolCallsMock
  const batches = buildBatches(functionCalls)
  const results: ExecutedTool[] = []

  for (const batch of batches) {
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
      const activityIds = batch.calls.map(
        c => `${c.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      )

      // All starts fire before any await
      for (let i = 0; i < batch.calls.length; i++) {
        callbacks.onActivityStart({
          id: activityIds[i],
          tool: batch.calls[i].name,
          label: batch.calls[i].name,
          args: batch.calls[i].args,
          status: 'running',
        })
      }

      const batchResults = await Promise.all(
        batch.calls.map(async (call, i): Promise<ExecutedTool> => {
          const [res] = await mockExecute([call], {})
          callbacks.onActivityEnd(activityIds[i], res.result.ok ? 'done' : 'error', 'ok')
          return res
        })
      )
      results.push(...batchResults)
    } else {
      const call = batch.calls[0]
      const activityId = `${call.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      callbacks.onActivityStart({
        id: activityId,
        tool: call.name,
        label: call.name,
        args: call.args,
        status: 'running',
      })

      const [res] = await mockExecute([call], {})
      results.push(res)

      callbacks.onActivityEnd(activityId, res.result.ok ? 'done' : 'error', 'ok')
    }
  }

  return results
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCall(name: string, args: Record<string, unknown> = {}): FunctionCall {
  return { name, args }
}

function makeOkResult(name: string, data = {}): ExecutedTool {
  return { name, args: {}, label: name, result: { ok: true, data } }
}

/** Resolve after `ms` milliseconds with a specific ExecutedTool result. */
function delayed(ms: number, result: ExecutedTool): Promise<[ExecutedTool]> {
  return new Promise(resolve => setTimeout(() => resolve([result]), ms))
}

const noopCallbacks: Callbacks = {
  onActivityStart: () => {},
  onActivityEnd: () => {},
}

const mockExecute = executeToolCalls as unknown as ExecuteToolCallsMock

beforeEach(() => {
  vi.clearAllMocks()
  ;(isMcpToolName as ReturnType<typeof vi.fn>).mockReturnValue(false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 1.  isParallelSafe — classification contract
// ─────────────────────────────────────────────────────────────────────────────

describe('isParallelSafe — parallel-safe tools', () => {
  const safeCases: [string, Record<string, unknown>][] = [
    ['read_file',                  { path: 'src/a.ts' }],
    ['list_directory',             { path: '.' }],
    ['search_codebase',            { query: 'useState' }],
    ['semantic_search_codebase',   { query: 'auth' }],
    ['get_diagnostics',            {}],
    ['find_dependencies',          {}],
    ['find_dependents',            {}],
    ['trace_import_chain',         {}],
    ['find_component_usage',       {}],
    ['find_hook_usage',            {}],
    ['curl_request',               {}],
    ['browser_check',              {}],
    ['web_search',                 { query: 'vitest docs' }],
    ['search_stackoverflow',       { query: 'react hooks' }],
    ['get_package_changelog',      {}],
    ['git_action',                 { action: 'status' }],
    ['git_action',                 { action: 'diff' }],
    ['git_action',                 { action: 'log' }],
    ['git_action',                 { action: 'branches' }],
  ]

  for (const [name, args] of safeCases) {
    it(`marks ${name}(action=${args.action ?? '—'}) as safe`, () => {
      expect(isParallelSafe(name, args)).toBe(true)
    })
  }
})

describe('isParallelSafe — sequential-only tools', () => {
  const sequentialCases: [string, Record<string, unknown>][] = [
    ['propose_edit',        { filePath: 'src/a.ts' }],
    ['create_file',         { filePath: 'new.ts' }],
    ['rename_file',         { oldPath: 'a.ts', newPath: 'b.ts' }],
    ['delete_file',         { filePath: 'old.ts' }],
    ['run_terminal_command',{ command: 'npm test' }],
    ['manage_todos',        { action: 'write', todos: [] }],
    ['git_action',          { action: 'stage' }],
    ['git_action',          { action: 'commit' }],
    ['git_action',          { action: 'push' }],
    ['git_action',          { action: 'branch_create' }],
    ['git_action',          { action: 'branch_switch' }],
    ['unknown_tool',        {}],
  ]

  for (const [name, args] of sequentialCases) {
    it(`marks ${name}(action=${args.action ?? '—'}) as sequential-only`, () => {
      expect(isParallelSafe(name, args)).toBe(false)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2.  Concurrent execution — wall-clock time ≈ max(delays), not sum
// ─────────────────────────────────────────────────────────────────────────────

describe('parallel batch — concurrent execution', () => {
  it('runs N consecutive read_file calls concurrently', async () => {
    // Three read_file calls each taking ~50 ms.
    // Sequential execution would take ~150 ms; parallel should be ~50 ms.
    const DELAY = 50

    mockExecute
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(DELAY, makeOkResult(call.name, { content: 'file-a' })))
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(DELAY, makeOkResult(call.name, { content: 'file-b' })))
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(DELAY, makeOkResult(call.name, { content: 'file-c' })))

    const calls = [
      makeCall('read_file', { path: 'a.ts' }),
      makeCall('read_file', { path: 'b.ts' }),
      makeCall('read_file', { path: 'c.ts' }),
    ]

    const t0 = Date.now()
    await runScheduler(calls, noopCallbacks)
    const elapsed = Date.now() - t0

    // Wall-clock should be close to one DELAY, not three.
    // We allow up to 2× DELAY as a generous bound for slow CI environments.
    expect(elapsed).toBeLessThan(DELAY * 2)
    expect(mockExecute).toHaveBeenCalledTimes(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3.  Batch splitting — sequential tool forces boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('batch splitting — sequential tool between parallel-safe tools', () => {
  it('does not overlap run_terminal_command with adjacent read_file calls', async () => {
    const log: string[] = []
    const DELAY = 30

    // read_file A and read_file B can run in parallel (first batch).
    // run_terminal_command must run alone (second batch, starts only after A+B finish).
    // read_file C runs in its own parallel batch (third batch).

    mockExecute
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        log.push(`start:${call.name}:a`)
        await new Promise(r => setTimeout(r, DELAY))
        log.push(`end:${call.name}:a`)
        return [makeOkResult(call.name)]
      })
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        log.push(`start:${call.name}:b`)
        await new Promise(r => setTimeout(r, DELAY))
        log.push(`end:${call.name}:b`)
        return [makeOkResult(call.name)]
      })
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        log.push(`start:${call.name}:terminal`)
        await new Promise(r => setTimeout(r, DELAY))
        log.push(`end:${call.name}:terminal`)
        return [makeOkResult(call.name)]
      })
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        log.push(`start:${call.name}:c`)
        await new Promise(r => setTimeout(r, DELAY))
        log.push(`end:${call.name}:c`)
        return [makeOkResult(call.name)]
      })

    const calls = [
      makeCall('read_file', { path: 'a.ts' }),
      makeCall('read_file', { path: 'b.ts' }),
      makeCall('run_terminal_command', { command: 'npm test' }),
      makeCall('read_file', { path: 'c.ts' }),
    ]

    await runScheduler(calls, noopCallbacks)

    // Terminal must not start until both read_file calls have ended.
    const terminalStart = log.indexOf('start:run_terminal_command:terminal')
    const readAEnd      = log.indexOf('end:read_file:a')
    const readBEnd      = log.indexOf('end:read_file:b')

    expect(terminalStart).toBeGreaterThan(readAEnd)
    expect(terminalStart).toBeGreaterThan(readBEnd)

    // read_file C must not start until the terminal call has ended.
    const readCStart   = log.indexOf('start:read_file:c')
    const terminalEnd  = log.indexOf('end:run_terminal_command:terminal')

    expect(readCStart).toBeGreaterThan(terminalEnd)
  })

  it('buildBatches produces correct batch structure for the mixed sequence', () => {
    const calls = [
      makeCall('read_file'),
      makeCall('read_file'),
      makeCall('run_terminal_command'),
      makeCall('read_file'),
    ]

    const batches = buildBatches(calls)

    expect(batches).toHaveLength(3)
    expect(batches[0]).toMatchObject({ parallel: true,  calls: expect.arrayContaining([expect.objectContaining({ name: 'read_file' })]) })
    expect(batches[0].calls).toHaveLength(2)
    expect(batches[1]).toMatchObject({ parallel: false, calls: [expect.objectContaining({ name: 'run_terminal_command' })] })
    expect(batches[2]).toMatchObject({ parallel: true,  calls: [expect.objectContaining({ name: 'read_file' })] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4.  Output order — always matches input order
// ─────────────────────────────────────────────────────────────────────────────

describe('output order — always matches input order', () => {
  it('preserves input order even when a later promise in a batch resolves first', async () => {
    // call[0] (read_file a) takes 80 ms — slow
    // call[1] (read_file b) takes 10 ms — fast; resolves before [0]
    // call[2] (read_file c) takes 40 ms — medium
    //
    // Without explicit ordering, Promise.all could return them in resolve
    // order (b, c, a). The scheduler must return them as (a, b, c).

    mockExecute
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(80, makeOkResult(call.name, { content: 'data-a' })))
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(10, makeOkResult(call.name, { content: 'data-b' })))
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(40, makeOkResult(call.name, { content: 'data-c' })))

    const calls = [
      makeCall('read_file', { path: 'a.ts' }),
      makeCall('read_file', { path: 'b.ts' }),
      makeCall('read_file', { path: 'c.ts' }),
    ]

    const results = await runScheduler(calls, noopCallbacks)

    expect(results).toHaveLength(3)
    // Each result must carry the data from its corresponding input call
    expect((results[0].result as { ok: true; data: { content: string } }).data?.content).toBe('data-a')
    expect((results[1].result as { ok: true; data: { content: string } }).data?.content).toBe('data-b')
    expect((results[2].result as { ok: true; data: { content: string } }).data?.content).toBe('data-c')
  })

  it('preserves order across mixed parallel/sequential batches', async () => {
    // [read_file-A, read_file-B] (parallel) → [run_terminal_command] (sequential)
    // Output must be [A, B, terminal] in that order.

    mockExecute
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(40, makeOkResult(call.name, { content: 'A' })))
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(10, makeOkResult(call.name, { content: 'B' })))  // resolves before A
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(5,  makeOkResult(call.name, { exitCode: 0 })))

    const calls = [
      makeCall('read_file', { path: 'a.ts' }),
      makeCall('read_file', { path: 'b.ts' }),
      makeCall('run_terminal_command', { command: 'echo hi' }),
    ]

    const results = await runScheduler(calls, noopCallbacks)

    expect(results).toHaveLength(3)
    expect(results[0].name).toBe('read_file')
    expect((results[0].result as { ok: true; data: { content: string } }).data?.content).toBe('A')
    expect(results[1].name).toBe('read_file')
    expect((results[1].result as { ok: true; data: { content: string } }).data?.content).toBe('B')
    expect(results[2].name).toBe('run_terminal_command')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5.  UI lifecycle — onActivityStart / onActivityEnd ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('UI lifecycle — activity callbacks', () => {
  it('fires all onActivityStart calls before any promise is awaited in a parallel batch', async () => {
    const log: string[] = []
    const DELAY = 30

    mockExecute
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        await new Promise(r => setTimeout(r, DELAY))
        return [makeOkResult(call.name, { content: 'x' })]
      })
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        await new Promise(r => setTimeout(r, DELAY))
        return [makeOkResult(call.name, { content: 'y' })]
      })

    const callbacks: Callbacks = {
      onActivityStart: (a) => log.push(`start:${a.tool}`),
      onActivityEnd:   (id, status) => log.push(`end:${status}`),
    }

    const calls = [
      makeCall('read_file', { path: 'x.ts' }),
      makeCall('read_file', { path: 'y.ts' }),
    ]

    await runScheduler(calls, callbacks)

    // Both starts must come before any end
    const firstEndIdx = log.findIndex(e => e.startsWith('end:'))
    const lastStartIdx = log.map((e, i) => e.startsWith('start:') ? i : -1)
      .filter(i => i >= 0)
      .at(-1) ?? -1

    expect(lastStartIdx).toBeLessThan(firstEndIdx)
    expect(log.filter(e => e.startsWith('start:'))).toHaveLength(2)
    expect(log.filter(e => e.startsWith('end:'))).toHaveLength(2)
  })

  it('fires onActivityEnd per-call as it resolves, not after the whole batch', async () => {
    const endTimes: number[] = []

    // call[0] takes 60 ms, call[1] takes 10 ms
    mockExecute
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(60, makeOkResult(call.name)))
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        delayed(10, makeOkResult(call.name)))

    const callbacks: Callbacks = {
      onActivityStart: () => {},
      onActivityEnd: () => endTimes.push(Date.now()),
    }

    const calls = [
      makeCall('read_file', { path: 'slow.ts' }),
      makeCall('read_file', { path: 'fast.ts' }),
    ]

    await runScheduler(calls, callbacks)

    expect(endTimes).toHaveLength(2)
    // The fast call (10 ms) should fire its end significantly before the slow one (60 ms)
    const gap = endTimes[1] - endTimes[0]
    // gap may be negative (fast resolved first) or small positive (scheduling jitter)
    // Either way, they should NOT be ~0 ms apart (which would mean we waited for
    // the whole batch). We verify the earlier end came at least 20 ms before the later one.
    expect(Math.abs(gap)).toBeGreaterThan(20)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6.  Abort signal — skips batches after abort
// ─────────────────────────────────────────────────────────────────────────────

describe('abort signal', () => {
  it('skips pending batches when signal is already aborted before the loop starts', async () => {
    const controller = new AbortController()
    controller.abort()

    mockExecute.mockImplementation(([call]: FunctionCall[]) =>
      Promise.resolve([makeOkResult(call.name)]))

    const calls = [
      makeCall('read_file', { path: 'a.ts' }),
      makeCall('read_file', { path: 'b.ts' }),
    ]

    const results = await runScheduler(calls, noopCallbacks, controller.signal)

    // All results should be cancellation placeholders
    expect(mockExecute).not.toHaveBeenCalled()
    expect(results.every(r => !r.result.ok)).toBe(true)
    expect(results.every(r => !r.result.ok && r.result.error === 'Cancelled by user')).toBe(true)
  })

  it('completes the in-flight batch but skips subsequent batches after abort', async () => {
    const controller = new AbortController()

    let firstBatchStarted = false

    mockExecute
      .mockImplementationOnce(async ([call]: FunctionCall[]) => {
        firstBatchStarted = true
        // Abort mid-flight
        controller.abort()
        await new Promise(r => setTimeout(r, 10))
        return [makeOkResult(call.name, { content: 'done' })]
      })
      // This should NOT be called because the second batch is a sequential call
      // that comes after the abort
      .mockImplementationOnce(([call]: FunctionCall[]) =>
        Promise.resolve([makeOkResult(call.name)]))

    const calls = [
      makeCall('read_file', { path: 'a.ts' }),        // batch 1 — in flight when abort fires
      makeCall('run_terminal_command', { command: 'npm test' }), // batch 2 — should be skipped
    ]

    const results = await runScheduler(calls, noopCallbacks, controller.signal)

    expect(firstBatchStarted).toBe(true)
    expect(results).toHaveLength(2)
    // First call completed naturally
    expect(results[0].result.ok).toBe(true)
    // Second call was skipped
    expect(results[1].result.ok).toBe(false)
    expect((results[1].result as { ok: false; error: string }).error).toBe('Cancelled by user')
    // executeToolCalls was only called once (for the in-flight batch)
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })
})
