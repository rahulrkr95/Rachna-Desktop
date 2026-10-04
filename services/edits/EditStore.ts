// services/edits/EditStore.ts
//
// Manages the lifecycle of pending edits proposed by the agent.
//
// Design principles:
//   - The agent NEVER writes to disk directly. It calls `propose_edit`,
//     which creates a PendingEdit entry here.
//   - The original file on disk remains completely unchanged until the
//     user explicitly calls acceptEdit() or acceptAll().
//   - Zustand is used so React components subscribe reactively without
//     any manual event wiring.
//   - Each edit tracks the before/after content in full so the Monaco
//     DiffEditor can render the exact comparison.
//   - acceptEdit() writes to disk via Tauri `save_file` + triggers
//     re-index. rejectEdit() simply removes the pending entry.
//   - When proposeEdit() is called for a file that already has a pending
//     edit, the existing entry is UPDATED in place (upsert by filePath).
//     Only one pending edit may exist per file at any time.
//   - Diff tabs are keyed by filePath so only one diff tab ever exists
//     per file regardless of how many proposals the agent makes.
//   - When an edit is accepted or rejected, its diff tab is automatically
//     closed so the Monaco editor returns to showing the normal file tab.

import { create } from 'zustand'
import { saveFile } from '../../lib/tauriFs'
import { useRepoIndex } from '../../store/useRepoIndex'
import { verifyBuild, type BuildVerificationResult } from '../agent/buildVerification'
import { verifyTests, type TestVerificationResult } from '../agent/testVerification'
import { verifyLint, type LintVerificationResult } from '../agent/lintVerification'
import { saveRejectedEdit } from '../../lib/conversationMemory'
import { buildPostMergeVerificationNudge } from '../agent/postMergeVerification'

// ── Types ────────────────────────────────────────────────────────────────────

export type EditStatus = 'pending' | 'accepted' | 'rejected'

export interface PendingEdit {
  /** Stable unique id for this edit (timestamp + random suffix) */
  id: string
  /** Absolute path of the file being edited */
  filePath: string
  /** Short display name (last path segment) */
  fileName: string
  /** The original file content AT THE TIME the FIRST edit was proposed for this file */
  originalContent: string
  /** The new content the agent wants to apply (always the latest proposal) */
  proposedContent: string
  /** Human-readable summary of what the edit does */
  description: string
  /** ISO-8601 timestamp */
  proposedAt: string
  status: EditStatus
  /** Monaco language id derived from file extension */
  language: string
  /** Set once accepted/rejected */
  resolvedAt?: string
  /**
   * When this edit belongs to a multi-file batch (from batch_propose_edits),
   * both fields are set. Edits with the same batchId were proposed together
   * and should be reviewed/accepted/rejected as a unit.
   */
  batchId?: string
  batchName?: string
  /**
   * True for edits proposed by a flow that owns its own accept/reject
   * lifecycle end-to-end (currently: build_new_project/design_project via
   * services/agent/buildNewProject.ts) rather than leaving the decision to
   * the user. Such a flow needs disk edits visible in the DiffEditor as
   * they stream in, but NOT a manual Merge/Reject surface — it creates the
   * project first, then calls acceptBatch()/rejectBatch() itself once
   * generation finishes (see buildCompletionNote). Edits flagged
   * `autoManaged` are therefore excluded from selectPendingCount and
   * selectBatchGroups (so the floating EditReviewBar and the "Pending
   * Edits (N)" header + Merge All/Reject All never show them) and from
   * acceptAll/rejectAll (so a click on either never races the in-flight
   * build). Nothing else about them differs — they're written, rolled
   * back, and re-indexed by the exact same acceptEdit/acceptBatch code
   * path as any other edit.
   */
  autoManaged?: boolean
}

export interface DiagnosticSnapshot {
  editId: string
  filePath: string
  before: DiagSummary[]
  after: DiagSummary[]
}

export interface DiagSummary {
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  code?: string | number
}

// ── State ────────────────────────────────────────────────────────────────────

interface EditStoreState {
  /** All edits (pending, accepted, or rejected) from this session */
  edits: PendingEdit[]
  /** Diagnostic snapshots keyed by editId */
  diagnosticSnapshots: Record<string, DiagnosticSnapshot>
  /** Build verification results keyed by editId */
  buildResults: Record<string, BuildVerificationResult>
  /** Test verification results keyed by editId */
  testResults: Record<string, TestVerificationResult>
  /** Lint verification results keyed by editId */
  lintResults: Record<string, LintVerificationResult>
  /**
   * UX-001 — Agent Execution Timeline. Tracks which verification checks are
   * currently in flight for a given editId/batchId/'accept-all' key, so the
   * timeline can show "Verifying build…" live instead of only a final
   * Verified/Failed badge once `buildResults`/`testResults`/`lintResults`
   * are populated. Cleared (key removed / flag unset) once the check
   * finishes, at the same moment the corresponding result is stored.
   */
  verifying: Record<string, { build?: boolean; test?: boolean; lint?: boolean }>
  /**
   * Mandatory execution/verification instructions keyed by editId or
   * batchId, produced right after a merge for any frontend/UI or
   * backend/API files that were written. Surfaced to the agent on its
   * next turn via useChat's verificationContext pipeline so it actually
   * runs and checks the change instead of assuming it worked.
   */
  verificationNudges: Record<string, string>

