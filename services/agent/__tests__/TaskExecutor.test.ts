// services/agent/__tests__/TaskExecutor.test.ts
//
// Covers the Failure, Retry & Manual Override system's core engine
// (services/agent/TaskExecutor.ts). The UI-facing state machine in
// useChat.ts (retryStep/markStepDone/cancelExecution) is a thin wrapper
// around this engine, so pinning the engine's contract down here is what
// actually guarantees:
//   - Strict Sequential Execution: step N+1 never starts until step N has
//     finished (successfully or via manual override) — verified via a
//     call-order log, not just final state.
//   - Failure Handling: a thrown step stops the walk immediately; later
//     steps never run; the failure is reported with enough info (`failed`,
//     `stoppedAtStepId`) for the caller to render it and offer Retry/Mark
//     Done.
//   - Retry: re-invoking runExecutionSteps with ONLY the failed step (+
//     whatever came after it) — exactly what useChat's retryStep passes in
//     — never re-runs anything before it.
//   - Manual Override ("Mark Done"): simulated by the caller injecting the
//     failed step's id into completedStepIds itself and resuming with the
//     remaining steps — mirrors useChat's markStepDone, which never calls
//     `execute` again for the manually-completed step.
//   - Resume Logic: whatever TaskState/step-subset is handed back in a
//     `failed`/`stop` result is exactly what a fresh call needs to continue
//     without repeating or skipping anything.

import { describe, it, expect, vi } from 'vitest'
import { runExecutionSteps, orderSteps, formatTaskStateForPrompt } from '../TaskExecutor'
import type { ExecutionStep, TaskState } from '../../../types'
import { createInitialTaskState } from '../../../types'

function step(id: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return { id, task: `do ${id}`, intent: 'chat', ...overrides }
}

