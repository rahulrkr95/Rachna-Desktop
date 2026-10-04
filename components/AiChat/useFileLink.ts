// components/AiChat/useFileLink.ts
//
// Resolves a file path mentioned in an AI message to an absolute path,
// validates it exists inside the current workspace, then opens it in
// Monaco via the existing openTab workflow.
//
// Resolution order for a relative path like "components/AiChat/useChat.ts":
//   1. projectRoot/path          (workspace-relative — most common)
//   2. path itself               (already absolute — less common)
//
// After opening the tab, if a line number was provided the hook will
// wait one tick for Monaco to activate the file, then navigate to
// the line and focus the editor.

import { useCallback, useState, useEffect, useRef } from 'react'
import { getPathInfo, readFile } from '../../lib/tauriFs'
import { useEditorStore }        from '../../store/useEditorStore'
import { useRepoIndex }          from '../../store/useRepoIndex'
import { globalEditorRef }       from '../MonacoEditor'

// ── Types ─────────────────────────────────────────────────────────────────────

export type FileLinkStatus = 'unknown' | 'exists' | 'missing'

// ── Path resolution helpers ────────────────────────────────────────────────────

/**
 * Given a raw path token from the AI message and the current project root,
 * return the first absolute path that exists on disk, or null.
 */
async function resolvePath(
  raw: string,
  projectRoot: string | null,
): Promise<string | null> {
  const candidates: string[] = []

  // 1. Workspace-relative (most common case)
  if (projectRoot) {
    const sep = projectRoot.endsWith('/') ? '' : '/'
    candidates.push(`${projectRoot}${sep}${raw}`)
  }

  // 2. Treat as-is (already absolute)
  candidates.push(raw)

  for (const candidate of candidates) {
    try {
      const info = await getPathInfo(candidate)
      if (info.exists && info.is_file) return candidate
    } catch {
      // path_info returns an error for bad paths on some platforms — skip
    }
  }

  return null
}

// ── useOpenFileLink ────────────────────────────────────────────────────────────

/**
 * Returns a stable callback that opens `rawPath` (optionally at `line`) in Monaco.
 * Only opens the file if it exists in the workspace — otherwise no-ops.
 */
export function useOpenFileLink() {
  const openTab     = useEditorStore(s => s.openTab)
  const projectRoot = useRepoIndex(s => s.projectRoot)

  return useCallback(
    async (rawPath: string, line?: number) => {
      const absPath = await resolvePath(rawPath, projectRoot)
      if (!absPath) return // file not found in workspace — silently ignore

      let result
      try {
        result = await readFile(absPath)
      } catch {
        return
      }

      const name = absPath.replace(/\\/g, '/').split('/').pop() ?? rawPath
      const ext  = name.split('.').pop() ?? 'txt'

      openTab({
        id:       absPath,
        name,
        lang:     ext,
        content:  result.kind === 'text' ? result.content : '',
        modified: false,
        kind:     result.kind,
        mime:     result.mime,
        size:     result.size,
        mtime:    result.modified,
      })

      // Navigate to line after the tab becomes active in Monaco.
      // We yield briefly so the Zustand store update flushes and Monaco
      // has a chance to load the new model before we call revealLine.
      if (line && line > 0) {
        setTimeout(() => {
          const editor = globalEditorRef.current
          if (!editor) return
          editor.revealLineInCenter(line)
          editor.setPosition({ lineNumber: line, column: 1 })
          editor.focus()
        }, 80)
      } else {
        setTimeout(() => {
          globalEditorRef.current?.focus()
        }, 80)
      }
    },
    [openTab, projectRoot],
  )
}

// ── useFileLinkStatus ──────────────────────────────────────────────────────────

/**
 * Asynchronously checks whether `rawPath` resolves to a real file in the
 * workspace. Returns 'unknown' initially, then 'exists' or 'missing'.
 *
 * Keyed on projectRoot + rawPath so it re-checks when the project changes.
 * Uses a ref to avoid re-running the effect when the cacheKey hasn't changed
 * (prevents redundant Tauri IPC calls during re-renders).
 */
export function useFileLinkStatus(rawPath: string): FileLinkStatus {
  const [status, setStatus] = useState<FileLinkStatus>('unknown')
  const projectRoot          = useRepoIndex(s => s.projectRoot)
  const lastCheckedRef       = useRef<string>('')

  const cacheKey = `${projectRoot ?? ''}::${rawPath}`

  useEffect(() => {
    if (lastCheckedRef.current === cacheKey) return
    lastCheckedRef.current = cacheKey

    let cancelled = false
    resolvePath(rawPath, projectRoot).then(result => {
      if (!cancelled) setStatus(result ? 'exists' : 'missing')
    })
    return () => { cancelled = true }
  }, [cacheKey, rawPath, projectRoot])

  return status
}
