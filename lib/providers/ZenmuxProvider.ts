// lib/providers/ZenmuxProvider.ts
// Zenmux provider — OpenAI-compatible API gateway / proxy
//
// ALL network calls are routed through the Tauri backend (reqwest) rather than
// the webview's `fetch` API. This is required because:
//   1. Zenmux's server does not include Tauri's internal webview origin in its
//      Access-Control-Allow-Origin header, so direct `fetch` calls CORS-fail.
//   2. The GET /models request must NOT carry a `Content-Type: application/json`
//      header — Content-Type is only meaningful on requests that have a body.
//
// Three Tauri commands are used:
//   run_http_request   → listModels, agentTurn  (non-streaming)
//   proxy_llm_stream   → stream  (SSE streaming, emits events per chunk)

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  AIProvider,
  ModelInfo,
  ProviderMessage,
  ProviderFunctionDeclaration,
  ProviderAgentTurn,
  StreamCallbacks,
  ChatOptions,
  ProviderUsage,
} from './types'
import {
  createOpenAICompatibleProvider,
  type OpenAIMessage,
} from './openaiCompatible'

// ── Config persistence ─────────────────────────────────────────────────────

export const ZENMUX_URL_KEY     = 'rachna_ide_zenmux_url'
export const ZENMUX_DEFAULT_URL = 'https://zenmux.ai/api/v1'
export const ZENMUX_PAYG_URL    = 'https://zenmux.ai/api/v1'

export function getZenmuxBaseUrl(): string {
  try { return localStorage.getItem(ZENMUX_URL_KEY) || ZENMUX_DEFAULT_URL } catch { return ZENMUX_DEFAULT_URL }
}
export function setZenmuxBaseUrl(url: string): void {
  try { localStorage.setItem(ZENMUX_URL_KEY, url.trim() || ZENMUX_DEFAULT_URL) } catch { /* ignore */ }
}

export const ZENMUX_API_KEY_KEY = 'rachna_ide_zenmux_api_key'
export const ZENMUX_MODE_KEY    = 'rachna_ide_zenmux_mode'
export type ZenmuxMode = 'cloud' | 'selfhosted'

export function getZenmuxMode(): ZenmuxMode {
  try { return (localStorage.getItem(ZENMUX_MODE_KEY) as ZenmuxMode) || 'cloud' } catch { return 'cloud' }
}
export function setZenmuxMode(mode: ZenmuxMode): void {
  try { localStorage.setItem(ZENMUX_MODE_KEY, mode) } catch { /* ignore */ }
}
export function getZenmuxPaygKey(): string {
  try { return localStorage.getItem(ZENMUX_API_KEY_KEY) || '' } catch { return '' }
}
export function setZenmuxPaygKey(key: string): void {
  try { localStorage.setItem(ZENMUX_API_KEY_KEY, key.trim()) } catch { /* ignore */ }
}

// ── Request timeout ─────────────────────────────────────────────────────────
// Applies to both agentTurn (non-streaming) and stream calls — the two
// long-running requests that can hit "Request timed out after Ns" when a
// model takes a while to respond. User-configurable so a timeout can be
// raised after a failure without editing code.

export const ZENMUX_TIMEOUT_KEY            = 'rachna_ide_zenmux_timeout_seconds'
export const ZENMUX_DEFAULT_TIMEOUT_SECONDS = 120
export const ZENMUX_MIN_TIMEOUT_SECONDS     = 30
export const ZENMUX_MAX_TIMEOUT_SECONDS     = 600

export function getZenmuxTimeoutSeconds(): number {
  try {
    const raw    = localStorage.getItem(ZENMUX_TIMEOUT_KEY)
    const parsed = raw ? parseInt(raw, 10) : NaN
    if (Number.isFinite(parsed) && parsed >= ZENMUX_MIN_TIMEOUT_SECONDS && parsed <= ZENMUX_MAX_TIMEOUT_SECONDS) {
      return parsed
    }
    return ZENMUX_DEFAULT_TIMEOUT_SECONDS
  } catch {
    return ZENMUX_DEFAULT_TIMEOUT_SECONDS
  }
}

export function setZenmuxTimeoutSeconds(seconds: number): void {
  try {
    const clamped = Math.min(ZENMUX_MAX_TIMEOUT_SECONDS, Math.max(ZENMUX_MIN_TIMEOUT_SECONDS, Math.round(seconds)))
    localStorage.setItem(ZENMUX_TIMEOUT_KEY, String(clamped))
  } catch { /* ignore */ }
}

/** Clears the override, falling back to ZENMUX_DEFAULT_TIMEOUT_SECONDS. */
export function resetZenmuxTimeoutSeconds(): void {
  try { localStorage.removeItem(ZENMUX_TIMEOUT_KEY) } catch { /* ignore */ }
}

// ── Model filter / info ────────────────────────────────────────────────────

function isZenmuxChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (id.includes('embed') || id.includes('rerank') || id.includes('bge-') || id.includes('minilm')) return false
  return true
}

