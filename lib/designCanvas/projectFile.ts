// lib/designCanvas/projectFile.ts
//
// Persists a Design Project's canvas (viewport + node positions/metadata)
// to a `.rachna_design` JSON manifest on disk, and loads it back. The
// manifest is written *inside* the project folder as a fixed filename
// (design.rachna_design) rather than at a user-chosen path, so opening a
// Design Project is a single step: pick the .rachna_design file, and its
// parent directory *is* the project root — no separate "where are the
// files" question, and the project stays intact if the whole folder is
// moved or renamed together.
//
// The manifest is the primary artifact the user thinks of as "the Design
// Project" (see the flow in the task description), while the generated
// .html/.css/.js files it references remain ordinary files underneath,
// reachable through every existing file/project tool unchanged.

import { getPathInfo, pickFile, readFile, saveFile } from '../tauriFs'
import {
  DESIGN_PROJECT_FORMAT,
  DESIGN_PROJECT_FILE_EXT,
  DESIGN_PROJECT_MANIFEST_NAME,
  type DesignProjectManifest,
} from './types'

function pathSeparatorFor(path: string): '\\' | '/' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

export function manifestPathFor(projectRoot: string): string {
  const sep = pathSeparatorFor(projectRoot)
  const trimmed = projectRoot.endsWith(sep) ? projectRoot.slice(0, -1) : projectRoot
  return `${trimmed}${sep}${DESIGN_PROJECT_MANIFEST_NAME}`
}

/** Joins a project root and a project-relative path using the root's
 *  separator convention — used when transferring an in-memory node's
 *  `unsaved://relative/path` onto its real on-disk location once the
 *  underlying files have just been written to `projectRoot`. */
export function joinProjectPath(projectRoot: string, relativePath: string): string {
  const sep = pathSeparatorFor(projectRoot)
  const trimmed = projectRoot.endsWith(sep) ? projectRoot.slice(0, -1) : projectRoot
  const relNative = relativePath.replace(/\\/g, '/').replace(/\//g, sep)
  return `${trimmed}${sep}${relNative}`
}

function parseManifest(raw: string): DesignProjectManifest | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.format !== DESIGN_PROJECT_FORMAT || !parsed.canvas) return null
    return parsed as DesignProjectManifest
  } catch {
    return null
  }
}

/** Writes (or overwrites) `{projectRoot}/design.rachna_design`. Returns
 *  the absolute path written to. */
export async function saveDesignProjectManifest(
  projectRoot: string,
  manifest: DesignProjectManifest,
): Promise<string> {
  const path = manifestPathFor(projectRoot)
  const result = await saveFile({ path, content: JSON.stringify(manifest, null, 2) })
  return result.path
}

/** Reads `{projectRoot}/design.rachna_design` if present. Returns null
 *  (never throws) if the project hasn't been saved as a Design Project
 *  yet — e.g. an ordinary code project, or a design project saved before
 *  this feature existed. */
export async function loadDesignProjectManifestFromRoot(
  projectRoot: string,
): Promise<DesignProjectManifest | null> {
  try {
    const path = manifestPathFor(projectRoot)
    const info = await getPathInfo(path)
    if (!info.exists || !info.is_file) return null
    const { content } = await readFile(path)
    return parseManifest(content)
  } catch {
    return null
  }
}

export interface PickedDesignProjectFile {
  manifest: DesignProjectManifest
  /** The folder the manifest lives in — always treated as the project root. */
  projectRoot: string
  manifestPath: string
}

/** Loads a known manifest path, used by the persisted recent-project list. */
export async function loadDesignProjectFile(path: string): Promise<PickedDesignProjectFile> {
  const { content } = await readFile(path)
  const manifest = parseManifest(content)
  if (!manifest) throw new Error('This file is not a valid Rachna Design Project.')

  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  const suffix = idx === -1 ? '' : normalized.slice(idx)
  const projectRoot = idx === -1 ? path : path.slice(0, path.length - suffix.length)
  return { manifest, projectRoot, manifestPath: path }
}

/** Opens a native "Open File" dialog filtered to `.rachna_design` files
 *  (see the `pick_file` Tauri command), reads and parses whichever file
 *  the user picks, and returns it along with its parent directory (the
 *  project root). Returns null if the user cancelled the dialog. Throws
 *  if the chosen file isn't a valid Design Project manifest. */
export async function pickAndLoadDesignProjectFile(): Promise<PickedDesignProjectFile | null> {
  const path = await pickFile({
    title: 'Open Design Project',
    filterName: 'Rachna Design Project',
    filterExtensions: [DESIGN_PROJECT_FILE_EXT],
  })
  if (!path) return null

  return loadDesignProjectFile(path)
}
