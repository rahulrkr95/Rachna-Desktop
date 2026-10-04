// services/agent/tools/folderOpTools.ts
//
// Tools: copy_file, copy_folder, move_folder, delete_folder, create_folder
//
// Structural filesystem tools for the agent, primarily aimed at
// DESKTOP_TASK:files turns (see lib/intentRegistry.ts's
// DESKTOP_TASK_FILES_TOOL_NAMES) — "duplicate this template", "clone this
// project folder", "move this folder to the Desktop", "delete this old
// folder", "make a new folder for X". They complement fileOpTools.ts:
//   - copy_file:     duplicates a single file (templates, assets, configs)
//   - copy_folder:   recursively clones a directory tree (project
//                    folders/features)
//   - move_folder:   moves/renames a directory
//   - delete_folder: recursively, irreversibly deletes a directory
//   - create_folder: creates a new (possibly nested) directory
//
// Unlike create_file, these do NOT go through the propose_edit review
// workflow — there's no single-file diff to preview for "copy this whole
// folder" the way there is for a text edit. Each tool executes immediately
// once the model calls it, same as rename_file/delete_file today. Callers
// that want a confirmation step in front of destructive folder operations
// should gate that in the UI layer (e.g. a permission prompt), same as
// terminalTool.ts's requestTerminalPermission — not duplicated here.
//
// These invoke Tauri commands that must exist in commands.rs
// (copy_file, copy_folder, move_folder, delete_folder, create_folder).

import { invoke } from '@tauri-apps/api/core'
import {
  validateFileExists,
  validateFolderExists,
  validatePathDoesNotExist,
} from '../fileValidation'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── copy_file ────────────────────────────────────────────────────────────────

export interface CopyFileArgs {
  sourcePath: string
  destinationPath: string
}

export interface CopyFileResult {
  sourcePath: string
  destinationPath: string
  message: string
}

export const copyFileTool: AgentTool<CopyFileArgs, CopyFileResult> = {
  declaration: {
    name: 'copy_file',
    description:
      'Duplicate a single file to a new location (e.g. templates, assets, config files). ' +
      'The source file is left untouched. Fails if the destination already exists. ' +
      'For a DESKTOP_TASK:files request with no project open, give full absolute OS paths ' +
      '(e.g. "C:\\\\Users\\\\me\\\\Desktop\\\\notes.txt") or paths relative to the user\'s home folder.',
    parameters: {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Path of the existing file to copy (absolute, or relative to project root).',
        },
        destinationPath: {
          type: 'string',
          description: 'Path for the new copy (absolute, or relative to project root). Must not already exist.',
        },
      },
      required: ['sourcePath', 'destinationPath'],
    },
  },

  describeCall: (args) => `Copying ${args.sourcePath ?? ''} → ${args.destinationPath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const src = await validateFileExists(args.sourcePath, ctx.projectRoot)
    if (!src.ok) return toolErr(src.error)

    const dst = await validatePathDoesNotExist(args.destinationPath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!dst.ok) return toolErr(dst.error)

    try {
      await invoke('copy_file', { sourcePath: src.path, destinationPath: dst.path })

      return toolOk<CopyFileResult>({
        sourcePath: src.path,
        destinationPath: dst.path,
        message: `File copied: ${src.path} → ${dst.path}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to copy file: ${args.sourcePath}`
      )
    }
  },
}

// ── copy_folder ──────────────────────────────────────────────────────────────

export interface CopyFolderArgs {
  sourcePath: string
  destinationPath: string
}

export interface CopyFolderResult {
  sourcePath: string
  destinationPath: string
  message: string
}

export const copyFolderTool: AgentTool<CopyFolderArgs, CopyFolderResult> = {
  declaration: {
    name: 'copy_folder',
    description:
      'Recursively clone an entire folder — e.g. duplicating a project folder or a feature ' +
      'directory. Copies every file and subfolder. Fails if the destination already exists. ' +
      'For a DESKTOP_TASK:files request with no project open, give full absolute OS paths or ' +
      'paths relative to the user\'s home folder.',
    parameters: {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Path of the existing folder to copy (absolute, or relative to project root).',
        },
        destinationPath: {
          type: 'string',
          description: 'Path for the new folder copy (absolute, or relative to project root). Must not already exist.',
        },
      },
      required: ['sourcePath', 'destinationPath'],
    },
  },

  describeCall: (args) => `Copying folder ${args.sourcePath ?? ''} → ${args.destinationPath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const src = await validateFolderExists(args.sourcePath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!src.ok) return toolErr(src.error)

    const dst = await validatePathDoesNotExist(args.destinationPath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!dst.ok) return toolErr(dst.error)

    try {
      await invoke('copy_folder', { sourcePath: src.path, destinationPath: dst.path })

      return toolOk<CopyFolderResult>({
        sourcePath: src.path,
        destinationPath: dst.path,
        message: `Folder copied: ${src.path} → ${dst.path}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to copy folder: ${args.sourcePath}`
      )
    }
  },
}

