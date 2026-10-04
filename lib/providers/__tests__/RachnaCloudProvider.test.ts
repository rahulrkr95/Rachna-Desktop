import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { useAuthStore } from '../../../store/useAuthStore'
import { RachnaCloudProvider } from '../RachnaCloudProvider'

const invokeMock = vi.mocked(invoke)

describe('RachnaCloudProvider', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useAuthStore.setState({
      sessionToken: 'session-secret',
      refreshUserInfo: vi.fn(async () => {}),
    })
  })

  afterEach(() => {
    useAuthStore.setState({ sessionToken: null })
  })

  it('uses the authenticated Tauri transport and exact non-streaming Cloud contract', async () => {
    invokeMock.mockResolvedValueOnce({ content: 'hello' })
    const provider = new RachnaCloudProvider()
    const onChunk = vi.fn()
    const onDone = vi.fn()

    await provider.stream('ignored-direct-key', [{ role: 'user', content: 'Hi' }], {
      onChunk,
      onDone,
      onError: error => { throw error },
    }, { temperature: 0.4, maxOutputTokens: 9000 })

    expect(invokeMock).toHaveBeenCalledWith('cloud_ai_generate', {
      token: 'session-secret',
      request: {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.4,
        max_tokens: 4096,
        stream: false,
      },
    })
    expect(onChunk).toHaveBeenCalledWith('hello')
    expect(onDone).toHaveBeenCalledWith('hello')
    expect(useAuthStore.getState().refreshUserInfo).toHaveBeenCalledOnce()
  })

  it('maps insufficient balance without exposing the backend response', async () => {
    invokeMock.mockRejectedValueOnce('CLOUD_AI_INSUFFICIENT_COINS')
    const onError = vi.fn()
    await new RachnaCloudProvider().stream('', [{ role: 'user', content: 'Hi' }], {
      onChunk: () => {},
      onDone: () => {},
      onError,
    })
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toBe('Insufficient coins. Check your Rachna Cloud balance and try again.')
  })

  it('reports unsupported tools and vision instead of silently degrading', async () => {
    const provider = new RachnaCloudProvider()
    expect(provider.supportsToolCalling()).toBe(false)
    expect(provider.supportsVision()).toBe(false)
    await expect(provider.agentTurn('', [], [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    }])).rejects.toThrow(/does not currently support agent tools/)
    expect(() => provider.toInternalMessages([{
      role: 'user',
      content: 'inspect this',
      images: [{ base64: 'abc', mimeType: 'image/png' }],
    }])).toThrow(/does not currently support image input/)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
