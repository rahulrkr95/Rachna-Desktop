// services/agent/pathUtils.ts
//
// Small shared helpers for resolving paths passed by the model into
// absolute filesystem paths, scoped to the open project root.
//
// Kept intentionally simple (string-based) — the renderer has no Node `path`
// module. Handles both POSIX and Windows-style separators since the
// workspace root may be a Windows path (see useRepoIndex / win_make_absolute
// in the Rust backend).

import { getDefaultCwd } from '../../lib/defaultCwd'

export interface ResolvedPath {
  ok: true
  path: string
}

export interface UnresolvedPath {
  ok: false
  error: string
}

export type PathResolution = ResolvedPath | UnresolvedPath

function isAbsolute(p: string): boolean {
  // POSIX absolute, or Windows drive-letter / UNC absolute
  return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p)
}

function detectSeparator(root: string): '/' | '\\' {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/'
}

/**
 * Resolves a model-supplied path (absolute or relative) against the
 * project root. Returns an error result instead of throwing if no project
 * is open and the path is relative.
 *
 * Normalizes mixed separators to the root's separator style so paths work
 * consistently on Windows backends.
 */
export function resolveWorkspacePath(
  inputPath: string,
  projectRoot: string | null
): PathResolution {
  const trimmed = inputPath.trim()

  if (!trimmed) {
    return { ok: false, error: 'Path must not be empty.' }
  }

  if (isAbsolute(trimmed)) {
    return { ok: true, path: trimmed }
  }

  if (!projectRoot) {
    return {
      ok: false,
      error: `Cannot resolve relative path "${trimmed}" — no project folder is open.`,
    }
  }

  const sep = detectSeparator(projectRoot)
  const normalizedRelative = trimmed.replace(/[\\/]+/g, sep).replace(/^[\\/]+/, '')
  const normalizedRoot = projectRoot.endsWith(sep) ? projectRoot.slice(0, -1) : projectRoot

  return { ok: true, path: `${normalizedRoot}${sep}${normalizedRelative}` }
}

/**
 * Resolves a model-supplied path for DESKTOP_TASK filesystem operations
 * (create_file / open_file when invoked outside a project context), which
 * routinely need to reach arbitrary OS locations — the user's Desktop,
 * Documents, Downloads, etc. — rather than anything inside a project.
 *
 * Resolution order:
 *   1. Absolute paths (drive-letter, UNC, or POSIX-rooted) are used as-is.
 *   2. If a project happens to be open, relative paths still resolve
 *      against the project root (same behavior as resolveWorkspacePath) —
 *      a project being open always takes precedence.
 *   3. Otherwise (no project open), relative paths — e.g.
 *      "Desktop\\RachnaSystemTest\\test.txt" — resolve against the OS home
 *      directory instead of failing, since "Desktop"/"Documents"/etc. are
 *      just subfolders of home. This mirrors the fallback terminalTool.ts
 *      already uses for `run_terminal_command`'s cwd (see lib/defaultCwd.ts).
 *
 * Unlike resolveWorkspacePath, this never returns an error for a relative
 * path with no project open — DESKTOP_TASK file operations are documented as
 * working without a project, so there's always a home-directory fallback.
 */
export async function resolveSystemPath(
  inputPath: string,
  projectRoot: string | null
): Promise<PathResolution> {
  const trimmed = inputPath.trim()

  if (!trimmed) {
    return { ok: false, error: 'Path must not be empty.' }
  }

  if (isAbsolute(trimmed)) {
    return { ok: true, path: trimmed }
  }

  if (projectRoot) {
    return resolveWorkspacePath(trimmed, projectRoot)
  }

  const home = await getDefaultCwd()
  const sep = detectSeparator(home)
  const normalizedRelative = trimmed.replace(/[\\/]+/g, sep).replace(/^[\\/]+/, '')
  const normalizedHome = home.endsWith(sep) ? home.slice(0, -1) : home

  return { ok: true, path: `${normalizedHome}${sep}${normalizedRelative}` }
}
