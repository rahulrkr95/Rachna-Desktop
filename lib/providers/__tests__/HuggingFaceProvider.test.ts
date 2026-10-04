// lib/providers/__tests__/HuggingFaceProvider.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  HuggingFaceProvider,
  buildCustomHuggingFaceModel,
  isValidHuggingFaceModelId,
  HUGGINGFACE_ROUTER_URL,
} from '../HuggingFaceProvider'

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    ...init,
  } as Response
}

describe('HuggingFaceProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('has the expected id/displayName and is registered as a pluggable provider', () => {
    const provider = new HuggingFaceProvider()
    expect(provider.id).toBe('huggingface')
    expect(provider.displayName).toBe('Hugging Face')
  })

  it('lists models by calling the router with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct' }],
    }))

    const provider = new HuggingFaceProvider()
    const models = await provider.listModels('hf_test_token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain(HUGGINGFACE_ROUTER_URL)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer hf_test_token' })
    expect(models.length).toBeGreaterThan(0)
  })

  it('accepts any Hugging Face model id via the custom-model helper', () => {
    const model = buildCustomHuggingFaceModel('bharatgenai/Param-1')
    expect(model.id).toBe('bharatgenai/Param-1')
    expect(model.displayName).toBe('bharatgenai/Param-1')
    expect(model.supportsStreaming).toBe(true)
  })

  it('validates plausible Hub model id shapes', () => {
    expect(isValidHuggingFaceModelId('bharatgenai/Param-1')).toBe(true)
    expect(isValidHuggingFaceModelId('meta-llama/Llama-3.1-8B-Instruct:together')).toBe(true)
    expect(isValidHuggingFaceModelId('')).toBe(false)
    expect(isValidHuggingFaceModelId('   ')).toBe(false)
  })

  it('retries once on a 500 before succeeding', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500, text: async () => 'boom' } as any))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'org/model' }] }))

    const provider = new HuggingFaceProvider()
    const models = await provider.listModels('hf_test_token')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(models.some(m => m.id === 'org/model')).toBe(true)
  })

  it('silently stops (no onError) when the request is cancelled via AbortSignal', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    })

    const provider = new HuggingFaceProvider()
    const onError = vi.fn()
    const onChunk = vi.fn()
    await provider.stream('hf_test_token', [{ role: 'user', content: 'hi' }], {
      onChunk,
      onDone: () => {},
      onError,
    }, { model: 'org/model', signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Deliberate cancellation is not surfaced as an error — matches the
    // shared openaiCompatible.ts contract (isAbortError → silent return).
    expect(onError).not.toHaveBeenCalled()
    expect(onChunk).not.toHaveBeenCalled()
  })
})