  // ── Actions ──────────────────────────────────────────────────────────────

  /**
   * Called by the propose_edit agent tool to register or update an edit.
   *
   * Upsert semantics (one pending edit per file):
   *   - If no pending edit exists for filePath → create a new entry and open a diff tab.
   *   - If a pending edit already exists for filePath → update proposedContent and
   *     description in place, preserving originalContent. The existing diff tab is
   *     activated (not duplicated).
   *
   * Returns the edit id (stable across updates for the same file).
   */
  proposeEdit: (params: {
    filePath: string
    originalContent: string
    proposedContent: string
    description: string
  }) => string

  /**
   * Return the single pending edit for a given file path, or undefined.
   * Only returns edits whose status is 'pending'.
   */
  getPendingEdit: (filePath: string) => PendingEdit | undefined

  /**
   * Upsert a PendingEdit directly (lower-level than proposeEdit).
   * Creates a new entry if none exists for edit.filePath, otherwise
   * replaces the existing one in place. Does NOT manage diff tabs.
   */
  upsertPendingEdit: (edit: PendingEdit) => void

  /**
   * Remove the pending edit for the given file path (regardless of its id).
   * No-ops if no pending edit exists for that path.
   */
  removePendingEdit: (filePath: string) => void

  /** Accept a single pending edit — writes to disk */
  acceptEdit: (id: string) => Promise<{ ok: boolean; error?: string }>

  /** Reject a single pending edit (no disk write) */
  rejectEdit: (id: string) => void

  /** Accept ALL pending edits in sequence */
  acceptAll: () => Promise<{ accepted: number; failed: number }>

  /** Reject ALL pending edits */
  rejectAll: () => void

  /**
   * Accept exactly the pending edits identified by `ids` (silently
   * skipping any id that is missing or no longer pending), same
   * all-or-nothing write/rollback contract as acceptAll. Used to
   * auto-merge edits proposed during a non-work_with_repo step (e.g.
   * build_new_project, design_project, desktop_task) without touching
   * unrelated pending edits still awaiting manual review from a
   * SOFTWARE:WORK_WITH_REPO step — see runDecomposedSteps in useChat.ts.
   */
  acceptEdits: (ids: string[]) => Promise<{ accepted: number; failed: number }>

  /**
   * Register multiple file edits as a single named batch.
   * All edits are registered atomically with the same batchId.
   * Returns an array of editIds in the same order as `entries`.
   */
  proposeBatch: (params: {
    batchId: string
    batchName: string
    entries: Array<{
      filePath: string
      originalContent: string
      proposedContent: string
      description: string
    }>
    /** See PendingEdit.autoManaged — applied to every entry in this batch. */
    autoManaged?: boolean
  }) => string[]

  /** Accept all pending edits belonging to a batch */
  acceptBatch: (batchId: string) => Promise<{ accepted: number; failed: number }>

  /** Reject all pending edits belonging to a batch */
  rejectBatch: (batchId: string) => void

  /**
   * Clears the `autoManaged` flag on every pending edit in a batch,
   * making it a normal reviewable batch again (visible in the EditReviewBar,
   * counted in "Pending Edits (N)", reachable by Merge All/Reject All). Used
   * by services/agent/buildNewProject.ts when its own auto-accept call
   * fails or throws — the batch must fall back to something the user can
   * act on instead of sitting pending with no visible controls (see
   * PendingEdit.autoManaged).
   */
  clearAutoManaged: (batchId: string) => void

  /** Revert an already-accepted edit back to its original content */
  revertEdit: (id: string) => Promise<{ ok: boolean; error?: string }>

  /** Store diagnostic before/after snapshots for a completed edit */
  setDiagnosticSnapshot: (snapshot: DiagnosticSnapshot) => void

  /** Store build verification result for an edit */
  setBuildResult: (result: BuildVerificationResult) => void

  /** Store test verification result for an edit */
  setTestResult: (result: TestVerificationResult) => void

  /** Store lint verification result for an edit */
  setLintResult: (result: LintVerificationResult) => void

  /** Store a mandatory post-merge verification nudge, keyed by editId or batchId */
  setVerificationNudge: (key: string, nudge: string) => void

