// components/GeminiUsagePanel.tsx
// "Screen" showing, for every model available to the active Gemini key:
//   - model details (context window, input/output limits, capabilities)
//   - the free-tier rate limits Rachna respects for it (RPM / RPD / TPM)
//   - cumulative tokens consumed so far (prompt / completion / total),
//     tracked client-side from each response's usageMetadata since Gemini
//     doesn't expose a usage-reporting API.

import { useEffect, useState, useCallback } from 'react'
import styles from './GeminiUsagePanel.module.css'
import { useApiKeyStore } from '../store/useApiKeyStore'
import { getProvider } from '../lib/providers/registry'
import type { ModelInfo } from '../lib/providers/types'
import { getGeminiFreeRateLimit, getGeminiDailyUsage, getGeminiMinuteUsage } from '../lib/providers/geminiRateLimiter'
import { getAllGeminiUsage, resetGeminiUsage, type GeminiModelUsage } from '../lib/providers/geminiUsageTracker'

interface Props {
  open: boolean
  onClose: () => void
}

function fmtNum(n: number): string {
  return n.toLocaleString()
}

function fmtTokens(n?: number): string {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

export default function GeminiUsagePanel({ open, onClose }: Props) {
  const getModels = useApiKeyStore(s => s.getModels)
  const getActiveKey = useApiKeyStore(s => s.getActiveKey)
  const [models, setModels] = useState<ModelInfo[]>(getModels('gemini'))
  const [usage, setUsage] = useState<Record<string, GeminiModelUsage>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [refreshErr, setRefreshErr] = useState('')

  const refreshUsage = useCallback(() => {
    setUsage(getAllGeminiUsage())
  }, [])

  // Forces a re-render every few seconds while open so the This-minute/Today
  // usage cells (read live from localStorage at render time, not React
  // state) stay current — otherwise "3/15 rpm" would only update the next
  // time the panel is closed and reopened.
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (!open) return
    setModels(getModels('gemini'))
    refreshUsage()
    const id = setInterval(() => forceTick(t => t + 1), 5_000)
    return () => clearInterval(id)
  }, [open, getModels, refreshUsage])

  const handleRefreshModels = async () => {
    const key = getActiveKey('gemini')
    if (!key?.value) {
      setRefreshErr('No active Gemini key — add one first.')
      return
    }
    setRefreshing(true)
    setRefreshErr('')
    try {
      const provider = getProvider('gemini')
      if (!provider) throw new Error('Gemini provider not registered')
      const fetched = await provider.listModels(key.value)
      setModels(fetched)
    } catch (e) {
      setRefreshErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }

  const handleReset = (model?: string) => {
    const label = model ? `usage stats for ${model}` : 'ALL Gemini usage stats'
    if (!confirm(`Clear ${label}? This can't be undone.`)) return
    resetGeminiUsage(model)
    refreshUsage()
  }

  if (!open) return null

  const activeKey = getActiveKey('gemini')

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Gemini token usage and models">
        <div className={styles.header}>
          <span className={styles.title}>Gemini — Token Usage &amp; Models</span>
          <span className={styles.subtitle}>
            {models.length} model{models.length !== 1 ? 's' : ''} available
          </span>
          <button
            className={styles.refreshBtn}
            onClick={handleRefreshModels}
            disabled={refreshing}
            title="Refresh model list from the Gemini API"
          >
            {refreshing ? 'Refreshing…' : '⟳ Refresh models'}
          </button>
          <button
            className={styles.resetBtn}
            onClick={() => handleReset()}
            title="Clear all recorded usage stats"
          >
            Reset all
          </button>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={styles.body}>
          {refreshErr && <p className={styles.errText}>⚠ {refreshErr}</p>}

          {models.length === 0 ? (
            <p className={styles.empty}>
              No Gemini models loaded yet. Add a Gemini API key, then click "Refresh models" above.
            </p>
          ) : (
            <div className={styles.table}>
              <div className={styles.rowHead}>
                <span>Model</span>
                <span>Context / I-O limits</span>
                <span>Free-tier limits</span>
                <span>This minute</span>
                <span>Today</span>
                <span>Tokens consumed (all-time)</span>
                <span />
              </div>

              {models.map(m => {
                const limit = getGeminiFreeRateLimit(m.id)
                const u = usage[m.id.replace(/^models\//, '').toLowerCase()]
                const daily = activeKey ? getGeminiDailyUsage(activeKey.value, m.id) : { count: 0, resetAt: null }
                const minute = activeKey ? getGeminiMinuteUsage(activeKey.value, m.id) : { count: 0, resetAt: null }

                return (
                  <div className={styles.row} key={m.id}>
                    <div className={styles.modelCell}>
                      <span className={styles.modelName}>{m.displayName}</span>
                      <span className={styles.modelId}>{m.id}</span>
                      <span className={styles.badges}>
                        {m.supportsTools && <span className={`${styles.badge} ${styles.badgeGreen}`}>tools</span>}
                        {m.supportsVision && <span className={`${styles.badge} ${styles.badgeBlue}`}>vision</span>}
                        {m.supportsStreaming && <span className={styles.badge}>streaming</span>}
                      </span>
                    </div>

                    <div className={styles.cell}>
                      <div>ctx: {fmtTokens(m.contextWindow)}</div>
                      <div>in: {fmtTokens(m.inputTokenLimit)}</div>
                      <div>out: {fmtTokens(m.outputTokenLimit)}</div>
                    </div>

                    <div className={styles.cell}>
                      {limit ? (
                        <>
                          <div>{limit.rpm} req/min</div>
                          {limit.rpd && <div>{limit.rpd} req/day</div>}
                          {limit.tpm && <div>{fmtTokens(limit.tpm)} tok/min</div>}
                        </>
                      ) : (
                        <span className={styles.muted}>not tracked</span>
                      )}
                    </div>

                    <div className={styles.cell}>
                      {limit?.rpm ? (
                        <span className={minute.count >= limit.rpm ? styles.quotaFull : undefined}>
                          {minute.count} / {limit.rpm}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </div>

                    <div className={styles.cell}>
                      {limit?.rpd ? (
                        <span className={daily.count >= limit.rpd ? styles.quotaFull : undefined}>
                          {daily.count} / {limit.rpd}
                        </span>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </div>

                    <div className={styles.cell}>
                      {u ? (
                        <>
                          <div>{fmtNum(u.totalTokens)} total</div>
                          <div className={styles.muted}>{fmtNum(u.promptTokens)} in / {fmtNum(u.completionTokens)} out</div>
                          <div className={styles.muted}>{u.requestCount} request{u.requestCount !== 1 ? 's' : ''}</div>
                        </>
                      ) : (
                        <span className={styles.muted}>no usage yet</span>
                      )}
                    </div>

                    <div className={styles.cell}>
                      {u && (
                        <button
                          className={styles.rowResetBtn}
                          onClick={() => handleReset(m.id)}
                          title={`Clear usage stats for ${m.displayName}`}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <p className={styles.footNote}>
            Token counts come from each response's <code>usageMetadata</code> and are tallied locally on this
            device — Gemini doesn't expose a usage-reporting API, so these numbers reset if you clear app data.
            Free-tier limits are Rachna's best-effort mirror of Google's published quotas and are enforced
            client-side (short waits for per-minute limits, hard stop for daily limits) — actual account quotas
            may differ.
          </p>
        </div>
      </div>
    </div>
  )
}
