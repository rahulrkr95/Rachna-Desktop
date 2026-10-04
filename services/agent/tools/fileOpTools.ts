// services/agent/tools/fileOpTools.ts
//
// Tools: create_file, rename_file, delete_file
//
// File operation tools for the agent. Unlike propose_edit (which uses the
// diff workflow for existing files), these operate on file structure:
//   - create_file: creates a NEW file that doesn't yet exist
//   - rename_file: renames/moves a file
//   - delete_file: deletes a file
//
// Safety: create_file goes through the propose_edit workflow too, since
// "creating a new file" is a change the user should review.
// rename_file and delete_file are structural — they are also gated behind
// a pending confirmation tracked in the EditStore.
//
// These invoke Tauri commands that must exist in commands.rs.

import { invoke } from '@tauri-apps/api/core'
import { validateFileDoesNotExist, validateFileExists } from '../fileValidation'
import { resolveWorkspacePath } from '../pathUtils'
import { useEditStore } from '../../edits/EditStore'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── create_file ──────────────────────────────────────────────────────────────

export interface CreateFileArgs {
  filePath: string
  content: string
  description: string
}

export interface CreateFileResult {
  editId: string
  filePath: string
  pending: true
  message: string
}

export const createFileTool: AgentTool<CreateFileArgs, CreateFileResult> = {
  declaration: {
    name: 'create_file',
    description:
      'Propose creating a new file with the given content. ' +
      'The file will not be created until the user accepts the proposed change. ' +
      'Use this to create new source files, test files, or config files — ' +
      'or, for a DESKTOP_TASK:files request, any file anywhere on disk (e.g. on the Desktop).',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path for the new file. For coding/project work, this is relative to the ' +
            'project root (or absolute, if you want a specific location). For a ' +
            'DESKTOP_TASK:files request with no project open, give a full absolute OS path ' +
            '(e.g. "C:\\Users\\me\\Desktop\\notes.txt") or a path relative to the user\'s home ' +
            'folder (e.g. "Desktop\\notes.txt") — either resolves correctly with no project open.',
        },
        content: {
          type: 'string',
          description: 'Complete content to write to the new file.',
        },
        description: {
          type: 'string',
          description: 'Human-readable summary, e.g. "Create UserService.ts with CRUD methods".',
        },
      },
      required: ['filePath', 'content', 'description'],
    },
  },

  describeCall: (args) => `Creating new file ${args.filePath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const validated = await validateFileDoesNotExist(args.filePath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!validated.ok) return toolErr(validated.error)

    const { proposeEdit } = useEditStore.getState()
    const editId = proposeEdit({
      filePath: validated.path,
      originalContent: '',   // empty = new file creation
      proposedContent: args.content,
      description: `[New File] ${args.description}`,
    })

    return toolOk<CreateFileResult>({
      editId,
      filePath: validated.path,
      pending: true,
      message:
        `New file creation proposed (id: ${editId}). ` +
        'The user must accept before the file is created on disk.',
    })
  },
}

// ── rename_file ──────────────────────────────────────────────────────────────

export interface RenameFileArgs {
  oldPath: string
  newPath: string
}

export interface RenameFileResult {
  oldPath: string
  newPath: string
  message: string
}

export const renameFileTool: AgentTool<RenameFileArgs, RenameFileResult> = {
  declaration: {
    name: 'rename_file',
    description:
      'Rename or move a file within the project. ' +
      'This immediately moves the file on disk. ' +
      'You should also propose_edit any files that import the renamed file ' +
      'to update their import paths.',
    parameters: {
      type: 'object',
      properties: {
        oldPath: {
          type: 'string',
          description: 'Current path of the file (absolute or relative to project root).',
        },
        newPath: {
          type: 'string',
          description: 'New path for the file (absolute or relative to project root).',
        },
      },
      required: ['oldPath', 'newPath'],
    },
  },

  describeCall: (args) =>
    `Renaming ${args.oldPath ?? ''} → ${args.newPath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const oldValidated = await validateFileExists(args.oldPath, ctx.projectRoot)
    if (!oldValidated.ok) return toolErr(oldValidated.error)

    const newResolved = resolveWorkspacePath(args.newPath, ctx.projectRoot)
    if (!newResolved.ok) return toolErr(newResolved.error)

    try {
      await invoke('rename_file', {
        oldPath: oldValidated.path,
        newPath: newResolved.path,
      })

      return toolOk<RenameFileResult>({
        oldPath: oldValidated.path,
        newPath: newResolved.path,
        message: `File renamed: ${oldValidated.path} → ${newResolved.path}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to rename file: ${args.oldPath}`
      )
    }
  },
}

// ── delete_file ──────────────────────────────────────────────────────────────

export interface DeleteFileArgs {
  filePath: string
  reason: string
}

export interface DeleteFileResult {
  filePath: string
  message: string
}

export const deleteFileTool: AgentTool<DeleteFileArgs, DeleteFileResult> = {
  declaration: {
    name: 'delete_file',
    description:
      'Delete a file from the project. ' +
      'This is IRREVERSIBLE — use with caution. ' +
      'Only delete files that are clearly unused or explicitly requested by the user. ' +
      'Provide a reason explaining why deletion is safe.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path of the file to delete (absolute or relative to project root).',
        },
        reason: {
          type: 'string',
          description: 'Explanation of why this file should be deleted.',
        },
      },
      required: ['filePath', 'reason'],
    },
  },

  describeCall: (args) => `Deleting ${args.filePath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const validated = await validateFileExists(args.filePath, ctx.projectRoot)
    if (!validated.ok) return toolErr(validated.error)

    try {
      await invoke('delete_file', { path: validated.path })

      return toolOk<DeleteFileResult>({
        filePath: validated.path,
        message: `File deleted: ${validated.path}. Reason: ${args.reason}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to delete file: ${args.filePath}`
      )
    }
  },
}
