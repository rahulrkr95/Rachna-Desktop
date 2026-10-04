import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiProvider, parseGeminiQuotaError } from '../GeminiProvider'
import { getGeminiDailyUsage, getGeminiMinuteUsage } from '../geminiRateLimiter'

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
})

const retryInfo = (retryDelay: string) => ({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
  },
})

describe('Gemini quota handling', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('classifies RetryInfo, daily quota, and hard quota responses', () => {
    expect(parseGeminiQuotaError(retryInfo('1.25s'))).toEqual({ kind: 'retryable', retryDelayMs: 1_250 })
    expect(parseGeminiQuotaError({ error: { details: [{
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
    }] } })).toEqual({ kind: 'daily' })
    expect(parseGeminiQuotaError({ error: { message: 'Billing account quota exhausted' } })).toEqual({ kind: 'hard' })
  })

  it('waits for RetryInfo, retries on the same key, and tracks both attempts', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(retryInfo('2s')), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] } }],
      }), { status: 200 }))

    const provider = new GeminiProvider()
    const resultPromise = provider.agentTurn('test-key-12345678', [{ role: 'user', parts: [{ text: 'hi' }] }], [], {
      model: 'gemini-2.5-flash',
    })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(resultPromise).resolves.toMatchObject({ text: 'done' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getGeminiMinuteUsage('test-key-12345678', 'gemini-2.5-flash').count).toBe(2)
    expect(getGeminiDailyUsage('test-key-12345678', 'gemini-2.5-flash').count).toBe(2)
    vi.useRealTimers()
  })

  it('stops retrying after the configured retry limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(retryInfo('0s')), { status: 429 })
    )
    const provider = new GeminiProvider({ maxRateLimitRetries: 2 })

    const request = provider.agentTurn('test-key-12345678', [], [], { model: 'gemini-2.5-flash' })
    const error = await request.then(
      () => { throw new Error('Expected request to fail') },
      value => value
    ) as Error

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(error.message).toContain('Gemini API error 429')
    expect(provider.isQuotaError(error)).toBe(false)
  })

  it('does not classify generic retryable rate-limit messages for key failover', () => {
    const provider = new GeminiProvider()

    expect(provider.isQuotaError(new Error('HTTP 429: rate limit RESOURCE_EXHAUSTED'))).toBe(false)
    expect(provider.isQuotaError(new Error('quota'))).toBe(false)
  })

  it('leaves daily quota errors available to the existing key failover path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
        }],
      },
    }), { status: 429 }))

    const provider = new GeminiProvider()
    const request = provider.agentTurn('test-key-12345678', [], [], { model: 'gemini-2.5-flash' })
    const error = await request.then(
      () => { throw new Error('Expected request to fail') },
      value => value
    ) as Error
    expect(error.message).toContain('Gemini API error 429')
    expect(provider.isQuotaError(error)).toBe(true)
  })
})
