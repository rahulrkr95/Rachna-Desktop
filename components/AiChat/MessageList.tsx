// components/AiChat/MessageList.tsx

import React from 'react'
import type { ChatMessage } from '../../types'
import type { AgentActivity } from '../../services/agent'
import type { RetrievalStats } from '../../lib/chunkSearch'
import type { CompressionMetrics } from '../../lib/contextCompression'
import { MessageBody, MessageCopyBtn } from './MarkdownRenderer'
import { useEditStore, selectPendingEdits, type PendingEdit } from '../../services/edits/EditStore'
import { useEditorStore } from '../../store/useEditorStore'
import { IntentPlanCard } from './IntentPlanCard'
import { ClarificationCard } from './ClarificationCard'
import { PendingToggleCard } from './PendingToggleCard'
import { AiCallOverlay, aiCallHoverPreview } from './AiCallOverlay'
import { ScreenshotActivityBanner } from './ScreenshotActivityBanner'
import { useIdeEntitlements } from '../../store/useIdeEntitlements'
import { useDesignCanvasStore } from '../../store/useDesignCanvasStore'
import styles from '../AiChat.module.css'

// ── EditActionButtons ────────────────────────────────────────────────────────

function EditActionButtons({ edit, onStatusChange }: { edit: PendingEdit, onStatusChange: () => void }) {
  const [loading, setLoading] = React.useState(false)
  const [success, setSuccess] = React.useState(false)
  const acceptEdit = useEditStore(s => s.acceptEdit)
  const rejectEdit = useEditStore(s => s.rejectEdit)
  const openDiffTab = useEditorStore(s => s.openDiffTab)
  const activateDiffTabForFile = useEditorStore(s => s.activateDiffTabForFile)
  const closeDiffTab = useEditorStore(s => s.closeDiffTab)

  const handleAction = async (action: 'accept' | 'reject') => {
    setLoading(true)
    if (action === 'accept') {
      await acceptEdit(edit.id)
    } else {
      rejectEdit(edit.id)
      // Also close the diff tab when rejecting from chat
      closeDiffTab(edit.id)
    }
    setSuccess(true)
    setLoading(false)
    onStatusChange()
  }

  // "Review" opens (or focuses) the Monaco diff-tab for this edit. The tab
  // may not exist yet if it was never opened via the EditReviewBar, so we
  // open it here rather than assuming it's already present — matching how
  // BatchCard's "View All" opens tabs for every edit in a batch.
  const handleReview = () => {
    const existing = useEditorStore.getState().diffTabs.find(t => t.filePath === edit.filePath)
    if (existing) {
      activateDiffTabForFile(edit.filePath)
    } else {
      openDiffTab({
        id: edit.id,
        editId: edit.id,
        name: `⎇ ${edit.fileName}`,
        filePath: edit.filePath,
        fileName: edit.fileName,
        language: edit.language,
      })
    }
  }

  if (success) return <div className={styles.editActionStatus}>✓ Applied</div>

  return (
    <div className={styles.editActionButtons}>
      <button className={styles.editActionBtn} onClick={() => handleAction('accept')} disabled={loading}>Apply</button>
      <button className={styles.editActionBtn} onClick={handleReview}>Review</button>
      <button className={styles.editActionBtn} onClick={() => handleAction('reject')} disabled={loading}>Reject</button>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortenPath(path: string): string {
  const parts = path.split(/[\\\\/]/)
  if (parts.length <= 3) return path
  return `${parts[0]}/.../${parts[parts.length - 1]}`
}

// ── AgentActivityRow ──────────────────────────────────────────────────────────
//
// 'ai_call' activities (the agent calling out to the LLM provider mid-turn)
// never show their raw prompt/label as a "step" here — instead they render
// a small "API Call" flair chip. Clicking (or hovering, via the title attr)
// opens the same scrollable AiCallOverlay used in AgentActivityPanel, which
// shows the exact prompt sent and response received, rather than being
// inlined into the chat transcript.

function AgentActivityRow({
  activity,
  onInspectAiCall,
}: {
  activity: AgentActivity
  onInspectAiCall: (activity: AgentActivity) => void
}) {
  const canInspectAiCalls = useIdeEntitlements().canInspectAiCalls
  const isError = activity.status === 'error'
  const icon =
    activity.status === 'running' ? '⟳' :
    isError                          ? '⚠' :
    '✓'

  if (activity.kind === 'ai_call') {
    if (!canInspectAiCalls) return null
    return (
      <div className={`${styles.agentActivity ?? ''} ${styles[`agentActivity_${activity.status}`] ?? ''}`}>
        <span className={styles.agentActivityIcon}>{icon}</span>
        <span className={styles.agentActivityLabel}>{activity.label}</span>
        <button
          type="button"
          className={styles.apAiCallChip}
          onClick={() => {
            onInspectAiCall(activity)
          }}
          title={aiCallHoverPreview(activity, canInspectAiCalls)}
        >
          🧠 API Call
        </button>
        {isError && activity.result && (
          <span className={`${styles.agentActivityResultChip} ${styles.agentActivityResultChipError}`}>
            ⚠ {activity.result}
          </span>
        )}
      </div>
    )
  }

  if (activity.tool === 'run_terminal_command') {
    const command = typeof activity.args.command === 'string' ? activity.args.command : ''
    return (
      <details className={`${styles.agentActivity ?? ''} ${styles.terminalActivity ?? ''} ${styles[`agentActivity_${activity.status}`] ?? ''}`}>
        <summary className={styles.terminalActivitySummary}>
          <span className={styles.agentActivityIcon}>{icon}</span>
          <span className={styles.terminalCommandChip}>Terminal Command</span>
          <span className={styles.agentActivityLabel}>{activity.label}</span>
          {activity.result && (
            <span className={`${styles.agentActivityResultChip} ${isError ? styles.agentActivityResultChipError : styles.agentActivityResultChipOk}`}>
              {isError ? '⚠ ' : ''}{activity.result}
            </span>
          )}
        </summary>
        {command && <code className={styles.terminalActivityCommand}>{command}</code>}
      </details>
    )
  }

  return (
    <div className={`${styles.agentActivity ?? ''} ${styles[`agentActivity_${activity.status}`] ?? ''}`}>
      <span className={styles.agentActivityIcon}>{icon}</span>
      <span className={styles.agentActivityLabel}>{activity.label}</span>
      {activity.result && (
        <span
          className={`${styles.agentActivityResultChip} ${
            isError ? styles.agentActivityResultChipError : styles.agentActivityResultChipOk
          }`}
        >
          {isError ? '⚠ ' : ''}{activity.result}
        </span>
      )}
      {activity.artifact?.type === 'screenshot' && (
        <ScreenshotActivityBanner activity={activity} />
      )}
    </div>
  )
}

// ── RetrievalStatsRow ─────────────────────────────────────────────────────────

function RetrievalStatsRow({ stats }: { stats: RetrievalStats }) {
  if (stats.noContextFound) {
    return (
      <div className={styles.retrievalWarning}>
        ⚠ No repository context found.
      </div>
    )
  }

  return (
    <div className={styles.retrievalStats}>
      <span className={styles.retrievalChip} title={`Extracted: "${stats.extractedTerms}"`}>
        ✓ Chunks: {stats.chunksFound}
      </span>
      {stats.searchMode && (
        <span
          className={styles.retrievalChip}
          title={
            stats.searchMode === 'hybrid'
              ? 'FTS5 + Ollama embedding re-ranking'
              : 'FTS5 only — Ollama unreachable, semantic search inactive'
          }
        >
          {stats.searchMode === 'hybrid' ? '◆ Semantic: on' : '◇ Semantic: off'}
        </span>
      )}
      <span className={styles.retrievalChip}>
        ✓ Symbols: {stats.symbolsFound}
      </span>
      <span
        className={`${styles.retrievalChip} ${stats.filesRetrieved.length === 0 ? styles.retrievalChipEmpty : ''}`}
        title={stats.filesRetrieved.join('\n')}
      >
        ✓ Files: {stats.filesRetrieved.length > 0
          ? stats.filesRetrieved.map(shortenPath).join(', ')
          : 'None'
        }
        {stats.usedFilenameFallback ? ' (fallback)' : ''}
      </span>
    </div>
  )
}

// ── CompressionStatsRow ──────────────────────────────────────────────────────

function CompressionStatsRow({ metrics }: { metrics: CompressionMetrics }) {
  if (metrics.reductionPct <= 0) return null
  return (
    <div className={styles.retrievalStats} title={
      `Original: ~${metrics.originalTokens} tokens\nCompressed: ~${metrics.compressedTokens} tokens\n` +
      `Active file: ${metrics.sections.activeFile.original}→${metrics.sections.activeFile.compressed}\n` +
      `Repo context: ${metrics.sections.repoContext.original}→${metrics.sections.repoContext.compressed}\n` +
      `Chat history: ${metrics.sections.chatHistory.original}→${metrics.sections.chatHistory.compressed}`
    }>
      <span className={styles.retrievalChip} style={{ opacity: 0.75 }}>
        ⚡ {metrics.reductionPct}% compressed
      </span>
      <span className={styles.retrievalChip} style={{ opacity: 0.75 }}>
        ~{metrics.compressedTokens} tokens
      </span>
      {metrics.chatTurnsSummarised > 0 && (
        <span className={styles.retrievalChip} style={{ opacity: 0.75 }}>
          {metrics.chatTurnsSummarised} turns summarised
        </span>
      )}
    </div>
  )
}

// ── EmptyState ─────────────────────────────────────────────────────────────────

function EmptyState({ hasKey }: { hasKey: boolean }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyGem} />
      <p className={styles.emptyTitle}>Rachna Agent is ready</p>
      <p className={styles.emptyHint}>
        {hasKey
          ? 'Ask anything about your code.'
          : 'Add an API key in Settings → AI Providers to start.'}
      </p>
    </div>
  )
}

