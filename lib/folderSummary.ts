// lib/folderSummary.ts
//
// Builds a compact, indented text listing of a folder tree — used to give
// the model visibility into an *additional* (non-primary, unindexed)
// folder added to the File Explorer (see store/useAdditionalFoldersStore.ts).
// The primary project gets full retrieval/indexing; additional folders
// just get this lightweight directory listing so the model knows what's
// there and can call read_file/list_directory with absolute paths to dig
// in further, same as it would for the primary project.

import type { FolderEntry } from './tauriFs'

const DEFAULT_MAX_ENTRIES = 300
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '.next', '.venv',
  '__pycache__', '.cache', 'out',
])

/**
 * Renders `root` as an indented text tree, e.g.:
 *   backend-service/
 *     src/
 *       index.ts
 *       routes/
 *         users.ts
 *     package.json
 * Truncates once `maxEntries` lines have been emitted, appending a
 * "…N more entries" note so the block stays budget-friendly for large
 * repos while still being genuinely useful for orientation.
 */
export function buildFolderTreeText(root: FolderEntry, maxEntries = DEFAULT_MAX_ENTRIES): string {
  const lines: string[] = []
  let omitted = 0

  function walk(node: FolderEntry, depth: number) {
    if (lines.length >= maxEntries) {
      omitted++
      return
    }
    const indent = '  '.repeat(depth)
    lines.push(`${indent}${node.name}${node.is_dir ? '/' : ''}`)

    if (node.is_dir) {
      if (SKIP_DIR_NAMES.has(node.name)) return
      for (const child of node.children) {
        walk(child, depth + 1)
      }
    }
  }

  walk(root, 0)

  if (omitted > 0) {
    lines.push(`… ${omitted} more entr${omitted === 1 ? 'y' : 'ies'} not shown`)
  }

  return lines.join('\n')
}
