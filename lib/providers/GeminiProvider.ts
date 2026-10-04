// lib/providers/GeminiProvider.ts
// Wraps the existing Gemini API calls behind the AIProvider interface.
// The rest of the app (AgentLoop, AiChat) never imports from lib/gemini.ts
// directly — they go through the provider registry.

import type {
  AIProvider,
  ModelInfo,
  ProviderMessage,
  ProviderFunctionDeclaration,
  ProviderAgentTurn,
  StreamCallbacks,
  ChatOptions,
  ProviderUsage,
  PendingFileAttachment,
} from './types'
import {
  GeminiDailyQuotaExceededError,
  respectGeminiRpmLimit,
  waitForGeminiRateLimit,
} from './geminiRateLimiter'
import { recordGeminiUsage, type GeminiUsageMetadata } from './geminiUsageTracker'
import { emitRateLimitWait } from './rateLimitEvents'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ── Internal message types (mirrors what Gemini API expects) ──────────────

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiMessage {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

// ── Helper functions ───────────────────────────────────────────────────────

function buildBody(
  messages: GeminiMessage[],
  tools: ProviderFunctionDeclaration[],
  opts: ChatOptions
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: messages,
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  }
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] }
  }
  if (tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }]
  }
  return body
}

/**
 * Appends any queued file attachments (opts.attachments — see
 * lib/pendingAttachments.ts) as extra inlineData parts on the last message,
 * so they go out with this one request. Returns the same array unchanged
 * when there's nothing to attach.
 */
function withAttachments(messages: GeminiMessage[], attachments?: PendingFileAttachment[]): GeminiMessage[] {
  if (!attachments || attachments.length === 0) return messages
  if (messages.length === 0) return messages
  const attachmentParts: GeminiPart[] = attachments.map(a => ({
    inlineData: { mimeType: a.mimeType, data: a.base64 },
  }))
  const last = messages[messages.length - 1]
  const updatedLast: GeminiMessage = { ...last, parts: [...last.parts, ...attachmentParts] }
  return [...messages.slice(0, -1), updatedLast]
}

function extractText(parsed: unknown): string {
  try {
    const p = parsed as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    return p?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  } catch {
    return ''
  }
}

function extractUsage(parsed: unknown): GeminiUsageMetadata | undefined {
  try {
    const p = parsed as { usageMetadata?: GeminiUsageMetadata }
    return p?.usageMetadata
  } catch {
    return undefined
  }
}

interface GeminiQuotaResponse {
  error?: {
    code?: number
    status?: string
    message?: string
    details?: Array<Record<string, unknown>>
  }
}

export interface GeminiQuotaErrorInfo {
  kind: 'retryable' | 'daily' | 'hard'
  retryDelayMs?: number
}

function parseRetryDelay(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d+(?:\.\d+)?)s$/)
  if (!match) return undefined
  const milliseconds = Number(match[1]) * 1_000
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined
}

/** Classify Gemini's google.rpc error details without relying on message text. */
export function parseGeminiQuotaError(payload: unknown): GeminiQuotaErrorInfo {
  const error = (payload as GeminiQuotaResponse | null)?.error
  const details = Array.isArray(error?.details) ? error.details : []
  const retryInfo = details.find(detail =>
    String(detail['@type'] ?? '').endsWith('google.rpc.RetryInfo')
  )
  const retryDelayMs = parseRetryDelay(retryInfo?.retryDelay)

  const quotaText = details
    .flatMap(detail => Array.isArray(detail.violations) ? detail.violations : [detail])
    .map(value => JSON.stringify(value).toLowerCase())
    .join(' ')

  // Gemini supplies RetryInfo for short-lived request/token-per-minute
  // exhaustion. Daily and billing/hard quota failures intentionally continue
  // through the existing key-failover path.
  if (retryDelayMs !== undefined) return { kind: 'retryable', retryDelayMs }
  if (/per.?day|requests?.?per.?day|\brpd\b|daily/.test(quotaText)) return { kind: 'daily' }
  return { kind: 'hard' }
}

class GeminiApiError extends Error {
  constructor(
    status: number,
    detail: string,
    readonly quotaKind?: GeminiQuotaErrorInfo['kind']
  ) {
    super(`Gemini API error ${status}: ${detail}`)
    this.name = 'GeminiApiError'
  }
}

function quotaError(status: number, detail: string, quotaKind?: GeminiQuotaErrorInfo['kind']): Error {
  return new GeminiApiError(status, detail, quotaKind)
}