// ── ThinkingIndicator ──────────────────────────────────────────────────────────

function ThinkingIndicator() {
  return (
    <div className={styles.thinkingIndicator}>
      <div className={styles.thinkingAvatar}>✦</div>
      <span className={styles.thinkingLabel}>Rachna Agent is working</span>
      <div className={styles.thinkingDots}>
        <span className={styles.thinkingDot} />
        <span className={styles.thinkingDot} />
        <span className={styles.thinkingDot} />
      </div>
    </div>
  )
}

// ── MessageList ────────────────────────────────────────────────────────────────

interface Props {
  messages:        ChatMessage[]
  streaming:       boolean
  streamingMsgId:  string | null
  hasKey:          boolean
  onRetry:         (msgId: string) => void
  onContinue:      (msgId: string) => void
  onEditMessage:   (msgId: string, newBody: string) => void
  /** CHAT-004: prev/next navigation between sibling versions of a message. */
  onSwitchVersion: (msgId: string, direction: -1 | 1) => void
  onApprovePlan:   (planMsgId: string) => void
  onModifyPlan:    (payload: string) => void
  /** Reject an IntentPlan before it's approved — see useChat's cancelPlan. */
  onCancelPlan:    (planMsgId: string) => void
  /** Failure Handling: re-run ONLY the 'failed' step — see useChat's retryStep. */
  onRetryStep?:    (planMsgId: string) => void
  /** Failure Handling: override the 'failed' step as done and continue — see useChat's markStepDone. */
  onMarkStepDone?: (planMsgId: string) => void
  /** Failure Handling: cancel the whole execution from the 'failed' step onward — see useChat's cancelExecution. */
  onCancelExecution?: (planMsgId: string) => void
  onResolveToggle: (msgId: string, settingKey: 'autoAllowCommit' | 'autoAllowPush' | 'allowDirectPushToMain') => void
  /** Resolve a ClarificationCard (correction confirm / clarifying answers) — see useChat's resolveClarification. */
  onResolveClarification: (msgId: string, result: { useCorrection: boolean; answers?: string[] }) => void
  endRef:          React.RefObject<HTMLDivElement>
}

