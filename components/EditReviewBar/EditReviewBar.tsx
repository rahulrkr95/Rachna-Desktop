// components/EditReviewBar/EditReviewBar.tsx
//
// Review bar for pending AI-proposed edits.
//
// SINGLE edits: the original compact pill — "⎇ 1 file · Reject · View · Merge"
//
// BATCH edits: ONE card per batch with a SINGLE set of actions — Reject
// Batch / View All / Merge Batch — that applies to every file in the batch
// at once. The expanded file list is read-only (name + description only);
// there are intentionally no per-file accept/reject/view controls, so the
// user always reviews and resolves a multi-file edit as one atomic unit
// rather than file-by-file.
//
// Mixed: if the agent made some unbatched single edits alongside a batch,
// the unbatched ones each get their own single-edit row below the batch cards.

import React, { useState, useCallback } from 'react'
import {
  useEditStore,
  selectPendingCount,
  selectBatchGroups,
  type BatchGroup,
} from '../../services/edits/EditStore'
import { useEditorStore } from '../../store/useEditorStore'
import styles from './EditReviewBar.module.css'

// ── Batch card (3+ files or explicitly batched) ───────────────────────────

interface BatchCardProps {
  group: BatchGroup
  /** Called once a merge finishes with at least one file successfully
   *  written to disk, so the root component can surface the "Verify"
   *  follow-up action after this card unmounts (it disappears the moment
   *  its edits leave `pending`, so that state can't live here). */
  onMerged: (label: string, count: number) => void
}

