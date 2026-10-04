// components/AiChat/GeminiQuotaBanner.tsx
//
// FEATURE-001 — Gemini Daily Request Limits.
//
// `geminiRateLimiter.ts` already tracks RPD (requests/day) client-side and
// throws `GeminiDailyQuotaExceededError` inside GeminiProvider once the
// configured daily cap is reached — but that only surfaces to the user
// *after* they've sent a message and watched the agent loop fail deep in a
// tool call. This banner reads the same tracker proactively so the send bar
// can warn as usage approaches the cap, and block sending outright once it's
// exhausted, instead of letting a doomed request go out at all.
//
// Polls on an interval (rather than subscribing to a store) because usage is
// persisted to localStorage by the provider/rate-limiter, which isn't a
// reactive store — cheap enough at a few-second cadence for a small counter read.

import { useEffect, useState } from 'react'
import styles from '../AiChat.module.css'
import { getGeminiQuotaStatus, type GeminiQuotaStatus } from '../../lib/providers/geminiRateLimiter'

interface Props {
  providerId: string
  apiKey: string | undefined
  model: string | undefined
}

const POLL_MS = 5_000

function fmtResetIn(resetAt: number | null): string {
  if (!resetAt) return ''
  const ms = resetAt - Date.now()
  if (ms <= 0) return 'shortly'
  const hours = Math.floor(ms / 3_600_000)
  const mins = Math.round((ms % 3_600_000) / 60_000)
  if (hours > 0) return `in ~${hours}h ${mins}m`
  return `in ~${mins}m`
}

/** Exported so ChatInput/AiChat can gate the Send button without re-deriving quota logic. */
export function useGeminiQuotaStatus(providerId: string, apiKey: string | undefined, model: string | undefined): GeminiQuotaStatus | null {
  const [status, setStatus] = useState<GeminiQuotaStatus | null>(null)

  useEffect(() => {
    if (providerId !== 'gemini' || !apiKey || !model) {
      setStatus(null)
      return
    }
    const refresh = () => setStatus(getGeminiQuotaStatus(apiKey, model))
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [providerId, apiKey, model])

  return status
}

export function GeminiQuotaBanner({ providerId, apiKey, model }: Props) {
  const status = useGeminiQuotaStatus(providerId, apiKey, model)

  if (!status || !status.isNearLimit) return null

  return (
    <div className={`${styles.quotaBanner} ${status.isExhausted ? styles.quotaBannerBlocked : styles.quotaBannerWarn}`}>
      <span className={styles.quotaBannerIcon}>{status.isExhausted ? '⛔' : '⚠'}</span>
      <span className={styles.quotaBannerText}>
        {status.isExhausted ? (
          <>
            Daily free-tier limit reached for <strong>{status.model}</strong> ({status.count}/{status.rpd} requests today).
            {status.resetAt && <> Resets {fmtResetIn(status.resetAt)}.</>} Switch models or add another key in Settings to keep going.
          </>
        ) : (
          <>
            Approaching today's free-tier limit for <strong>{status.model}</strong> — {status.count}/{status.rpd} requests used
            ({status.remaining} left).
          </>
        )}
      </span>
    </div>
  )
}
