import { invoke } from '@tauri-apps/api/core'
import { registerSelfWrite } from '../services/selfWriteTracker'

// ── Shared types (mirror the Rust structs) ────────────────────────────────────

export interface FolderEntry {
  path:     string
  name:     string
  is_dir:   boolean
  /** Populated for directories; empty array for files */
  children: FolderEntry[]
}

export interface ReadResult {
  path:    string
  /** Raw text for kind "text"; base64 for kind "base64"; empty for "binary" */
  content: string
  /** File size on disk, in bytes */
  size:    number
  /** "text" | "base64" | "binary" */
  kind:    'text' | 'base64' | 'binary'
  /** Best-guess MIME type */
  mime:    string
  /** Last-modified unix timestamp (seconds), if available */
  modified?: number | null
}

export interface SaveResult {
  path:    string
  /** Bytes written */
  written: number
}

// ── open_folder ───────────────────────────────────────────────────────────────

/**
 * Opens a native folder-picker dialog.
 * Returns the directory tree rooted at the chosen folder,
 * or `null` if the user cancelled.
 *
 * @example
 * const root = await openFolder()
 * if (root) setFileTree([root])
 */
export async function openFolder(): Promise<FolderEntry | null> {
  return invoke<FolderEntry | null>('open_folder')
}

/**
 * Reads the directory tree for a known path without opening a dialog.
 * Used to refresh the file explorer after indexing completes.
 *
 * @param path  Absolute path to the folder to read
 */
export async function readFolder(path: string): Promise<FolderEntry> {
  return invoke<FolderEntry>('read_folder', { path })
}

// ── pick_directory / create_project ──────────────────────────────────────────
// Used by the "Build New Project" flow (intent classification → BUILD_NEW_PROJECT):
// the user picks *where* the new project should live, types a name, and a
// fresh folder is created and returned (without walking an existing tree).

/**
 * Opens a native folder-picker dialog and returns just the chosen path,
 * or `null` if the user cancelled. Unlike `openFolder()`, this does not
 * recursively read the directory — it's meant for picking a *parent*
 * location for a brand-new project, not opening an existing one.
 */
export async function pickDirectory(title?: string): Promise<string | null> {
  return invoke<string | null>('pick_directory', { title: title ?? null })
}

/**
 * Opens a native "Open File" dialog for a single file, optionally
 * filtered to a set of extensions (given without the leading dot, e.g.
 * `['rachna_design']`), and returns the chosen path, or `null` if
 * cancelled. Generic — the caller is responsible for reading/parsing the
 * file itself (see lib/designCanvas/projectFile.ts for the Design Project
 * `.rachna_design` use case).
 */
export async function pickFile(opts?: {
  title?: string
  filterName?: string
  filterExtensions?: string[]
}): Promise<string | null> {
  return invoke<string | null>('pick_file', {
    title: opts?.title ?? null,
    filterName: opts?.filterName ?? null,
    filterExtensions: opts?.filterExtensions ?? null,
  })
}

/**
 * Creates `{parentPath}/{projectName}` (if it doesn't already exist) and
 * returns its directory tree. Throws if the name resolves to a path that
 * already exists as a file.
 */
export async function createProject(parentPath: string, projectName: string): Promise<FolderEntry> {
  return invoke<FolderEntry>('create_project', { parentPath, projectName })
}

/**
 * Resolves (and creates, if missing) the default location offered by the
 * "Build New Project" dialog: `{Rachna AI Studio install dir}/data/projects`.
 * Used to pre-fill the location field so most users never need to Browse…
 * manually; they can still override it. Returns `null` (rather than
 * throwing) if it can't be resolved — callers should just leave the
 * location field blank/empty in that case.
 */
export async function getDefaultProjectsDir(): Promise<string | null> {
  try {
    return await invoke<string>('get_default_projects_dir')
  } catch {
    return null
  }
}

// ── path_info ─────────────────────────────────────────────────────────────────

