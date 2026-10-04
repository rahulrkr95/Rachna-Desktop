// services/agent/tools/batchProposeEditsTool.ts
//
// Tool: batch_propose_edits
//
// Stages multiple file edits as a single named batch so the user sees the
// full impact of a refactor — all diffs grouped together — before accepting
// or rejecting anything.
//
// When to use:
//   • Any refactor that touches 3+ files (rename, extract module, change
//     interface, update import paths, etc.)
//   • Any change where the correctness of file N depends on file N-1 also
//     being applied — the files should land together or not at all.
//
// Relationship to propose_edit:
//   • propose_edit → single file, immediate diff tab
//   • batch_propose_edits → N files, one named batch card in the review bar,
//     accept/reject the whole set in one click (or file-by-file inside the batch)
//
// Each entry supports the same TWO MODES as propose_edit:
//   A) Full-file: provide newContent (complete replacement)
//   B) Patch:     provide patch (unified diff @@ hunk)
//
// The batch is registered atomically — all files or none. If any entry fails
// (file not found, bad patch), the whole batch is aborted and no edits are
// registered.

import { readFile } from '../../../lib/tauriFs'
import { validateFileExists } from '../fileValidation'
import { useEditStore } from '../../edits/EditStore'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Re-use the patch engine from proposeEditTool ───────────────────────────
// We duplicate the applyUnifiedPatch function here to avoid a circular import
// between the two tool files. If you refactor, move it to a shared utils file.

function applyUnifiedPatch(original: string, patch: string): string {
  const originalLines = original.split('\n')
  const patchLines = patch.split('\n')
  const result: string[] = [...originalLines]
  let offset = 0

  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  let i = 0
  while (
    i < patchLines.length &&
    (patchLines[i].startsWith('---') ||
      patchLines[i].startsWith('+++') ||
      patchLines[i].trim() === '')
  ) {
    i++
  }

  while (i < patchLines.length) {
    const line = patchLines[i]
    const m = line.match(HUNK_RE)
    if (!m) { i++; continue }

    const origStart = parseInt(m[1], 10) - 1
    i++

    const removes: number[] = []
    const inserts: { at: number; text: string }[] = []
    let contextCursor = origStart + offset

    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const hunkLine = patchLines[i]
      if (hunkLine.startsWith('-')) {
        const expected = result[contextCursor]
        const patchContent = hunkLine.slice(1)
        if (expected === undefined) {
          throw new Error(
            `Patch hunk error: tried to remove line ${contextCursor + 1} but file only has ${result.length} lines`
          )
        }
        if (expected !== patchContent) {
          throw new Error(
            `Patch hunk error at line ${contextCursor + 1}: ` +
            `expected "${patchContent}" but found "${expected}". ` +
            'Call read_file first and rebuild the patch against the current content.'
          )
        }
        removes.push(contextCursor)
        contextCursor++
      } else if (hunkLine.startsWith('+')) {
        inserts.push({ at: contextCursor, text: hunkLine.slice(1) })
      } else if (hunkLine.startsWith(' ') || hunkLine === '') {
        contextCursor++
      }
      i++
    }

    for (const idx of [...removes].sort((a, b) => b - a)) {
      result.splice(idx, 1)
      offset--
    }

    let insertOffset = 0
    for (const ins of inserts) {
      const removedBefore = removes.filter(r => r <= ins.at).length
      const adjustedAt = ins.at - removedBefore + insertOffset
      result.splice(adjustedAt, 0, ins.text)
      insertOffset++
      offset++
    }
  }

  return result.join('\n')
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface BatchEditEntry {
  /** Absolute or relative path to the file */
  filePath: string
  /** Short description of what this specific file change does */
  description: string
  /** FULL-FILE MODE: complete new content. Provide this OR patch, not both. */
  newContent?: string
  /** PATCH MODE: unified diff (@@ hunk). Provide this OR newContent, not both. */
  patch?: string
}

