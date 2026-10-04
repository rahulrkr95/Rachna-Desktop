// lib/providers/geminiRateLimiter.ts
// Client-side guardrails for user-supplied Gemini free-tier API keys.
// These limits are intentionally configurable through localStorage so they can
// be updated without a code change when Google changes public quota tiers.
//
// Enforces both:
//   • RPM (requests per minute) — short sliding window, makes the caller wait.
//   • RPD (requests per day)    — rolling 24h window, throws once exhausted
//     since there's nothing sensible to wait for (could be many hours).

export interface GeminiRateLimit {
  rpm: number
  tpm?: number
  rpd?: number
}

export interface GeminiRateLimitWait {
  providerId: 'gemini'
  model: string
  rpm: number
  waitMs: number
  reason: string
}

export class GeminiDailyQuotaExceededError extends Error {
  constructor(model: string, rpd: number) {
    super(`Gemini free-tier daily quota reached for ${model} (${rpd} requests/day). Try again tomorrow, switch models, or use a different key.`)
    this.name = 'GeminiDailyQuotaExceededError'
  }
}

const STORAGE_KEY = 'rachna_gemini_rate_limit_timestamps_v1'
const DAY_STORAGE_KEY = 'rachna_gemini_rate_limit_daily_v1'
const CONFIG_KEY = 'rachna_gemini_free_rate_limits_v1'
const WINDOW_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

const DEFAULT_GEMINI_FREE_RATE_LIMITS: Record<string, GeminiRateLimit> = {
  'gemini-3.1-flash-lite': { rpm: 15, tpm: 250_000, rpd: 500 },
  'gemini-2.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-3.5-flash': { rpm: 5, tpm: 250_000, rpd: 20 },
  'gemini-2.5-flash-lite': { rpm: 10, tpm: 250_000, rpd: 20 },
  'gemini-2.5-flash-tts': { rpm: 3, tpm: 10_000, rpd: 10 },
}

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined'
}

