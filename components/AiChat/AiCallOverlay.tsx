// components/AiChat/AiCallOverlay.tsx
//
// Scrollable overlay opened by clicking the "AI call" flair chip in
// AgentActivityPanel's expanded log. Shows the prompt sent to the LLM
// provider and the response received. Can be opened while the call is
// still running — in that case only the prompt is shown (plus a running
// indicator) until `aiCall.response` starts filling in, at which point the
// response section appears and updates live as more of it streams in.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentActivity } from '../../services/agent'
import styles from '../AiChat.module.css'

interface Props {
  activity: AgentActivity
  onClose: () => void
  /** Defense-in-depth: callers gate whether this overlay ever mounts on
   *  `canInspectAiCalls`, but if it's somehow rendered for a restricted
   *  seat anyway, it renders nothing rather than the prompt/response. */
  canInspect?: boolean
}

/** Hover message shown on the AI Call chip for seats without
 *  `canInspectAiCalls` — no prompt/response content is ever built or
 *  touched in this branch, so there's nothing to leak via the tooltip. */
export const AI_CALL_LOCKED_HOVER = '🔒 Prompt & response inspection is not available for this account'

/**
 * Short "prompt → response" preview text used as the AI Call chip's hover
 * tooltip, so hovering gives a quick glimpse without opening the full
 * scrollable overlay. Click still opens AiCallOverlay for the complete,
 * scrollable prompt/response.
 *
 * `canInspect` gates this entirely: when false, the locked message is
 * returned and `activity.aiCall` is never read, so the prompt/response text
 * cannot leak through the tooltip for restricted seats.
 */
export function aiCallHoverPreview(activity: AgentActivity, canInspect: boolean = true): string {
  if (!canInspect) return AI_CALL_LOCKED_HOVER
  const { aiCall } = activity
  if (!aiCall) return 'View prompt and response'
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
  const prompt   = truncate(aiCall.prompt.trim() || '(empty prompt)', 220)
  const response = aiCall.response.trim()
    ? truncate(aiCall.response.trim(), 220)
    : (activity.status === 'running' ? '(waiting for response…)' : '(no response text)')
  const modelLine = `${aiCall.providerName}${aiCall.model ? ` (${aiCall.model})` : ''}`
  return `${modelLine}\n\nPrompt:\n${prompt}\n\nResponse:\n${response}\n\n(click to view full prompt/response)`
}

export function AiCallOverlay({ activity, onClose, canInspect = true }: Props) {
  const { aiCall, status } = activity
  const responseRef = useRef<HTMLPreElement>(null)
  const autoScrollRef = useRef(true)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Auto-scroll the response pane to bottom as it streams, unless the user
  // has scrolled up to read something earlier.
  useEffect(() => {
    if (autoScrollRef.current && responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight
    }
  }, [aiCall?.response])

  // Defense-in-depth only — callers are expected to never mount this
  // overlay at all when `canInspectAiCalls` is false.
  if (!canInspect) return null
  if (!aiCall) return null

  const hasResponse = aiCall.response.trim().length > 0
  const running = status === 'running'

  return (
    <div className={styles.aiCallOverlayBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.aiCallOverlayModal}>
        {/* Header */}
        <div className={styles.aiCallOverlayHeader}>
          <span className={styles.aiCallOverlayIcon}>🧠</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.aiCallOverlayTitle}>
              AI call — {aiCall.providerName}
              {aiCall.model && <span className={styles.aiCallOverlayModel}> · {aiCall.model}</span>}
            </div>
            {running && (
              <div className={styles.aiCallOverlayStatus}>
                <span className={styles.apDotRunning} /> running…
              </div>
            )}
          </div>
          <button className={styles.aiCallOverlayClose} onClick={onClose} title="Close">✕</button>
        </div>

        {/* Body */}
        <div className={styles.aiCallOverlayBody}>
          <div className={styles.aiCallOverlaySection}>
            <div className={styles.aiCallOverlaySectionHeader}>
              <div className={styles.aiCallOverlaySectionLabel}>Prompt sent</div>
              <CopyAiCallItemButton text={aiCall.prompt} label="Prompt" />
            </div>
            <pre className={styles.aiCallOverlayPre}>{aiCall.prompt || '(empty prompt)'}</pre>
          </div>

          {(aiCall.latencyMs !== undefined || aiCall.tokenUsage || aiCall.startedAt) && (
            <div className={styles.aiCallOverlaySection}>
              <div className={styles.aiCallOverlaySectionLabel}>Call details</div>
              <pre className={styles.aiCallOverlayPre}>{[
                `Status: ${status}`,
                aiCall.startedAt ? `Started: ${aiCall.startedAt}` : '',
                aiCall.completedAt ? `Completed: ${aiCall.completedAt}` : '',
                aiCall.latencyMs !== undefined ? `Duration: ${aiCall.latencyMs} ms` : '',
                aiCall.tokenUsage ? `Tokens: ${aiCall.tokenUsage.totalTokens} total (${aiCall.tokenUsage.promptTokens} prompt, ${aiCall.tokenUsage.completionTokens} completion${aiCall.tokenUsage.estimated ? ', estimated' : ''})` : '',
                aiCall.error ? `Error: ${aiCall.error}` : '',
              ].filter(Boolean).join('\n')}</pre>
            </div>
          )}

          {aiCall.parsedResponse !== undefined && (
            <div className={styles.aiCallOverlaySection}>
              <div className={styles.aiCallOverlaySectionHeader}>
                <div className={styles.aiCallOverlaySectionLabel}>Parsed response</div>
                <CopyAiCallItemButton text={JSON.stringify(aiCall.parsedResponse, null, 2)} label="Parsed response" />
              </div>
              <pre className={styles.aiCallOverlayPre}>{JSON.stringify(aiCall.parsedResponse, null, 2)}</pre>
            </div>
          )}

          {aiCall.systemInstruction && (
            <div className={styles.aiCallOverlaySection}>
              <div className={styles.aiCallOverlaySectionHeader}>
                <div className={styles.aiCallOverlaySectionLabel}>System instruction</div>
                <CopyAiCallItemButton text={aiCall.systemInstruction} label="System instruction" />
              </div>
              <pre className={styles.aiCallOverlayPre}>{aiCall.systemInstruction}</pre>
            </div>
          )}

          <div className={styles.aiCallOverlaySection}>
            <div className={styles.aiCallOverlaySectionHeader}>
              <div className={styles.aiCallOverlaySectionLabel}>
                Response received
                {running && !hasResponse && <span className={styles.aiCallOverlayWaiting}> — waiting…</span>}
              </div>
              <CopyAiCallItemButton text={aiCall.response} label="Response" />
            </div>
            {hasResponse ? (
              <pre
                ref={responseRef}
                className={styles.aiCallOverlayPre}
                onScroll={(e) => {
                  const el = e.currentTarget
                  autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
                }}
              >
                {aiCall.response}
              </pre>
            ) : (
              !running && (
                <div className={styles.aiCallOverlayEmpty}>(no response text)</div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CopyAiCallItemButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
  }, [])

  const copyToClipboard = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      resetTimerRef.current = setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }, [text])

  return (
    <button
      type="button"
      className={`${styles.aiCallOverlayCopy} ${copied ? styles.aiCallOverlayCopySuccess : ''}`}
      onClick={copyToClipboard}
      title={copied ? `${label} copied` : `Copy ${label.toLowerCase()} to clipboard`}
      aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()} to clipboard`}
    >
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  )
}
