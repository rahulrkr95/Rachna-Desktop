// services/agent/fileValidation.ts
//
// Shared file-existence validation for agent tools. Every read, edit, rename,
// delete, or diff operation should call these helpers after resolving paths
// so missing files fail with a clear tool error instead of bubbling exceptions.

import { getPathInfo } from '../../lib/tauriFs'
import { resolveWorkspacePath, resolveSystemPath } from './pathUtils'

export interface ValidatedFile {
  ok: true
  /** Absolute path used for filesystem operations */
  path: string
  /** Original path supplied by the model (trimmed) */
  inputPath: string
}

export interface FileValidationFailure {
  ok: false
  error: string
}

export type FileValidationResult = ValidatedFile | FileValidationFailure

function displayPath(inputPath: string, resolvedPath: string): string {
  const trimmed = inputPath.trim()
  if (trimmed === resolvedPath) return `"${trimmed}"`
  return `"${trimmed}" (resolved to "${resolvedPath}")`
}

function fileNotFoundError(inputPath: string, resolvedPath: string): string {
  return (
    `Cannot read this file — it does not exist: ${displayPath(inputPath, resolvedPath)}. ` +
    'Please verify the path is correct, use list_directory to browse the project, ' +
    'or use create_file if a new file should be added.'
  )
}

function notAFileError(inputPath: string, resolvedPath: string): string {
  return (
    `Path is a directory, not a file: ${displayPath(inputPath, resolvedPath)}. ` +
    'Provide the path to a file, not a folder.'
  )
}

function fileAlreadyExistsError(inputPath: string, resolvedPath: string): string {
  return (
    `File already exists: ${displayPath(inputPath, resolvedPath)}. ` +
    'Use propose_edit to modify existing files, or choose a different path.'
  )
}

/**
 * Checks that a resolved absolute path points to an existing regular file.
 */
export async function validateResolvedFileExists(
  inputPath: string,
  resolvedPath: string
): Promise<FileValidationResult> {
  try {
    const info = await getPathInfo(resolvedPath)

    if (!info.exists) {
      return { ok: false, error: fileNotFoundError(inputPath, resolvedPath) }
    }
    if (info.is_dir) {
      return { ok: false, error: notAFileError(inputPath, resolvedPath) }
    }
    if (!info.is_file) {
      return {
        ok: false,
        error: `Path is not a regular file: ${displayPath(inputPath, resolvedPath)}.`,
      }
    }

    return { ok: true, path: resolvedPath, inputPath: inputPath.trim() }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : `Failed to verify file exists: ${displayPath(inputPath, resolvedPath)}`,
    }
  }
}

/**
 * Resolves a model-supplied path against the project root, then verifies the
 * target file exists on disk.
 */
export async function validateFileExists(
  inputPath: string,
  projectRoot: string | null
): Promise<FileValidationResult> {
  const resolved = resolveWorkspacePath(inputPath, projectRoot)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  return validateResolvedFileExists(inputPath, resolved.path)
}

function folderNotFoundError(inputPath: string, resolvedPath: string): string {
  return (
    `Cannot find this folder — it does not exist: ${displayPath(inputPath, resolvedPath)}. ` +
    'Please verify the path is correct, use list_directory to browse, ' +
    'or use create_folder if a new folder should be added.'
  )
}

function notAFolderError(inputPath: string, resolvedPath: string): string {
  return (
    `Path is a file, not a folder: ${displayPath(inputPath, resolvedPath)}. ` +
    'Provide the path to a folder, not a file.'
  )
}

function folderAlreadyExistsError(inputPath: string, resolvedPath: string): string {
  return `A folder or file already exists at: ${displayPath(inputPath, resolvedPath)}.`
}

/**
 * Resolves a model-supplied path and verifies the target folder exists on
 * disk. Set `allowExternalPaths` for DESKTOP_TASK:files turns (same
 * resolution strategy as validateFileDoesNotExist — see its doc comment).
 */
export async function validateFolderExists(
  inputPath: string,
  projectRoot: string | null,
  allowExternalPaths = false
): Promise<FileValidationResult> {
  const resolved = allowExternalPaths
    ? await resolveSystemPath(inputPath, projectRoot)
    : resolveWorkspacePath(inputPath, projectRoot)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    const info = await getPathInfo(resolved.path)

    if (!info.exists) {
      return { ok: false, error: folderNotFoundError(inputPath, resolved.path) }
    }
    if (!info.is_dir) {
      return { ok: false, error: notAFolderError(inputPath, resolved.path) }
    }

    return { ok: true, path: resolved.path, inputPath: inputPath.trim() }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : `Failed to verify folder exists: ${displayPath(inputPath, resolved.path)}`,
    }
  }
}

/**
 * Resolves a model-supplied path and verifies nothing (file or folder)
 * already exists there. Used by create_folder / copy_file / copy_folder /
 * move_folder before writing to a destination path.
 */
export async function validatePathDoesNotExist(
  inputPath: string,
  projectRoot: string | null,
  allowExternalPaths = false
): Promise<FileValidationResult> {
  const resolved = allowExternalPaths
    ? await resolveSystemPath(inputPath, projectRoot)
    : resolveWorkspacePath(inputPath, projectRoot)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    const info = await getPathInfo(resolved.path)

    if (info.exists) {
      return { ok: false, error: folderAlreadyExistsError(inputPath, resolved.path) }
    }

    return { ok: true, path: resolved.path, inputPath: inputPath.trim() }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : `Failed to verify path: ${displayPath(inputPath, resolved.path)}`,
    }
  }
}

/**
 * Resolves a model-supplied path and verifies the target file does NOT exist.
 * Used by create_file before proposing a new file.
 *
 * @param allowExternalPaths — when true (DESKTOP_TASK:files turns — see
 * ToolContext.allowExternalPaths), resolves via resolveSystemPath so
 * absolute OS paths and home-relative paths (e.g. "Desktop\\notes.txt")
 * work even with no project open. When false/omitted, resolves via
 * resolveWorkspacePath exactly as before — project-relative behavior for
 * coding/project turns is unchanged.
 */
export async function validateFileDoesNotExist(
  inputPath: string,
  projectRoot: string | null,
  allowExternalPaths = false
): Promise<FileValidationResult> {
  const resolved = allowExternalPaths
    ? await resolveSystemPath(inputPath, projectRoot)
    : resolveWorkspacePath(inputPath, projectRoot)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  try {
    const info = await getPathInfo(resolved.path)

    if (info.exists) {
      if (info.is_dir) {
        return {
          ok: false,
          error: `Cannot create file — path is an existing directory: ${displayPath(inputPath, resolved.path)}.`,
        }
      }
      return { ok: false, error: fileAlreadyExistsError(inputPath, resolved.path) }
    }

    return { ok: true, path: resolved.path, inputPath: inputPath.trim() }
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : `Failed to verify file path: ${displayPath(inputPath, resolved.path)}`,
    }
  }
}
