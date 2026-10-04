// components/AiChat/ChatHeader.tsx

import React from 'react'
import styles from '../AiChat.module.css'
import type { CompactionMetadata } from '../../lib/conversationCompaction'
import type { GeminiQuotaStatus } from '../../lib/providers/geminiRateLimiter'
import { useActionAutoApproveStore } from '../../store/useActionAutoApproveStore'

interface Props {
  pendingEditCount:    number
  messageCount:        number
  chatOpen:            boolean
  exporting:           boolean
  onExport:            () => void
  onNewChat:           () => void
  /**
   * Chat View only (the floating chat-only dialog window). Row 1: badges/
   * PDF export + "+ New Chat" — in both Full Studio View and Chat View.
   * This flag just tightens the gap/padding a little for the narrower Chat
   * View window; it no longer changes which controls go on which row (the
   * Terminal/Screenshots/Mouse & Keys auto-approve pills now live in the
   * ACTIONS bar — see AiChat.tsx's exported `AutoApproveToggle`).
   */
  compactDialogLayout?: boolean
  /** Estimated token count for current chat history. */
  chatTokenEstimate?:  number
  /** Number of compaction passes that have occurred. */
  compactionPassCount?: number
  /** Metadata from the last compaction (for tooltip). */
  lastCompactionMeta?: CompactionMetadata | null
  /**
   * RPM/RPD usage for the active model, when the active provider is Gemini
   * with a key + model selected. Renders a small "3/15 rpm · 20/500 rpd"
   * badge — always visible (not just when near the limit; GeminiQuotaBanner
   * still owns the separate warning banner for that). Null/undefined hides
   * the badge (non-Gemini provider, no key, or no configured limits for
   * this model).
   */
  geminiQuota?: GeminiQuotaStatus | null
  /** True when a project folder is currently open. Controls whether the
   *  folder-chips bar is shown at all — there's nothing to pick from when
   *  no project is open. */
  projectOpen?: boolean
  /** One entry per currently-open folder (primary project + any additional
   *  folders added via the File Explorer) — see store/useAdditionalFoldersStore
   *  and AiChat.tsx's folderChips. Rendered as a horizontally scrollable,
   *  retractable strip of chips (see FolderChipsBar below). */
  folderChips?: { path: string; name: string }[]
  /** Absolute paths of the currently-selected folder chip(s) — see
   *  store/useFolderChipsStore. */
  selectedFolderPaths?: string[]
  /** Toggles a single folder chip's selection on/off. */
  onToggleFolderChip?: (path: string) => void
}

