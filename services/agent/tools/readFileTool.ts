// services/agent/tools/readFileTool.ts
//
// Tool: read_file
// Reads the full text content of a file from the open workspace using the
// existing `read_file` Tauri command (lib/tauriFs.ts).

import { readFile } from '../../../lib/tauriFs'
import { validateFileExists } from '../fileValidation'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

export interface ReadFileArgs {
  path: string
}

export interface ReadFileResult {
  path: string
  content: string
  size: number
  truncated: boolean
}

/** Cap returned content so a single huge file can't blow the prompt budget. */
const MAX_CONTENT_CHARS = 20000

export const readFileTool: AgentTool<ReadFileArgs, ReadFileResult> = {
  declaration: {
    name: 'read_file',
    description:
      'Read the full text content of a file in the open project. ' +
      'Path may be absolute or relative to the project root. ' +
      'The file must exist on disk — returns a clear error if it does not. ' +
      'Returns the file content, possibly truncated if very large.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path, e.g. "src/App.tsx" (relative to project root) or an absolute path.',
        },
      },
      required: ['path'],
    },
  },

  describeCall: (args) => `Reading ${args.path}…`,

  execute: async (args, ctx: ToolContext) => {
    const validated = await validateFileExists(args.path, ctx.projectRoot)
    if (!validated.ok) return toolErr(validated.error)

    try {
      const { content, size, kind } = await readFile(validated.path)

      if (kind !== 'text') {
        return toolOk<ReadFileResult>({
          path: validated.path,
          content: `[binary file, ${size} bytes — content not shown]`,
          size,
          truncated: false,
        })
      }

      const truncated = content.length > MAX_CONTENT_CHARS
      const finalContent = truncated
        ? content.slice(0, MAX_CONTENT_CHARS) + '\n…(truncated)'
        : content

      return toolOk<ReadFileResult>({
        path: validated.path,
        content: finalContent,
        size,
        truncated,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to read file: ${args.path}`
      )
    }
  },
}
