// lib/designCanvasFiles.ts
//
// Walks the FolderEntry tree returned by readFolder() (lib/tauriFs.ts) and
// collects every .html/.htm page for the Design Canvas
// (components/viewers/DesignCanvasView.tsx) to lay out as view-only
// frames. Deliberately ignores everything the Design specialist never
// writes into (node_modules, dist/build output, hidden dot-folders) so a
// stray vendored HTML file doesn't clutter the board.

import type { FolderEntry } from './tauriFs'

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'out'])

export interface DesignPageEntry {
  path: string
  name: string
}

function isHtmlFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

/**
 * Recursively collects .html/.htm files from a folder tree, depth-first,
 * in the order the file system returned them (readFolder already sorts
 * dirs-then-files alphabetically on the Rust side).
 */
export function collectDesignPages(root: FolderEntry): DesignPageEntry[] {
  const pages: DesignPageEntry[] = []

  function walk(entry: FolderEntry) {
    if (entry.is_dir) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) return
      for (const child of entry.children) walk(child)
      return
    }
    if (isHtmlFile(entry.name)) {
      pages.push({ path: entry.path, name: entry.name })
    }
  }

  walk(root)
  return pages
}
