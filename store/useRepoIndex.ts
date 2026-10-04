// store/useRepoIndex.ts
//
// Zustand store that manages the lifecycle of repo indexing.
//
// Trigger points:
//   1. indexFolder(root)  — called when the user opens a folder
//   2. refreshGraph()     — called before every AI chat send
//   3. reindexFile(path)  — called on Ctrl+S; re-scans only when the saved
//                           file lives inside projectRoot and is a TS/JS file
//   4. forceReindex()     — called after accepting/reverting edits; always
//                           triggers a full re-scan regardless of file type.
//
// Architecture (why it works this way):
//   The repo-scanner module uses Node.js APIs (fs, path, ts-morph) that
//   are unavailable in the Vite/browser renderer bundle. Calling it directly
//   from the renderer crashes silently, producing the "index error / AI
//   context limited" state.
//
//   Fix: the scanning runs as a Rust subprocess via invoke('scan_repo').
//   The Tauri backend shells out to `node dist/run.js <root> --json` and
//   returns the raw ScanResult JSON. The DependencyGraphEngine (pure TS,
//   no Node deps) then builds the in-memory graph from that JSON inside
//   the renderer — keeping all Node.js code off the browser bundle.

import { create }  from 'zustand'
import { invoke }  from '@tauri-apps/api/core'
import { dependencyGraphEngine } from '../lib/repo-scanner/src/dependencyGraph/graphEngine'
import type { ScanResult }       from '../lib/repo-scanner/src/repoScanner/types'
import type { GraphStats, CycleRecord } from '../lib/repo-scanner/src/dependencyGraph/types'
import { semanticSearchManager } from '../lib/semanticSearch'
import { useApiKeyStore } from './useApiKeyStore'
import { getUseGeminiEmbeddings } from '../components/SettingsModal'
import { defaultRegistry } from '../lib/repo-scanner/src/repoScanner/languageAdapters'

// ── Status ────────────────────────────────────────────────────────────────

export type IndexStatus =
  | 'idle'       // no folder opened yet
  | 'indexing'   // first full scan in progress
  | 'refreshing' // incremental refresh in progress
  | 'ready'      // graph is up to date
  | 'error'      // last operation failed

// ── Graph snapshot (serialisable, safe to put in prompt) ─────────────────

export interface GraphSnapshot {
  nodes:  string[]
  edges:  Array<{ from: string; to: string; specifier: string }>
  cycles: CycleRecord[]
  stats:  GraphStats
}

// ── State shape ───────────────────────────────────────────────────────────

interface RepoIndexState {
  projectRoot:    string | null
  scanResult:     ScanResult | null
  graphSnapshot:  GraphSnapshot | null
  status:         IndexStatus
  error:          string | null
  lastIndexedAt:  string | null
  /** Number of per-file parse errors from the last scan (ts-morph failures) */
  parseErrorCount: number

  indexFolder:   (root: string) => Promise<void>
  /**
   * Sets projectRoot WITHOUT running a scan. Used by the "Build New Project"
   * flow: the folder is brand new and empty at this point (the AI hasn't
   * proposed any files yet), so a scan would do nothing useful. Status stays
   * 'idle'. The first real index happens automatically via forceReindex()
   * once the user accepts the AI-proposed files (see EditStore.acceptAll /
   * acceptBatch), which is the point at which files actually land on disk.
   */
  setProjectRootOnly: (root: string) => void
  /**
   * Closes the currently open project — resets projectRoot and all
   * scan/index state back to the pre-open baseline ('idle', no scan
   * result, no graph). Does NOT touch open editor tabs, panel layout, or
   * app mode — callers (IDELayout) own that orchestration so the "Close
   * Project" action can also clear tabs and flip back to welcome mode.
   */
  closeProject:  () => void
  refreshGraph:  () => Promise<void>
  /**
   * Called after a file is saved (Ctrl+S).
   * Triggers a full refreshGraph only when:
   *   - a folder is open (projectRoot is set)
   *   - the saved file is inside the project root
   *   - the file has a TS/JS extension (scanner only cares about these)
   * No-ops silently otherwise so saves on unrelated files cost nothing.
   */
  reindexFile:   (savedFilePath: string) => Promise<void>
  /**
   * Like reindexFile but WITHOUT the file-type guard — always triggers a
   * full re-scan.  Used after accepting or reverting AI edits to guarantee
   * the SQLite chunks and dependency graph are fresh for subsequent chat
   * queries, regardless of the changed file's extension.
   */
  forceReindex:  () => Promise<void>
  /**
   * Called by the Tauri file-watcher event handler with a batch of changed
   * absolute paths.  Re-scans ONLY those files (via scan_repo_files) and
   * patches the in-memory ScanResult + graph incrementally — no full
   * project re-scan.  Falls back to refreshGraph() if scan_repo_files is
   * unavailable or returns an error.
   */
  reindexChangedFiles: (changedPaths: string[]) => Promise<void>
}

