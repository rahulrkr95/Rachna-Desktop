// services/agent/__tests__/verificationGate.test.ts
//
// Unit tests for the enforced Agent Verification Loop (verificationGate.ts).
//
// Strategy:
//   - '@tauri-apps/api/core' is mocked so buildVerification / lintVerification
//     / testVerification (which the gate calls directly) never touch a real
//     shell — their `invoke('run_terminal_command', ...)` calls are routed
//     through a single configurable stub keyed by the command string.
//   - './ToolRegistry' is mocked so get_diagnostics can be driven directly
//     without a real Monaco instance.
//
// What's covered:
//   1. Edit-tool detection (requirement 1): propose_edit / batch_propose_edits /
//      create_file / rename_file / delete_file all register changed files;
//      failed calls and read-only tools do not.
//   2. Doc/config-only changes never trigger a forced round (minimizing
//      unnecessary rebuilds).
//   3. A forced round runs diagnostics + build + lint + test and reports
//      failures without ever throwing.
//   4. skip_verification causes every step to report 'skipped' with the
//      given reason, without actually invoking build/lint/test.
//   5. The forced-round cap is respected so the loop can never spin forever.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExecutedTool } from '../ToolExecutor'
import type { ToolContext } from '../types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../ToolRegistry', () => ({
  getTool: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { getTool } from '../ToolRegistry'
import {
  createGateState,
  recordExecutedTools,
  needsForcedRound,
  hasUnresolvedAfterCap,
  runForcedVerificationRound,
  isDocOrConfigOnly,
  MAX_FORCED_ROUNDS,
} from '../verificationGate'

const mockInvoke = invoke as ReturnType<typeof vi.fn>
const mockGetTool = getTool as ReturnType<typeof vi.fn>

const ctx: ToolContext = { projectRoot: '/fake/project' }

function ok(data: unknown): ExecutedTool['result'] {
  return { ok: true, data }
}
function err(error: string): ExecutedTool['result'] {
  return { ok: false, error }
}

// Default: no project files found (every `cat X` fails) and no diagnostics
// tool registered — individual tests override as needed.
beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit_code: 1, timed_out: false, duration_ms: 5 })
  mockGetTool.mockReset()
  mockGetTool.mockReturnValue(undefined)
})

describe('isDocOrConfigOnly', () => {
  it('treats an empty change set as doc-only (nothing to verify)', () => {
    expect(isDocOrConfigOnly([])).toBe(true)
  })

  it('treats markdown-only changes as doc-only', () => {
    expect(isDocOrConfigOnly(['README.md', 'docs/guide.md'])).toBe(true)
  })

  it('treats a single code file as NOT doc-only', () => {
    expect(isDocOrConfigOnly(['README.md', 'src/index.ts'])).toBe(false)
  })
})

describe('recordExecutedTools', () => {
  it('registers the file from a successful propose_edit', () => {
    const gate = createGateState()
    const executed: ExecutedTool[] = [
      { name: 'propose_edit', args: {}, label: '', result: ok({ filePath: '/fake/project/src/a.ts' }) },
    ]
    recordExecutedTools(gate, executed)
    expect([...gate.pendingFiles]).toEqual(['/fake/project/src/a.ts'])
    expect([...gate.allChangedFiles]).toEqual(['/fake/project/src/a.ts'])
  })

  it('registers both paths from a successful rename_file', () => {
    const gate = createGateState()
    const executed: ExecutedTool[] = [
      { name: 'rename_file', args: {}, label: '', result: ok({ oldPath: '/a.ts', newPath: '/b.ts' }) },
    ]
    recordExecutedTools(gate, executed)
    expect([...gate.pendingFiles].sort()).toEqual(['/a.ts', '/b.ts'])
  })

  it('registers every file from a successful batch_propose_edits', () => {
    const gate = createGateState()
    const executed: ExecutedTool[] = [
      {
        name: 'batch_propose_edits',
        args: {},
        label: '',
        result: ok({ results: [{ filePath: '/a.ts' }, { filePath: '/b.ts' }] }),
      },
    ]
    recordExecutedTools(gate, executed)
    expect([...gate.pendingFiles].sort()).toEqual(['/a.ts', '/b.ts'])
  })

  it('ignores failed edit tool calls', () => {
    const gate = createGateState()
    const executed: ExecutedTool[] = [
      { name: 'propose_edit', args: {}, label: '', result: err('file not found') },
    ]
    recordExecutedTools(gate, executed)
    expect(gate.pendingFiles.size).toBe(0)
  })

  it('ignores read-only tool calls entirely', () => {
    const gate = createGateState()
    const executed: ExecutedTool[] = [
      { name: 'read_file', args: {}, label: '', result: ok({ content: 'hello' }) },
      { name: 'get_diagnostics', args: {}, label: '', result: ok({ diagnostics: [], available: true }) },
    ]
    recordExecutedTools(gate, executed)
    expect(gate.pendingFiles.size).toBe(0)
  })

  it('records the reason from a successful skip_verification call', () => {
    const gate = createGateState()
    const executed: ExecutedTool[] = [
      { name: 'skip_verification', args: {}, label: '', result: ok({ acknowledged: true, reason: 'comment-only change' }) },
    ]
    recordExecutedTools(gate, executed)
    expect(gate.skipReason).toBe('comment-only change')
  })
})

