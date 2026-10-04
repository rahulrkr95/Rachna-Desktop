// services/agent/tools/readLinesTool.ts
//
// Tool: read_lines
//
// Reads a single line, or an inclusive range of lines, from a text file in
// the open workspace — the line-scoped sibling of `read_file`. `read_file`
// pulls the whole file (truncating past MAX_CONTENT_CHARS), which is wasteful
// when the model already knows roughly where in a file it needs to look
// (e.g. from a search/grep hit, a diagnostic, or a previous read) and just
// wants to re-check or quote a specific line or a small surrounding range —
// exactly the kind of narrow, cheap lookup the EDIT_PROJECT (work_with_repo)
// intent leans on a lot: confirm exact current content before proposing an
// edit, re-read a line after a diff, or pull a small window around a
// reported error line.
//
// `startLine` alone reads that single line ("get a line"); adding `endLine`
// reads the inclusive range from `startLine` through `endLine` ("get
// lines"). 1-indexed throughout, matching how editors/diagnostics report
// line numbers.

import { readFile } from '../../../lib/tauriFs'
import { validateFileExists } from '../fileValidation'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

export interface ReadLinesArgs {
  path: string
  /** 1-indexed line number to start at (inclusive). Provide this alone to read just one line. */
  startLine: number
  /** 1-indexed line number to end at (inclusive). Omit to read only `startLine`. */
  endLine?: number
}

export interface ReadLinesResult {
  path: string
  startLine: number
  endLine: number
  /** Total number of lines in the file, so the model knows how close to the end it is. */
  totalLines: number
  /** Each requested line, prefixed with its 1-indexed line number (e.g. "12: const x = 1"). */
  content: string
  /** True if endLine was clamped down to the file's last line. */
  clampedToEnd: boolean
}

/** Cap how many lines a single call can pull, so a huge accidental range (e.g. startLine=1,
 *  endLine=1000000) can't blow the prompt budget — same spirit as read_file's MAX_CONTENT_CHARS. */
const MAX_LINES_RETURNED = 2000

function splitLines(content: string): string[] {
  // Normalize CRLF/CR to LF before splitting so line numbers match what an
  // editor would show regardless of the file's line-ending style.
  return content.replace(/\r\n?/g, '\n').split('\n')
}

export const readLinesTool: AgentTool<ReadLinesArgs, ReadLinesResult> = {
  declaration: {
    name: 'read_lines',
    description:
      'Read a single line, or an inclusive range of lines, from a text file in the open ' +
      'project — cheaper than read_file when only a specific line or small window is needed ' +
      '(e.g. confirming exact current content before an edit, or inspecting a line a ' +
      'diagnostic/search hit pointed at). Provide `startLine` alone to get exactly one line, or ' +
      'add `endLine` to get every line from `startLine` through `endLine` inclusive. Line ' +
      'numbers are 1-indexed. Returns each line prefixed with its line number. Errors if the ' +
      'file does not exist or `startLine` is past the end of the file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path, e.g. "src/App.tsx" (relative to project root) or an absolute path.',
        },
        startLine: {
          type: 'number',
          description: '1-indexed line number to start at (inclusive). Provide this alone to read just that one line.',
        },
        endLine: {
          type: 'number',
          description: '1-indexed line number to end at (inclusive). Omit to read only startLine.',
        },
      },
      required: ['path', 'startLine'],
    },
  },

  describeCall: (args) =>
    args.endLine && args.endLine !== args.startLine
      ? `Reading ${args.path} lines ${args.startLine}-${args.endLine}…`
      : `Reading ${args.path} line ${args.startLine}…`,

  execute: async (args, ctx: ToolContext) => {
    const startLine = Math.trunc(args.startLine)
    if (!Number.isFinite(startLine) || startLine < 1) {
      return toolErr('startLine must be a positive integer (1-indexed) for read_lines.')
    }

    const rawEnd = args.endLine === undefined ? startLine : Math.trunc(args.endLine)
    if (!Number.isFinite(rawEnd) || rawEnd < startLine) {
      return toolErr('endLine, when provided, must be an integer >= startLine for read_lines.')
    }

    const validated = await validateFileExists(args.path, ctx.projectRoot)
    if (!validated.ok) return toolErr(validated.error)

    try {
      const { content, kind } = await readFile(validated.path)

      if (kind !== 'text') {
        return toolErr(`Cannot read lines from a binary file: "${args.path}".`)
      }

      const lines = splitLines(content)
      const totalLines = lines.length

      if (startLine > totalLines) {
        return toolErr(
          `startLine (${startLine}) is past the end of the file — "${args.path}" only has ${totalLines} line(s).`
        )
      }

      const cappedEnd = Math.min(rawEnd, totalLines, startLine + MAX_LINES_RETURNED - 1)
      const clampedToEnd = cappedEnd < rawEnd

      const slice = lines.slice(startLine - 1, cappedEnd)
      const numbered = slice.map((line, i) => `${startLine + i}: ${line}`).join('\n')

      return toolOk<ReadLinesResult>({
        path: validated.path,
        startLine,
        endLine: cappedEnd,
        totalLines,
        content: numbered,
        clampedToEnd,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to read lines from file: ${args.path}`
      )
    }
  },
}