export interface PathInfo {
  exists:  boolean
  is_file: boolean
  is_dir:  boolean
}

/**
 * Returns whether a path exists on disk and whether it is a file or directory.
 * Does not throw for missing paths — check `exists` on the result instead.
 */
export async function getPathInfo(path: string): Promise<PathInfo> {
  return invoke<PathInfo>('path_info', { path })
}

// ── read_file ─────────────────────────────────────────────────────────────────

/**
 * Reads a file from disk and returns its content along with metadata.
 * Never throws for non-UTF-8 / binary content — instead returns
 * `kind: "base64"` (previewable binary like images/audio/video/pdf) or
 * `kind: "binary"` (opaque/large files, content omitted).
 * Throws if the file doesn't exist, the path is a directory, or read fails.
 *
 * @param path  Absolute path to the file
 */
export async function readFile(path: string): Promise<ReadResult> {
  const info = await getPathInfo(path)

  if (!info.exists) {
    throw new Error(
      `Cannot read this file — it does not exist: "${path}". ` +
      'The file may have been moved, deleted, or the path may be incorrect.'
    )
  }
  if (info.is_dir) {
    throw new Error(
      `Cannot read "${path}" — it is a directory, not a file. ` +
      'Provide the path to a file instead.'
    )
  }
  if (!info.is_file) {
    throw new Error(`Cannot read "${path}" — path is not a regular file.`)
  }

  return invoke<ReadResult>('read_file', { path })
}

// ── list_directory ───────────────────────────────────────────────────────────

export interface DirEntryInfo {
  name:   string
  path:   string
  is_dir: boolean
}

/**
 * Returns the immediate (non-recursive) children of `path`, directories
 * first then alphabetically. Throws if the path doesn't exist or isn't a
 * directory.
 */
export async function listDirectory(path: string): Promise<DirEntryInfo[]> {
  return invoke<DirEntryInfo[]>('list_directory', { path })
}

// ── save_file ─────────────────────────────────────────────────────────────────

/**
 * Saves `content` to `path`.
 * - If `path` is provided, writes directly (creates parent dirs as needed).
 * - If `path` is omitted, opens a native Save As dialog.
 * - `defaultName` seeds the filename in the Save As dialog.
 *
 * @example
 * // Direct save (Ctrl+S)
 * await saveFile({ path: activeFile.path, content: activeFile.content })
 *
 * // Save As (Ctrl+Shift+S)
 * const result = await saveFile({ content, defaultName: 'untitled.tsx' })
 * console.log('Saved to', result.path)
 */
export async function saveFile(opts: {
  content:     string
  path?:       string
  defaultName?: string
}): Promise<SaveResult> {
  const result = await invoke<SaveResult>('save_file', {
    path:        opts.path        ?? null,
    content:     opts.content,
    defaultName: opts.defaultName ?? null,
  })

  // Mark this path as a self-write so the file watcher (useFileWatcher.ts)
  // doesn't surface it back to the user as an "external change" needing a
  // manual reindex — this call site already triggers its own reindex.
  registerSelfWrite(result.path)

  return result
}

// ── write_base64_file ────────────────────────────────────────────────────────

/**
 * Saves base64-encoded binary `data` (images, video, PDF, PPTX, etc.) to
 * `path`, creating parent directories as needed. Companion to `saveFile`,
 * which only handles UTF-8 text. Always writes directly — no Save As dialog,
 * since callers always know the destination path up front.
 */
export async function saveBinaryFile(path: string, base64Data: string): Promise<SaveResult> {
  const result = await invoke<SaveResult>('write_base64_file', { path, data: base64Data })
  registerSelfWrite(result.path)
  return result
}

// ── rename_file ───────────────────────────────────────────────────────────────

/**
 * Renames or moves a file from `oldPath` to `newPath`.
 * Creates parent directories for `newPath` if needed.
 * Throws if the source doesn't exist.
 */
