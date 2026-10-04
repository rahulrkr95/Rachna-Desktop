// lib/providers/__tests__/SarvamProvider.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SarvamProvider, SARVAM_BASE_URL, SARVAM_DEFAULT_MODEL } from '../SarvamProvider'

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
  } as Response
}

describe('SarvamProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('has the expected id/displayName', () => {
    const provider = new SarvamProvider()
    expect(provider.id).toBe('sarvam')
    expect(provider.displayName).toBe('Sarvam AI')
  })

  it('has a documented default model matching the product spec', () => {
    expect(SARVAM_DEFAULT_MODEL).toBe('sarvam-105b')
  })

  it('lists models against the OpenAI-compatible /v1/models endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: 'sarvam-105b' }, { id: 'sarvam-2b' }],
    }))

    const provider = new SarvamProvider()
    const models = await provider.listModels('sarvam_test_key')

    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(`${SARVAM_BASE_URL}/models`)
    expect(models.map(m => m.id)).toEqual(['sarvam-105b', 'sarvam-2b'])
    // "any future models" — nothing filtered out
    expect(models.every(m => m.supportsTools)).toBe(true)
  })

  it('performs a non-streaming agent turn and reports token usage afterwards', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'Namaste!', tool_calls: [] } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }))

    const provider = new SarvamProvider()
    const turn = await provider.agentTurn(
      'sarvam_test_key',
      provider.toInternalMessages([{ role: 'user', content: 'hi' }]),
      [],
      { model: SARVAM_DEFAULT_MODEL }
    )

    expect(turn.text).toBe('Namaste!')
    expect(turn.functionCalls).toEqual([])

    const usage = await provider.getUsage('sarvam_test_key')
    expect(usage.status).toMatch(/12 prompt/)
    expect(usage.status).toMatch(/16 total/)
  })

  it('retries transient 5xx failures before giving up', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' } as Response)
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'sarvam-105b' }] }))

    const provider = new SarvamProvider()
    const models = await provider.listModels('sarvam_test_key')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(models).toHaveLength(1)
  })

  it('does not retry non-retryable 4xx errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key' } as Response)

    const provider = new SarvamProvider()
    await expect(provider.listModels('bad_key')).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
