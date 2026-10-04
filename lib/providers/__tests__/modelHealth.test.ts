// lib/providers/__tests__/modelHealth.test.ts
//
// Exercises checkModelHealth()/checkModelsHealth() against a minimal fake
// AIProvider (not a real provider implementation) — the whole point of the
// module under test is that it drives every provider through the same
// interface, so a fake satisfying that interface is exactly what should be
// tested against, rather than duplicating one real provider's HTTP details.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  checkModelHealth,
  checkModelsHealth,
  HEALTH_CHECK_PROMPT,
  HEALTH_CHECK_MAX_TOKENS,
} from '../modelHealth'
import type { AIProvider, ChatOptions, ProviderAgentTurn, ProviderMessage } from '../types'

function makeFakeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    id: 'fake',
    displayName: 'Fake Provider',
    async listModels() { return [] },
    async stream() { /* not used by health checks */ },
    async agentTurn(): Promise<ProviderAgentTurn> {
      return { text: 'OK', functionCalls: [], modelTurn: null }
    },
    appendToolResults(history) { return history },
    toInternalMessages(messages: ProviderMessage[]) { return messages },
    fromInternalMessages(history) { return history as ProviderMessage[] },
    isQuotaError(err: unknown) {
      return err instanceof Error && err.message.toLowerCase().includes('rate limit')
    },
    isAbortError(err: unknown) {
      return err instanceof Error && err.name === 'AbortError'
    },
    supportsVision() { return false },
    ...overrides,
  }
}

describe('checkModelHealth', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('reports Healthy with latency on a successful minimal completion', async () => {
    const agentTurn = vi.fn(async (_apiKey: string, _messages: unknown[], _tools: unknown[], opts?: ChatOptions) => {
      // The probe must be tiny, deterministic, non-streaming, temp 0.
      expect(opts?.temperature).toBe(0)
      expect(opts?.maxOutputTokens).toBe(HEALTH_CHECK_MAX_TOKENS)
      expect(opts?.model).toBe('model-a')
      return { text: 'OK', functionCalls: [], modelTurn: null }
    })
    const provider = makeFakeProvider({ agentTurn })

    const result = await checkModelHealth(provider, 'key', 'model-a')

    expect(result.healthy).toBe(true)
    expect(result.status).toBe('Healthy')
    expect(result.modelId).toBe('model-a')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.lastChecked).toBeGreaterThan(0)
    expect(result.error).toBeUndefined()
  })

  it('sends the documented minimal probe prompt', async () => {
    let sentMessages: ProviderMessage[] = []
    const provider = makeFakeProvider({
      toInternalMessages(messages: ProviderMessage[]) {
        sentMessages = messages
        return messages
      },
    })

    await checkModelHealth(provider, 'key', 'model-a')
    expect(sentMessages).toEqual([{ role: 'user', content: HEALTH_CHECK_PROMPT }])
  })

  it('classifies a 401 response as Unauthorized', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => {
        throw new Error('Fake API error 401: invalid api key')
      }),
    })

    const result = await checkModelHealth(provider, 'bad-key', 'model-a')
    expect(result.healthy).toBe(false)
    expect(result.status).toBe('Unauthorized')
    expect(result.error).toContain('401')
  })

  it('classifies a 404 response as NotFound', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => {
        throw new Error('Fake API error 404: model does not exist')
      }),
    })

    const result = await checkModelHealth(provider, 'key', 'unknown-model')
    expect(result.status).toBe('NotFound')
  })

  it('classifies a provider-flagged quota error as RateLimited', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => {
        throw new Error('Fake API error 429: rate limit exceeded')
      }),
    })

    const result = await checkModelHealth(provider, 'key', 'model-a')
    expect(result.status).toBe('RateLimited')
    expect(result.healthy).toBe(false)
  })

  it('classifies a slow model as Timeout once the timeout elapses', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn((_apiKey: string, _messages: unknown[], _tools: unknown[], opts?: ChatOptions) => {
        return new Promise<ProviderAgentTurn>((resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted')
            err.name = 'AbortError'
            reject(err)
          })
          // Never resolves on its own within the test's timeout window.
        })
      }),
    })

    const result = await checkModelHealth(provider, 'key', 'slow-model', { timeoutMs: 20 })
    expect(result.status).toBe('Timeout')
    expect(result.healthy).toBe(false)
  })

  it('classifies a network failure as NetworkError', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    })

    const result = await checkModelHealth(provider, 'key', 'model-a')
    expect(result.status).toBe('NetworkError')
  })

  it('falls back to Unknown for unrecognized failures', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => {
        throw new Error('something weird happened')
      }),
    })

    const result = await checkModelHealth(provider, 'key', 'model-a')
    expect(result.status).toBe('Unknown')
  })

  it('never throws — always resolves with a result object', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => { throw 'not even an Error instance' }),
    })

    await expect(checkModelHealth(provider, 'key', 'model-a')).resolves.toMatchObject({
      healthy: false,
    })
  })
})

describe('checkModelsHealth (concurrency + batching)', () => {
  it('checks every model and reports each result', async () => {
    const provider = makeFakeProvider({
      agentTurn: vi.fn(async (_apiKey: string, _messages: unknown[], _tools: unknown[], opts?: ChatOptions) => {
        if (opts?.model === 'bad-model') throw new Error('Fake API error 401: nope')
        return { text: 'OK', functionCalls: [], modelTurn: null }
      }),
    })

    const results = await checkModelsHealth(provider, 'key', ['model-a', 'bad-model', 'model-b'])
    const byId = new Map(results.map(r => [r.modelId, r]))

    expect(byId.get('model-a')?.healthy).toBe(true)
    expect(byId.get('model-b')?.healthy).toBe(true)
    expect(byId.get('bad-model')?.healthy).toBe(false)
    expect(byId.get('bad-model')?.status).toBe('Unauthorized')
  })

  it('never runs more than `concurrency` checks at once', async () => {
    let inFlight = 0
    let maxInFlight = 0

    const provider = makeFakeProvider({
      agentTurn: vi.fn(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 10))
        inFlight--
        return { text: 'OK', functionCalls: [], modelTurn: null }
      }),
    })

    const modelIds = Array.from({ length: 12 }, (_, i) => `model-${i}`)
    await checkModelsHealth(provider, 'key', modelIds, { concurrency: 3 })

    expect(maxInFlight).toBeLessThanOrEqual(3)
    expect(maxInFlight).toBeGreaterThan(1) // actually ran concurrently, not serially
  })

  it('streams individual results via onResult as each check completes', async () => {
    const provider = makeFakeProvider()
    const seen: string[] = []

    await checkModelsHealth(provider, 'key', ['a', 'b', 'c'], {
      onResult: (result) => seen.push(result.modelId),
    })

    expect(seen.sort()).toEqual(['a', 'b', 'c'])
  })
})