export async function renameFile(oldPath: string, newPath: string): Promise<void> {
  await invoke<void>('rename_file', { oldPath, newPath })

  // Mark both the old and new paths as self-writes so the file watcher
  // doesn't surface this rename/move back to the user as an "external
  // change" needing a manual reindex — the old path disappearing and the
  // new path appearing are both consequences of this in-app action.
  registerSelfWrite(oldPath)
  registerSelfWrite(newPath)
}

// ── delete_file ───────────────────────────────────────────────────────────────

/**
 * Permanently deletes a file at `path`.
 * Throws if the path doesn't exist or is a directory.
 */
export async function deleteFile(path: string): Promise<void> {
  await invoke<void>('delete_file', { path })

  // Mark this path as a self-write so the file watcher doesn't surface
  // this in-app delete back to the user as an "external change" needing
  // a manual reindex.
  registerSelfWrite(path)
}

// ── copy_file ────────────────────────────────────────────────────────────────

/**
 * Duplicates a file from `sourcePath` to `destinationPath`. Creates parent
 * directories for the destination as needed. Throws if the source doesn't
 * exist or the destination already exists.
 */
export async function copyFile(sourcePath: string, destinationPath: string): Promise<void> {
  await invoke<void>('copy_file', { sourcePath, destinationPath })
  registerSelfWrite(destinationPath)
}

// ── copy_folder ──────────────────────────────────────────────────────────────

/**
 * Recursively clones a directory tree from `sourcePath` to
 * `destinationPath`. Throws if the source isn't a directory or the
 * destination already exists.
 */
export async function copyFolder(sourcePath: string, destinationPath: string): Promise<void> {
  await invoke<void>('copy_folder', { sourcePath, destinationPath })
  registerSelfWrite(destinationPath)
}

// ── move_folder ──────────────────────────────────────────────────────────────

/**
 * Moves/renames a directory from `oldPath` to `newPath`. Falls back to a
 * recursive copy + delete for cross-volume moves. Throws if the source
 * isn't a directory or the destination already exists.
 */
export async function moveFolder(oldPath: string, newPath: string): Promise<void> {
  await invoke<void>('move_folder', { oldPath, newPath })
  registerSelfWrite(oldPath)
  registerSelfWrite(newPath)
}

// ── delete_folder ────────────────────────────────────────────────────────────

/**
 * Permanently, recursively deletes a directory at `path`.
 * Throws if the path doesn't exist or is a file.
 */
export async function deleteFolder(path: string): Promise<void> {
  await invoke<void>('delete_folder', { path })
  registerSelfWrite(path)
}

// ── create_folder ────────────────────────────────────────────────────────────

/**
 * Creates a new directory at `path` (and any missing parent directories).
 * No-op if the directory already exists; throws if `path` already exists
 * as a file.
 */
export async function createFolder(path: string): Promise<void> {
  await invoke<void>('create_folder', { path })
  registerSelfWrite(path)
}

// ── Convenience: open folder and read a file in one shot ─────────────────────

/**
 * Helper: reads a file and returns just the text content string.
 * Useful when you don't need the metadata.
 */
export async function readFileContent(path: string): Promise<string> {
  const { content } = await readFile(path)
  return content
}

/**
 * Helper: saves and returns the resolved path.
 * Useful for "Save As" flows where you need to update state with the new path.
 */
export async function saveFileAs(content: string, defaultName?: string): Promise<string> {
  const { path } = await saveFile({ content, defaultName })
  return path
}


export async function getHomeDir(): Promise<string> {
  return invoke<string>('get_home_dir')
}

/**
 * Stable, portable-install directory for locally-spawned (stdio) MCP
 * servers that need a persistent on-disk file of their own — e.g. the
 * Gmail / Google Calendar MCP servers caching their own first-run OAuth
 * token (see lib/mcp/googleStdioCredentials.ts). Created on first call.
 */
export async function getMcpCredentialsDir(): Promise<string> {
  return invoke<string>('get_mcp_credentials_dir')
}