describe('orderSteps', () => {
  it('preserves original order when there are no dependencies', () => {
    const steps = [step('a'), step('b'), step('c')]
    expect(orderSteps(steps).map(s => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('moves a dependency ahead of its dependent even if declared out of order', () => {
    const steps = [step('b', { dependsOn: ['a'] }), step('a')]
    expect(orderSteps(steps).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('falls back to original order on an unknown dependency id (fail open, never throws)', () => {
    const steps = [step('a', { dependsOn: ['ghost'] }), step('b')]
    expect(() => orderSteps(steps)).not.toThrow()
    expect(orderSteps(steps).map(s => s.id)).toEqual(['a', 'b'])
  })

  it('falls back to original order on a dependency cycle rather than throwing', () => {
    const steps = [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })]
    expect(() => orderSteps(steps)).not.toThrow()
  })
})

describe('runExecutionSteps — Strict Sequential Execution', () => {
  it('runs steps one at a time, in order, and step N+1 never starts before step N resolves', async () => {
    const log: string[] = []
    const steps = [step('1'), step('2'), step('3')]

    const execute = vi.fn(async (s: ExecutionStep) => {
      log.push(`start:${s.id}`)
      // Yield to the microtask queue so a buggy parallel implementation
      // would have a chance to interleave starts before finishes.
      await new Promise(r => setTimeout(r, 5))
      log.push(`end:${s.id}`)
      return { summary: `${s.id} done` }
    })

    const result = await runExecutionSteps(steps, execute, createInitialTaskState())

    expect(result.completed).toBe(true)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(log).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'])
  })

  it('threads completedStepIds, summaries, discoveries, and changedFiles forward step by step', async () => {
    const steps = [step('1'), step('2')]
    const execute = vi.fn(async (s: ExecutionStep) => ({
      summary: `summary-${s.id}`,
      discoveries: [`discovery-${s.id}`],
      changedFiles: [`file-${s.id}.ts`],
    }))

    const result = await runExecutionSteps(steps, execute, createInitialTaskState())

    expect(result.completed).toBe(true)
    expect(result.taskState.completedStepIds).toEqual(['1', '2'])
    expect(result.taskState.stepSummaries).toEqual({ '1': 'summary-1', '2': 'summary-2' })
    expect(result.taskState.discoveries).toEqual(['discovery-1', 'discovery-2'])
    expect(result.taskState.changedFiles).toEqual(['file-1.ts', 'file-2.ts'])
  })

  it('respects an aborted signal by stopping before the next step runs', async () => {
    const controller = new AbortController()
    const steps = [step('1'), step('2')]
    const execute = vi.fn(async (s: ExecutionStep) => {
      if (s.id === '1') controller.abort()
      return { summary: 'ok' }
    })

    const result = await runExecutionSteps(steps, execute, createInitialTaskState(), { signal: controller.signal })

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.completed).toBe(false)
    expect(result.stoppedAtStepId).toBe('2')
  })
})

describe('runExecutionSteps — Failure Handling', () => {
  it('stops immediately on a thrown step, marks it failed, and never calls later steps', async () => {
    const steps = [step('1'), step('2'), step('3')]
    const execute = vi.fn(async (s: ExecutionStep) => {
      if (s.id === '2') throw new Error('tool call failed')
      return { summary: 'ok' }
    })

    const result = await runExecutionSteps(steps, execute, createInitialTaskState())

    expect(execute).toHaveBeenCalledTimes(2) // step 1, then the failing step 2 — step 3 never invoked
    expect(execute).not.toHaveBeenCalledWith(steps[2], expect.anything())
    expect(result.completed).toBe(false)
    expect(result.failed).toBe(true)
    expect(result.stoppedAtStepId).toBe('2')
  })

  it('preserves TaskState exactly as of right before the failed step (no partial bookkeeping for it)', async () => {
    const steps = [step('1'), step('2')]
    const execute = vi.fn(async (s: ExecutionStep) => {
      if (s.id === '1') return { summary: 'step one summary', changedFiles: ['a.ts'] }
      throw new Error('boom')
    })

    const result = await runExecutionSteps(steps, execute, createInitialTaskState())

    expect(result.failed).toBe(true)
    expect(result.taskState.completedStepIds).toEqual(['1'])
    expect(result.taskState.stepSummaries).toEqual({ '1': 'step one summary' })
    expect(result.taskState.changedFiles).toEqual(['a.ts'])
  })

  it('distinguishes a genuine failure (failed: true) from a clean UI hand-off ({ stop: true })', async () => {
    const steps = [step('1'), step('2')]
    const execute = vi.fn(async (s: ExecutionStep) => {
      if (s.id === '1') return { stop: true, summary: 'needs a folder picker' }
      return { summary: 'unreachable' }
    })

    const result = await runExecutionSteps(steps, execute, createInitialTaskState())

    expect(result.completed).toBe(false)
    expect(result.failed).toBeUndefined()
    expect(result.stoppedAtStepId).toBe('1')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('never lets a step throw become an unhandled rejection', async () => {
    const steps = [step('1')]
    const execute = vi.fn(async () => { throw new Error('kaboom') })
    await expect(runExecutionSteps(steps, execute, createInitialTaskState())).resolves.toMatchObject({ failed: true })
  })
})

describe('runExecutionSteps — Retry (re-run ONLY the failed step)', () => {
  it('a retry call given just [failedStep, ...rest] never re-invokes earlier, already-completed steps', async () => {
    const steps = [step('1'), step('2'), step('3')]
    const calls: string[] = []
    let failStep2 = true
    const execute = vi.fn(async (s: ExecutionStep) => {
      calls.push(s.id)
      if (s.id === '2' && failStep2) throw new Error('flaky failure')
      return { summary: 'ok' }
    })

    // First run: fails at step 2.
    const first = await runExecutionSteps(steps, execute, createInitialTaskState())
    expect(first.failed).toBe(true)
    expect(first.stoppedAtStepId).toBe('2')
    expect(calls).toEqual(['1', '2'])

    // Retry: caller (useChat's retryStep) resumes with ONLY the failed step
    // onward, using the TaskState exactly as returned from the failed run.
    calls.length = 0
    failStep2 = false
    const ordered = orderSteps(steps)
    const failedIdx = ordered.findIndex(s => s.id === first.stoppedAtStepId)
    const retrySteps = ordered.slice(failedIdx)

    const second = await runExecutionSteps(retrySteps, execute, first.taskState)

    expect(second.completed).toBe(true)
    expect(calls).toEqual(['2', '3']) // step 1 never re-invoked
    expect(second.taskState.completedStepIds).toEqual(['1', '2', '3'])
  })

  it('a second consecutive failure on retry still stops exactly at the failed step, not before or after', async () => {
    const steps = [step('2'), step('3')] // simulates a retry-scoped subset
    const calls: string[] = []
    const execute = vi.fn(async (s: ExecutionStep) => {
      calls.push(s.id)
      throw new Error('still broken')
    })

    const seedState: TaskState = { completedStepIds: ['1'], discoveries: [], changedFiles: [], stepSummaries: { '1': 'ok' } }
    const result = await runExecutionSteps(steps, execute, seedState)

    expect(result.failed).toBe(true)
    expect(result.stoppedAtStepId).toBe('2')
    expect(calls).toEqual(['2']) // step 3 never attempted
    expect(result.taskState.completedStepIds).toEqual(['1']) // unchanged from before the retry
  })
})

describe('runExecutionSteps — Manual Override ("Mark Done") resume semantics', () => {
  it('resuming with the manually-completed step folded into TaskState and excluded from the step list never re-executes it', async () => {
    const allSteps = [step('1'), step('2'), step('3')]
    const calls: string[] = []
    const execute = vi.fn(async (s: ExecutionStep) => {
      calls.push(s.id)
      return { summary: 'ok' }
    })

    // Simulate: step '1' completed normally, step '2' failed and was then
    // marked done manually by the user (useChat's markStepDone) WITHOUT
    // ever calling `execute` for it again.
    const taskStateAfterManualOverride: TaskState = {
      completedStepIds: ['1', '2'],
      discoveries: [],
      changedFiles: [],
      stepSummaries: { '1': 'ok', '2': 'marked done manually by the user after this step failed.' },
    }
    const remaining = allSteps.slice(2) // just step '3'

    const result = await runExecutionSteps(remaining, execute, taskStateAfterManualOverride)

    expect(calls).toEqual(['3']) // steps 1 and 2 never invoked in this call
    expect(result.completed).toBe(true)
    expect(result.taskState.completedStepIds).toEqual(['1', '2', '3'])
  })

  it('marking the LAST step done manually leaves nothing further to run', async () => {
    // Mirrors useChat's markStepDone early-return when `rest.length === 0`.
    const remaining: ExecutionStep[] = []
    const execute = vi.fn()
    const result = await runExecutionSteps(remaining, execute, createInitialTaskState())
    expect(execute).not.toHaveBeenCalled()
    expect(result.completed).toBe(true)
  })
})

describe('runExecutionSteps — Resume Logic', () => {
  it('resuming from a TaskState with prior completions never repeats them and continues exactly where it left off', async () => {
    const allSteps = [step('1'), step('2'), step('3'), step('4')]
    const calls: string[] = []
    const execute = vi.fn(async (s: ExecutionStep) => {
      calls.push(s.id)
      return { summary: 'ok' }
    })

    const priorState: TaskState = {
      completedStepIds: ['1', '2'],
      discoveries: [],
      changedFiles: [],
      stepSummaries: { '1': 'ok', '2': 'ok' },
    }
    // The caller is responsible for slicing to the first incomplete step —
    // exactly what useChat's failedStepContextRef bookkeeping does.
    const firstIncompleteIdx = allSteps.findIndex(s => !priorState.completedStepIds.includes(s.id))
    const resumeSteps = allSteps.slice(firstIncompleteIdx)

    const result = await runExecutionSteps(resumeSteps, execute, priorState)

    expect(calls).toEqual(['3', '4']) // never repeats 1 or 2, never skips 3
    expect(result.completed).toBe(true)
    expect(result.taskState.completedStepIds).toEqual(['1', '2', '3', '4'])
  })
})

describe('formatTaskStateForPrompt', () => {
  it('returns an empty string for a fresh TaskState (first step has nothing to report)', () => {
    expect(formatTaskStateForPrompt(createInitialTaskState())).toBe('')
  })

  it('folds prior summaries, discoveries, and changed files into a short context block', () => {
    const ts: TaskState = {
      completedStepIds: ['1'],
      discoveries: ['found the API key in .env'],
      changedFiles: ['src/index.ts'],
      stepSummaries: { '1': 'Created the initial route.' },
    }
    const text = formatTaskStateForPrompt(ts)
    expect(text).toContain('Created the initial route.')
    expect(text).toContain('found the API key in .env')
    expect(text).toContain('src/index.ts')
  })
})