// ── Embedding provider selection ─────────────────────────────────────────
//
// Repo indexing defaults to Gemini's text-embedding-004 model for higher
// quality semantic search (see hybridRetrieval.ts's defaultEmbeddingProvider
// resolver). Returns undefined when the user has switched the "Use Gemini
// embeddings for repo search" setting off, or when no Gemini key is
// configured — callers should treat undefined as "use the built-in
// LocalEmbeddingProvider fallback".

function resolveGeminiEmbeddingApiKey(): string | undefined {
  if (!getUseGeminiEmbeddings()) return undefined
  return useApiKeyStore.getState().getActiveKey('gemini')?.value || undefined
}

// ── Internal: run scan via Tauri backend, build graph in renderer ─────────

async function runScanAndBuildGraph(root: string): Promise<{
  scan:     ScanResult
  snapshot: GraphSnapshot
}> {
  // 0. Resolve which embedding provider repo indexing should use. When a
  //    Gemini API key is available (and the user hasn't opted out via
  //    Settings), it's forwarded to the scanner subprocess so it can build
  //    the vector index with GeminiEmbeddingProvider instead of the local
  //    TF-IDF fallback. Forwarding this extra arg is harmless until the
  //    Tauri `scan_repo` command itself is updated to consume it.
  const embeddingApiKey = resolveGeminiEmbeddingApiKey()

  // 1. Tauri backend runs `node dist/run.js <root> --json` and returns JSON
  const json = await invoke<string>('scan_repo', { root, embeddingApiKey })
  const scan: ScanResult = JSON.parse(json)

  // 2. Build/replace the in-memory dependency graph (pure TS, browser-safe)
  dependencyGraphEngine.buildFromScan(scan)

  const cycles   = dependencyGraphEngine.detectCycles()
  const snapshot: GraphSnapshot = {
    ...dependencyGraphEngine.toJSON(),
    cycles,
    stats: dependencyGraphEngine.getStats(),
  }

  // 3. Load the vector index built by the scanner subprocess (non-blocking)
  semanticSearchManager.clear()
  semanticSearchManager.loadIndex(root).catch(err => {
    console.debug('[semantic] background index load failed (non-fatal):', err)
  })

  return { scan, snapshot }
}

function isScannerFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const filename = normalized.split('/').pop()?.toLowerCase() ?? ''
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) {
    return true
  }
  const ext = filename.split('.').pop() ?? ''
  return defaultRegistry.allExtensions().has(ext)
}

// ── Ollama embedding pipeline (sqlite-vec semantic search) — REMOVED ──────
//
// This used to trigger a SECOND full `scan_repo` (with `embed`/`ollamaUrl`
// args) on every indexFolder() AND every refreshGraph() call — and
// refreshGraph() runs before every AI chat send. But the Rust `scan_repo`
// command signature only ever accepted `root: String`; Tauri silently
// dropped the extra `embed`/`ollamaUrl` fields, so this was a full
// duplicate ts-morph re-parse of the entire project that never actually
// produced any embeddings (chunk.embedding always came back empty, so the
// store_embedding calls below were skipped every time). Pure wasted time.
//
// Removed rather than "fixed in place" because making it actually work
// requires backend changes first: (1) `scan_repo` needs to accept and
// forward `embed`/`ollama_url` to the Node subprocess, and (2) embeddings
// should be written in one batched SQLite transaction instead of one
// `invoke('store_embedding', ...)` round-trip per chunk. Re-add this pass
// (via Settings → "Re-embed" / `reembed_repo`, which already exists and is
// user-triggered rather than running on every scan) once that's in place.
//
// If Ollama embeddings + hybrid semantic search matter to you day-to-day,
// say so and I'll wire up the backend half properly rather than leaving it
// removed.

// ── Store ─────────────────────────────────────────────────────────────────