  /** UX-001 — mark a verification check as running/finished for the timeline. */
  setVerifying: (key: string, kind: 'build' | 'test' | 'lint', running: boolean) => void

  /** Remove accepted/rejected edits from the visible list */
  clearResolved: () => void
}

// ── Language helper ───────────────────────────────────────────────────────────

function extToMonacoLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    css: 'css', scss: 'scss',
    json: 'json',
    md: 'markdown',
    html: 'html',
    yaml: 'yaml', yml: 'yaml',
    go: 'go',
    py: 'python',
    sh: 'shell',
    rs: 'rust',
    txt: 'plaintext',
  }
  return map[ext] ?? 'plaintext'
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useEditStore = create<EditStoreState>((set, get) => ({
  edits: [],
  diagnosticSnapshots: {},
  buildResults: {},
  testResults: {},
  lintResults: {},
  verificationNudges: {},
  verifying: {},

  // ── getPendingEdit ─────────────────────────────────────────────────────────
  getPendingEdit: (filePath) =>
    get().edits.find(e => e.filePath === filePath && e.status === 'pending'),

  // ── upsertPendingEdit ──────────────────────────────────────────────────────
  upsertPendingEdit: (edit) => {
    set(state => {
      const idx = state.edits.findIndex(
        e => e.filePath === edit.filePath && e.status === 'pending'
      )
      if (idx === -1) {
        return { edits: [...state.edits, edit] }
      }
      const updated = [...state.edits]
      updated[idx] = edit
      return { edits: updated }
    })
  },

  // ── removePendingEdit ──────────────────────────────────────────────────────
  removePendingEdit: (filePath) => {
    set(state => ({
      edits: state.edits.filter(
        e => !(e.filePath === filePath && e.status === 'pending')
      ),
    }))
  },

  // ── proposeEdit ────────────────────────────────────────────────────────────
  proposeEdit: ({ filePath, originalContent, proposedContent, description }) => {
    const existing = get().getPendingEdit(filePath)
    const language = extToMonacoLang(filePath)
    const fileName = filePath.split(/[/\\\\]/).pop() ?? filePath

    if (existing) {
      // ── Update existing pending edit in place ──────────────────────────
      // Preserve originalContent from the first proposal so the diff always
      // shows the true before-state relative to disk.
      const updated: PendingEdit = {
        ...existing,
        proposedContent,
        description,
        proposedAt: new Date().toISOString(),
      }
      get().upsertPendingEdit(updated)

      // NOTE: We do NOT auto-activate the diff tab here.
      // The EditReviewBar shows "View Changes" — the user decides when to open the diff.

      return existing.id
    }

    // ── Create new pending edit ────────────────────────────────────────────
    const id = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const edit: PendingEdit = {
      id,
      filePath,
      fileName,
      originalContent,
      proposedContent,
      description,
      language,
      proposedAt: new Date().toISOString(),
      status: 'pending',
    }

    get().upsertPendingEdit(edit)

    // NOTE: Diff tab is NOT auto-opened here.
    // The floating EditReviewBar appears with "View Changes" / "Merge All" / "Reject All".
    // Diff tabs are opened only when the user clicks "View Changes".

    return id
  },

  // ── acceptEdit ─────────────────────────────────────────────────────────────
  acceptEdit: async (id) => {
    const edit = get().edits.find(e => e.id === id)
    if (!edit) return { ok: false, error: `Edit ${id} not found` }
    if (edit.status !== 'pending') {
      return { ok: false, error: `Edit ${id} is already ${edit.status}` }
    }

    try {
      // Write the proposed content to disk
      await saveFile({ path: edit.filePath, content: edit.proposedContent })

      // Mark as accepted
      set(state => ({
        edits: state.edits.map(e =>
          e.id === id
            ? { ...e, status: 'accepted' as EditStatus, resolvedAt: new Date().toISOString() }
            : e
        ),
      }))

      // ── Re-index so the AI's next read_file / search reflects the edit ──
      // Uses forceReindex() which bypasses the TS/JS-only file guard so
      // ANY edited file (CSS, JSON, etc.) gets its SQLite chunks updated.
      await useRepoIndex.getState().forceReindex()

      // ── Close the diff tab and close the file tab if open ───────────────
      import('../../store/useEditorStore').then(({ useEditorStore }) => {
        const store = useEditorStore.getState()
        // Close the diff tab (its id equals the edit id)
        store.closeDiffTab(id)
        // Close the regular Monaco file tab so the editor returns to a clean state
        const openTab = store.tabs.find(t => t.id === edit.filePath)
        if (openTab) {
          store.closeTab(edit.filePath)
        }
      })

      // ── Build verification (async, non-blocking for the UI) ──────────────
      // Runs in the background after the file write. The result is stored in
      // buildResults so the UI can show Verified / Failed badges, and the
      // agent context is updated if the build fails.
      ;(async () => {
        const { projectRoot } = useRepoIndex.getState()
        if (!projectRoot) return

        get().setVerifying(id, 'build', true)
        const buildResult = await verifyBuild(projectRoot, id)
        get().setBuildResult(buildResult)
        get().setVerifying(id, 'build', false)
      })().catch(err => {
        console.warn('[EditStore] Build verification failed:', err)
        get().setVerifying(id, 'build', false)
      })

      // ── Test verification (async, non-blocking) ───────────────────────────
      ;(async () => {
        const { projectRoot } = useRepoIndex.getState()
        if (!projectRoot) return

        get().setVerifying(id, 'test', true)
        const testResult = await verifyTests(projectRoot, id)
        get().setTestResult(testResult)
        get().setVerifying(id, 'test', false)
      })().catch(err => {
        console.warn('[EditStore] Test verification failed:', err)
        get().setVerifying(id, 'test', false)
      })

      // ── Lint verification (async, non-blocking) ───────────────────────────
      ;(async () => {
        const { projectRoot } = useRepoIndex.getState()
        if (!projectRoot) return

        get().setVerifying(id, 'lint', true)
        const lintResult = await verifyLint(projectRoot, id, edit.filePath)
        get().setLintResult(lintResult)
        get().setVerifying(id, 'lint', false)
      })().catch(err => {
        console.warn('[EditStore] Lint verification failed:', err)
        get().setVerifying(id, 'lint', false)
      })

      // ── Mandatory execution/verification nudge (frontend/backend files) ───
      const nudge = buildPostMergeVerificationNudge([edit.filePath])
      if (nudge) get().setVerificationNudge(id, nudge)

      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : `Failed to save ${edit.filePath}`,
      }
    }
  },

  // ── rejectEdit ─────────────────────────────────────────────────────────────
  rejectEdit: (id) => {
    const edit = get().edits.find(e => e.id === id && e.status === 'pending')

    set(state => ({
      edits: state.edits.map(e =>
        e.id === id && e.status === 'pending'
          ? { ...e, status: 'rejected' as EditStatus, resolvedAt: new Date().toISOString() }
          : e
      ),
    }))

    // ── Persist rejection to SQLite for agent memory ──────────────────────
    if (edit) {
      const { projectRoot } = useRepoIndex.getState()
      if (projectRoot) {
        saveRejectedEdit({
          projectRoot,
          filePath: edit.filePath,
          description: edit.description,
        }).catch(err => console.warn('[EditStore] saveRejectedEdit failed:', err))
      }
    }

    // Close the diff tab for the rejected edit
    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const store = useEditorStore.getState()
      const diffTab = store.diffTabs.find(t => t.editId === id)
      if (diffTab) store.closeDiffTab(diffTab.id)
    })
  },

  // ── proposeBatch ───────────────────────────────────────────────────────────
  proposeBatch: ({ batchId, batchName, entries, autoManaged }) => {
    const language_map = extToMonacoLang
    const timestamp = new Date().toISOString()
    const editIds: string[] = []

    set(state => {
      const newEdits = [...state.edits]

      for (const entry of entries) {
        const fileName = entry.filePath.split(/[/\\]/).pop() ?? entry.filePath
        const language = language_map(entry.filePath)

        // Check if there is already a pending edit for this file
        const existingIdx = newEdits.findIndex(
          e => e.filePath === entry.filePath && e.status === 'pending'
        )

        if (existingIdx !== -1) {
          // Upgrade the existing edit into this batch
          const existing = newEdits[existingIdx]
          const id = existing.id
          editIds.push(id)
          newEdits[existingIdx] = {
            ...existing,
            proposedContent: entry.proposedContent,
            description: entry.description,
            proposedAt: timestamp,
            batchId,
            batchName,
            ...(autoManaged !== undefined ? { autoManaged } : {}),
          }
        } else {
          const id = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          editIds.push(id)
          newEdits.push({
            id,
            filePath: entry.filePath,
            fileName,
            originalContent: entry.originalContent,
            proposedContent: entry.proposedContent,
            description: entry.description,
            language,
            proposedAt: timestamp,
            status: 'pending',
            batchId,
            batchName,
            ...(autoManaged !== undefined ? { autoManaged } : {}),
          })
        }
      }

      return { edits: newEdits }
    })

    return editIds
  },

  // ── acceptBatch ────────────────────────────────────────────────────────────
  // Atomic, single-command merge: a batch is reviewed and resolved as ONE
  // unit (see EditReviewBar — there is intentionally no per-file accept).
  // To honor that at the data layer too, files are never left
  // partially merged: if any file in the batch fails to write, every file
  // that was already written in this call is rolled back to its original
  // content and the whole batch is reported as failed. Either the full
  // batch lands, or none of it does.
  acceptBatch: async (batchId) => {
    const batchEdits = get().edits.filter(
      e => e.batchId === batchId && e.status === 'pending'
    )
    if (batchEdits.length === 0) return { accepted: 0, failed: 0 }

    const written: PendingEdit[] = []
    let failure: { edit: PendingEdit; error: unknown } | null = null

    for (const edit of batchEdits) {
      try {
        await saveFile({ path: edit.filePath, content: edit.proposedContent })
        written.push(edit)
      } catch (err) {
        failure = { edit, error: err }
        break
      }
    }

    if (failure) {
      // Roll back every file already written in this call so the batch
      // never lands partially — best-effort; a rollback failure is logged
      // but does not change the reported outcome (the batch still failed).
      for (const edit of written) {
        try {
          await saveFile({ path: edit.filePath, content: edit.originalContent })
        } catch (rollbackErr) {
          console.warn(`[EditStore] Rollback failed for ${edit.filePath}:`, rollbackErr)
        }
      }
      console.warn(
        `[EditStore] Batch ${batchId} aborted — ${failure.edit.filePath} failed to write, ` +
        `${written.length} prior file(s) rolled back.`,
        failure.error
      )
      return { accepted: 0, failed: batchEdits.length }
    }

    // Every file wrote successfully — mark the whole batch accepted at once.
    set(state => ({
      edits: state.edits.map(e =>
        e.batchId === batchId && e.status === 'pending'
          ? { ...e, status: 'accepted' as EditStatus, resolvedAt: new Date().toISOString() }
          : e
      ),
    }))

    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const store = useEditorStore.getState()
      for (const edit of batchEdits) {
        store.closeDiffTab(edit.id)
        const openTab = store.tabs.find(t => t.id === edit.filePath)
        if (openTab) store.closeTab(edit.filePath)
      }
    })

    await useRepoIndex.getState().forceReindex()

    // ── Mandatory execution/verification nudge (frontend/backend files) ─────
    const nudge = buildPostMergeVerificationNudge(batchEdits.map(e => e.filePath))
    if (nudge) get().setVerificationNudge(batchId, nudge)

    // Run and check the repo after merging: build + test verification.
    ;(async () => {
      const { projectRoot } = useRepoIndex.getState()
      if (!projectRoot) return
      get().setVerifying(batchId, 'build', true)
      get().setVerifying(batchId, 'test', true)
      const [buildResult, testResult] = await Promise.all([
        verifyBuild(projectRoot, batchId),
        verifyTests(projectRoot, batchId),
      ])
      get().setBuildResult(buildResult)
      get().setTestResult(testResult)
      get().setVerifying(batchId, 'build', false)
      get().setVerifying(batchId, 'test', false)
    })().catch(err => {
      console.warn('[EditStore] Batch verification failed:', err)
      get().setVerifying(batchId, 'build', false)
      get().setVerifying(batchId, 'test', false)
    })

    return { accepted: batchEdits.length, failed: 0 }
  },

  // ── rejectBatch ────────────────────────────────────────────────────────────
  rejectBatch: (batchId) => {
    const batchEdits = get().edits.filter(
      e => e.batchId === batchId && e.status === 'pending'
    )

    set(state => ({
      edits: state.edits.map(e =>
        e.batchId === batchId && e.status === 'pending'
          ? { ...e, status: 'rejected' as EditStatus, resolvedAt: new Date().toISOString() }
          : e
      ),
    }))

    const { projectRoot } = useRepoIndex.getState()
    if (projectRoot) {
      for (const edit of batchEdits) {
        saveRejectedEdit({
          projectRoot,
          filePath: edit.filePath,
          description: edit.description,
        }).catch(err => console.warn('[EditStore] saveRejectedEdit failed:', err))
      }
    }

    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const store = useEditorStore.getState()
      for (const edit of batchEdits) {
        const diffTab = store.diffTabs.find(t => t.editId === edit.id)
        if (diffTab) store.closeDiffTab(diffTab.id)
      }
    })
  },

  // ── clearAutoManaged ──────────────────────────────────────────────────────
  // See interface doc comment above — flips a stuck autoManaged batch back
  // into a normal, manually-reviewable one.
  clearAutoManaged: (batchId) => {
    set(state => ({
      edits: state.edits.map(e =>
        e.batchId === batchId && e.status === 'pending' && e.autoManaged
          ? { ...e, autoManaged: false }
          : e
      ),
    }))
  },

  // ── acceptAll ─────────────────────────────────────────────────────────────
  // Same atomicity contract as acceptBatch: "Accept All" is one single
  // command, so it either merges every pending edit or none of them —
  // never a partial subset left on disk.
  acceptAll: async () => {
    // autoManaged edits (build_new_project/design_project — see
    // PendingEdit.autoManaged) resolve themselves via their own
    // acceptBatch()/rejectBatch() call once generation finishes; a manual
    // "Merge All" click must never sweep up a build that's still in
    // flight and accept its placeholder/partial content early.
    const pending = get().edits.filter(e => e.status === 'pending' && !e.autoManaged)
    if (pending.length === 0) return { accepted: 0, failed: 0 }

    const written: PendingEdit[] = []
    let failure: { edit: PendingEdit; error: unknown } | null = null

    for (const edit of pending) {
      try {
        await saveFile({ path: edit.filePath, content: edit.proposedContent })
        written.push(edit)
      } catch (err) {
        failure = { edit, error: err }
        break
      }
    }

    if (failure) {
      for (const edit of written) {
        try {
          await saveFile({ path: edit.filePath, content: edit.originalContent })
        } catch (rollbackErr) {
          console.warn(`[EditStore] Rollback failed for ${edit.filePath}:`, rollbackErr)
        }
      }
      console.warn(
        `[EditStore] Accept All aborted — ${failure.edit.filePath} failed to write, ` +
        `${written.length} prior file(s) rolled back.`,
        failure.error
      )
      return { accepted: 0, failed: pending.length }
    }

    set(state => ({
      edits: state.edits.map(e =>
        e.status === 'pending' && !e.autoManaged
          ? { ...e, status: 'accepted' as EditStatus, resolvedAt: new Date().toISOString() }
          : e
      ),
    }))

    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const store = useEditorStore.getState()
      for (const edit of pending) {
        store.closeDiffTab(edit.id)
        const openTab = store.tabs.find(t => t.id === edit.filePath)
        if (openTab) store.closeTab(edit.filePath)
      }
    })

    // ── Single re-index after ALL files are written ─────────────────────────
    // Batching avoids N full scans when accepting N edits.
    await useRepoIndex.getState().forceReindex()

    // ── Mandatory execution/verification nudge (frontend/backend files) ─────
    const nudge = buildPostMergeVerificationNudge(pending.map(e => e.filePath))
    if (nudge) get().setVerificationNudge('accept-all', nudge)

    // Run and check the repo after merging: build + test verification.
    ;(async () => {
      const { projectRoot } = useRepoIndex.getState()
      if (!projectRoot) return
      get().setVerifying('accept-all', 'build', true)
      get().setVerifying('accept-all', 'test', true)
      const [buildResult, testResult] = await Promise.all([
        verifyBuild(projectRoot, 'accept-all'),
        verifyTests(projectRoot, 'accept-all'),
      ])
      get().setBuildResult(buildResult)
      get().setTestResult(testResult)
      get().setVerifying('accept-all', 'build', false)
      get().setVerifying('accept-all', 'test', false)
    })().catch(err => {
      console.warn('[EditStore] Accept-all verification failed:', err)
      get().setVerifying('accept-all', 'build', false)
      get().setVerifying('accept-all', 'test', false)
    })

    return { accepted: pending.length, failed: 0 }
  },

  // ── acceptEdits ───────────────────────────────────────────────────────────
  // Same all-or-nothing write/rollback contract as acceptAll, but scoped to
  // exactly the given ids instead of every pending edit — see the interface
  // doc comment above for why (auto-merge for non-work_with_repo steps must
  // never sweep up an unrelated work_with_repo step's still-pending edits).
  acceptEdits: async (ids) => {
    const idSet = new Set(ids)
    const pending = get().edits.filter(e => idSet.has(e.id) && e.status === 'pending')
    if (pending.length === 0) return { accepted: 0, failed: 0 }

    const written: PendingEdit[] = []
    let failure: { edit: PendingEdit; error: unknown } | null = null

    for (const edit of pending) {
      try {
        await saveFile({ path: edit.filePath, content: edit.proposedContent })
        written.push(edit)
      } catch (err) {
        failure = { edit, error: err }
        break
      }
    }

    if (failure) {
      for (const edit of written) {
        try {
          await saveFile({ path: edit.filePath, content: edit.originalContent })
        } catch (rollbackErr) {
          console.warn(`[EditStore] Rollback failed for ${edit.filePath}:`, rollbackErr)
        }
      }
      console.warn(
        `[EditStore] acceptEdits aborted — ${failure.edit.filePath} failed to write, ` +
        `${written.length} prior file(s) rolled back.`,
        failure.error
      )
      return { accepted: 0, failed: pending.length }
    }

    const acceptedIds = new Set(pending.map(e => e.id))
    set(state => ({
      edits: state.edits.map(e =>
        acceptedIds.has(e.id)
          ? { ...e, status: 'accepted' as EditStatus, resolvedAt: new Date().toISOString() }
          : e
      ),
    }))

    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const store = useEditorStore.getState()
      for (const edit of pending) {
        store.closeDiffTab(edit.id)
        const openTab = store.tabs.find(t => t.id === edit.filePath)
        if (openTab) store.closeTab(edit.filePath)
      }
    })

    await useRepoIndex.getState().forceReindex()

    const nudge = buildPostMergeVerificationNudge(pending.map(e => e.filePath))
    if (nudge) get().setVerificationNudge('accept-edits', nudge)

    ;(async () => {
      const { projectRoot } = useRepoIndex.getState()
      if (!projectRoot) return
      get().setVerifying('accept-edits', 'build', true)
      get().setVerifying('accept-edits', 'test', true)
      const [buildResult, testResult] = await Promise.all([
        verifyBuild(projectRoot, 'accept-edits'),
        verifyTests(projectRoot, 'accept-edits'),
      ])
      get().setBuildResult(buildResult)
      get().setTestResult(testResult)
      get().setVerifying('accept-edits', 'build', false)
      get().setVerifying('accept-edits', 'test', false)
    })().catch(err => {
      console.warn('[EditStore] acceptEdits verification failed:', err)
      get().setVerifying('accept-edits', 'build', false)
      get().setVerifying('accept-edits', 'test', false)
    })

    return { accepted: pending.length, failed: 0 }
  },

  // ── rejectAll ─────────────────────────────────────────────────────────────
  rejectAll: () => {
    // Same reasoning as acceptAll above — never reject an in-flight
    // autoManaged build out from under it via the global "Reject All".
    const pending = get().edits.filter(e => e.status === 'pending' && !e.autoManaged)

    set(state => ({
      edits: state.edits.map(e =>
        e.status === 'pending' && !e.autoManaged
          ? { ...e, status: 'rejected' as EditStatus, resolvedAt: new Date().toISOString() }
          : e
      ),
    }))

    // ── Persist all rejections to SQLite for agent memory ─────────────────
    const { projectRoot } = useRepoIndex.getState()
    if (projectRoot) {
      for (const edit of pending) {
        saveRejectedEdit({
          projectRoot,
          filePath: edit.filePath,
          description: edit.description,
        }).catch(err => console.warn('[EditStore] saveRejectedEdit failed:', err))
      }
    }

    // Close all open diff tabs for rejected edits
    import('../../store/useEditorStore').then(({ useEditorStore }) => {
      const store = useEditorStore.getState()
      for (const edit of pending) {
        const diffTab = store.diffTabs.find(t => t.editId === edit.id)
        if (diffTab) store.closeDiffTab(diffTab.id)
      }
    })
  },

  // ── revertEdit ─────────────────────────────────────────────────────────────
  revertEdit: async (id) => {
    const edit = get().edits.find(e => e.id === id)
    if (!edit) return { ok: false, error: `Edit ${id} not found` }
    if (edit.status !== 'accepted') {
      return { ok: false, error: `Edit ${id} is not accepted (status: ${edit.status})` }
    }

    try {
      // Write the original content back to disk
      await saveFile({ path: edit.filePath, content: edit.originalContent })

      // Mark back as pending so the diff tab can be reviewed again
      set(state => ({
        edits: state.edits.map(e =>
          e.id === id
            ? { ...e, status: 'pending' as EditStatus, resolvedAt: undefined }
            : e
        ),
      }))

      // Re-index so the AI sees the reverted content
      await useRepoIndex.getState().forceReindex()

      // Refresh the open file tab if it's open
      import('../../store/useEditorStore').then(({ useEditorStore }) => {
        const store = useEditorStore.getState()
        const openTab = store.tabs.find(t => t.id === edit.filePath)
        if (openTab) {
          store.updateContent(edit.filePath, edit.originalContent)
          store.markSaved(edit.filePath)
        }
        // Re-open the diff tab so user can review / re-accept
        if (!store.diffTabs.find(t => t.editId === edit.id)) {
          store.openDiffTab({
            id: edit.id,
            editId: edit.id,
            name: `⎇ ${edit.fileName}`,
            filePath: edit.filePath,
            fileName: edit.fileName,
            language: edit.language,
          })
        }
      })

      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : `Failed to revert ${edit.filePath}`,
      }
    }
  },

  // ── setDiagnosticSnapshot ─────────────────────────────────────────────────
  setDiagnosticSnapshot: (snapshot) => {
    set(state => ({
      diagnosticSnapshots: {
        ...state.diagnosticSnapshots,
        [snapshot.editId]: snapshot,
      },
    }))
  },

  // ── setBuildResult ────────────────────────────────────────────────────────
  setBuildResult: (result) => {
    set(state => ({
      buildResults: {
        ...state.buildResults,
        [result.editId]: result,
      },
    }))
  },

  // ── setTestResult ─────────────────────────────────────────────────────────
  setTestResult: (result) => {
    set(state => ({
      testResults: {
        ...state.testResults,
        [result.editId]: result,
      },
    }))
  },

  // ── setLintResult ─────────────────────────────────────────────────────────
  setLintResult: (result) => {
    set(state => ({
      lintResults: {
        ...state.lintResults,
        [result.editId]: result,
      },
    }))
  },

  // ── setVerificationNudge ───────────────────────────────────────────────────
  setVerificationNudge: (key, nudge) => {
    set(state => ({
      verificationNudges: {
        ...state.verificationNudges,
        [key]: nudge,
      },
    }))
  },

  // ── setVerifying ───────────────────────────────────────────────────────────
  setVerifying: (key, kind, running) => {
    set(state => {
      const existing = state.verifying[key] ?? {}
      const next = { ...existing, [kind]: running }
      // Drop the key entirely once nothing for it is running, so consumers
      // can just check `verifying[key]` truthiness/emptiness.
      const stillRunning = Object.values(next).some(Boolean)
      const verifying = { ...state.verifying }
      if (stillRunning) {
        verifying[key] = next
      } else {
        delete verifying[key]
      }
      return { verifying }
    })
  },

  // ── clearResolved ─────────────────────────────────────────────────────────
  clearResolved: () => {
    set(state => ({
      edits: state.edits.filter(e => e.status === 'pending'),
    }))
  },
}))