export interface GeminiProviderOptions {
  /** Number of retryable Gemini 429 responses to retry before surfacing the error. */
  maxRateLimitRetries?: number
}

const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3

async function fetchGemini(
  apiKey: string,
  model: string,
  url: string,
  init: RequestInit,
  maxRateLimitRetries: number,
  signal?: AbortSignal
): Promise<Response> {
  for (let retryCount = 0; ; retryCount += 1) {
    await respectGeminiRpmLimit(apiKey, model, signal, wait => {
      console.info(`[Gemini rate limit] ${wait.reason} — waiting ~${Math.round(wait.waitMs / 1000)}s`)
      emitRateLimitWait(wait)
    })
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')

    const response = await fetch(url, init)
    if (response.status !== 429) return response

    const detail = await response.text().catch(() => '')
    let parsed: unknown
    try { parsed = JSON.parse(detail) } catch { parsed = undefined }
    const quota = parseGeminiQuotaError(parsed)
    if (quota.kind !== 'retryable') throw quotaError(response.status, detail, quota.kind)
    if (retryCount >= maxRateLimitRetries) {
      throw quotaError(response.status, detail, quota.kind)
    }

    // The rejected attempt was already recorded by respectGeminiRpmLimit.
    // Waiting here and passing through it again before retrying keeps the
    // existing RPM/RPD counters (and their UI readers) as the sole tracker.
    await waitForGeminiRateLimit(model, quota.retryDelayMs!, signal, wait => {
      console.info(`[Gemini rate limit] ${wait.reason} — waiting ~${Math.round(wait.waitMs / 1000)}s`)
      emitRateLimitWait(wait)
    })
  }
}

