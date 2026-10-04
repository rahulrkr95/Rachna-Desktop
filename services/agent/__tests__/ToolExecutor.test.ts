// services/agent/__tests__/ToolExecutor.test.ts
//
// Regression tests for the "git_action receives invalid arguments" bug:
// some providers (see lib/providers/openaiCompatible.ts, ZenmuxProvider.ts,
// lmStudioNative.ts) parse a model's raw `function.arguments` string with
// JSON.parse(), which happily accepts a bare JSON string/array/number, not
// just an object. A malformed model response like `arguments: "\"push\""`
// used to flow all the way through as `args: "push"` and blow up
// git_action's Zod schema with "Expected object, received string".
//
// ToolExecutor.executeToolCall() is the single choke point every tool call
// passes through before hitting a tool's schema, so it's the right place to
// guarantee args are always an object — regardless of which upstream
// provider (or a bug in one of them) produced the call.

import './_localStoragePolyfill'
import { describe, it, expect, vi } from 'vitest'

// ── localStorage polyfill ────────────────────────────────────────────────────
// vitest.config.ts runs tests under environment: 'node', which has no
// localStorage. ToolRegistry (imported transitively by ToolExecutor) pulls
// in several tool modules whose backing Zustand stores read localStorage
// eagerly at module-load time (e.g. useApiKeyStore). This is pre-existing
// behaviour, not something this test is exercising — polyfilled via the
// side-effect import above (see _localStoragePolyfill.ts for why it has to
// be a separate, first import rather than inline code here).

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../../store/useGitStore', () => ({
  useGitStore: { getState: () => ({ root: null, refreshAll: vi.fn() }) },
}))

import { executeToolCall } from '../ToolExecutor'
import type { ToolContext } from '../types'

const ctx: ToolContext = { projectRoot: null }

describe('ToolExecutor — args normalization', () => {
  it('passes a well-formed object straight through unchanged', async () => {
    const result = await executeToolCall(
      { name: 'git_action', args: { action: 'status' } },
      ctx
    )
    // No project root, so this still fails — but on the *expected* reason,
    // not an "Expected object, received string" schema error.
    expect(result.result.ok).toBe(false)
    if (result.result.ok) return
    expect(result.result.error).toMatch(/requires an open project/i)
  })

  it('recovers when args arrives as a JSON-stringified object', async () => {
    // Simulates the malformed-but-recoverable case: a provider forwarded
    // the raw, un-parsed JSON string instead of the parsed object.
    const result = await executeToolCall(
      { name: 'git_action', args: '{"action":"status"}' as unknown as Record<string, unknown> },
      ctx
    )
    expect(result.result.ok).toBe(false)
    if (result.result.ok) return
    // Recovered into a real object and reached the tool's own logic —
    // not a schema validation error.
    expect(result.result.error).toMatch(/requires an open project/i)
    expect(result.result.error).not.toMatch(/expected object/i)
  })

  it('falls back to {} — and a clear schema error — when args is a bare non-JSON-object primitive', async () => {
    // e.g. arguments: "push" (a bare string, not `{"action":"push"}`)
    const result = await executeToolCall(
      { name: 'git_action', args: 'push' as unknown as Record<string, unknown> },
      ctx
    )
    expect(result.result.ok).toBe(false)
    if (result.result.ok) return
    // Never throws, never crashes the turn — surfaces as a normal tool
    // error the model can see and correct on its next call.
    expect(result.result.error).toMatch(/invalid git_action arguments/i)
  })

  it('falls back to {} when args is null', async () => {
    const result = await executeToolCall(
      { name: 'git_action', args: null as unknown as Record<string, unknown> },
      ctx
    )
    expect(result.result.ok).toBe(false)
    if (result.result.ok) return
    expect(result.result.error).toMatch(/invalid git_action arguments/i)
  })

  it('falls back to {} when args is an array', async () => {
    const result = await executeToolCall(
      { name: 'git_action', args: ['status'] as unknown as Record<string, unknown> },
      ctx
    )
    expect(result.result.ok).toBe(false)
    if (result.result.ok) return
    expect(result.result.error).toMatch(/invalid git_action arguments/i)
  })
})
