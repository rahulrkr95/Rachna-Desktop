// lib/providers/LMStudioProvider.ts
// LM Studio provider — uses LM Studio's own native REST API
// (`/api/v1/models`, `/api/v1/chat`), NOT the OpenAI-compatible surface.
//
// Docs:
//   https://lmstudio.ai/docs/developer/rest/list
//   https://lmstudio.ai/docs/developer/rest/chat
//
// This provider reads the configured base URL at call-time from
// localStorage so users can change it in Settings without restarting.
// Because LM Studio's `/api/v1/models` reports every model it can load
// (any architecture, any publisher), this works with any model — there is
// no hardcoded model allowlist.

import type { AIProvider, ModelInfo, ProviderMessage, ProviderFunctionDeclaration, ProviderAgentTurn, StreamCallbacks, ChatOptions, ProviderUsage } from './types'
import { createLMStudioNativeProvider } from './lmStudioNative'

// ── Config persistence ─────────────────────────────────────────────────────

export const LM_STUDIO_URL_KEY = 'rachna_ide_lmstudio_url'
export const LM_STUDIO_KEY_KEY = 'rachna_ide_lmstudio_apikey'

// Base URL is the LM Studio server root (no trailing /api/v1) — the native API
// lives at `${baseUrl}/api/v1/models` and `${baseUrl}/api/v1/chat`.
export const LM_STUDIO_DEFAULT_URL = 'http://127.0.0.1:1234'

export function getLMStudioBaseUrl(): string {
  try {
    const stored = localStorage.getItem(LM_STUDIO_URL_KEY)
    if (!stored) return LM_STUDIO_DEFAULT_URL
    // Normalize: strip any /api/v1, /v1, or /api suffixes so we always store
    // the bare server root (e.g. http://127.0.0.1:1234)
    return stored
      .trim()
      .replace(/\/api\/v1\/?$/, '')
      .replace(/\/v1\/?$/, '')
      .replace(/\/api\/?$/, '')
      .replace(/\/+$/, '') || LM_STUDIO_DEFAULT_URL
  } catch {
    return LM_STUDIO_DEFAULT_URL
  }
}

export function setLMStudioBaseUrl(url: string): void {
  try {
    const trimmed = url
      .trim()
      .replace(/\/api\/v1\/?$/, '')
      .replace(/\/v1\/?$/, '')
      .replace(/\/api\/?$/, '')
      .replace(/\/+$/, '')
    localStorage.setItem(LM_STUDIO_URL_KEY, trimmed || LM_STUDIO_DEFAULT_URL)
  } catch { /* ignore */ }
}

export function getLMStudioApiKey(): string {
  try {
    return localStorage.getItem(LM_STUDIO_KEY_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setLMStudioApiKey(key: string): void {
  try {
    if (key.trim()) {
      localStorage.setItem(LM_STUDIO_KEY_KEY, key.trim())
    } else {
      localStorage.removeItem(LM_STUDIO_KEY_KEY)
    }
  } catch { /* ignore */ }
}

// ── Dynamic-URL wrapper ────────────────────────────────────────────────────
// We can't create the native impl with a static baseUrl because the user
// may change it in Settings. Instead we create a thin wrapper that builds a
// fresh impl on every call so it always picks up the latest URL/key.

function getImpl() {
  return createLMStudioNativeProvider({
    getBaseUrl: getLMStudioBaseUrl,
    getApiKey: getLMStudioApiKey,
    displayName: 'LM Studio',
  })
}

// ── LMStudioProvider ───────────────────────────────────────────────────────

export class LMStudioProvider implements AIProvider {
  readonly id = 'lmstudio'
  readonly displayName = 'LM Studio'

  isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'))
    )
  }

  isQuotaError(err: unknown): boolean {
    return getImpl().isQuotaError(err)
  }

  supportsVision(): boolean {
    return false
  }

  async listModels(_apiKey: string): Promise<ModelInfo[]> {
    return getImpl().listModels('')
  }

  async getUsage(_apiKey: string): Promise<ProviderUsage> {
    return { status: 'Local model — no usage limits' }
  }

  toInternalMessages(messages: ProviderMessage[]): unknown[] {
    return getImpl().toInternalMessages(messages)
  }

  fromInternalMessages(history: unknown[]): ProviderMessage[] {
    return getImpl().fromInternalMessages(history)
  }

  appendToolResults(
    history: unknown[],
    modelTurn: unknown,
    results: Array<{ name: string; result: Record<string, unknown> }>
  ): unknown[] {
    return getImpl().appendToolResults(history, modelTurn, results)
  }

  async stream(
    _apiKey: string,
    messages: ProviderMessage[],
    callbacks: StreamCallbacks,
    opts?: ChatOptions
  ): Promise<void> {
    return getImpl().stream('', messages, callbacks, opts)
  }

  async agentTurn(
    _apiKey: string,
    messages: unknown[],
    tools: ProviderFunctionDeclaration[],
    opts?: ChatOptions
  ): Promise<ProviderAgentTurn> {
    return getImpl().agentTurn('', messages, tools, opts)
  }
}