// ── Selectors ─────────────────────────────────────────────────────────────────

// autoManaged edits (build_new_project/design_project — see
// PendingEdit.autoManaged) are excluded from every selector below that
// feeds the manual review UI (EditReviewBar, the "Pending Edits (N)"
// header + Merge All/Reject All). They still exist in `edits` as normal
// PendingEdit rows — for the DiffEditor, disk writes, and re-indexing —
// they're just never something the user is asked to act on.

export const selectPendingEdits = (state: EditStoreState): PendingEdit[] =>
  state.edits.filter(e => e.status === 'pending' && !e.autoManaged)

export const selectPendingCount = (state: EditStoreState): number =>
  state.edits.filter(e => e.status === 'pending' && !e.autoManaged).length

export const selectBuildResult = (id: string) =>
  (state: EditStoreState): BuildVerificationResult | undefined =>
    state.buildResults[id]

export const selectTestResult = (id: string) =>
  (state: EditStoreState): TestVerificationResult | undefined =>
    state.testResults[id]

export const selectLintResult = (id: string) =>
  (state: EditStoreState): LintVerificationResult | undefined =>
    state.lintResults[id]

/**
 * UX-001 — Agent Execution Timeline. True while any build/test/lint check
 * (for any edit/batch/'accept-all') is currently in flight, so the timeline
 * can show a single live "Verifying…" row without the caller needing to
 * enumerate every key in `verifying`.
 */