function BatchCard({ group, onMerged }: BatchCardProps) {
  const acceptBatch = useEditStore(s => s.acceptBatch)
  const rejectBatch = useEditStore(s => s.rejectBatch)
  const [merging, setMerging] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)
  const [expanded, setExpanded] = useState(false)

  const isTrueBatch = group.edits.length > 1 && group.edits[0].batchId !== group.edits[0].id

  const handleMerge = useCallback(async () => {
    setMerging(true)
    setResult(null)
    const { accepted, failed } = await acceptBatch(group.batchId)
    setResult(
      failed === 0
        ? { kind: 'ok', msg: `✓ ${accepted} file${accepted !== 1 ? 's' : ''} merged` }
        : { kind: 'err', msg: `✓ ${accepted} merged, ✗ ${failed} failed` }
    )
    setMerging(false)
    if (accepted > 0) {
      onMerged(group.batchName, accepted)
    }
    setTimeout(() => setResult(null), 3000)
  }, [acceptBatch, group.batchId, group.batchName, onMerged])

  const handleReject = useCallback(() => {
    rejectBatch(group.batchId)
  }, [rejectBatch, group.batchId])

  const handleViewAll = useCallback(() => {
    const store = useEditorStore.getState()
    for (const edit of group.edits) {
      const already = store.diffTabs.find(t => t.editId === edit.id)
      if (!already) {
        store.openDiffTab({
          id: edit.id,
          editId: edit.id,
          name: `⎇ ${edit.fileName}`,
          filePath: edit.filePath,
          fileName: edit.fileName,
          language: edit.language,
        })
      } else {
        store.activateDiffTabForFile(edit.filePath)
      }
    }
    if (group.edits.length > 0) {
      store.activateDiffTabForFile(group.edits[0].filePath)
    }
  }, [group.edits])

  // Single-file unbatched edit: render the compact pill style
  if (!isTrueBatch) {
    const edit = group.edits[0]
    return (
      <div className={styles.bar}>
        <div className={styles.left}>
          <span className={styles.icon}>⎇</span>
          <span className={styles.label}>{edit.fileName}</span>
          <span className={styles.descChip} title={edit.description}>
            {edit.description.length > 48
              ? edit.description.slice(0, 48) + '…'
              : edit.description}
          </span>
        </div>
        <div className={styles.actions}>
          {result && (
            <span className={`${styles.resultMsg} ${result.kind === 'ok' ? styles.resultOk : styles.resultErr}`}>
              {result.msg}
            </span>
          )}
          <button className={styles.btnReject} onClick={handleReject} disabled={merging}>
            ✕ Reject
          </button>
          <button className={styles.btnView} onClick={handleViewAll}>
            ⎇ View
          </button>
          <button
            className={`${styles.btnMerge} ${merging ? styles.btnMerging : ''}`}
            onClick={handleMerge}
            disabled={merging}
          >
            {merging ? <><span className={styles.spinner} /> Merging…</> : '✓ Merge'}
          </button>
        </div>
      </div>
    )
  }

  // Multi-file batch: rich card
  return (
    <div className={styles.batchCard}>
      {/* ── Header row ── */}
      <div className={styles.batchHeader}>
        <div className={styles.batchLeft}>
          <span className={styles.batchIcon}>⎇</span>
          <div className={styles.batchMeta}>
            <span className={styles.batchName}>{group.batchName}</span>
            <span className={styles.batchCount}>
              {group.edits.length} file{group.edits.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button
            className={styles.expandToggle}
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Collapse file list' : 'Show file list'}
          >
            {expanded ? '▲' : '▼'}
          </button>
        </div>

        <div className={styles.actions}>
          {result && (
            <span className={`${styles.resultMsg} ${result.kind === 'ok' ? styles.resultOk : styles.resultErr}`}>
              {result.msg}
            </span>
          )}
          <button className={styles.btnReject} onClick={handleReject} disabled={merging}
            title="Reject all files in this batch">
            ✕ Reject Batch
          </button>
          <button className={styles.btnView} onClick={handleViewAll}
            title="Open diff tabs for all files in batch">
            ⎇ View All
          </button>
          <button
            className={`${styles.btnMerge} ${merging ? styles.btnMerging : ''}`}
            onClick={handleMerge}
            disabled={merging}
            title="Accept and write all files in batch to disk"
          >
            {merging ? <><span className={styles.spinner} /> Merging…</> : '✓ Merge Batch'}
          </button>
        </div>
      </div>

      {/* ── Expanded file list ── */}
      {expanded && (
        <div className={styles.batchFileList}>
          {group.edits.map(edit => (
            <BatchFileRow key={edit.id} edit={edit} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Individual file row inside an expanded batch card ─────────────────────
//
// Read-only: this list exists purely so the user can see which files are
// part of the batch before deciding. Per-file accept/reject/view actions
// were removed on purpose — a multi-file batch is reviewed and resolved
// through the single Reject Batch / View All / Merge Batch action set in
// the card header, not file-by-file.

interface BatchFileRowProps {
  edit: import('../../services/edits/EditStore').PendingEdit
}

function BatchFileRow({ edit }: BatchFileRowProps) {
  return (
    <div className={styles.fileRow}>
      <span className={styles.fileRowName} title={edit.filePath}>{edit.fileName}</span>
      <span className={styles.fileRowDesc} title={edit.description}>
        {edit.description.length > 40
          ? edit.description.slice(0, 40) + '…'
          : edit.description}
      </span>
    </div>
  )
}

// ── Post-merge "Verify" follow-up ───────────────────────────────────────────
//
// Manual, human-in-the-loop only: this never runs anything on its own. It
// just remembers the most recent successful merge and offers a button that,
// if the user chooses to click it, hands off to whatever "run the project"
// mechanism IDELayout already has (active Run Configuration → embedded
// terminal, or the Run Configuration panel if nothing is set up yet).

interface JustMerged {
  label: string
  count: number
}

function VerifyBar({ merged, onVerify, onDismiss }: {
  merged: JustMerged
  onVerify?: () => void
  onDismiss: () => void
}) {
  return (
    <div className={`${styles.bar} ${styles.verifyBar}`}>
      <div className={styles.left}>
        <span className={`${styles.icon} ${styles.iconOk}`}>✓</span>
        <span className={styles.label}>
          {merged.count} file{merged.count !== 1 ? 's' : ''} merged
        </span>
        <span className={styles.descChip} title={merged.label}>{merged.label}</span>
      </div>
      <div className={styles.actions}>
        <button className={styles.btnDismiss} onClick={onDismiss} title="Dismiss">
          ✕
        </button>
        <button
          className={styles.btnVerify}
          onClick={onVerify}
          disabled={!onVerify}
          title="Run the project locally to check this change (opens Run Configuration first if none is set up)"
        >
          ▶ Verify
        </button>
      </div>
    </div>
  )
}

// ── Root component ────────────────────────────────────────────────────────

interface EditReviewBarProps {
  /**
   * Optional — runs the project locally (e.g. the active Run
   * Configuration's run command in the embedded terminal, or opens the
   * Run Configuration panel if nothing is configured yet). Wired by
   * IDELayout to its existing handleRunProject. When omitted, the Verify
   * button is disabled rather than hidden, since it only ever appears
   * right after the user has explicitly merged a change.
   */
  onVerify?: () => void
  /**
   * True when rendered inside the small, fixed-size Chat View dialog
   * window (see IDELayout's chatDialogMode / services/viewModeWindow.ts's
   * CHAT_WIDTH/CHAT_HEIGHT — 400×600, no native title bar, no StatusBar).
   * The default card sizing/positioning below assumes the full IDE
   * window: a 400px min-width (wider than the ENTIRE chat dialog window)
   * and a `bottom: 28px` offset reserved for the StatusBar, which isn't
   * rendered in chat dialog mode. Both clip the card against the smaller
   * window's edges — this flag switches to the narrower, StatusBar-less
   * layout instead (see .reviewContainerDialog / .barDialog /
   * .batchCardDialog in EditReviewBar.module.css).
   */
  chatDialogMode?: boolean
}

export default function EditReviewBar({ onVerify, chatDialogMode = false }: EditReviewBarProps) {
  const pendingCount = useEditStore(selectPendingCount)
  const batchGroups = useEditStore(selectBatchGroups)
  // Set only when the user has just clicked Merge / Merge Batch and at
  // least one file was written to disk. Cleared on dismiss or once the
  // user acts on it — this is intentionally NOT tied to pending edits,
  // since the merged batch's card unmounts the instant it's no longer
  // pending, before the user could ever see a follow-up action on it.
  const [justMerged, setJustMerged] = useState<JustMerged | null>(null)

  const handleMerged = useCallback((label: string, count: number) => {
    setJustMerged({ label, count })
  }, [])

  const handleVerify = useCallback(() => {
    onVerify?.()
    setJustMerged(null)
  }, [onVerify])

  if (pendingCount === 0 && !justMerged) return null

  return (
    <div className={`${styles.reviewContainer} ${chatDialogMode ? styles.reviewContainerDialog : ''}`}>
      {batchGroups.map(group => (
        <BatchCard key={group.batchId} group={group} onMerged={handleMerged} />
      ))}
      {justMerged && (
        <VerifyBar
          merged={justMerged}
          onVerify={onVerify ? handleVerify : undefined}
          onDismiss={() => setJustMerged(null)}
        />
      )}
    </div>
  )
}
