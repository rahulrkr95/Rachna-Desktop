// components/LLMCallInspector.tsx
//
// LLM Call Inspector — a persistent floating panel (session-scoped) that
// logs EVERY LLM call made during the session, from the very first
// classification call through the final response — see
// lib/llmCallLogger.ts, the single centralized logger every call site in
// the app routes through.
//
// Unlike the panel's previous event-bus version, entries are hydrated from
// llmCallLogger.getAll() on mount (so calls made before the panel was ever
// opened still show up) and updated in place as they resolve — a call
// appears the instant it starts (status: pending) and flips to
// success/error when it completes, rather than only appearing after the
// fact.
//
// Opened via the ⚡ button in the header (Header.tsx passes onToggle).

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { llmCallLogger, LLMCallRecord, LLMCallStage, STAGE_LABELS, LLMCallAttachmentMeta } from '../lib/llmCallLogger'
import styles from './LLMCallInspector.module.css'
import { useIdeEntitlements } from '../store/useIdeEntitlements'

// ── Panel Component ────────────────────────────────────────────────────────

interface LLMCallInspectorProps {
  open: boolean
  onClose: () => void
}

type Section = 'prompt' | 'system' | 'response' | 'attachments' | null

export function LLMCallInspector({ open, onClose }: LLMCallInspectorProps) {
  const canInspectAiCalls = useIdeEntitlements().canInspectAiCalls
  const [records, setRecords] = useState<LLMCallRecord[]>(() => llmCallLogger.getAll())
  const [filter, setFilter] = useState<'all' | LLMCallStage>('all')
  const [expanded, setExpanded] = useState<Record<string, Section>>({})
  const bottomRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  useEffect(() => {
    // Catch up on anything logged between mounts (e.g. the panel was closed
    // then reopened), then subscribe for live start/complete/fail updates.
    setRecords(llmCallLogger.getAll())
    const off = llmCallLogger.on((record) => {
      setRecords(prev => {
        const idx = prev.findIndex(r => r.id === record.id)
        if (idx === -1) return [...prev, record]
        const next = prev.slice()
        next[idx] = record
        return next
      })
    })
    return off
  }, [])

  useEffect(() => {
    if (autoScrollRef.current && open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [records, open])

  const toggleSection = useCallback((id: string, section: Exclude<Section, null>) => {
    setExpanded(prev => ({ ...prev, [id]: prev[id] === section ? null : section }))
  }, [])

  const clearLog = useCallback(() => {
    llmCallLogger.clear()
    setRecords([])
    setExpanded({})
  }, [])

  const filtered = filter === 'all' ? records : records.filter(r => r.stage === filter)

  if (!open || !canInspectAiCalls) return null

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={styles.titleIcon}>⚡</span>
          LLM Call Inspector
          <span className={styles.count}>{records.length}</span>
        </span>
        <div className={styles.headerActions}>
          <select
            className={styles.filterSelect}
            value={filter}
            onChange={e => setFilter(e.target.value as typeof filter)}
            title="Filter by call stage"
          >
            <option value="all">All calls</option>
            {(Object.keys(STAGE_LABELS) as LLMCallStage[]).map(stage => (
              <option key={stage} value={stage}>{STAGE_LABELS[stage]}</option>
            ))}
          </select>
          <button className={styles.clearBtn} onClick={clearLog} title="Clear log">
            🗑
          </button>
          <button className={styles.closeBtn} onClick={onClose} title="Close inspector">
            ×
          </button>
        </div>
      </div>

      {/* Log body */}
      <div
        className={styles.body}
        onScroll={e => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
          autoScrollRef.current = atBottom
        }}
      >
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            {records.length === 0
              ? 'No LLM calls yet — start chatting to see them here.'
              : 'No calls match the current filter.'}
          </div>
        ) : (
          filtered.map((record, idx) => (
            <EntryCard
              key={record.id}
              record={record}
              index={idx + 1}
              section={expanded[record.id] ?? null}
              onToggleSection={toggleSection}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ── Entry Card ─────────────────────────────────────────────────────────────

function EntryCard({
  record,
  index,
  section,
  onToggleSection,
}: {
  record: LLMCallRecord
  index: number
  section: Section
  onToggleSection: (id: string, section: Exclude<Section, null>) => void
}) {
  const time = new Date(record.startedAt).toLocaleTimeString()
  const prompt = record.requestPayload?.messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
  const promptPreview = prompt.length > 140 ? prompt.slice(0, 140) + '…' : prompt

  return (
    <div className={`${styles.entry} ${styles.entryStream}`}>
      {/* Top row: index + badge + provider + model + status + time */}
      <div className={styles.entryHeader}>
        <span className={styles.entryIndex}>#{index}</span>
        <span className={`${styles.badge} ${styles.badgeStream}`}>
          {STAGE_LABELS[record.stage]}
        </span>
        {record.iteration !== undefined && (
          <span className={styles.iter}>iter {record.iteration}</span>
        )}
        <span className={styles.provider}>{record.providerName}</span>
        {record.model && <span className={styles.model}>· {record.model}</span>}
        <StatusBadge status={record.status} />
        {record.latencyMs !== undefined && (
          <span className={styles.iter}>{record.latencyMs}ms</span>
        )}
        {record.tokenUsage && (
          <span className={styles.iter}>
            ~{record.tokenUsage.totalTokens} tok
          </span>
        )}
        {record.requestPayload?.attachments && record.requestPayload.attachments.length > 0 && (
          <span className={styles.iter} title="Files attached to this request">
            📎 {record.requestPayload.attachments.length}
          </span>
        )}
        <span className={styles.time}>{time}</span>
      </div>

      {/* Prompt preview / error */}
      <div className={styles.promptPreview}>
        <span className={styles.arrow}>↳</span>
        {record.status === 'error' ? `Error: ${record.error}` : promptPreview}
      </div>

      {/* Expand buttons */}
      <div className={styles.expandRow}>
        <button className={styles.expandBtn} onClick={() => onToggleSection(record.id, 'prompt')}>
          {section === 'prompt' ? '▲ hide prompt' : '▼ full prompt'}
        </button>
        {record.requestPayload?.systemInstruction && (
          <button className={styles.expandBtn} onClick={() => onToggleSection(record.id, 'system')}>
            {section === 'system' ? '▲ hide system' : '▼ system prompt'}
          </button>
        )}
        {record.response && (
          <button className={styles.expandBtn} onClick={() => onToggleSection(record.id, 'response')}>
            {section === 'response' ? '▲ hide response' : '▼ response'}
          </button>
        )}
        {record.requestPayload?.attachments && record.requestPayload.attachments.length > 0 && (
          <button className={styles.expandBtn} onClick={() => onToggleSection(record.id, 'attachments')}>
            {section === 'attachments'
              ? '▲ hide attachments'
              : `▼ attachments (${record.requestPayload.attachments.length})`}
          </button>
        )}
      </div>

      {/* Expanded content */}
      {section === 'prompt' && <pre className={styles.expandedPre}>{prompt}</pre>}
      {section === 'system' && record.requestPayload?.systemInstruction && (
        <pre className={styles.expandedPre}>{record.requestPayload.systemInstruction}</pre>
      )}
      {section === 'response' && record.response && (
        <pre className={styles.expandedPre}>{record.response}</pre>
      )}
      {section === 'attachments' && record.requestPayload?.attachments && (
        <AttachmentsList attachments={record.requestPayload.attachments} />
      )}
    </div>
  )
}

function AttachmentsList({ attachments }: { attachments: LLMCallAttachmentMeta[] }) {
  const formatSize = (bytes: number) =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`

  return (
    <div className={styles.expandedPre} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {attachments.map((a, i) => (
        <div key={`${a.fileId}-${i}`}>
          📎 <strong>{a.fileName}</strong> · {a.mimeType} · {formatSize(a.size)}
          {a.providerId ? ` · provider: ${a.providerId}` : ' · not sent (provider does not support attachments)'}
          {a.purpose ? ` · "${a.purpose}"` : ''}
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: LLMCallRecord['status'] }) {
  const label = status === 'pending' ? '● PENDING' : status === 'success' ? '✓ OK' : '✕ ERROR'
  const color = status === 'pending' ? styles.badgePending : status === 'success' ? styles.badgeStream : styles.badgeError
  return <span className={`${styles.badge} ${color}`}>{label}</span>
}