// ── FolderChipsBar ────────────────────────────────────────────────────────
// One chip per currently-open folder (primary project + any additional
// folders), laid out in a horizontally scrollable strip instead of the old
// single "With Repo Context" boolean toggle. Clicking a chip selects/
// deselects that folder for the next Send — repo context sent alongside is
// built ONLY from whichever chip(s) are selected (see useChat.ts's
// executeSend / store/useFolderChipsStore.ts). Multiple chips can be
// selected at once, in which case context from every selected folder goes.
// Always shown in full (no collapse toggle) — when there are more chips
// than fit, the row just scrolls horizontally.
function FolderChipsBar({
  folders, selectedPaths, onToggle,
}: {
  folders: { path: string; name: string }[]
  selectedPaths: string[]
  onToggle: (path: string) => void
}) {
  if (folders.length === 0) return null

  return (
    <div className={styles.folderChipsBar}>
      <div className={styles.folderChipsScroll}>
        {folders.map(f => {
          const selected = selectedPaths.includes(f.path)
          return (
            <button
              type="button"
              key={f.path}
              className={`${styles.autoApprovePill} ${styles.folderChip} ${selected ? styles.folderChipActive : ''}`}
              onClick={() => onToggle(f.path)}
              aria-pressed={selected}
              title={
                selected
                  ? `${f.name} — selected. This Send will use this folder's repo context. Click to deselect.`
                  : `${f.name} — click to select. Selecting sends this folder's repo context with the next Send.`
              }
            >
              <span className={styles.autoApprovePillIcon}>📁</span>
              {f.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── AutoApproveToggle ─────────────────────────────────────────────────────
// Three always-visible "skip the permission dialog" toggle buttons — one
// per action category — instead of a dropdown, so the current auto-approve
// state is legible at a glance without an extra click. Reads/writes the
// store directly so no wiring is needed through parents.
export function AutoApproveToggle() {
  const {
    autoApproveTerminal,
    autoApproveScreenshots,
    autoApproveInputControl,
    setAutoApproveTerminal,
    setAutoApproveScreenshots,
    setAutoApproveInputControl,
  } = useActionAutoApproveStore()

  const pill = (
    icon: string,
    label: string,
    hint: string,
    checked: boolean,
    onToggle: (v: boolean) => void,
  ) => (
    <button
      type="button"
      className={`${styles.autoApprovePill} ${checked ? styles.autoApprovePillActive : ''}`}
      onClick={() => onToggle(!checked)}
      aria-pressed={checked}
      title={`${checked ? 'Auto-approve ON' : 'Auto-approve OFF'} — ${hint}`}
    >
      <span className={styles.autoApprovePillIcon}>{icon}</span>
      {label}
    </button>
  )

  return (
    <div className={styles.autoApproveGroup} title="Agent auto-approve — skip the permission dialog for chosen action categories">
      {pill('⌘', 'Terminal', 'run_terminal_command calls execute without a confirmation click.', autoApproveTerminal, setAutoApproveTerminal)}
      {pill('◧', 'Screenshots', 'take_screenshot calls run without asking first.', autoApproveScreenshots, setAutoApproveScreenshots)}
      {pill('⌨', 'Mouse & Keys', 'mouse_click / press_key calls run without asking first.', autoApproveInputControl, setAutoApproveInputControl)}
    </div>
  )
}

export function ChatHeader({
  pendingEditCount,
  messageCount,
  chatOpen,
  exporting,
  onExport,
  onNewChat,
  chatTokenEstimate    = 0,
  compactionPassCount  = 0,
  lastCompactionMeta   = null,
  geminiQuota          = null,
  compactDialogLayout = false,
  projectOpen          = false,
  folderChips          = [],
  selectedFolderPaths  = [],
  onToggleFolderChip,
}: Props) {
  const newChatLabel =
    chatOpen && messageCount > 0 ? '+ New Chat' :
                                   '+ New Chat'

  const newChatTitle =
    chatOpen && messageCount > 0 ? 'Start a new chat' :
                                   'New chat'

  // Token usage badge: show when there's meaningful history
  const showTokenBadge = chatTokenEstimate > 500

  // Compaction badge: show after at least one pass
  const showCompactionBadge = compactionPassCount > 0

  // Build compaction tooltip
  const compactionTooltip = lastCompactionMeta
    ? `Compaction pass #${lastCompactionMeta.passNumber} · ` +
      `Saved ~${lastCompactionMeta.tokensSaved.toLocaleString()} tokens (${lastCompactionMeta.savingsPct}%) · ` +
      `${lastCompactionMeta.compactedMessageCount} msgs compacted`
    : 'Conversation has been compacted'

  // Badges + export button — identical markup/behavior in both layouts,
  // just relocated between rows when compactDialogLayout is on.
  const badgesAndExport = (
    <>
      {pendingEditCount > 0 && (
        <span
          className={styles.pendingEditsBadge}
          title={`${pendingEditCount} pending change(s) — review in the editor tabs`}
        >
          ⎇ {pendingEditCount}
        </span>
      )}

      {/* Token usage estimate */}
      {showTokenBadge && (
        <span
          className={styles.tokenBadge}
          title={`~${chatTokenEstimate.toLocaleString()} estimated tokens in chat history`}
        >
          ~{chatTokenEstimate > 1000
            ? `${(chatTokenEstimate / 1000).toFixed(1)}k`
            : chatTokenEstimate} tok
        </span>
      )}

      {/* Gemini RPM/RPD usage — always visible when a Gemini model with
          configured limits is active, not just when near the cap (that's
          GeminiQuotaBanner's job, further down in the send bar). */}
      {geminiQuota && (
        <span
          className={`${styles.tokenBadge} ${geminiQuota.isExhausted ? styles.quotaBadgeExhausted : geminiQuota.isNearLimit ? styles.quotaBadgeWarn : ''}`}
          title={
            `${geminiQuota.model} free-tier usage — ` +
            `${geminiQuota.rpmUsed}/${geminiQuota.rpm} requests this minute, ` +
            `${geminiQuota.count}/${geminiQuota.rpd} requests today.`
          }
        >
          {geminiQuota.rpmUsed}/{geminiQuota.rpm} rpm · {geminiQuota.count}/{geminiQuota.rpd} rpd
        </span>
      )}

      {/* Compaction indicator */}
      {showCompactionBadge && (
        <span
          className={styles.compactionBadge}
          title={compactionTooltip}
        >
          ⚡ ×{compactionPassCount}
        </span>
      )}

      {messageCount > 0 && (
        <button
          className={styles.exportBtn}
          onClick={onExport}
          disabled={exporting}
          title="Export chat as PDF"
        >
          {exporting ? '⟳ Exporting…' : '↓ PDF'}
        </button>
      )}
    </>
  )

  const newChatButton = (
    <button
      className={styles.newChatBtn}
      onClick={onNewChat}
      title={newChatTitle}
    >
      {newChatLabel}
    </button>
  )

  // ── Header rows: row 1 = badges/PDF export + New Chat, row 2 (when a
  //    project is open) = the folder context chips. compactDialogLayout
  //    only tweaks spacing/padding for the narrower Chat View window —
  //    the structure itself is identical either way. The auto-approve
  //    pills (Terminal / Screenshots / Mouse & Keys) no longer render
  //    here — they live in the ACTIONS bar instead (see AiChat.tsx). ────
  return (
    <div className={compactDialogLayout ? styles.headerCompact : styles.header2Row}>
      <div className={styles.headerRow1}>
        {badgesAndExport}
        {newChatButton}
      </div>
      {projectOpen && folderChips.length > 0 && (
        <FolderChipsBar
          folders={folderChips}
          selectedPaths={selectedFolderPaths}
          onToggle={path => onToggleFolderChip?.(path)}
        />
      )}
    </div>
  )
}