// ── VersionNav ────────────────────────────────────────────────────────────────
// CHAT-004: "‹ 2 / 3 ›" prev/next control shown on messages that have
// sibling branches (an edited user message, or a regenerated AI reply).

function VersionNav({
  msg,
  streaming,
  onSwitchVersion,
}: {
  msg: ChatMessage
  streaming: boolean
  onSwitchVersion: (msgId: string, direction: -1 | 1) => void
}) {
  if (!msg.versionInfo) return null
  const { index, count } = msg.versionInfo
  return (
    <div className={styles.versionNav} title="Other versions of this message">
      <button
        className={styles.versionNavBtn}
        onClick={() => onSwitchVersion(msg.id, -1)}
        disabled={streaming || index <= 0}
        title="Previous version"
      >
        ‹
      </button>
      <span className={styles.versionNavLabel}>{index + 1} / {count}</span>
      <button
        className={styles.versionNavBtn}
        onClick={() => onSwitchVersion(msg.id, 1)}
        disabled={streaming || index >= count - 1}
        title="Next version"
      >
        ›
      </button>
    </div>
  )
}

export function MessageList({
  messages,
  streaming,
  streamingMsgId,
  hasKey,
  onRetry,
  onContinue,
  onEditMessage,
  onSwitchVersion,
  onApprovePlan,
  onModifyPlan,
  onCancelPlan,
  onRetryStep,
  onMarkStepDone,
  onCancelExecution,
  onResolveToggle,
  onResolveClarification,
  endRef,
}: Props) {
  const pendingEdits = useEditStore(selectPendingEdits)
  const [, setRefresh] = React.useState(0)
  // Track which message is currently being edited inline
  const [editingMsgId, setEditingMsgId] = React.useState<string | null>(null)
  const [editDraft,    setEditDraft]    = React.useState('')
  // Which persisted 'ai_call' agent activity (if any) is being inspected
  // via the AiCallOverlay, opened from the "API Call" flair chip.
  const [inspectingAiCall, setInspectingAiCall] = React.useState<AgentActivity | null>(null)
  const canInspectAiCalls = useIdeEntitlements().canInspectAiCalls
  const canConfigurePermissions = useIdeEntitlements().canConfigurePermissions

  // ── Floating "API Calls" header ──────────────────────────────────────────
  // 'ai_call' activities (Message Classifier / Task Planner / any other
  // mid-turn LLM call) no longer render as their own rows inline in the
  // transcript — they were redundant clutter above every reply. Instead
  // they're collected here and surfaced through a small floating header
  // pinned to the top of the message list; clicking it drops down the full
  // list of calls made so far, and clicking any entry opens the same
  // AiCallOverlay (prompt + response) as before.
  const [aiCallPanelOpen, setAiCallPanelOpen] = React.useState(false)
  const allAiCalls = React.useMemo(() => {
    const out: AgentActivity[] = []
    for (const m of messages) {
      for (const a of m.agentActivities ?? []) {
        if (a.kind === 'ai_call') out.push(a)
      }
    }
    return out
  }, [messages])

  const startEdit = (msg: ChatMessage) => {
    setEditingMsgId(msg.id)
    setEditDraft(msg.body ?? '')
  }

  const cancelEdit = () => {
    setEditingMsgId(null)
    setEditDraft('')
  }

  const commitEdit = (msgId: string) => {
    const trimmed = editDraft.trim()
    if (trimmed) {
      onEditMessage(msgId, trimmed)
    }
    setEditingMsgId(null)
    setEditDraft('')
  }

  return (
    <div className={styles.messages}>
      {/* ── Floating "API Calls" header ────────────────────────────────────
          Sticky to the top of this scroll region. Only shown once there's
          at least one call to inspect, and hidden entirely for seats
          without canInspectAiCalls, so restricted accounts cannot inspect
          request/response content. ── */}
      {canInspectAiCalls && allAiCalls.length > 0 && (
        <div className={styles.aiCallFloatingHeader}>
          <button
            type="button"
            className={styles.aiCallFloatingHeaderBtn}
            onClick={() => setAiCallPanelOpen(o => !o)}
            aria-expanded={aiCallPanelOpen}
            title="View AI API calls made this conversation"
          >
            🧠 {allAiCalls.length} API call{allAiCalls.length === 1 ? '' : 's'}
            <span className={styles.aiCallFloatingHeaderChevron}>{aiCallPanelOpen ? '▲' : '▼'}</span>
          </button>
          {aiCallPanelOpen && (
            <div className={styles.aiCallFloatingPanel}>
              {allAiCalls.map(a => (
                <button
                  key={a.id}
                  type="button"
                  className={styles.aiCallFloatingPanelItem}
                  title={aiCallHoverPreview(a, canInspectAiCalls)}
                  onClick={() => {
                    setInspectingAiCall(a)
                    setAiCallPanelOpen(false)
                  }}
                >
                  <span className={styles.aiCallFloatingPanelItemIcon}>
                    {a.status === 'running' ? '⟳' : a.status === 'error' ? '⚠' : '✓'}
                  </span>
                  <span className={styles.aiCallFloatingPanelItemLabel}>{a.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {messages.length === 0
        ? <EmptyState hasKey={hasKey} />
        : messages.map(msg => {
          const isUser = msg.role === 'user'

          // Ephemeral "Waiting for Xs to not trigger Gemini RPM limit."
          // notices (see useChat.ts's onRateLimitWait subscription) get a
          // light, non-bubble treatment — they're operational status, not
          // an actual assistant reply, so a full avatar/header row would
          // overstate them.
          if (msg.isRateLimitNotice) {
            return (
              <div key={msg.id} className={styles.rateLimitNotice}>
                <span className={styles.rateLimitNoticeIcon}>⏳</span>
                <span>{msg.body}</span>
              </div>
            )
          }

          return (
            <div
              key={msg.id}
              className={`${styles.msg} ${isUser ? styles.msgUserRow : ''}`}
            >
              <div className={`${styles.msgHeader} ${isUser ? styles.msgHeaderUser : ''}`}>
                <div className={`${styles.msgAvatar} ${isUser ? styles.avatarUser : styles.avatarAi}`}>
                  {msg.initials}
                </div>
                <span className={`${styles.msgName} ${isUser ? styles.msgNameUser : ''}`}>{msg.name}</span>
                {msg.isDesign && (
                  <>
                    <span className={styles.designBadge}>DESIGN</span>
                    <button
                      className={styles.designCanvasBtn}
                      onClick={() => useDesignCanvasStore.getState().open()}
                      title="Open Design Canvas — view all pages on one board"
                    >
                      🎨 Open Canvas
                    </button>
                  </>
                )}
                <span className={styles.msgTime}>{msg.time}</span>
                {msg.persistenceStatus === 'unsaved' && (
                  <span className={styles.msgTime} title="Rachna will keep retrying this message in the background">
                    Not saved yet
                  </span>
                )}
                <VersionNav msg={msg} streaming={streaming} onSwitchVersion={onSwitchVersion} />
                {msg.body && <MessageCopyBtn content={msg.body} />}
                {isUser && (
                  <>
                    <button
                      className={styles.retryBtn}
                      onClick={() => onRetry(msg.id)}
                      title="Retry this message"
                    >
                      ↺
                    </button>
                    <button
                      className={styles.editMsgBtn}
                      onClick={() => editingMsgId === msg.id ? cancelEdit() : startEdit(msg)}
                      title={editingMsgId === msg.id ? 'Cancel edit' : 'Edit and resend from here'}
                    >
                      {editingMsgId === msg.id ? '✕' : '✎'}
                    </button>
                  </>
                )}
              </div>

              <div className={`${styles.msgBody} ${isUser ? styles.msgUser : styles.msgAi}`}>
                {/* ── Inline edit mode ──────────────────────────────── */}
                {isUser && editingMsgId === msg.id ? (
                  <div className={styles.editMsgArea}>
                    <textarea
                      className={styles.editMsgTextarea}
                      value={editDraft}
                      onChange={e => setEditDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(msg.id) }
                        if (e.key === 'Escape') cancelEdit()
                      }}
                      autoFocus
                      rows={Math.max(2, editDraft.split('\n').length)}
                    />
                    <div className={styles.editMsgActions}>
                      <button className={styles.editMsgSend}  onClick={() => commitEdit(msg.id)}>Send</button>
                      <button className={styles.editMsgCancel} onClick={cancelEdit}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                {isUser && (msg.images?.length ?? 0) > 0 && (
                  <div className={styles.imagePreviewRow}>
                    {msg.images!.map((img, i) => (
                      <div key={i} className={styles.imagePreviewThumb}>
                        <img src={img.previewUrl} alt="Attached" />
                      </div>
                    ))}
                  </div>
                )}
                {!isUser && msg.retrieval && (
                  <RetrievalStatsRow stats={msg.retrieval} />
                )}
                {!isUser && msg.compressionMetrics && (
                  <CompressionStatsRow metrics={msg.compressionMetrics} />
                )}
                {!isUser && (msg.agentActivities?.length ?? 0) > 0 && (
                  <div className={styles.agentActivities}>
                    {msg.agentActivities!.map(a => (
                      <AgentActivityRow key={a.id} activity={a} onInspectAiCall={setInspectingAiCall} />
                    ))}
                  </div>
                )}

                {msg.body
                  ? (
                    <MessageBody
                      body={msg.body}
                      streaming={streaming && msg.id === streamingMsgId}
                    />
                  )
                  : streaming && msg.id === streamingMsgId
                    ? (
                      <div className={styles.dotsRow}>
                        <span className={styles.streamDot} />
                        <span className={styles.streamDot} style={{ animationDelay: '0.18s' }} />
                        <span className={styles.streamDot} style={{ animationDelay: '0.36s' }} />
                      </div>
                    )
                    : (msg.intentPlan)
                      // Body was intentionally emptied because its content
                      // (raw plan / feasibility text) is already shown below
                      // as a formatted card — don't also show the "stopped"
                      // placeholder dash in that case.
                      ? null
                      : (
                        <span className={styles.stoppedPlaceholder}>—</span>
                      )
                }

                {/* ── Retry failed step ──────────────────────────────────
                     Shown whenever a turn errored out — whether that's an
                     API call that failed before any tool ran, or a timeout
                     after one or more tool calls already succeeded. Always
                     resumes from exactly that point (never repeats
                     already-succeeded tool calls), and can be clicked again
                     if the retry itself fails. ── */}
                {!isUser && msg.resumable && (
                  <button
                    className={styles.continueBtn}
                    onClick={() => onContinue(msg.id)}
                    disabled={streaming}
                    title="Retry the failed step, without repeating earlier steps"
                  >
                    ↻ Retry
                  </button>
                )}

                {/* ── Pending settings toggle ───────────────────────────
                     Shown when a git_action call was blocked by a
                     Settings → Git safety gate. Flipping it both updates
                     the real setting and auto-resumes the blocked action —
                     no free-text reply for intent classification to
                     misinterpret as a new, unrelated request. ── */}
                {!isUser && msg.pendingToggle && (
                  <PendingToggleCard
                    msgId={msg.id}
                    settingKey={msg.pendingToggle.settingKey}
                    label={msg.pendingToggle.label}
                    resolved={!!msg.pendingToggle.resolved}
                    disabled={streaming}
                    locked={!canConfigurePermissions}
                    onResolve={onResolveToggle}
                  />
                )}

                {/* ── Clarification card (correction confirm / questions) ──
                     Shown BEFORE the plan card when the Agentic Classifier
                     flagged the raw message as needing a "did you mean...?"
                     confirmation and/or up to 3 clarifying answers first —
                     see useChat's presentClarificationOrPlan /
                     resolveClarification. Nothing is planned until this
                     resolves. ── */}
                {!isUser && msg.clarification && (
                  <ClarificationCard
                    msgId={msg.id}
                    correctedText={msg.clarification.correctedText}
                    questions={msg.clarification.questions}
                    answers={msg.clarification.answers}
                    resolved={msg.clarification.resolved}
                    useOriginal={msg.clarification.useOriginal}
                    disabled={streaming}
                    onResolve={onResolveClarification}
                  />
                )}

                {/* ── Intent-based Task Planner plan card ─────────────────
                     Shows the (unmodified, already-generated) plan for
                     review before any step runs, then — once approved —
                     keeps rendering as a live pending/running/completed/
                     failed tracker for each step (see stepStatuses,
                     populated by useChat's runDecomposedSteps). ── */}
                {!isUser && msg.intentPlan && (
                  <IntentPlanCard
                    plan={msg.intentPlan}
                    approved={!!msg.planApproved}
                    autoApproved={!!msg.autoApproved}
                    cancelled={!!msg.planCancelled}
                    stepStatuses={msg.stepStatuses}
                    executionCancelled={!!msg.executionCancelled}
                    msgId={msg.id}
                    onApprove={onApprovePlan}
                    onModify={onModifyPlan}
                    onCancel={onCancelPlan}
                    onRetryStep={onRetryStep}
                    onMarkStepDone={onMarkStepDone}
                    onCancelExecution={onCancelExecution}
                  />
                )}

                {!isUser && pendingEdits.length > 0 && (
                  <div className={styles.pendingEditsSection}>
                    <div className={styles.pendingEditsHeader}>Pending edits:</div>
                    {pendingEdits.map(edit => (
                      <div key={edit.id} className={styles.pendingEditItem}>
                        <span className={styles.pendingEditFile}>{edit.fileName}</span>
                        <EditActionButtons edit={edit} onStatusChange={() => setRefresh(r => r + 1)} />
                      </div>
                    ))}
                  </div>
                )}
                  </>
                )}
              </div>
            </div>
          )
        })
      }

      {/* ── Persistent "working" indicator at the end of the chat ──── */}
      {streaming && messages.length > 0 && (() => {
        const streamingMsg = streamingMsgId
          ? messages.find(m => m.id === streamingMsgId)
          : null
        const hasActivities = (streamingMsg?.agentActivities?.length ?? 0) > 0
        return hasActivities ? null : <ThinkingIndicator />
      })()}

      <div ref={endRef} />

      {/* ── AI call inspector overlay (persisted "API Call" chips) ─────── */}
      {inspectingAiCall && canInspectAiCalls && (
        <AiCallOverlay activity={inspectingAiCall} onClose={() => setInspectingAiCall(null)} canInspect={canInspectAiCalls} />
      )}
    </div>
  )
}
