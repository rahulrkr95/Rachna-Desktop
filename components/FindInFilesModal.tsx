// components/FindInFilesModal.tsx
//
// Lightweight "Find in Files" dialog wired to the existing search_repo
// FTS5 index (the same backend used for AI retrieval — see lib/chunkSearch.ts).
// Reuses the already-indexed chunk DB rather than re-implementing a fresh
// recursive grep, so results appear instantly for any indexed project.

import { useState, useCallback, useEffect, useRef } from 'react'
import styles from './FindInFilesModal.module.css'
import { searchChunks, type ChunkSearchResult } from '../lib/chunkSearch'

interface Props {
  open: boolean
  onClose: () => void
  hasProject: boolean
  /** Absolute path of the currently open project. Required to scope the
   *  search to the right per-project SQLite DB (see searchChunks below) —
   *  without it the backend hashes an empty string into a project dir that
   *  was never `init()`-ed, and the query fails with "no such table:
   *  chunks_fts" even though the real project index exists and is ready. */
  projectRoot: string | null
  onResultSelect: (filePath: string, line: number) => void
}

export default function FindInFilesModal({ open, onClose, hasProject, projectRoot, onResultSelect }: Props) {
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<ChunkSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<number | null>(null)

  // Focus the input and reset state whenever the modal opens
  useEffect(() => {
    if (!open) return
    setQuery('')
    setResults([])
    setError(null)
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); setError(null); return }
    setLoading(true)
    setError(null)
    try {
      const r = await searchChunks(q, 50, projectRoot ?? undefined)
      setResults(r)
    } catch (e) {
      setError(String(e))
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [projectRoot])

  // Debounced search-as-you-type
  const handleQueryChange = (value: string) => {
    setQuery(value)
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => runSearch(value), 250)
  }

  if (!open) return null

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.modal} onMouseDown={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>🔎 Find in Files</span>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.searchBar}>
          <input
            ref={inputRef}
            className={styles.input}
            placeholder={hasProject ? 'Search across the indexed project…' : 'Open a folder to search across files'}
            value={query}
            disabled={!hasProject}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runSearch(query) }}
          />
          {loading && <span className={styles.spinner} aria-hidden />}
        </div>

        <div className={styles.body}>
          {!hasProject && (
            <div className={styles.empty}>Open a project folder first — Find in Files searches the repo index.</div>
          )}
          {hasProject && error && (
            <div className={styles.empty}>Search failed: {error}</div>
          )}
          {hasProject && !error && !loading && query.trim() && results.length === 0 && (
            <div className={styles.empty}>No matches for &ldquo;{query}&rdquo;.</div>
          )}
          {hasProject && !query.trim() && (
            <div className={styles.empty}>Type to search file contents across the indexed project.</div>
          )}

          {results.map(r => {
            const shortPath = r.file_path.replace(/\\/g, '/')
            const fileName  = shortPath.split('/').pop() ?? shortPath
            const snippet   = r.content.split('\n').slice(0, 3).join('\n')
            return (
              <button
                key={r.id}
                className={styles.resultRow}
                onClick={() => { onResultSelect(r.file_path, r.start_line); onClose() }}
              >
                <div className={styles.resultHeader}>
                  <span className={styles.resultFile}>{fileName}</span>
                  <span className={styles.resultPath}>{shortPath}</span>
                  <span className={styles.resultLine}>:{r.start_line}</span>
                </div>
                <pre className={styles.resultSnippet}>{snippet}</pre>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
