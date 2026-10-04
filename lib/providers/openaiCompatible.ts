// lib/providers/openaiCompatible.ts
// Shared OpenAI-compatible chat completions implementation.
// Used by OpenAIProvider and DeepSeekProvider (DeepSeek exposes an OpenAI-compatible API).

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
import { openAISchemaConverter } from './schemaConverters/OpenAISchemaConverter'

// ── Internal message types ─────────────────────────────────────────────────

export interface OpenAIImageContentPart {
  type: 'image_url'
  image_url: { url: string }
}

export interface OpenAITextContentPart {
  type: 'text'
  text: string
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAICompatibleConfig {
  id: string
  displayName: string
  baseUrl: string
  defaultModel: string
  /** Override the discovery endpoint instead of `${baseUrl}/models`. */
  modelsUrl?: string
  /** HTTP method used for the discovery endpoint. Defaults to GET. */
  modelsMethod?: 'GET' | 'POST'
  /** Override the chat-completions endpoint instead of `${baseUrl}/chat/completions`. */
  chatUrl?: string
  /** HTTP method used for the chat-completions endpoint. Defaults to POST. */
  chatMethod?: 'GET' | 'POST'
  /** Return false to exclude a model from discovery results. */
  filterModel: (modelId: string) => boolean
  /** Optional per-model metadata overrides. */
  modelInfo?: (modelId: string) => Partial<ModelInfo>
  isQuotaError?: (err: unknown) => boolean
  /** Whether this provider's connection accepts image input on user messages. */
  supportsVision?: boolean
  /**
   * When true, request `usage` accounting from the API (adds
   * `stream_options.include_usage` on streaming calls) and surface the most
   * recent token counts through `getUsage()`. Off by default so existing
   * providers keep their exact previous request bodies.
   */
  reportUsage?: boolean
  /** Max retry attempts for transient network/5xx failures before the first byte of a response is read. Default 2. */
  maxRetries?: number
  /** Base delay (ms) for exponential backoff between retries. Default 400. */
  retryDelayMs?: number
}

// ── Token usage tracking (generic — any OpenAI-compatible provider) ────────

interface UsageSnapshot {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  model?: string
  fetchedAt: number
}

// Keyed by `${providerId}:${apiKey}` — in-memory only, never persisted.
const lastUsageByKey = new Map<string, UsageSnapshot>()

function recordUsage(
  providerId: string,
  apiKey: string,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  model?: string
): void {
  if (!usage) return
  lastUsageByKey.set(`${providerId}:${apiKey}`, {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    model,
    fetchedAt: Date.now(),
  })
}

function formatUsage(snapshot: UsageSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined
  const parts: string[] = []
  if (snapshot.promptTokens != null) parts.push(`${snapshot.promptTokens} prompt`)
  if (snapshot.completionTokens != null) parts.push(`${snapshot.completionTokens} completion`)
  if (snapshot.totalTokens != null) parts.push(`${snapshot.totalTokens} total`)
  if (parts.length === 0) return undefined
  const modelSuffix = snapshot.model ? ` (${snapshot.model})` : ''
  return `Last call: ${parts.join(' / ')} tokens${modelSuffix}`
}

// ── Retry helper (network/5xx only — never retries after a body starts) ────

function isRetryableStatus(status: number): boolean {
  return status >= 500 && status < 600
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

/**
 * Fetch with exponential-backoff retries for transient failures
 * (network errors and 5xx responses). Never retries once a non-retryable
 * response (2xx/4xx) has been received, and never retries streamed bodies —
 * only the initial connection attempt is covered.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries: number; retryDelayMs: number; signal?: AbortSignal }
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      const res = await fetch(url, init)
      if (res.ok || !isRetryableStatus(res.status) || attempt === opts.maxRetries) {
        return res
      }
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw err
      }
      lastErr = err
      if (attempt === opts.maxRetries) throw lastErr
    }
    await sleep(opts.retryDelayMs * Math.pow(2, attempt), opts.signal)
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// ── Known context windows (OpenAI does not expose these via /models) ───────

const CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o1-mini': 128_000,
  'o1-preview': 128_000,
  'o3-mini': 200_000,
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'deepseek-coder': 64_000,
}

function stringifyOAIContent(content: string | OpenAIContentPart[] | null | undefined): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map(p => (p.type === 'text' ? p.text : '[image]'))
    .filter(Boolean)
    .join('\n')
}

function inferContextWindow(modelId: string): number | undefined {
  if (CONTEXT_WINDOWS[modelId]) return CONTEXT_WINDOWS[modelId]
  const prefix = Object.keys(CONTEXT_WINDOWS).find(k => modelId.startsWith(k))
  return prefix ? CONTEXT_WINDOWS[prefix] : undefined
}

function inferSupportsTools(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (id.includes('embed') || id.includes('whisper') || id.includes('tts') || id.includes('dall-e')) {
    return false
  }
  if (id.startsWith('o1') && !id.includes('mini')) return false
  return true
}

function inferSupportsVision(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id.includes('gpt-4o') || id.includes('gpt-4-turbo') || id.includes('vision')
}

// This is the single point where generic ProviderFunctionDeclarations (as
// assembled by AgentLoop from built-in tools, MCP tools, and connector
// tools) become the OpenAI-compatible `tools` request field. Each
// declaration's `parameters` schema is re-sanitized here via
// OpenAISchemaConverter for OpenAI's own unsupported-keyword list —
// independent of whatever sanitization (if any) was already applied for a
// different provider. Shared by OpenAIProvider and DeepSeekProvider, both
// of which speak this same OpenAI-compatible tool-calling format.
function buildTools(tools: ProviderFunctionDeclaration[]): unknown[] {
  return tools.map(t => {
    const fn = openAISchemaConverter.convert({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })
    return { type: 'function', function: fn }
  })
}

function buildBody(
  messages: OpenAIMessage[],
  tools: ProviderFunctionDeclaration[],
  opts: ChatOptions,
  stream: boolean,
  reportUsage?: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxOutputTokens ?? 8192,
    stream,
  }
  if (tools.length > 0) {
    body.tools = buildTools(tools)
    body.tool_choice = 'auto'
  }
  if (stream && reportUsage) {
    body.stream_options = { include_usage: true }
  }
  return body
}

// Some OpenAI-compatible backends (local models, smaller hosted models)
// don't reliably emit `function.arguments` as a JSON *object* string — they
// sometimes emit a bare JSON string/array/number (e.g. `"push"` instead of
// `{"action":"push"}`). JSON.parse() happily accepts all of those and
// returns whatever primitive it finds, which previously flowed straight
// through as `args` and blew up downstream tool schemas with
// "Expected object, received string". Guard against every non-object
// outcome here so callers always get a Record<string, unknown>, never a
// bare primitive.
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
  // Parsed successfully but isn't a plain object (string/number/boolean/array/null).
  return { _raw: raw }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }
}

// ── Provider factory ───────────────────────────────────────────────────────

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): AIProvider {
  const maxRetries = config.maxRetries ?? 2
  const retryDelayMs = config.retryDelayMs ?? 400

  const defaultIsQuotaError = (err: unknown): boolean => {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('quota') ||
      msg.includes('insufficient_quota')
    )
  }

  return {
    id: config.id,
    displayName: config.displayName,

    isAbortError(err: unknown): boolean {
      return (
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted'))
      )
    },

    isQuotaError: config.isQuotaError ?? defaultIsQuotaError,

    supportsVision(): boolean {
      return !!config.supportsVision
    },

    async listModels(apiKey: string): Promise<ModelInfo[]> {
      const url = config.modelsUrl || `${config.baseUrl}/models`
      const method = config.modelsMethod ?? 'GET'
      // Content-Type is only valid on requests that carry a body.
      // GET /models has no body — send only the Authorization header.
      const getHeaders: Record<string, string> = apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : {}
      const res = await fetchWithRetry(url, {
        method,
        headers: method === 'GET' ? getHeaders : authHeaders(apiKey),
        ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
      }, { maxRetries, retryDelayMs })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`${config.displayName} API error ${res.status}: ${detail}`)
      }

      const json = await res.json() as {
        data?: { id: string; owned_by?: string }[]
      }

      const models: ModelInfo[] = []
      for (const m of json.data ?? []) {
        if (!config.filterModel(m.id)) continue

        const ctx = inferContextWindow(m.id)
        const overrides = config.modelInfo?.(m.id) ?? {}

        models.push({
          id: m.id,
          displayName: m.id,
          contextWindow: overrides.contextWindow ?? ctx,
          inputTokenLimit: overrides.inputTokenLimit ?? ctx,
          outputTokenLimit: overrides.outputTokenLimit ?? 8192,
          supportsTools: overrides.supportsTools ?? inferSupportsTools(m.id),
          supportsVision: overrides.supportsVision ?? inferSupportsVision(m.id),
          supportsStreaming: overrides.supportsStreaming ?? true,
        })
      }

      models.sort((a, b) => a.id.localeCompare(b.id))
      return models
    },

    async getUsage(apiKey: string): Promise<ProviderUsage> {
      const snapshot = lastUsageByKey.get(`${config.id}:${apiKey}`)
      const formatted = formatUsage(snapshot)
      return { status: formatted ?? `Usage data unavailable for ${config.displayName}` }
    },

    toInternalMessages(messages: ProviderMessage[]): OpenAIMessage[] {
      return messages.map(m => {
        if (m.images?.length) {
          const parts: OpenAIContentPart[] = [
            { type: 'text', text: m.content },
            ...m.images.map((img): OpenAIContentPart => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
          ]
          return { role: m.role === 'assistant' ? 'assistant' : 'user', content: parts }
        }
        return {
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        }
      })
    },

    fromInternalMessages(history: unknown[]): ProviderMessage[] {
      return (history as OpenAIMessage[]).map(m => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: `[Tool result: ${stringifyOAIContent(m.content)}]`,
          }
        }
        if (m.role === 'assistant' && m.tool_calls?.length) {
          const callSummary = m.tool_calls
            .map(tc => `[Called ${tc.function.name}(${tc.function.arguments})]`)
            .join('\n')
          const text = stringifyOAIContent(m.content)
          return {
            role: 'assistant',
            content: [text, callSummary].filter(Boolean).join('\n'),
          }
        }
        if (m.role === 'system') {
          return { role: 'user', content: `[System: ${stringifyOAIContent(m.content)}]` }
        }
        return {
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: stringifyOAIContent(m.content),
        }
      })
    },

    appendToolResults(
      history: unknown[],
      modelTurn: unknown,
      results: Array<{ name: string; result: Record<string, unknown> }>
    ): unknown[] {
      const msgs = [...(history as OpenAIMessage[])]
      const turn = modelTurn as OpenAIMessage
      const toolCalls = turn.tool_calls ?? []

      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        const matched =
          toolCalls.find(tc => tc.function.name === r.name && !msgs.some(
            m => m.role === 'tool' && m.tool_call_id === tc.id
          )) ?? toolCalls[i]

        msgs.push({
          role: 'tool',
          tool_call_id: matched?.id ?? `call_${r.name}_${i}`,
          content: JSON.stringify(r.result),
        })
      }
      return msgs
    },

    async stream(
      apiKey: string,
      messages: ProviderMessage[],
      callbacks: StreamCallbacks,
      opts: ChatOptions = {}
    ): Promise<void> {
      const model = opts.model ?? config.defaultModel
      const url = config.chatUrl || `${config.baseUrl}/chat/completions`
      const method = config.chatMethod ?? 'POST'

      const internal = this.toInternalMessages(messages) as OpenAIMessage[]
      const apiMessages: OpenAIMessage[] = opts.systemInstruction
        ? [{ role: 'system', content: opts.systemInstruction }, ...internal]
        : internal

      if (opts.signal?.aborted) return

      let response: Response
      try {
        response = await fetchWithRetry(url, {
          method,
          headers: authHeaders(apiKey),
          ...(method === 'POST' ? { body: JSON.stringify(buildBody(apiMessages, [], { ...opts, model }, true, config.reportUsage)) } : {}),
          signal: opts.signal,
        }, { maxRetries, retryDelayMs, signal: opts.signal })
      } catch (err) {
        if (this.isAbortError(err)) return
        callbacks.onError(err instanceof Error ? err : new Error(String(err)))
        return
      }

      if (!response.ok) {
        let detail = ''
        try { detail = await response.text() } catch { /* ignore */ }
        callbacks.onError(new Error(`${config.displayName} API error ${response.status}: ${detail}`))
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        callbacks.onError(new Error('Response body is not readable'))
        return
      }

      const decoder = new TextDecoder()
      let accumulated = ''
      let buffer = ''

      const abortHandler = () => { reader.cancel().catch(() => {}) }
      opts.signal?.addEventListener('abort', abortHandler)

      try {
        while (true) {
          if (opts.signal?.aborted) break
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') continue
            try {
              const parsed = JSON.parse(data) as {
                choices?: { delta?: { content?: string } }[]
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
              }
              const chunk = parsed?.choices?.[0]?.delta?.content ?? ''
              if (chunk) {
                accumulated += chunk
                callbacks.onChunk(chunk)
              }
              if (config.reportUsage && parsed.usage) {
                recordUsage(config.id, apiKey, parsed.usage, model)
              }
            } catch { /* malformed chunk */ }
          }
        }

        if (opts.signal?.aborted) return
        callbacks.onDone(accumulated)
      } catch (err) {
        if (this.isAbortError(err)) return
        callbacks.onError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        opts.signal?.removeEventListener('abort', abortHandler)
        reader.releaseLock()
      }
    },

    async agentTurn(
      apiKey: string,
      messages: unknown[],
      tools: ProviderFunctionDeclaration[],
      opts: ChatOptions = {}
    ): Promise<ProviderAgentTurn> {
      const model = opts.model ?? config.defaultModel
      const url = config.chatUrl || `${config.baseUrl}/chat/completions`
      const method = config.chatMethod ?? 'POST'
      const history = messages as OpenAIMessage[]

      const apiMessages: OpenAIMessage[] = opts.systemInstruction
        ? [{ role: 'system', content: opts.systemInstruction }, ...history]
        : history

      const res = await fetchWithRetry(url, {
        method,
        headers: authHeaders(apiKey),
        ...(method === 'POST' ? { body: JSON.stringify(buildBody(apiMessages, tools, { ...opts, model }, false, config.reportUsage)) } : {}),
        signal: opts.signal,
      }, { maxRetries, retryDelayMs, signal: opts.signal })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`${config.displayName} API error ${res.status}: ${detail}`)
      }

      const json = await res.json() as {
        choices?: {
          message?: {
            role?: string
            content?: string | null
            tool_calls?: OpenAIToolCall[]
          }
        }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }

      if (config.reportUsage && json.usage) {
        recordUsage(config.id, apiKey, json.usage, model)
      }

      const message = json?.choices?.[0]?.message
      const text = message?.content ?? ''
      const rawCalls = message?.tool_calls ?? []

      const functionCalls: ProviderAgentTurn['functionCalls'] = rawCalls.map(tc => ({
        name: tc.function.name,
        args: parseToolArgs(tc.function.arguments),
      }))

      const modelTurn: OpenAIMessage = {
        role: 'assistant',
        content: text || null,
        ...(rawCalls.length > 0 ? { tool_calls: rawCalls } : {}),
      }

      return { text, functionCalls, modelTurn }
    },
  }
}
