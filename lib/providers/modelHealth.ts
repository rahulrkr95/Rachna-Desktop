// lib/providers/modelHealth.ts
// Provider-agnostic model health checking.
//
// Validates that a given (provider, apiKey, modelId) combination actually
// works by sending a minimal, cheap completion request through the
// existing AIProvider.agentTurn() interface — the same non-streaming entry
// point the agent loop uses. No provider-specific HTTP/request logic lives
// here; everything goes through the AIProvider abstraction (agentTurn,
// toInternalMessages, isQuotaError, isAbortError), so adding a health check
// for a new provider requires zero changes to this file.

import type { AIProvider } from './types'

// ── Result shape ────────────────────────────────────────────────────────────

export type ModelHealthStatus =
  | 'Healthy'
  | 'Unauthorized'
  | 'RateLimited'
  | 'NotFound'
  | 'Unsupported'
  | 'Timeout'
  | 'NetworkError'
  | 'Unknown'

export interface ModelHealthResult {
  modelId: string
  healthy: boolean
  /** Round-trip time for the health-check request, in milliseconds. */
  latencyMs: number
  /** Unix ms timestamp of when this check completed. */
  lastChecked: number
  /** Human-readable error/failure detail, present when healthy === false. */
  error?: string
  status: ModelHealthStatus
}

export interface ModelHealthCheckOptions {
  /** Abort the check and report it as a timeout after this many ms. Default 15s. */
  timeoutMs?: number
  /** Requested max output tokens for the probe request. Kept intentionally tiny. */
  maxOutputTokens?: number
}

export interface ModelHealthBatchOptions extends ModelHealthCheckOptions {
  /** Max number of in-flight health-check requests at once. Default 6. */
  concurrency?: number
  /** Called as each individual model's result becomes available (streamed, not batched). */
  onResult?: (result: ModelHealthResult) => void
}

// ── Probe request ────────────────────────────────────────────────────────────

/** Minimal, deterministic prompt — cheap on every provider and easy to verify. */
export const HEALTH_CHECK_PROMPT = 'Reply with exactly: OK'

/**
 * Smallest reasonable max-output-tokens budget for a health probe. Some
 * providers reject absurdly small values for certain models, but this is
 * a safe floor across chat-completion style APIs; we're not trying to get
 * a full reply, just confirming the round trip succeeds.
 */
export const HEALTH_CHECK_MAX_TOKENS = 16

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_CONCURRENCY = 6

// ── Error classification ────────────────────────────────────────────────────
//
// Providers throw plain Errors from agentTurn(); by convention (see every
// provider implementation) the message is formatted as
// "<Provider name> API error <status>: <detail>". We lean on that shared
// convention plus the provider's own isQuotaError()/isAbortError() hooks
// (already part of the AIProvider interface) instead of re-deriving
// per-provider error semantics here.

function extractHttpStatus(message: string): number | undefined {
  const match = message.match(/(?:error|status)[\s:]*?(\d{3})\b/i)
  if (!match) return undefined
  const code = Number(match[1])
  return Number.isFinite(code) ? code : undefined
}

function classifyError(
  provider: AIProvider,
  err: unknown,
  timedOut: boolean
): { status: ModelHealthStatus; message: string } {
  const message = err instanceof Error ? err.message : String(err)

  if (timedOut) {
    return { status: 'Timeout', message: message || 'Request timed out' }
  }

  if (provider.isQuotaError(err)) {
    return { status: 'RateLimited', message }
  }

  const httpStatus = extractHttpStatus(message)
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: 'Unauthorized', message }
  }
  if (httpStatus === 404) {
    return { status: 'NotFound', message }
  }
  if (httpStatus === 429) {
    return { status: 'RateLimited', message }
  }
  if (httpStatus === 400 || httpStatus === 422) {
    return { status: 'Unsupported', message }
  }

  if (/network|fetch failed|failed to fetch|econnrefused|enotfound|dns/i.test(message)) {
    return { status: 'NetworkError', message }
  }

  return { status: 'Unknown', message }
}

// ── Single-model check ───────────────────────────────────────────────────────

/**
 * Validates a single model by sending a tiny, deterministic, non-streaming
 * completion request through the provider's existing agentTurn() path.
 * Never throws — failures are reported in the returned result.
 */
export async function checkModelHealth(
  provider: AIProvider,
  apiKey: string,
  modelId: string,
  opts: ModelHealthCheckOptions = {}
): Promise<ModelHealthResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const start = Date.now()

  try {
    const messages = provider.toInternalMessages([
      { role: 'user', content: HEALTH_CHECK_PROMPT },
    ])

    await provider.agentTurn(apiKey, messages, [], {
      model: modelId,
      temperature: 0,
      maxOutputTokens: opts.maxOutputTokens ?? HEALTH_CHECK_MAX_TOKENS,
      signal: controller.signal,
    })

    return {
      modelId,
      healthy: true,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
      status: 'Healthy',
    }
  } catch (err) {
    const { status, message } = classifyError(provider, err, controller.signal.aborted)
    return {
      modelId,
      healthy: false,
      latencyMs: Date.now() - start,
      lastChecked: Date.now(),
      error: message,
      status,
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── Concurrency-limited batch runner ────────────────────────────────────────

/** Tiny inline concurrency limiter — avoids pulling in a bundler-sensitive dep for one use site. */
function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function runOne(): Promise<void> {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await worker(items[i])
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: workerCount }, () => runOne())
  return Promise.all(runners).then(() => results)
}

/**
 * Runs health checks for many models concurrently (bounded by `concurrency`,
 * default 6, reasonable within the 5-10 range requested). Never rejects —
 * each model's outcome (success or failure) is captured in its own result.
 * `onResult` fires as each individual check completes so callers can update
 * UI/cache incrementally instead of waiting for the whole batch.
 */
export async function checkModelsHealth(
  provider: AIProvider,
  apiKey: string,
  modelIds: string[],
  opts: ModelHealthBatchOptions = {}
): Promise<ModelHealthResult[]> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  return runWithConcurrency(modelIds, concurrency, async modelId => {
    const result = await checkModelHealth(provider, apiKey, modelId, opts)
    opts.onResult?.(result)
    return result
  })
}