export const selectAnyVerifying = (state: EditStoreState): boolean =>
  Object.keys(state.verifying).length > 0

/** Human-readable label for whatever verification is currently running, or null if none. */
export const selectVerifyingLabel = (state: EditStoreState): string | null => {
  const kinds = new Set<string>()
  for (const flags of Object.values(state.verifying)) {
    if (flags.build) kinds.add('build')
    if (flags.test) kinds.add('tests')
    if (flags.lint) kinds.add('lint')
  }
  if (kinds.size === 0) return null
  return `Verifying ${Array.from(kinds).join(' + ')}…`
}

// Re-export so consumers only import from EditStore
export type { BuildVerificationResult }
export type { TestVerificationResult }
export type { LintVerificationResult }

// ── Batch types ───────────────────────────────────────────────────────────────

export interface BatchGroup {
  batchId: string
  batchName: string
  edits: PendingEdit[]
}

/**
 * Returns pending edits grouped by batchId.
 * Unbatched edits (no batchId) are each wrapped in their own single-item group
 * with a synthetic batchId equal to the edit id.
 */
export const selectBatchGroups = (state: EditStoreState): BatchGroup[] => {
  const pending = state.edits.filter(e => e.status === 'pending' && !e.autoManaged)
  const groups = new Map<string, BatchGroup>()

  for (const edit of pending) {
    const key = edit.batchId ?? edit.id
    if (!groups.has(key)) {
      groups.set(key, {
        batchId: key,
        batchName: edit.batchName ?? edit.fileName,
        edits: [],
      })
    }
    groups.get(key)!.edits.push(edit)
  }

  return Array.from(groups.values())
}