function zenmuxModelInfo(modelId: string): Partial<ModelInfo> {
  const id = modelId.toLowerCase()
  const supportsVision =
    id.includes('vision') || id.includes('vl') || id.includes('4o') ||
    id.includes('claude-3') || id.includes('gemini')
  const supportsTools =
    id.includes('gpt-4') || id.includes('gpt-3.5') ||
    id.includes('claude') || id.includes('gemini') ||
    id.includes('llama-3') || id.includes('mistral') ||
    id.includes('qwen') || id.includes('command-r')
  return { supportsTools, supportsVision, supportsStreaming: true }
}

// ── HTTP header builders ───────────────────────────────────────────────────

/** Headers for POST requests — Content-Type + optional Authorization. */
function postHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
  return h
}

// ── Tauri HTTP result shape (mirrors HttpResponseOutput in commands.rs) ────

interface TauriHttpResult {
  status:      number
  status_text: string
  headers:     Record<string, string>
  body:        string
  ok:          boolean
  duration_ms: number
  timed_out:   boolean
}

// ── Tool arg parser (mirrors openaiCompatible) ─────────────────────────────

// Mirrors openaiCompatible.ts's parseToolArgs — see the comment there.
// JSON.parse() accepts bare JSON strings/arrays/numbers, not just objects,
// so a model that emits `arguments: "\"push\""` would otherwise pass a raw
// string straight through as `args` and fail tool schema validation with
// "Expected object, received string".
function parseToolArgs(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return { _raw: raw }
}

// ── Message format helper (reuse openaiCompatible's conversion logic) ──────
// We instantiate a dummy config just to get the toInternalMessages /
// fromInternalMessages / appendToolResults methods; no network calls are made
// through this instance.

function getFormatHelper() {
  return createOpenAICompatibleProvider({
    id: 'zenmux',
    displayName: 'Zenmux',
    baseUrl: getZenmuxBaseUrl(),
    defaultModel: '',
    filterModel: isZenmuxChatModel,
    modelInfo: zenmuxModelInfo,
    supportsVision: true,
    isQuotaError: (err: unknown) => {
      if (!(err instanceof Error)) return false
      const msg = err.message.toLowerCase()
      return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    },
  })
}

// ── ZenmuxProvider ─────────────────────────────────────────────────────────

export class ZenmuxProvider implements AIProvider {
  readonly id          = 'zenmux'
  readonly displayName = 'Zenmux'

