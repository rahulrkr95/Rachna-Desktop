// services/agent/tools/listDirectoryTool.ts
//
// Tool: list_directory
// Lists the immediate files/folders inside a directory using the
// `list_directory` Tauri command (lib/tauriFs.ts).

import { listDirectory, type DirEntryInfo } from '../../../lib/tauriFs'
import { resolveWorkspacePath } from '../pathUtils'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

export interface ListDirectoryArgs {
  path: string
}

export interface ListDirectoryResult {
  path: string
  entries: DirEntryInfo[]
}

export const listDirectoryTool: AgentTool<ListDirectoryArgs, ListDirectoryResult> = {
  declaration: {
    name: 'list_directory',
    description:
      'List the files and folders directly inside a directory (non-recursive). ' +
      'Path may be absolute, relative to the project root, or "." for the project root.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path, e.g. "src/components", "." for project root, or an absolute path.',
        },
      },
      required: ['path'],
    },
  },

  describeCall: (args) => {
    const label = args.path === '.' || args.path === '' ? 'project root' : args.path
    return `Listing ${label}…`
  },

  execute: async (args, ctx: ToolContext) => {
    const target = args.path === '.' || args.path.trim() === '' ? '.' : args.path

    let absPath: string
    if (target === '.') {
      if (!ctx.projectRoot) {
        return toolErr('Cannot list project root — no project folder is open.')
      }
      absPath = ctx.projectRoot
    } else {
      const resolved = resolveWorkspacePath(target, ctx.projectRoot)
      if (!resolved.ok) return toolErr(resolved.error)
      absPath = resolved.path
    }

    try {
      const entries = await listDirectory(absPath)
      return toolOk<ListDirectoryResult>({ path: absPath, entries })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to list directory: ${target}`
      )
    }
  },
}