export interface BatchProposeEditsArgs {
  /**
   * A short human-readable name for this batch of changes.
   * Shown as the batch title in the review bar.
   * E.g. "Rename fetchUser → getUser", "Extract AuthService", "Add error boundaries"
   */
  batchName: string
  /** The list of file edits to stage. Must contain at least 2 entries. */
  edits: BatchEditEntry[]
}

export interface BatchEditResult {
  filePath: string
  editId: string
  mode: 'full' | 'patch'
  sizeWarning?: string
}

export interface BatchProposeEditsResult {
  batchId: string
  batchName: string
  fileCount: number
  results: BatchEditResult[]
  message: string
}

// ── Tool definition ────────────────────────────────────────────────────────

export const batchProposeEditsTool: AgentTool<BatchProposeEditsArgs, BatchProposeEditsResult> = {
  declaration: {
    name: 'batch_propose_edits',
    description:
      'Stage multiple file edits as a SINGLE named batch for atomic review. ' +
      'The user sees ALL changes together — one review card showing the full impact — ' +
      'before accepting or rejecting anything. Use this instead of calling propose_edit ' +
      'repeatedly when a refactor touches 3 or more files.\n\n' +
      'WHEN TO USE THIS TOOL:\n' +
      '  • Renames: a function/class/symbol used in many files\n' +
      '  • Interface changes: update a type and all its call sites\n' +
      '  • Extract / move: split a module and update all imports\n' +
      '  • Any change where the files should land together or not at all\n\n' +
      'WHEN TO USE propose_edit INSTEAD:\n' +
      '  • Only 1-2 files need changing\n' +
      '  • The files are fully independent (one file being wrong doesn\'t break the others)\n\n' +
      'Each entry supports the same TWO MODES as propose_edit:\n' +
      '  1. PATCH MODE (preferred for large files, targeted changes): provide `patch` as a ' +
      'unified diff with @@ hunk headers.\n' +
      '  2. FULL-FILE MODE (small files or sweeping rewrites): provide `newContent` — ' +
      'the COMPLETE new text. Never elide unchanged content.\n\n' +
      'The batch is registered atomically: if ANY file fails (not found, bad patch) the ' +
      'whole batch is aborted and nothing is staged.',
    parameters: {
      type: 'object',
      properties: {
        batchName: {
          type: 'string',
          description:
            'Short human-readable name for this batch. Shown as the refactor title in the UI. ' +
            'E.g. "Rename fetchUser → getUser (8 files)" or "Extract AuthService module".',
        },
        edits: {
          type: 'array',
          description:
            'The files to edit. Minimum 2 entries (use propose_edit for a single file). ' +
            'Each entry is an object with: ' +
            '`filePath` (string, required) — path to the file; ' +
            '`description` (string, required) — what this file change does; ' +
            '`newContent` (string) — FULL-FILE MODE: complete new file content, provide this OR patch; ' +
            '`patch` (string) — PATCH MODE: unified diff with @@ hunk headers, provide this OR newContent.',
          items: { type: 'object' },
        },
      },
      required: ['batchName', 'edits'],
    },
  },

  describeCall: (args) => {
    const n = Array.isArray(args.edits) ? args.edits.length : '?'
    const name = args.batchName ?? 'Batch refactor'
    return `Staging batch: ${name} (${n} files)…`
  },

  execute: async (args, ctx: ToolContext) => {
    // ── Validate top-level args ──────────────────────────────────────────
    if (!args.batchName?.trim()) {
      return toolErr('`batchName` is required and must be a non-empty string.')
    }
    if (!Array.isArray(args.edits) || args.edits.length < 2) {
      return toolErr(
        'batch_propose_edits requires at least 2 entries in `edits`. ' +
        'Use propose_edit for a single file.'
      )
    }

    // ── Phase 1: validate + read all files before touching EditStore ─────
    // We read every file first so if anything is wrong the batch is aborted
    // before any edit is registered — true atomicity from the agent's perspective.

    interface PreparedEntry {
      absolutePath: string
      originalContent: string
      proposedContent: string
      description: string
      mode: 'full' | 'patch'
      sizeWarning?: string
    }

    const prepared: PreparedEntry[] = []

    for (let i = 0; i < args.edits.length; i++) {
      const entry = args.edits[i]

      if (!entry.filePath) {
        return toolErr(`Entry at index ${i} is missing \`filePath\`.`)
      }
      if (!entry.newContent && !entry.patch) {
        return toolErr(
          `Entry for "${entry.filePath}" needs either \`newContent\` or \`patch\`.`
        )
      }
      if (entry.newContent && entry.patch) {
        return toolErr(
          `Entry for "${entry.filePath}" provides both \`newContent\` and \`patch\`. ` +
          'Provide exactly one.'
        )
      }

      // Validate file exists
      const validated = await validateFileExists(entry.filePath, ctx.projectRoot)
      if (!validated.ok) {
        return toolErr(`[${entry.filePath}] ${validated.error}`)
      }

      // Read current content
      let originalContent = ''
      try {
        const result = await readFile(validated.path)
        originalContent = result.content
      } catch (err) {
        return toolErr(
          `[${entry.filePath}] Failed to read file: ` +
          (err instanceof Error ? err.message : String(err))
        )
      }

      // Compute proposed content
      let proposedContent: string
      let mode: 'full' | 'patch'
      let sizeWarning: string | undefined

      if (entry.patch) {
        mode = 'patch'
        try {
          proposedContent = applyUnifiedPatch(originalContent, entry.patch)
        } catch (err) {
          return toolErr(
            `[${entry.filePath}] Patch failed: ` +
            (err instanceof Error ? err.message : String(err))
          )
        }
      } else {
        mode = 'full'
        proposedContent = entry.newContent!
        // Size-shrink guard (same heuristic as propose_edit)
        const originalLen = originalContent.length
        const proposedLen = proposedContent.length
        if (originalLen >= 300 && proposedLen < originalLen * 0.5) {
          const pctLost = Math.round((1 - proposedLen / originalLen) * 100)
          sizeWarning =
            `⚠️ SIZE WARNING for ${entry.filePath}: proposed content is ${pctLost}% smaller ` +
            `than original (${originalLen} → ${proposedLen} chars). This usually means ` +
            'unchanged content was elided. Re-submit with the complete file if unintentional.'
        }
      }

      // No-op guard per file
      if (proposedContent === originalContent) {
        return toolErr(
          `[${entry.filePath}] No changes detected — proposed content is identical to current.`
        )
      }

      prepared.push({
        absolutePath: validated.path,
        originalContent,
        proposedContent,
        description: entry.description ?? 'Batch edit',
        mode,
        sizeWarning,
      })
    }

    // ── Phase 2: register all edits atomically in EditStore ──────────────
    const { proposeBatch } = useEditStore.getState()

    const batchId = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const editResults = proposeBatch({
      batchId,
      batchName: args.batchName,
      entries: prepared.map(p => ({
        filePath: p.absolutePath,
        originalContent: p.originalContent,
        proposedContent: p.proposedContent,
        description: p.description,
      })),
    })

    // ── Build result ─────────────────────────────────────────────────────
    const results: BatchEditResult[] = prepared.map((p, i) => ({
      filePath: p.absolutePath,
      editId: editResults[i],
      mode: p.mode,
      sizeWarning: p.sizeWarning,
    }))

    const warnings = results.filter(r => r.sizeWarning)
    const warnText = warnings.length
      ? '\n\n' + warnings.map(w => w.sizeWarning).join('\n')
      : ''

    return toolOk<BatchProposeEditsResult>({
      batchId,
      batchName: args.batchName,
      fileCount: prepared.length,
      results,
      message:
        `Batch "${args.batchName}" staged with ${prepared.length} files (batchId: ${batchId}). ` +
        'All diffs are now grouped in the review panel. ' +
        'The user can accept the entire batch, reject it, or review file-by-file.' +
        warnText,
    })
  },
}
