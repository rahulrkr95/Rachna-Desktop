// components/AiChat/ConversationSidebar.tsx
//
// Shows every past conversation, split into two kinds of sections:
//   - "User Chats": conversations saved while no project folder was open
//     (NO_PROJECT_KEY scope). Always a flat list, always visible — these
//     used to be discarded entirely; they now persist just like any
//     project's chats do.
//   - "Projects": one expandable group per project that has chat history.
//     Clicking a chat that belongs to a project other than the one
//     currently open asks the host to switch to that project first (see
//     useChat's onSwitchProject / restoreConversation).
//
// Inside each section, conversations are grouped by recency (Today /
// Yesterday / Previous 7 Days / Older) the way ChatGPT, Gemini, and
// Claude's own chat history panels do. Each row is clickable (restore),
// has a trash icon (delete with inline confirmation), and the active
// session is highlighted.
//
// Props come directly from UseChatReturn so AiChat.tsx just passes them
// down without any extra state.

import React, { useState, useEffect, useMemo } from 'react'
import styles from './ConversationSidebar.module.css'
import type { Conversation } from '../../lib/conversationMemory'

// ── Date formatting ───────────────────────────────────────────────────────────

function formatRelative(ts: string): string {
  // `created_at` / `updated_at` are stored as millisecond epoch strings
  const ms = Number(ts)
  if (!ms) return ''
  const now = Date.now()
  const diff = now - ms
  if (diff < 60_000)       return 'just now'
  if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── Grouping (Today / Yesterday / Previous 7 Days / Older) ───────────────────

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function groupLabel(updatedAt: string): string {
  const ms = Number(updatedAt)
  if (!ms) return 'Older'
  const today = startOfDay(Date.now())
  const day   = startOfDay(ms)
  const diffDays = Math.round((today - day) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays <= 7)  return 'Previous 7 Days'
  if (diffDays <= 30) return 'Previous 30 Days'
  return 'Older'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older']

function groupConversations(conversations: Conversation[]): Array<[string, Conversation[]]> {
  const buckets = new Map<string, Conversation[]>()
  for (const conv of conversations) {
    const label = groupLabel(conv.updated_at)
    if (!buckets.has(label)) buckets.set(label, [])
    buckets.get(label)!.push(conv)
  }
  return GROUP_ORDER
    .filter(label => buckets.has(label))
    .map(label => [label, buckets.get(label)!])
}

// ── ConversationRows: the grouped-by-recency list, reused for both the
//    "User Chats" section and the inside of each expanded project group ──────

interface ConversationRowsProps {
  conversations:        Conversation[]
  activeConversationId: string | null
  /** id of the conversation a run is currently in flight for (null when nothing is running) — see Props.runningConversationId. */
  runningConversationId: string | null
  confirmId:            string | null
  onRestore:            (conv: Conversation) => void
  onDeleteClick:        (e: React.MouseEvent, id: string) => void
  onConfirmYes:         (e: React.MouseEvent, conv: Conversation) => void
  onConfirmNo:          (e: React.MouseEvent) => void
  emptyHint:            string
}

function ConversationRows({
  conversations,
  activeConversationId,
  runningConversationId,
  confirmId,
  onRestore,
  onDeleteClick,
  onConfirmYes,
  onConfirmNo,
  emptyHint,
}: ConversationRowsProps) {
  const grouped = useMemo(() => groupConversations(conversations), [conversations])

  if (conversations.length === 0) {
    return <div className={styles.empty}>{emptyHint}</div>
  }

  return (
    <>
      {grouped.map(([label, convs]) => (
        <div key={label} className={styles.group}>
          <div className={styles.groupLabel}>{label}</div>

          {convs.map(conv => {
            // Show inline delete confirmation for this row
            if (confirmId === conv.id) {
              return (
                <div key={conv.id} className={styles.confirmRow}>
                  <span className={styles.confirmLabel} title={conv.title}>
                    Delete "{conv.title}"?
                  </span>
                  <button
                    className={styles.confirmYes}
                    onClick={e => onConfirmYes(e, conv)}
                  >
                    Delete
                  </button>
                  <button
                    className={styles.confirmNo}
                    onClick={onConfirmNo}
                  >
                    Cancel
                  </button>
                </div>
              )
            }

            const isActive  = conv.id === activeConversationId
            const isRunning = conv.id === runningConversationId

            return (
              <div
                key={conv.id}
                className={`${styles.item} ${isActive ? styles.active : ''}`}
                onClick={() => !isActive && onRestore(conv)}
                title={isRunning ? `${conv.title} — a response is being generated` : conv.title}
              >
                <div className={styles.itemText}>
                  <div className={styles.itemTitle}>
                    {isRunning && <span className={styles.runningSpinner} aria-label="Generating response" />}
                    {conv.title}
                  </div>
                  <div className={styles.itemDate}>
                    {isRunning ? 'Generating…' : formatRelative(conv.updated_at)}
                  </div>
                </div>

                <button
                  className={styles.deleteBtn}
                  onClick={e => onDeleteClick(e, conv.id)}
                  title="Delete conversation"
                >
                  🗑
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface ProjectGroup {
  projectRoot: string
  label: string
  conversations: Conversation[]
}

interface Props {
  /** No-project ("User Chats") conversations — always a flat list. */
  noProjectConversations: Conversation[]
  /** One entry per project with chat history — rendered as expandable groups. */
  projectConversationGroups: ProjectGroup[]
  /** The project folder path currently open, or null if none (welcome screen). */
  currentProjectRoot:  string | null
  activeConversationId: string | null
  /**
   * id of the conversation currently generating a response (a run is
   * in-flight for it — see useChat's `streaming` + `activeConversationId`),
   * or null when nothing is running. Renders a small spinner + "Generating…"
   * on that conversation's row so it's visible in the history list even
   * while looking at a different chat.
   */
  runningConversationId?: string | null
  onRestore:           (conversation: Conversation) => void
  onDelete:            (id: string) => void
  onNewChat:           () => void
  /** Re-fetches the conversation list from SQLite (useChat's refreshHistory). */
  onRefresh:           () => Promise<void>
  /** True when rendered inside the left panel's "Chat" tab (alongside
   *  File Explorer / Git / Design Canvas) rather than as its own
   *  permanently-docked rail next to the messages. Fills 100% of its
   *  container, drops its own border/collapse chrome (switching panels
   *  is now the activity bar's job), and always shows expanded. */
  embedded?: boolean
}

// ── ClearAllButton ────────────────────────────────────────────────────────
// Icon button + inline confirm bar (same pattern as the per-row delete
// confirmation below), instead of a native confirm() — keeps the UI
// consistent and avoids a blocking browser dialog.
interface ClearAllButtonProps {
  disabled: boolean
  clearing: boolean
  onConfirm: () => void
}

function ClearAllButton({ disabled, clearing, onConfirm }: ClearAllButtonProps) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className={styles.clearAllConfirm}>
        <span className={styles.clearAllConfirmLabel}>Delete all chats?</span>
        <button
          className={styles.confirmYes}
          disabled={clearing}
          onClick={() => { onConfirm(); setConfirming(false) }}
        >
          {clearing ? 'Deleting…' : 'Delete all'}
        </button>
        <button className={styles.confirmNo} disabled={clearing} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      className={styles.toggleBtn}
      onClick={() => setConfirming(true)}
      disabled={disabled}
      title="Clear all chat history"
    >
      🗑
    </button>
  )
}

export function ConversationSidebar({
  noProjectConversations,
  projectConversationGroups,
  currentProjectRoot,
  activeConversationId,
  runningConversationId = null,
  onRestore,
  onDelete,
  onNewChat,
  onRefresh,
  embedded = false,
}: Props) {
  // Track which row is pending delete confirmation
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // Spins the refresh icon while a manual refresh is in flight.
  const [refreshing, setRefreshing] = useState(false)
  const handleRefreshClick = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  // Expanded by default — like ChatGPT/Gemini/Claude, chat history should be
  // visible at a glance rather than hidden behind a toggle. Persist the
  // user's preference if they do collapse it. Embedded mode (rendered
  // inside the left panel's own "Chat" tab) has no collapse state of its
  // own — the activity bar is what shows/hides it now — so it always
  // stays expanded there.
  const [collapsedState, setCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('rachna_ide_history_collapsed') === '1'
    } catch {
      return false
    }
  })
  const collapsed = embedded ? false : collapsedState

  useEffect(() => {
    if (embedded) return
    try {
      localStorage.setItem('rachna_ide_history_collapsed', collapsedState ? '1' : '0')
    } catch { /* ignore */ }
  }, [collapsedState, embedded])

  // Which project groups are expanded. The currently-open project (if any)
  // starts expanded; the user can toggle any group open/closed from there.
  const [expandedRoots, setExpandedRoots] = useState<Set<string>>(() =>
    currentProjectRoot ? new Set([currentProjectRoot]) : new Set()
  )
  // If the user opens a different project, make sure its group is expanded
  // too (without collapsing groups they already opened manually).
  useEffect(() => {
    if (!currentProjectRoot) return
    setExpandedRoots(prev =>
      prev.has(currentProjectRoot) ? prev : new Set(prev).add(currentProjectRoot)
    )
  }, [currentProjectRoot])

  const toggleExpanded = (root: string) => {
    setExpandedRoots(prev => {
      const next = new Set(prev)
      if (next.has(root)) next.delete(root)
      else next.add(root)
      return next
    })
  }

  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setConfirmId(id)
  }

  const handleConfirmYes = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    setConfirmId(null)
    onDelete(conv.id)
  }

  const handleConfirmNo = (e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmId(null)
  }

  const isEmpty = noProjectConversations.length === 0 && projectConversationGroups.length === 0

  // ── Clear all ─────────────────────────────────────────────────────────
  // Deletes every conversation across "User Chats" and every project group.
  // There's no bulk-delete backend command, so this just fans out
  // deleteConversation (the existing per-row onDelete) over every id and
  // refreshes once at the end, then starts a fresh chat since whatever was
  // active just got wiped too.
  const [clearing, setClearing] = useState(false)
  const handleClearAll = async () => {
    if (clearing || isEmpty) return
    setClearing(true)
    try {
      const allIds = [
        ...noProjectConversations.map(c => c.id),
        ...projectConversationGroups.flatMap(g => g.conversations.map(c => c.id)),
      ]
      await Promise.all(allIds.map(id => Promise.resolve(onDelete(id))))
      await onRefresh()
      onNewChat()
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''} ${embedded ? styles.embedded : ''}`}>
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        {!collapsed && <span className={styles.headerTitle}>Past Chats</span>}
        {/* All header icon buttons live in ONE flex row of their own so they
            lay out side by side with a fixed gap, instead of being spread
            apart individually inside .header's own space-between flex —
            which let the refresh (⟳) and clear-all (🗑) buttons render on
            top of each other in both the docked "Chat" tab and the Chat
            View dialog. */}
        <div className={styles.headerActions}>
          {!collapsed && (
            <button
              className={styles.toggleBtn}
              onClick={handleRefreshClick}
              disabled={refreshing}
              title="Refresh chat list"
            >
              <span className={refreshing ? styles.spinning : undefined}>⟳</span>
            </button>
          )}
          {!collapsed && (
            <ClearAllButton disabled={isEmpty || clearing} clearing={clearing} onConfirm={handleClearAll} />
          )}
          {/* Collapse/expand is redundant once this panel lives inside the
              left panel's own Chat tab — switching away is the activity
              bar's job — so it's only shown in the old standalone rail. */}
          {!embedded && (
            <button
              className={styles.toggleBtn}
              onClick={() => setCollapsedState(!collapsedState)}
              title={collapsed ? "Expand history" : "Collapse history"}
            >
              {collapsed ? '▶' : '◀'}
            </button>
          )}
        </div>
      </div>

      {/* ── New chat button ─────────────────────────────────────────────── */}
      {!collapsed && (
        <button className={styles.newChatBtn} onClick={onNewChat}>
          <span className={styles.newChatIcon}>+</span> New chat
        </button>
      )}

      {/* ── List ──────────────────────────────────────────────────────── */}
      {!collapsed && (
        <div className={styles.list}>
          {isEmpty && (
            <div className={styles.empty}>
              No conversations yet.
              <br />
              Start chatting to build history.
            </div>
          )}

          {/* ── User Chats (no project open) — always a flat section ──── */}
          {!isEmpty && (
            <div className={styles.projectGroup}>
              <div className={styles.projectGroupHeader}>
                <span className={styles.projectGroupIcon}>💬</span>
                <span className={styles.projectGroupLabel}>
                  User Chats{currentProjectRoot === null ? ' (current)' : ''}
                </span>
                <span className={styles.projectGroupCount}>{noProjectConversations.length}</span>
              </div>
              <ConversationRows
                conversations={noProjectConversations}
                activeConversationId={activeConversationId}
                runningConversationId={runningConversationId}
                confirmId={confirmId}
                onRestore={onRestore}
                onDeleteClick={handleDeleteClick}
                onConfirmYes={handleConfirmYes}
                onConfirmNo={handleConfirmNo}
                emptyHint="No chats outside a project yet."
              />
            </div>
          )}

          {/* ── Projects — one expandable group per project ────────────── */}
          {projectConversationGroups.length > 0 && (
            <div className={styles.projectsSection}>
              <div className={styles.groupLabel}>Projects</div>
              {projectConversationGroups.map(group => {
                const isCurrent = group.projectRoot === currentProjectRoot
                const expanded = expandedRoots.has(group.projectRoot)
                return (
                  <div
                    key={group.projectRoot}
                    className={`${styles.projectGroup} ${!isCurrent ? styles.projectGroupNonCurrent : ''}`}
                  >
                    <div
                      className={`${styles.projectGroupHeader} ${styles.projectGroupHeaderClickable}`}
                      onClick={() => toggleExpanded(group.projectRoot)}
                      title={group.projectRoot}
                    >
                      <span className={styles.projectGroupChevron}>{expanded ? '▾' : '▸'}</span>
                      <span className={styles.projectGroupIcon}>📁</span>
                      <span className={styles.projectGroupLabel}>
                        {group.label}{isCurrent ? ' (current)' : ''}
                      </span>
                      <span className={styles.projectGroupCount}>{group.conversations.length}</span>
                    </div>
                    {expanded && (
                      <ConversationRows
                        conversations={group.conversations}
                        activeConversationId={activeConversationId}
                        runningConversationId={runningConversationId}
                        confirmId={confirmId}
                        onRestore={onRestore}
                        onDeleteClick={handleDeleteClick}
                        onConfirmYes={handleConfirmYes}
                        onConfirmNo={handleConfirmNo}
                        emptyHint="No chats yet."
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
