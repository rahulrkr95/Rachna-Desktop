// lib/providers/openRouterRateLimiter.ts
// Client-side guardrails for OpenRouter's free-tier models — any model whose
// id ends in ":free" (e.g. "meta-llama/llama-3.1-8b-instruct:free").
//
// OpenRouter's public free-tier limits (https://openrouter.ai/docs/limits):
//   • 20 requests/minute across all `:free` models
//   • 50 requests/day per account if it has < $10 lifetime credit purchased
//   • 1000 requests/day once $10+ lifetime credit has been purchased
//
// We can't reliably detect the account's credit balance from the client, so
// we default to the conservative 50/day tier. Users who've topped up can
// raise `rpd` for their account via the same localStorage config Gemini uses
// (kept configurable for the same reason: providers change public quotas
// without notice).
//
// Mirrors lib/providers/geminiRateLimiter.ts's shape/behavior:
//   • RPM — short sliding window, makes the caller wait it out.
//   • RPD — rolling 24h window, throws once exhausted (nothing sensible to
//     wait for — could be many hours).

export interface OpenRouterFreeRateLimit {
  rpm: number
  rpd: number
}

export interface OpenRouterRateLimitWait {
  providerId: 'openrouter'
  model: string
  rpm: number
  waitMs: number
  reason: string
}

export class OpenRouterDailyQuotaExceededError extends Error {
  constructor(model: string, rpd: number) {
    super(`OpenRouter free-tier daily quota reached for ${model} (${rpd} requests/day). Try again tomorrow, switch to a paid model, or use a different key.`)
    this.name = 'OpenRouterDailyQuotaExceededError'
  }
}

const STORAGE_KEY = 'rachna_openrouter_rate_limit_timestamps_v1'
const DAY_STORAGE_KEY = 'rachna_openrouter_rate_limit_daily_v1'
const CONFIG_KEY = 'rachna_openrouter_free_rate_limit_v1'
const WINDOW_MS = 60_000
const DAY_MS = 24 * 60 * 60_000

const DEFAULT_OPENROUTER_FREE_RATE_LIMIT: OpenRouterFreeRateLimit = { rpm: 20, rpd: 50 }

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

/** Whether a model id is one of OpenRouter's free-tier models. */
export function isOpenRouterFreeModel(model: string): boolean {
  return model.toLowerCase().endsWith(':free')
}

/** The currently configured free-tier limit — editable via localStorage (e.g. once a user tops up $10+ credit and moves to the 1000/day tier). */
export function getOpenRouterFreeRateLimit(): OpenRouterFreeRateLimit {
  return readJson(CONFIG_KEY, DEFAULT_OPENROUTER_FREE_RATE_LIMIT)
}

export function setOpenRouterFreeRateLimit(limit: OpenRouterFreeRateLimit): void {
  writeJson(CONFIG_KEY, limit)
}

function requestKey(apiKey: string, model: string): string {
  const keyTail = apiKey.slice(-8) || 'empty'
  return `${model.toLowerCase()}:${keyTail}`
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

/** How many free-tier requests have been made today (rolling 24h) for this key+model. */
export function getOpenRouterDailyUsage(apiKey: string, model: string): { count: number; resetAt: number | null } {
  const key = requestKey(apiKey, model)
  const now = Date.now()
  const all = readJson<Record<string, number[]>>(DAY_STORAGE_KEY, {})
  const recent = (all[key] ?? []).filter(ts => now - ts < DAY_MS)
  return { count: recent.length, resetAt: recent.length ? recent[0] + DAY_MS : null }
}

/**
 * Waits out the RPM window and throws if the daily cap is already exhausted.
 * No-op for paid (non ":free") models — OpenRouter's public limits only
 * apply to the free tier.
 */
export async function respectOpenRouterFreeRateLimit(
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  onWait?: (wait: OpenRouterRateLimitWait) => void
): Promise<void> {
  if (!isOpenRouterFreeModel(model)) return
  const limit = getOpenRouterFreeRateLimit()

  // ── Daily cap: nothing sensible to wait for, so fail fast instead ───────
  if (limit.rpd > 0) {
    const { count } = getOpenRouterDailyUsage(apiKey, model)
    if (count >= limit.rpd) {
      throw new OpenRouterDailyQuotaExceededError(model, limit.rpd)
    }
  }

  // ── Per-minute cap: worth a short wait ───────────────────────────────────
  if (limit.rpm > 0) {
    const key = requestKey(apiKey, model)
    const now = Date.now()
    const all = readJson<Record<string, number[]>>(STORAGE_KEY, {})
    const recent = (all[key] ?? []).filter(ts => now - ts < WINDOW_MS)

    if (recent.length >= limit.rpm) {
      const waitMs = Math.max(1_000, WINDOW_MS - (now - recent[0]) + 250)
      onWait?.({
        providerId: 'openrouter',
        model,
        rpm: limit.rpm,
        waitMs,
        reason: `Respecting OpenRouter free-tier RPM (${limit.rpm}/min)`,
      })
      await sleep(waitMs, signal)
      if (signal?.aborted) return
    }
  }

  const afterWait = Date.now()
  const key = requestKey(apiKey, model)

  const refreshed = readJson<Record<string, number[]>>(STORAGE_KEY, {})
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
