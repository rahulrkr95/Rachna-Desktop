// services/agent/tools/proposeEditTool.ts
//
// Tool: propose_edit
//
// The ONLY way for the agent to modify a file. It does NOT write to disk.
// Instead it registers a PendingEdit in the EditStore so the user can
// review the diff before anything changes.
//
// TWO MODES:
//
//   A) Full-file replacement (newContent provided, no patch):
//      Supply the complete new file text. Use only for small files (<200 lines)
//      or when making sweeping changes that touch most of the file.
//
//   B) Unified-diff patch (patch provided, no newContent):
//      Supply a standard unified diff (--- / +++ / @@ hunk headers).
//      The tool applies the patch to the current file content on the fly.
//      Use for targeted edits — much cheaper and avoids truncation risk.
//
//      Patch format (unified diff, context lines optional but recommended):
//        --- a/path/to/file
//        +++ b/path/to/file
//        @@ -10,7 +10,9 @@
//         unchanged context line
//        -line to remove
//        +line to add
//         unchanged context line
//
// Workflow:
//   1. Agent calls `read_file` to get the current content
//   2. Agent computes the desired change (full content OR patch)
//   3. Agent calls `propose_edit(filePath, description, newContent | patch)`
//   4. EditStore registers the pending edit
//   5. A diff tab opens in the editor workspace for native review
//   6. User accepts (writes to disk) or rejects (discards)
//
// The tool always returns success from the agent's perspective — the actual
// write happens only when the user accepts. This keeps the agent loop from
// stalling while waiting for user approval.

import { readFile } from '../../../lib/tauriFs'
import { validateFileExists } from '../fileValidation'
import { useEditStore } from '../../edits/EditStore'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Patch application ─────────────────────────────────────────────────────

/**
 * Apply a unified diff patch to `original`. Returns the patched string.
 * Supports the standard unified diff format (--- / +++ / @@ headers).
 * Throws a descriptive error if any hunk fails to apply.
 */
function applyUnifiedPatch(original: string, patch: string): string {
  const originalLines = original.split('\n')
  const patchLines = patch.split('\n')

  // Result is built as an array of lines, then joined.
  const result: string[] = [...originalLines]
  let offset = 0 // cumulative line-count delta from previously applied hunks

  // ── Parse hunks ────────────────────────────────────────────────────────
  // A hunk starts with @@ -startOrig,countOrig +startNew,countNew @@
  // Lines that follow are: ' ' (context), '-' (remove), '+' (add).
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

  let i = 0
  // Skip file header lines (---, +++)
  while (i < patchLines.length && (patchLines[i].startsWith('---') || patchLines[i].startsWith('+++') || patchLines[i].trim() === '')) {
    i++
  }

  while (i < patchLines.length) {
    const line = patchLines[i]
    const m = line.match(HUNK_RE)
    if (!m) { i++; continue }

    // origStart is 1-based in the patch; convert to 0-based index.
    const origStart = parseInt(m[1], 10) - 1
    const origCount = m[2] !== undefined ? parseInt(m[2], 10) : 1
    i++ // move past the @@ line

    // Collect this hunk's body
    const removes: number[] = []   // 0-based indices in `result` to remove
    const inserts: { at: number; text: string }[] = []
    let origCursor = origStart + offset // position in `result` (adjusted for offset)
    let contextCursor = origCursor

    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const hunkLine = patchLines[i]
      if (hunkLine.startsWith('-')) {
        // Validate the line being removed matches what we have
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
        // Context line — advance cursor
        contextCursor++
      }
      // Lines starting with '\' (e.g. "\ No newline at end of file") are ignored
      i++
    }

    // Apply removes (in reverse order so indices stay valid)
    for (const idx of [...removes].sort((a, b) => b - a)) {
      result.splice(idx, 1)
      offset--
    }

    // Apply inserts
    // Re-calculate insert positions relative to the removals that happened
    let insertOffset = 0
    for (const ins of inserts) {
      // Adjust insert position: subtract the number of removes that were before it
      const removedBefore = removes.filter(r => r <= ins.at).length
      const adjustedAt = ins.at - removedBefore + insertOffset
      result.splice(adjustedAt, 0, ins.text)
      insertOffset++
      offset++
    }
  }

  return result.join('\n')
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface ProposeEditArgs {
  /** Absolute or relative path to the file to edit */
  filePath: string
  /** Short description of what this edit does, e.g. "Fix type error on line 42" */
  description: string
  /**
   * EITHER provide this (full file replacement) OR `patch` — not both.
   * The complete new content for the file. Use for small files or sweeping rewrites.
   */
  newContent?: string
  /**
   * EITHER provide this (unified diff) OR `newContent` — not both.
   * A standard unified diff patch (--- / +++ / @@ headers required).
   * Preferred for targeted edits to large files — avoids full regeneration.
   */
  patch?: string
}