  isAbortError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))
  }

  isQuotaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
  }

  supportsVision(): boolean { return true }

  // ── listModels ─────────────────────────────────────────────────────────
  // Routes through run_http_request (reqwest) — no CORS, correct GET headers.

  async listModels(_apiKey: string): Promise<ModelInfo[]> {
    const baseUrl = getZenmuxBaseUrl()
    const url     = `${baseUrl.replace(/\/+$/, '')}/models`

    // Simple unauthenticated GET — no Authorization, no Content-Type.
    // Equivalent to: curl https://zenmux.ai/api/v1/models
    // Routed through Tauri (reqwest) to avoid webview CORS restrictions.
    let result: TauriHttpResult
    try {
      result = await invoke<TauriHttpResult>('run_http_request', {
        args: {
          url,
          method:          'GET',
          headers:         undefined,
          body:            undefined,
          timeout_seconds: 30,
        },
      })
    } catch (err) {
      throw new Error(`Zenmux listModels failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!result.ok) {
      throw new Error(`Zenmux API error ${result.status}: ${result.body}`)
    }

    const json = JSON.parse(result.body) as { data?: { id: string }[] }
    return (json.data ?? [])
      .filter(m => isZenmuxChatModel(m.id))
      .map(m => {
        const overrides = zenmuxModelInfo(m.id)
        return {
          id:              m.id,
          displayName:     m.id,
          contextWindow:   undefined,
          inputTokenLimit: undefined,
          outputTokenLimit: 8192,
          supportsTools:   overrides.supportsTools   ?? true,
          supportsVision:  overrides.supportsVision  ?? false,
          supportsStreaming: true,
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  async getUsage(_apiKey: string): Promise<ProviderUsage> {
    return { status: 'Usage data unavailable for Zenmux' }
  }

  // ── Message format (delegate to openaiCompatible helper) ──────────────

  toInternalMessages(messages: Parameters<AIProvider['toInternalMessages']>[0]) {
    return getFormatHelper().toInternalMessages(messages)
  }

  fromInternalMessages(history: unknown[]) {
    return getFormatHelper().fromInternalMessages(history)
  }

  appendToolResults(
    history: unknown[],
    modelTurn: unknown,
    results: Array<{ name: string; result: Record<string, unknown> }>,
  ) {
    return getFormatHelper().appendToolResults(history, modelTurn, results)
  }

  // ── stream ─────────────────────────────────────────────────────────────
  // Routes through proxy_llm_stream (reqwest SSE) — no CORS.
  // The Rust command emits per-chunk Tauri events; we listen and forward
  // them to the StreamCallbacks just like openaiCompatible does inline.

  async stream(
    apiKey:    string,
    messages:  Parameters<AIProvider['stream']>[1],
    callbacks: Parameters<AIProvider['stream']>[2],
    opts?:     Parameters<AIProvider['stream']>[3],
  ): Promise<void> {
    const model   = opts?.model ?? ''
    const baseUrl = getZenmuxBaseUrl()
    const url     = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

    const internal    = this.toInternalMessages(messages) as OpenAIMessage[]
    const apiMessages = opts?.systemInstruction
      ? [{ role: 'system' as const, content: opts.systemInstruction }, ...internal]
      : internal

    const body = JSON.stringify({
      model,
      messages:    apiMessages,
      temperature: opts?.temperature    ?? 0.7,
      max_tokens:  opts?.maxOutputTokens ?? 8192,
      stream:      true,
    })

    if (opts?.signal?.aborted) return

    const eventId   = crypto.randomUUID()
    let accumulated = ''
    let settled     = false   // guard: callbacks called at most once

    // Register Tauri event listeners BEFORE invoking the command so no
    // events are missed (the command may emit immediately upon connection).
    const unlistenChunk = await listen<{ data: string }>(
      `llm-stream-chunk-${eventId}`,
      (ev) => {
        if (settled || opts?.signal?.aborted) return
        try {
          const parsed = JSON.parse(ev.payload.data) as {
            choices?: { delta?: { content?: string } }[]
          }
          const chunk = parsed?.choices?.[0]?.delta?.content ?? ''
          if (chunk) { accumulated += chunk; callbacks.onChunk(chunk) }
        } catch { /* malformed SSE chunk — skip */ }
      },
    )

    const unlistenDone = await listen(
      `llm-stream-done-${eventId}`,
      () => {
        if (!settled) { settled = true; callbacks.onDone(accumulated) }
        cleanup()
      },
    )

    const unlistenError = await listen<{ message: string }>(
      `llm-stream-error-${eventId}`,
      (ev) => {
        if (!settled) { settled = true; callbacks.onError(new Error(ev.payload.message)) }
        cleanup()
      },
    )

    function cleanup() {
      unlistenChunk()
      unlistenDone()
      unlistenError()
    }

    try {
      // This await resolves only after the Rust command returns (i.e. after
      // the stream finishes and done/error was already emitted). The event
      // listeners above fire during the await.
      await invoke('proxy_llm_stream', {
        eventId,
        url,
        headers: postHeaders(apiKey),
        body,
        timeoutSeconds: getZenmuxTimeoutSeconds(),
      })
    } catch (err) {
      // Tauri command itself failed (e.g. reqwest build error) — the
      // done/error events were never emitted, so we settle here.
      if (!settled) {
        settled = true
        if (!this.isAbortError(err)) {
          callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        }
      }
      cleanup()
    }
  }

  // ── agentTurn ──────────────────────────────────────────────────────────
  // Non-streaming POST — routes through run_http_request (reqwest, no CORS).

  async agentTurn(
    apiKey:    string,
    messages:  unknown[],
    tools:     Parameters<AIProvider['agentTurn']>[2],
    opts?:     Parameters<AIProvider['agentTurn']>[3],
  ): Promise<ProviderAgentTurn> {
    const model   = opts?.model ?? ''
    const baseUrl = getZenmuxBaseUrl()
    const url     = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

    const history     = messages as OpenAIMessage[]
    const apiMessages = opts?.systemInstruction
      ? [{ role: 'system' as const, content: opts.systemInstruction }, ...history]
      : history

    const builtTools = tools.map(t => ({
      type:     'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))

    const bodyObj: Record<string, unknown> = {
      model,
      messages:    apiMessages,
      temperature: opts?.temperature    ?? 0.7,
      max_tokens:  opts?.maxOutputTokens ?? 8192,
      stream:      false,
    }
    if (builtTools.length > 0) {
      bodyObj.tools       = builtTools
      bodyObj.tool_choice = 'auto'
    }

    let result: TauriHttpResult
    try {
      result = await invoke<TauriHttpResult>('run_http_request', {
        args: {
          url,
          method:          'POST',
          headers:         postHeaders(apiKey),
          body:            JSON.stringify(bodyObj),
          timeout_seconds: getZenmuxTimeoutSeconds(),
        },
      })
    } catch (err) {
      throw new Error(`Zenmux agentTurn failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!result.ok) {
      throw new Error(`Zenmux API error ${result.status}: ${result.body}`)
    }

    type OAIToolCall = { id: string; type: string; function: { name: string; arguments: string } }
    const json = JSON.parse(result.body) as {
      choices?: { message?: { content?: string | null; tool_calls?: OAIToolCall[] } }[]
    }

    const message    = json?.choices?.[0]?.message
    const text       = message?.content ?? ''
    const rawCalls   = message?.tool_calls ?? []

    const functionCalls: ProviderAgentTurn['functionCalls'] = rawCalls.map(tc => ({
      name: tc.function.name,
      args: parseToolArgs(tc.function.arguments),
    }))

    const modelTurn: OpenAIMessage = {
      role:    'assistant',
      content: text || null,
      ...(rawCalls.length > 0 ? {
        tool_calls: rawCalls.map(tc => ({
          ...tc,
          type: 'function' as const,
        }))
      } : {}),
    }

    return { text, functionCalls, modelTurn }
  }
}