// ── GeminiProvider ─────────────────────────────────────────────────────────

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini'
  readonly displayName = 'Google Gemini'

  private readonly maxRateLimitRetries: number

  constructor(options: GeminiProviderOptions = {}) {
    const configuredRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES
    this.maxRateLimitRetries = Number.isFinite(configuredRetries)
      ? Math.max(0, Math.floor(configuredRetries))
      : DEFAULT_MAX_RATE_LIMIT_RETRIES
  }

  isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === 'AbortError' || err.message === 'The user aborted a request.')
    )
  }

  isQuotaError(err: unknown): boolean {
    return err instanceof GeminiDailyQuotaExceededError || (
      err instanceof GeminiApiError &&
      (err.quotaKind === 'daily' || err.quotaKind === 'hard')
    )
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    const url = `${GEMINI_BASE}/models?key=${apiKey}&pageSize=100`
    const res = await fetch(url)
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Gemini API error ${res.status}: ${detail}`)
    }
    const json = await res.json() as {
      models?: {
        name: string
        displayName: string
        inputTokenLimit?: number
        outputTokenLimit?: number
        supportedGenerationMethods?: string[]
        description?: string
      }[]
    }

    const models: ModelInfo[] = []
    for (const m of json.models ?? []) {
      const methods = m.supportedGenerationMethods ?? []
      const canGenerate = methods.includes('generateContent') || methods.includes('streamGenerateContent')
      if (!canGenerate) continue

      // Extract the short model id from the full name ("models/gemini-2.5-flash" → "gemini-2.5-flash")
      const shortId = m.name.replace(/^models\//, '')
      const inputLimit = m.inputTokenLimit ?? 0
      const outputLimit = m.outputTokenLimit ?? 0

      models.push({
        id: shortId,
        displayName: m.displayName || shortId,
        contextWindow: inputLimit + outputLimit || undefined,
        inputTokenLimit: inputLimit || undefined,
        outputTokenLimit: outputLimit || undefined,
        supportsTools: methods.includes('generateContent'),
        supportsVision: shortId.includes('vision') || inputLimit > 100_000,
        supportsStreaming: methods.includes('streamGenerateContent'),
      })
    }

    // Sort: flash models first (fastest), then pro, then others
    models.sort((a, b) => {
      const score = (m: ModelInfo) => {
        if (m.id.includes('flash')) return 0
        if (m.id.includes('pro')) return 1
        return 2
      }
      return score(a) - score(b) || a.id.localeCompare(b.id)
    })

    return models
  }

  async getUsage(_apiKey: string): Promise<ProviderUsage> {
    // Gemini doesn't expose a public usage endpoint; return a placeholder
    return { status: 'Usage data unavailable for Gemini' }
  }

  toInternalMessages(messages: ProviderMessage[]): GeminiMessage[] {
    return messages.map(m => {
      const parts: GeminiPart[] = m.images?.length
        ? [
            ...m.images.map((img): GeminiPart => ({
              inlineData: { mimeType: img.mimeType, data: img.base64 },
            })),
            { text: m.content },
          ]
        : [{ text: m.content }]
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      }
    })
  }

  supportsVision(): boolean {
    return true
  }

  supportsFileAttachments(): boolean {
    return true
  }

  mapFileAttachment(attachment: PendingFileAttachment): GeminiPart {
    return { inlineData: { mimeType: attachment.mimeType, data: attachment.base64 } }
  }

  fromInternalMessages(history: unknown[]): ProviderMessage[] {
    return (history as GeminiMessage[]).map(m => ({
      role: m.role === 'model' ? 'assistant' : 'user',
      content: m.parts
        .map(p => {
          if (p.text) return p.text
          if (p.functionCall) return `[Called ${p.functionCall.name}(${JSON.stringify(p.functionCall.args)})]`
          if (p.functionResponse) return `[Result of ${p.functionResponse.name}: ${JSON.stringify(p.functionResponse.response)}]`
          return ''
        })
        .join('\n'),
    }))
  }

  appendToolResults(
    history: unknown[],
    _modelTurn: unknown,
    results: Array<{ name: string; result: Record<string, unknown> }>
  ): unknown[] {
    const functionResponseMessage: GeminiMessage = {
      role: 'user',
      parts: results.map(r => ({
        functionResponse: {
          name: r.name,
          response: r.result,
        },
      })),
    }
    return [...(history as GeminiMessage[]), functionResponseMessage]
  }

  async stream(
    apiKey: string,
    messages: ProviderMessage[],
    callbacks: StreamCallbacks,
    opts: ChatOptions = {}
  ): Promise<void> {
    const model = opts.model ?? 'gemini-2.5-flash'

    const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    const geminiMessages = this.toInternalMessages(messages)

    if (opts.signal?.aborted) return

    let response: Response
    try {
      response = await fetchGemini(apiKey, model, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(withAttachments(geminiMessages, opts.attachments), [], opts)),
        signal: opts.signal,
      }, this.maxRateLimitRetries, opts.signal)
    } catch (err) {
      if (this.isAbortError(err)) return
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
      return
    }

    if (!response.ok) {
      let detail = ''
      try { detail = await response.text() } catch { /* ignore */ }
      callbacks.onError(quotaError(response.status, detail))
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
    let lastUsage: GeminiUsageMetadata | undefined

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
            const parsed = JSON.parse(data)
            const chunk = extractText(parsed)
            if (chunk) {
              accumulated += chunk
              callbacks.onChunk(chunk)
            }
            const usage = extractUsage(parsed)
            if (usage) lastUsage = usage
          } catch { /* malformed chunk */ }
        }
      }

      if (opts.signal?.aborted) return
      if (lastUsage) recordGeminiUsage(model, lastUsage)
      callbacks.onDone(accumulated)
    } catch (err) {
      if (this.isAbortError(err)) return
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      opts.signal?.removeEventListener('abort', abortHandler)
      reader.releaseLock()
    }
  }

  async agentTurn(
    apiKey: string,
    messages: unknown[],
    tools: ProviderFunctionDeclaration[],
    opts: ChatOptions = {}
  ): Promise<ProviderAgentTurn> {
    const model = opts.model ?? 'gemini-2.5-flash'
    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`
    const geminiMessages = messages as GeminiMessage[]

    const res = await fetchGemini(apiKey, model, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(withAttachments(geminiMessages, opts.attachments), tools, opts)),
      signal: opts.signal,
    }, this.maxRateLimitRetries, opts.signal)

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw quotaError(res.status, detail)
    }

    const json = await res.json() as {
      candidates?: { content?: { role?: string; parts?: GeminiPart[] } }[]
      usageMetadata?: GeminiUsageMetadata
    }

    if (json.usageMetadata) recordGeminiUsage(model, json.usageMetadata)

    const content = json?.candidates?.[0]?.content
    const parts = content?.parts ?? []

    let text = ''
    const functionCalls: ProviderAgentTurn['functionCalls'] = []

    for (const part of parts) {
      if (part.text) {
        text += part.text
      } else if (part.functionCall) {
        functionCalls.push({
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
        })
      }
    }

    const modelMessage: GeminiMessage = {
      role: 'model',
      parts: parts.length > 0 ? parts : [{ text }],
    }

    return {
      text,
      functionCalls,
      modelTurn: modelMessage,
    }
  }
}
