// lib/providers/geminiUsageTracker.ts
// Client-side token usage bookkeeping for Gemini models. Gemini's API returns
// `usageMetadata` (promptTokenCount / candidatesTokenCount / totalTokenCount)
// on every generateContent / streamGenerateContent response — GeminiProvider
// feeds that through recordGeminiUsage() so the "Token Usage" screen
// (components/GeminiUsagePanel.tsx) has real numbers to show, without
// requiring a server or a usage-reporting API (Gemini doesn't expose one).

export interface GeminiModelUsage {
  model: string
  requestCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  lastUsedAt: number
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

const STORAGE_KEY = 'rachna_gemini_token_usage_v1'

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined'
}

function readAll(): Record<string, GeminiModelUsage> {
  if (!storageAvailable()) return {}
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function writeAll(usage: Record<string, GeminiModelUsage>): void {
  if (!storageAvailable()) return
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(usage)) } catch { /* ignore */ }
}

function normalizeModel(model: string): string {
  return model.replace(/^models\//, '').toLowerCase()
}

/** Record one request's token usage against a model's running totals. */
export function recordGeminiUsage(model: string, usage: GeminiUsageMetadata): void {
  const key = normalizeModel(model)
  const all = readAll()
  const existing = all[key] ?? {
    model: key,
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastUsedAt: 0,
  }

  const prompt = usage.promptTokenCount ?? 0
  const completion = usage.candidatesTokenCount ?? 0
  const total = usage.totalTokenCount ?? (prompt + completion)

  all[key] = {
    model: key,
    requestCount: existing.requestCount + 1,
    promptTokens: existing.promptTokens + prompt,
    completionTokens: existing.completionTokens + completion,
    totalTokens: existing.totalTokens + total,
    lastUsedAt: Date.now(),
  }
  writeAll(all)
}

/** All recorded per-model usage, keyed by normalized model id. */
export function getAllGeminiUsage(): Record<string, GeminiModelUsage> {
  return readAll()
}

/** Clears usage stats — for a single model, or everything if omitted. */
export function resetGeminiUsage(model?: string): void {
  if (!model) {
    writeAll({})
    return
  }
  const all = readAll()
  delete all[normalizeModel(model)]
  writeAll(all)
}