function readJson<T>(key: string, fallback: T): T {
  if (!storageAvailable()) return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  if (!storageAvailable()) return
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

export function getGeminiFreeRateLimits(): Record<string, GeminiRateLimit> {
  return readJson(CONFIG_KEY, DEFAULT_GEMINI_FREE_RATE_LIMITS)
}

function normalizeModel(model: string): string {
  return model.replace(/^models\//, '').toLowerCase()
}

export function getGeminiFreeRateLimit(model: string): GeminiRateLimit | undefined {
  const limits = getGeminiFreeRateLimits()
  const normalized = normalizeModel(model)
  return limits[normalized]
}

function requestKey(apiKey: string, model: string): string {
  // Avoid persisting the full key while still keeping separate user keys isolated.
  const keyTail = apiKey.slice(-8) || 'empty'
  return `${normalizeModel(model)}:${keyTail}`
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Wait using the same abort-aware timer as the proactive RPM guard. Gemini's
 * RetryInfo responses use this entry point so reactive and proactive waits do
 * not grow separate timing implementations.
 */
export async function waitForGeminiRateLimit(
  model: string,
  waitMs: number,
  signal?: AbortSignal,
  onWait?: (wait: GeminiRateLimitWait) => void
): Promise<void> {
  const limit = getGeminiFreeRateLimit(model)
  onWait?.({
    providerId: 'gemini',
    model: normalizeModel(model),
    rpm: limit?.rpm ?? 0,
    waitMs,
    reason: 'Gemini requested a quota retry delay',
  })
  await sleep(waitMs, signal)
}

/** How many requests have been made today (rolling 24h) for this key+model, and when the oldest one falls out of the window. */
export function getGeminiDailyUsage(apiKey: string, model: string): { count: number; resetAt: number | null } {
  const key = requestKey(apiKey, model)
  const now = Date.now()
  const all = readJson<Record<string, number[]>>(DAY_STORAGE_KEY, {})
  const recent = (all[key] ?? []).filter(ts => now - ts < DAY_MS)
  return { count: recent.length, resetAt: recent.length ? recent[0] + DAY_MS : null }
}

/** How many requests have been made in the current rolling 1-minute window for this key+model, and when the oldest one falls out of the window (i.e. when the count next drops). */
export function getGeminiMinuteUsage(apiKey: string, model: string): { count: number; resetAt: number | null } {
  const key = requestKey(apiKey, model)
  const now = Date.now()
  const all = readJson<Record<string, number[]>>(STORAGE_KEY, {})
  const recent = (all[key] ?? []).filter(ts => now - ts < WINDOW_MS)
  return { count: recent.length, resetAt: recent.length ? recent[0] + WINDOW_MS : null }
}

/**
 * Convenience summary combining `getGeminiDailyUsage` / `getGeminiMinuteUsage`
 * with the configured RPD/RPM caps for `model`, for UI components (chat
 * send-bar banner, usage panel, provider settings) that need to show/warn
 * *before* a request is attempted rather than only after
 * `respectGeminiRpmLimit` throws deep inside the provider call.
 *
 * Returns `null` when the model has no configured daily cap — nothing
 * meaningful to show. (RPM fields are populated whenever `limit.rpm` is
 * set, which is true for every entry in DEFAULT_GEMINI_FREE_RATE_LIMITS.)
 */
export interface GeminiQuotaStatus {
  model: string
  count: number
  rpd: number
  remaining: number
  percentUsed: number
  isExhausted: boolean
  /** True once usage crosses 80% of the daily cap — UI should start warning. */
  isNearLimit: boolean
  resetAt: number | null
  /** Requests-per-minute cap for this model (0 if not configured). */
  rpm: number
  /** Requests made in the current rolling 1-minute window. */
  rpmUsed: number
  /** `rpm - rpmUsed`, floored at 0. */
  rpmRemaining: number
  /** 0-100, floored at `rpm`. */
  rpmPercentUsed: number
  /** When the oldest request in the current minute window falls out of it (i.e. rpmUsed next decreases), or null if no requests this minute. */
  rpmResetAt: number | null
}

export function getGeminiQuotaStatus(apiKey: string, model: string): GeminiQuotaStatus | null {
  const limit = getGeminiFreeRateLimit(model)
  if (!limit?.rpd || limit.rpd <= 0) return null

  const { count, resetAt } = getGeminiDailyUsage(apiKey, model)
  const remaining = Math.max(0, limit.rpd - count)
  const percentUsed = Math.min(100, Math.round((count / limit.rpd) * 100))

  const rpm = limit.rpm ?? 0
  const { count: rpmUsed, resetAt: rpmResetAt } = getGeminiMinuteUsage(apiKey, model)
  const rpmRemaining = rpm > 0 ? Math.max(0, rpm - rpmUsed) : 0
  const rpmPercentUsed = rpm > 0 ? Math.min(100, Math.round((rpmUsed / rpm) * 100)) : 0

  return {
    model: normalizeModel(model),
    count,
    rpd: limit.rpd,
    remaining,
    percentUsed,
    isExhausted: count >= limit.rpd,
    isNearLimit: percentUsed >= 80,
    resetAt,
    rpm,
    rpmUsed,
    rpmRemaining,
    rpmPercentUsed,
    rpmResetAt,
  }
}

export async function respectGeminiRpmLimit(
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  onWait?: (wait: GeminiRateLimitWait) => void
): Promise<void> {
  const limit = getGeminiFreeRateLimit(model)
  if (!limit) return

  // ── Daily cap: nothing sensible to wait for, so fail fast instead ───────
  if (limit.rpd && limit.rpd > 0) {
    const { count } = getGeminiDailyUsage(apiKey, model)
    if (count >= limit.rpd) {
      throw new GeminiDailyQuotaExceededError(normalizeModel(model), limit.rpd)
    }
  }

  // ── Per-minute cap: worth a short wait ───────────────────────────────────
  if (limit.rpm && limit.rpm > 0) {
    const key = requestKey(apiKey, model)
    const now = Date.now()
    const all = readJson<Record<string, number[]>>(STORAGE_KEY, {})
    const recent = (all[key] ?? []).filter(ts => now - ts < WINDOW_MS)

    if (recent.length >= limit.rpm) {
      const waitMs = Math.max(1_000, WINDOW_MS - (now - recent[0]) + 250)
      onWait?.({
        providerId: 'gemini',
        model: normalizeModel(model),
        rpm: limit.rpm,
        waitMs,
        reason: `Respecting Gemini free-key RPM (${limit.rpm}/min)`,
      })
      await waitForGeminiRateLimit(model, waitMs, signal)
      if (signal?.aborted) return
    }
  }

  const afterWait = Date.now()

  // Record this request against both the per-minute and per-day windows.
  const refreshed = readJson<Record<string, number[]>>(STORAGE_KEY, {})
  const key = requestKey(apiKey, model)
  const updated = (refreshed[key] ?? []).filter(ts => afterWait - ts < WINDOW_MS)
  updated.push(afterWait)
  refreshed[key] = updated
  writeJson(STORAGE_KEY, refreshed)

  const dailyAll = readJson<Record<string, number[]>>(DAY_STORAGE_KEY, {})
  const dailyUpdated = (dailyAll[key] ?? []).filter(ts => afterWait - ts < DAY_MS)
  dailyUpdated.push(afterWait)
  dailyAll[key] = dailyUpdated
  writeJson(DAY_STORAGE_KEY, dailyAll)
}
