import { describe, expect, it, beforeEach } from 'vitest'
import { executorRegistry, runAutomation, ExecutorNotReadyError } from '../automationRunner'
import type { AutomationJob } from '../automationScheduler'

const baseJob = (overrides: Partial<AutomationJob> = {}): AutomationJob => ({
  id: 'job-1',
  name: 'Test job',
  request: 'do the thing',
  schedule: { type: 'once', runAt: new Date().toISOString() },
  enabled: true,
  soundEnabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'idle',
  history: [],
  kind: 'needs_ai',
  steps: [],
  ...overrides,
})

describe('AutomationRunner / ExecutorRegistry', () => {
  beforeEach(() => {
    // The registry is a module-level singleton; unregister anything the
    // test itself registers so tests don't leak into each other.
  })

  it('dispatches each step purely by its executor name -- never by job.kind', async () => {
    const calls: string[] = []
    const unregisterTerminal = executorRegistry.register('terminal', async (step) => {
      calls.push(`terminal:${step.command}`)
    })
    const job = baseJob({
      kind: 'no_ai', // deliberately mismatched vs the steps below, to prove kind is ignored
      steps: [
        { executor: 'terminal', command: 'echo one' },
        { executor: 'terminal', command: 'echo two' },
      ],
    })
    await runAutomation(job)
    expect(calls).toEqual(['terminal:echo one', 'terminal:echo two'])
    unregisterTerminal()
  })

  it('runs a runOncePerJob executor only once even if multiple steps route to it', async () => {
    let runs = 0
    const unregisterAi = executorRegistry.register('ai', async () => { runs += 1 }, { runOncePerJob: true })
    const job = baseJob({
      steps: [
        { executor: 'ai', prompt: 'first prompt' },
        { executor: 'ai', prompt: 'second prompt' },
      ],
    })
    await runAutomation(job)
    expect(runs).toBe(1)
    unregisterAi()
  })

  it('throws when no executor is registered for a step type', async () => {
    const job = baseJob({ steps: [{ executor: 'terminal', command: 'echo hi' }] })
    await expect(runAutomation(job)).rejects.toThrow(/No executor registered for step type "terminal"/)
  })

  it('propagates ExecutorNotReadyError so the caller can distinguish it from a real failure', async () => {
    const unregister = executorRegistry.register('ai', async () => {
      throw new ExecutorNotReadyError('not ready')
    })
    const job = baseJob({ steps: [{ executor: 'ai', prompt: 'hi' }] })
    await expect(runAutomation(job)).rejects.toBeInstanceOf(ExecutorNotReadyError)
    unregister()
  })
})