describe('needsForcedRound', () => {
  it('is false with no pending files', () => {
    const gate = createGateState()
    expect(needsForcedRound(gate)).toBe(false)
  })

  it('is false when every pending file is doc-only', () => {
    const gate = createGateState()
    gate.pendingFiles.add('README.md')
    expect(needsForcedRound(gate)).toBe(false)
  })

  it('is true when a code file is pending and under the round cap', () => {
    const gate = createGateState()
    gate.pendingFiles.add('src/index.ts')
    expect(needsForcedRound(gate)).toBe(true)
  })

  it('is false once the round cap is reached, and hasUnresolvedAfterCap flips true', () => {
    const gate = createGateState()
    gate.pendingFiles.add('src/index.ts')
    gate.roundsRun = MAX_FORCED_ROUNDS
    expect(needsForcedRound(gate)).toBe(false)
    expect(hasUnresolvedAfterCap(gate)).toBe(true)
  })
})

describe('runForcedVerificationRound', () => {
  it('skips every step with the reason when skip_verification was called', async () => {
    const gate = createGateState()
    gate.pendingFiles.add('src/index.ts')
    gate.skipReason = 'user explicitly said not to bother checking'

    const report = await runForcedVerificationRound(gate, '/fake/project', ctx)

    expect(report.outcomes.every(o => o.status === 'skipped')).toBe(true)
    expect(report.outcomes[0].detail).toBe('user explicitly said not to bother checking')
    // The skip is consumed — it must not silently apply to the next round too.
    expect(gate.skipReason).toBeNull()
    // No terminal commands should have been run for a skipped round.
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('reports build failure when the detected build command exits non-zero', async () => {
    const gate = createGateState()
    gate.pendingFiles.add('/fake/project/src/index.ts')

    mockInvoke.mockImplementation(async (_cmd: string, args: any) => {
      if (args?.command === 'cat package.json') {
        return {
          stdout: JSON.stringify({ scripts: { build: 'vite build' } }),
          stderr: '', exit_code: 0, timed_out: false, duration_ms: 5,
        }
      }
      if (args?.command?.includes('npm run build')) {
        return { stdout: '', stderr: 'TS2322: type error', exit_code: 1, timed_out: false, duration_ms: 42 }
      }
      // Everything else (lock files, Cargo.toml, go.mod, tsconfig, eslint, test script) → not found
      return { stdout: '', stderr: '', exit_code: 1, timed_out: false, duration_ms: 1 }
    })

    const report = await runForcedVerificationRound(gate, '/fake/project', ctx)

    const build = report.outcomes.find(o => o.id === 'build')!
    expect(build.status).toBe('failed')
    expect(build.detail).toContain('TS2322')
    expect(report.overallOk).toBe(false)
    expect(report.markdown).toContain('One or more steps above **FAILED**')
  })

  it('reports not_applicable steps when nothing is detected, without failing the round', async () => {
    const gate = createGateState()
    gate.pendingFiles.add('/fake/project/src/index.ts')
    // Default mock: every `cat X` returns exit_code 1 → nothing detected anywhere.

    const report = await runForcedVerificationRound(gate, '/fake/project', ctx)

    const build = report.outcomes.find(o => o.id === 'build')!
    const lint = report.outcomes.find(o => o.id === 'lint')!
    const test = report.outcomes.find(o => o.id === 'test')!
    expect(build.status).toBe('not_applicable')
    expect(lint.status).toBe('not_applicable')
    expect(test.status).toBe('not_applicable')
    expect(report.overallOk).toBe(true)
  })

  it('clears pendingFiles after running so a repeat call is a no-op round', async () => {
    const gate = createGateState()
    gate.pendingFiles.add('/fake/project/src/index.ts')
    await runForcedVerificationRound(gate, '/fake/project', ctx)
    expect(gate.pendingFiles.size).toBe(0)
    expect(needsForcedRound(gate)).toBe(false)
  })

  it('uses live diagnostics for changed files when a diagnostics tool is registered', async () => {
    mockGetTool.mockImplementation((name: string) => {
      if (name !== 'get_diagnostics') return undefined
      return {
        execute: async () => ok({
          available: true,
          diagnostics: [
            { file: '/fake/project/src/index.ts', line: 10, column: 2, severity: 'error', message: "Cannot find name 'foo'" },
            { file: '/fake/project/src/other.ts', line: 1, column: 1, severity: 'error', message: 'unrelated file, should not count' },
          ],
        }),
      }
    })

    const gate = createGateState()
    gate.pendingFiles.add('/fake/project/src/index.ts')

    const report = await runForcedVerificationRound(gate, '/fake/project', ctx)
    const diagnostics = report.outcomes.find(o => o.id === 'diagnostics')!
    expect(diagnostics.status).toBe('failed')
    expect(diagnostics.detail).toContain("Cannot find name 'foo'")
    expect(diagnostics.detail).not.toContain('unrelated file')
  })
})