export const useRepoIndex = create<RepoIndexState>((set, get) => ({
  projectRoot:     null,
  scanResult:      null,
  graphSnapshot:   null,
  status:          'idle',
  error:           null,
  lastIndexedAt:   null,
  parseErrorCount: 0,

  // ── indexFolder ──────────────────────────────────────────────────────────
  indexFolder: async (root: string) => {
    set({ status: 'indexing', error: null, projectRoot: root, parseErrorCount: 0 })
    try {
      const { scan, snapshot } = await runScanAndBuildGraph(root)
      // Use the canonical projectRoot from the scan result (the Rust side
      // calls canonicalize() on the path, resolving symlinks and normalising
      // separators).  Chunks in SQLite are stored under this canonical path,
      // so every subsequent search_repo call must use the same value or the
      // file_path LIKE filter will match nothing → "No repo context found".
      const canonicalRoot = scan.projectRoot || root
      set({
        status:          'ready',
        projectRoot:     canonicalRoot,
        scanResult:      scan,
        graphSnapshot:   snapshot,
        lastIndexedAt:   new Date().toISOString(),
        parseErrorCount: Object.keys(scan.errors ?? {}).length,
      })
    } catch (err) {
      set({
        status: 'error',
        error:  err instanceof Error ? err.message : String(err),
      })
    }
  },

  // ── setProjectRootOnly ───────────────────────────────────────────────────
  setProjectRootOnly: (root: string) => {
    set({
      projectRoot:     root,
      status:          'idle',
      error:           null,
      scanResult:      null,
      graphSnapshot:   null,
      lastIndexedAt:   null,
      parseErrorCount: 0,
    })
  },

  // ── closeProject ─────────────────────────────────────────────────────────
  closeProject: () => {
    semanticSearchManager.clear()
    set({
      projectRoot:     null,
      scanResult:      null,
      graphSnapshot:   null,
      status:          'idle',
      error:           null,
      lastIndexedAt:   null,
      parseErrorCount: 0,
    })
  },

  // ── refreshGraph ─────────────────────────────────────────────────────────
  refreshGraph: async () => {
    const { scanResult, projectRoot } = get()

    // No previous scan — do a full index if we have a root
    if (!scanResult) {
      if (projectRoot) await get().indexFolder(projectRoot)
      return
    }

    set({ status: 'refreshing', error: null })
    try {
      const { scan, snapshot } = await runScanAndBuildGraph(scanResult.projectRoot)
      const canonicalRoot = scan.projectRoot || scanResult.projectRoot
      set({
        status:          'ready',
        projectRoot:     canonicalRoot,
        scanResult:      scan,
        graphSnapshot:   snapshot,
        lastIndexedAt:   new Date().toISOString(),
        parseErrorCount: Object.keys(scan.errors ?? {}).length,
      })
    } catch (err) {
      // Don't block the AI chat on a refresh failure — keep old snapshot
      set({
        status: 'error',
        error:  err instanceof Error ? err.message : String(err),
      })
    }
  },

  // ── reindexFile ──────────────────────────────────────────────────────────
  reindexFile: async (savedFilePath: string) => {
    const { projectRoot, status } = get()

    // Nothing to do: no folder open, or already scanning
    if (!projectRoot || status === 'indexing') return

    // Only re-scan for files the scanner actually processes
    if (!isScannerFile(savedFilePath)) return

    // Only re-scan for files inside the open project
    const normalised = savedFilePath.replace(/\\\\/g, '/')
    const normRoot   = projectRoot.replace(/\\\\/g, '/')
    if (!normalised.startsWith(normRoot)) return

    // Reuse refreshGraph — it always re-scans from projectRoot
    await get().refreshGraph()
  },

  // ── forceReindex ─────────────────────────────────────────────────────────
  forceReindex: async () => {
    const { projectRoot, status } = get()
    if (!projectRoot || status === 'indexing') return
    // Bypass the isScannerFile guard — always refresh
    await get().refreshGraph()
  },

  // ── reindexChangedFiles ───────────────────────────────────────────────────
  //
  // Fast incremental chunk refresh triggered by the file watcher.
  //
  // Fast path — `fast_reindex_files` (pure Rust, no Node.js subprocess):
  //   1. Queries existing chunk rows from SQLite by file_path for each
  //      changed file.
  //   2. Re-chunks each file using stored symbol ranges from the `symbols`
  //      table (symbol-aware, single-file — no ts-morph Project rebuild).
  //   3. Diffs new chunks against stored chunks via FNV content hashes —
  //      unchanged chunks are skipped entirely.
  //   4. Deletes stale rows and inserts only new/modified chunks in a
  //      single SQLite transaction.
  //
  // The in-memory ScanResult and dependency graph are NOT rebuilt on this
  // path — the existing snapshot stays valid (imports/exports rarely change
  // on a function-body save) and will be refreshed by the next
  // refreshGraph() call before the AI chat send.
  //
  // Fallback chain (on fast path error):
  //   scan_repo_files (Node.js + ts-morph, partial ScanResult + graph merge)
  //   → refreshGraph() (full project re-scan)
  reindexChangedFiles: async (changedPaths: string[]) => {
    const { projectRoot, scanResult, status } = get()

    // Guard: nothing to do when no project is open or a full scan is running.
    if (!projectRoot || status === 'indexing') return

    // Filter to scanner-relevant files inside the project root.
    const normRoot = projectRoot.replace(/\\/g, '/')
    const relevant = changedPaths.filter(p => {
      const norm = p.replace(/\\/g, '/')
      return norm.startsWith(normRoot) && isScannerFile(p)
    })
    if (relevant.length === 0) return

    set({ status: 'refreshing', error: null })

    try {
      // ── Fast path: pure-Rust hash-diff chunk update ─────────────────────
      // No Node.js startup, no ts-morph Project rebuild.
      // Symbols come from the existing SQLite `symbols` table for this file.
      const stats = await invoke<{ updated: number; skipped: number; deleted: number }>(
        'fast_reindex_files',
        { files: relevant, root: projectRoot },
      )
      console.debug(
        `[reindexChangedFiles] fast: ${stats.updated} updated, ` +
        `${stats.skipped} skipped, ${stats.deleted} stale deleted`,
      )

      // SQLite chunks are up-to-date. Keep the existing in-memory ScanResult
      // and graph — they stay accurate for the common save-inside-function-body
      // case. refreshGraph() (called before every AI send) will catch any
      // import/export changes that the fast path cannot see.
      set({ status: 'ready', lastIndexedAt: new Date().toISOString(), error: null })
    } catch (fastErr) {
      // ── Fallback 1: scan_repo_files (Node.js, partial ScanResult) ───────
      // Triggers when fast_reindex_files errors (e.g. DB locked, disk read
      // failure). Spawns Node.js + ts-morph scoped to just the changed files.
      console.warn('[reindexChangedFiles] fast path failed, falling back to scan_repo_files:', fastErr)

      try {
        const json = await invoke<string>('scan_repo_files', {
          root: projectRoot,
          files: relevant,
        })
        const partialScan: ScanResult = JSON.parse(json)

        const base = scanResult ?? {
          projectRoot,
          scannedAt:  new Date().toISOString(),
          totalFiles: 0,
          totalLines: 0,
          files:      [],
          errors:     {},
        }

        const newByPath = new Map(partialScan.files.map(f => [f.path, f]))
        const merged = base.files
          .map(f => newByPath.get(f.path) ?? f)
          .concat(partialScan.files.filter(f => !base.files.some(b => b.path === f.path)))

        const updatedScan: ScanResult = {
          ...base,
          scannedAt:  new Date().toISOString(),
          totalFiles: merged.length,
          totalLines: merged.reduce((s, f) => s + f.metadata.lineCount, 0),
          files:      merged,
          errors:     { ...base.errors, ...partialScan.errors },
        }

        dependencyGraphEngine.buildFromScan(updatedScan)
        const cycles   = dependencyGraphEngine.detectCycles()
        const snapshot: GraphSnapshot = {
          ...dependencyGraphEngine.toJSON(),
          cycles,
          stats: dependencyGraphEngine.getStats(),
        }

        set({
          status:          'ready',
          projectRoot:     updatedScan.projectRoot || projectRoot,
          scanResult:      updatedScan,
          graphSnapshot:   snapshot,
          lastIndexedAt:   new Date().toISOString(),
          parseErrorCount: Object.keys(updatedScan.errors ?? {}).length,
        })
      } catch (err) {
        // ── Fallback 2: full project re-scan ────────────────────────────
        console.warn('[reindexChangedFiles] scan_repo_files failed, falling back to full refresh:', err)
        await get().refreshGraph()
      }
    }
  },
}))

// ── Selectors ─────────────────────────────────────────────────────────────

export const selectIsIndexing = (s: RepoIndexState) =>
  s.status === 'indexing' || s.status === 'refreshing'

export const selectGraphReady = (s: RepoIndexState) =>
  s.status === 'ready' && s.graphSnapshot !== null