export interface ProposeEditResult {
  /** The pending edit id (use to reference this edit) */
  editId: string
  filePath: string
  description: string
  /** True once the edit is registered and awaiting user review */
  pending: true
  /** How the edit was applied ('full' or 'patch') */
  mode: 'full' | 'patch'
  message: string
  /**
   * Set when full-file mode produced content dramatically smaller than the
   * original — the classic signature of an LLM silently eliding "unchanged"
   * content instead of reproducing it. Non-fatal (the edit is still
   * registered so the user can see exactly what happened in the diff), but
   * surfaced to the agent so it can self-correct, and to the activity log
   * so the user sees it before reviewing the diff.
   */
  sizeWarning?: string
}

// ── Tool definition ────────────────────────────────────────────────────────

export const proposeEditTool: AgentTool<ProposeEditArgs, ProposeEditResult> = {
  declaration: {
    name: 'propose_edit',
    description:
      'Propose a file edit for the user to review before it is written to disk. ' +
      'The agent MUST use this tool instead of writing files directly. ' +
      'The user will see a diff and can accept or reject the change. ' +
      '\n\n' +
      'TWO MODES — choose based on the size and scope of the change:\n' +
      '\n' +
      '  1. PATCH MODE (preferred for small, targeted changes to large files):\n' +
      '     Provide `patch` as a standard unified diff. Use this when most of the file\n' +
      '     stays the same and you are changing a few specific lines or blocks.\n' +
      '     Example:\n' +
      '       --- a/src/index.ts\n' +
      '       +++ b/src/index.ts\n' +
      '       @@ -42,6 +42,8 @@\n' +
      '        const x = 1\n' +
      '       -return x\n' +
      '       +const y = x + 1\n' +
      '       +return y\n' +
      '\n' +
      '  2. FULL-FILE MODE (required for sweeping rewrites, or any file under ~200 lines):\n' +
      '     Provide `newContent` with the COMPLETE new file text — every single line, not\n' +
      '     just the parts you changed.\n' +
      '     Always call read_file first so you have the exact current content.\n' +
      '\n' +
      '  ⚠️ CRITICAL — applies to BOTH modes: `newContent` in full mode is a literal, total\n' +
      '  replacement of the file. NEVER write placeholders or shorthand standing in for real\n' +
      '  content (e.g. "<!-- rest unchanged -->", "// ... rest of file ...", "/* same as before */").\n' +
      '  Anything you omit is permanently deleted the instant the user accepts. If a request like\n' +
      '  "make this look better / redesign / make responsive" touches most of the file (new CSS,\n' +
      '  new structure, new sections), that is still full-file mode — reproduce every existing\n' +
      '  element, meta tag, and unrelated section verbatim, and only change what the user actually\n' +
      '  asked you to change. If the file is too large to reproduce in full within your output\n' +
      '  budget, use patch mode for the specific hunks instead of truncating a full rewrite.\n' +
      '\n' +
      'The target file must already exist — use create_file for new files.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to edit (absolute or relative to project root).',
        },
        description: {
          type: 'string',
          description:
            'Human-readable summary of what this edit does, e.g. ' +
            '"Fix TS2345 type mismatch on line 42" or "Update import paths".',
        },
        newContent: {
          type: 'string',
          description:
            'FULL-FILE MODE: The complete new content for the file. ' +
            'Use only for small files (<200 lines) or sweeping rewrites. ' +
            'Provide either this or `patch`, not both.',
        },
        patch: {
          type: 'string',
          description:
            'PATCH MODE: A unified diff patch to apply to the current file. ' +
            'Must include @@ hunk headers. Lines prefixed with \'-\' are removed, ' +
            'lines prefixed with \'+\' are added, space-prefixed lines are context. ' +
            'Provide either this or `newContent`, not both.',
        },
      },
      required: ['filePath', 'description'],
    },
  },

  describeCall: (args) =>
    `Proposing edit to ${args.filePath ?? 'unknown'}${args.patch ? ' (patch)' : ''}…`,

  execute: async (args, ctx: ToolContext) => {
    // ── Validate arguments ──────────────────────────────────────────────
    if (!args.newContent && !args.patch) {
      return toolErr('Either `newContent` or `patch` must be provided.')
    }
    if (args.newContent && args.patch) {
      return toolErr('Provide either `newContent` or `patch` — not both.')
    }

    const validated = await validateFileExists(args.filePath, ctx.projectRoot)
    if (!validated.ok) return toolErr(validated.error)

    const absolutePath = validated.path

    // ── Read current file ───────────────────────────────────────────────
    let originalContent = ''
    try {
      const result = await readFile(absolutePath)
      originalContent = result.content
    } catch (err) {
      return toolErr(
        err instanceof Error
          ? err.message
          : `Failed to read file for diff: ${args.filePath}`
      )
    }

    // ── Compute proposed content ────────────────────────────────────────
    let proposedContent: string
    let mode: 'full' | 'patch'

    if (args.patch) {
      mode = 'patch'
      try {
        proposedContent = applyUnifiedPatch(originalContent, args.patch)
      } catch (err) {
        return toolErr(
          err instanceof Error
            ? `Failed to apply patch: ${err.message}`
            : `Failed to apply patch to ${args.filePath}`
        )
      }
    } else {
      mode = 'full'
      proposedContent = args.newContent!
    }

    // ── Guard: detect silent content elision in full-file mode ──────────
    // The single most common LLM failure on "redesign/improve this file"
    // requests: instead of reproducing the whole file with targeted changes,
    // the model writes a shorter "fresh" version and drops sections it
    // judged unimportant. There is nothing else in this pipeline that
    // catches that — EditStore stores whatever it's given — so we flag it
    // here. Non-blocking by design: some edits genuinely shrink a file a
    // lot (e.g. "strip this down"), so we don't refuse the edit, but we
    // make the loss impossible to miss for both the agent and the user.
    let sizeWarning: string | undefined
    if (mode === 'full') {
      const originalLen = originalContent.length
      const proposedLen = proposedContent.length
      const MIN_LEN_TO_CHECK = 300 // skip trivial/small files — ratio noise
      const SHRINK_RATIO_THRESHOLD = 0.5 // flag if proposal is <50% of original
      if (originalLen >= MIN_LEN_TO_CHECK && proposedLen < originalLen * SHRINK_RATIO_THRESHOLD) {
        const pctLost = Math.round((1 - proposedLen / originalLen) * 100)
        sizeWarning =
          `⚠️ SIZE WARNING: the proposed content is ${pctLost}% smaller than the original ` +
          `(${originalLen} → ${proposedLen} chars). This usually means unchanged content was ` +
          'elided instead of reproduced. If that was NOT intentional, call propose_edit again ' +
          'for this file with the COMPLETE content — every existing section reproduced verbatim, ' +
          'with only the specifically requested changes applied.'
      }
    }

    // ── Guard: no-op edits ─────────────────────────────────────────────
    const { getPendingEdit, proposeEdit } = useEditStore.getState()
    const existingEdit = getPendingEdit(absolutePath)

    const latestProposed = existingEdit ? existingEdit.proposedContent : originalContent
    if (latestProposed === proposedContent) {
      return toolErr(
        `No changes detected for ${absolutePath}. ` +
        'The proposed content is identical to the current pending proposal.'
      )
    }

    // Preserve original content from first proposal so the diff always
    // shows the true before-state.
    const effectiveOriginal = existingEdit ? existingEdit.originalContent : originalContent

    // ── Register / update in EditStore ─────────────────────────────────
    const editId = proposeEdit({
      filePath: absolutePath,
      originalContent: effectiveOriginal,
      proposedContent,
      description: args.description,
    })

    return toolOk<ProposeEditResult>({
      editId,
      filePath: absolutePath,
      description: args.description,
      pending: true,
      mode,
      sizeWarning,
      message:
        `Edit proposed via ${mode === 'patch' ? 'patch' : 'full replacement'} (id: ${editId}). ` +
        'The diff is now visible in the editor panel. ' +
        'The user must accept or reject it before the file is modified.' +
        (sizeWarning ? `\n\n${sizeWarning}` : ''),
    })
  },
}