// ── move_folder ──────────────────────────────────────────────────────────────

export interface MoveFolderArgs {
  oldPath: string
  newPath: string
}

export interface MoveFolderResult {
  oldPath: string
  newPath: string
  message: string
}

export const moveFolderTool: AgentTool<MoveFolderArgs, MoveFolderResult> = {
  declaration: {
    name: 'move_folder',
    description:
      'Move or rename an entire folder. This immediately moves the folder (and everything in ' +
      'it) on disk. Fails if the destination already exists. For a DESKTOP_TASK:files request ' +
      'with no project open, give full absolute OS paths or paths relative to the user\'s home folder.',
    parameters: {
      type: 'object',
      properties: {
        oldPath: {
          type: 'string',
          description: 'Current path of the folder (absolute, or relative to project root).',
        },
        newPath: {
          type: 'string',
          description: 'New path for the folder (absolute, or relative to project root). Must not already exist.',
        },
      },
      required: ['oldPath', 'newPath'],
    },
  },

  describeCall: (args) =>
    `Moving folder ${args.oldPath ?? ''} → ${args.newPath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const src = await validateFolderExists(args.oldPath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!src.ok) return toolErr(src.error)

    const dst = await validatePathDoesNotExist(args.newPath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!dst.ok) return toolErr(dst.error)

    try {
      await invoke('move_folder', { oldPath: src.path, newPath: dst.path })

      return toolOk<MoveFolderResult>({
        oldPath: src.path,
        newPath: dst.path,
        message: `Folder moved: ${src.path} → ${dst.path}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to move folder: ${args.oldPath}`
      )
    }
  },
}

// ── delete_folder ────────────────────────────────────────────────────────────

export interface DeleteFolderArgs {
  folderPath: string
  reason: string
}

export interface DeleteFolderResult {
  folderPath: string
  message: string
}

export const deleteFolderTool: AgentTool<DeleteFolderArgs, DeleteFolderResult> = {
  declaration: {
    name: 'delete_folder',
    description:
      'Recursively delete a folder and everything inside it. This is IRREVERSIBLE — use with ' +
      'extreme caution. Only delete folders that are clearly unused or explicitly requested by ' +
      'the user. Provide a reason explaining why deletion is safe.',
    parameters: {
      type: 'object',
      properties: {
        folderPath: {
          type: 'string',
          description: 'Path of the folder to delete (absolute, or relative to project root).',
        },
        reason: {
          type: 'string',
          description: 'Explanation of why this folder should be deleted.',
        },
      },
      required: ['folderPath', 'reason'],
    },
  },

  describeCall: (args) => `Deleting folder ${args.folderPath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const validated = await validateFolderExists(args.folderPath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!validated.ok) return toolErr(validated.error)

    try {
      await invoke('delete_folder', { path: validated.path })

      return toolOk<DeleteFolderResult>({
        folderPath: validated.path,
        message: `Folder deleted: ${validated.path}. Reason: ${args.reason}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to delete folder: ${args.folderPath}`
      )
    }
  },
}

// ── create_folder ────────────────────────────────────────────────────────────

export interface CreateFolderArgs {
  folderPath: string
  description: string
}

export interface CreateFolderResult {
  folderPath: string
  message: string
}

export const createFolderTool: AgentTool<CreateFolderArgs, CreateFolderResult> = {
  declaration: {
    name: 'create_folder',
    description:
      'Create a new folder (and any missing parent folders along the way), e.g. for a new ' +
      'project or feature directory. No-op if the folder already exists. For a DESKTOP_TASK:files ' +
      'request with no project open, give a full absolute OS path (e.g. "C:\\\\Users\\\\me\\\\Desktop\\\\NewFolder") ' +
      'or a path relative to the user\'s home folder.',
    parameters: {
      type: 'object',
      properties: {
        folderPath: {
          type: 'string',
          description: 'Path for the new folder (absolute, or relative to project root).',
        },
        description: {
          type: 'string',
          description: 'Human-readable summary, e.g. "Create src/components/Auth for the new login feature".',
        },
      },
      required: ['folderPath', 'description'],
    },
  },

  describeCall: (args) => `Creating folder ${args.folderPath ?? ''}…`,

  execute: async (args, ctx: ToolContext) => {
    const validated = await validatePathDoesNotExist(args.folderPath, ctx.projectRoot, ctx.allowExternalPaths)
    if (!validated.ok) return toolErr(validated.error)

    try {
      await invoke('create_folder', { path: validated.path })

      return toolOk<CreateFolderResult>({
        folderPath: validated.path,
        message: `Folder created: ${validated.path}. ${args.description}`,
      })
    } catch (err) {
      return toolErr(
        err instanceof Error ? err.message : `Failed to create folder: ${args.folderPath}`
      )
    }
  },
}
