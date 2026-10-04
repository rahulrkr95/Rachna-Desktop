// components/AiChat/useRetrieval.ts
//
// Encapsulates the full retrieval pipeline:
//   FTS chunk search → symbol search → filename fallback → graph expansion
//
// Returns a function `runRetrieval(question, editorContext?)` that resolves
// with the three context blocks (repo, symbol, graph) and a RetrievalStats
// object.
//
// ── Single-source semantic search ────────────────────────────────────────────
// Semantic (vector) search is handled exclusively by the Tauri `search_repo`
// command, which runs an FTS5 + Ollama/nomic-embed-text + sqlite-vec ANN
// hybrid internally and surfaces results through `repoContextBlock` via
// `searchChunks` / `chunkSearch.ts`.
//
// The renderer-side `semanticSearchManager` (LocalEmbeddingProvider, hash-
// based 512-dim TF-IDF cosine in-process) is intentionally NOT wired into
// this hook.  Running it on every chat turn produced a second, lower-quality
// semantic context block whose hits were already covered — or superseded — by
// the Tauri ANN path, wasting token budget on inconsistent-quality duplicates.
// `semanticSearchManager.loadIndex()` is still called after each scan (see
// useRepoIndex.ts) so the on-disk index stays fresh; it is simply not used
// for per-turn retrieval here.
//
// ── Active File Policy ────────────────────────────────────────────────────────
// Editor context (current file, open tabs, recently edited) is passed to the
// retrieval ranker as METADATA ONLY — it influences ranking scores via the
// "active file boost" but does NOT inject file contents into the prompt.
// File content is only included when retrieval determines the file is relevant
// to the user's query (via the FTS/symbol/graph pipeline), respecting the
// existing token budgets and compression pipelines.

import { useRepoIndex } from '../../store/useRepoIndex'
import { useEditorStore } from '../../store/useEditorStore'
import {
  searchChunks,
  searchChunksByFile,
  searchSymbols,
  buildRepoContextBlock,
  buildSymbolContextBlock,
  detectFilePath,
  sanitizeFtsQuery,
  extractSearchTerms,
  extractFilenameHints,
  getSearchMode,
  type RetrievalStats,
} from '../../lib/chunkSearch'
import { getRelatedFilesForMany, buildRelatedFilesContextBlock } from '../../lib/graphRetrieval'

// How many hops to expand in the dependency graph after retrieval
// identifies relevant files. depth=1 → direct dependencies + dependents.
const GRAPH_RETRIEVAL_DEPTH = 1

/** Lightweight editor context metadata passed to retrieval as ranking signals.
 *  Paths should be relative to the project root, matching the values stored
 *  in the repo index (FileNode.relativePath). */
export interface EditorContextMetadata {
  /** The single file currently focused in the editor. Gets the highest boost. */
  currentFilePath?: string
  /** All file paths with open editor tabs. Get a moderate boost. */
  openFilePaths?: string[]
  /** File paths edited recently in this session. Get a small decayed boost. */
  recentlyEditedPaths?: string[]
}

export interface RetrievalResult {
  repoContextBlock: string
  symbolContextBlock: string
  graphContextBlock: string
  /** Always empty string — semantic search is handled inside the Tauri
   *  `search_repo` command (FTS5 + ANN hybrid) and surfaces through
   *  `repoContextBlock`.  Kept for interface compatibility. */
  semanticContextBlock: string
  stats: RetrievalStats
  /** Lightweight metadata about the editor state — paths only, no content. */
  editorMetadata: EditorContextMetadata
}

export function useRetrieval() {
  const graphSnapshot = useRepoIndex(s => s.graphSnapshot)
  const projectRoot   = useRepoIndex(s => s.projectRoot)
  const indexStatus   = useRepoIndex(s => s.status)

  // Read open tabs from the editor store — paths only, no content.
  // This is the only place editor context enters the retrieval pipeline.
  const tabs   = useEditorStore(s => s.tabs)

  async function runRetrieval(
    question: string,
    editorContext?: EditorContextMetadata,
  ): Promise<RetrievalResult> {
    const detectedPath    = detectFilePath(question)
    const sanitizedQuery  = sanitizeFtsQuery(question)
    const extractedTerms  = extractSearchTerms(question)

    // ── Guard: skip retrieval if no project is indexed ────────────────────
    // Without a projectRoot the SQLite chunks table has nothing scoped to
    // this session and every invoke will either throw or return stale data
    // from a previously-open project.
    // Also skip when the index is still being built — chunks may not be
    // committed yet and FTS5 will return 0 results (the user sees
    // "repository context not found" even though files are being indexed).
    if (!projectRoot || indexStatus === 'indexing') {
      const reason = !projectRoot ? 'no project root' : 'index still building'
      console.debug(`[retrieval] skipped — ${reason}`)
      const emptyStats: RetrievalStats = {
        originalQuery: question,
        sanitizedQuery,
        extractedTerms,
        chunksFound: 0,
        symbolsFound: 0,
        filesRetrieved: [],
        usedFilenameFallback: false,
        noContextFound: true,
        searchMode: undefined,
      }
      return {
        repoContextBlock: '',
        symbolContextBlock: '',
        graphContextBlock: '',
        semanticContextBlock: '',
        stats: emptyStats,
        editorMetadata: { currentFilePath: editorContext?.currentFilePath },
      }
    }

    // ── Build editor metadata from open tabs (paths only, never content) ──
    // If the caller passed explicit editorContext use it; otherwise derive
    // from the live editor store (which always has current tab state).
    const openFilePaths = tabs
      .map(t => {
        // Convert absolute tab id → relative path when projectRoot is known
        if (projectRoot && t.id.startsWith(projectRoot)) {
          return t.id.slice(projectRoot.length).replace(/^[\\/]/, '').replace(/\\/g, '/')
        }
        return t.id
      })
      .filter(Boolean)

    const editorMetadata: EditorContextMetadata = {
      currentFilePath:     editorContext?.currentFilePath,
      openFilePaths:       editorContext?.openFilePaths ?? openFilePaths,
      recentlyEditedPaths: editorContext?.recentlyEditedPaths ?? [],
    }

    console.debug(
      `[retrieval] editor metadata: currentFile=${editorMetadata.currentFilePath ?? 'none'}` +
      ` openTabs=${editorMetadata.openFilePaths?.length ?? 0}` +
      ` recentEdits=${editorMetadata.recentlyEditedPaths?.length ?? 0}` +
      ` (paths only — no content injected)`
    )

    let repoContextBlock   = ''
    let symbolContextBlock = ''
    let graphContextBlock  = ''
    // semanticContextBlock is always '' — semantic search is handled inside
    // the Tauri search_repo command (FTS5+ANN hybrid) via searchChunks().
    const semanticContextBlock = ''

    const retrievedFiles         = new Set<string>()
    let usedFileAwareRetrieval   = false
    let usedFilenameFallback     = false
    let chunksFound              = 0
    let symbolsFound             = 0
    let searchMode: 'hybrid' | 'fts5_only' | undefined = undefined

    // ── File-path aware retrieval ─────────────────────────────────────────
    if (detectedPath) {
      try {
        const fileResult = await searchChunksByFile(detectedPath, projectRoot ?? undefined)
        if (fileResult.matched_files.length > 0) {
          usedFileAwareRetrieval = true
          repoContextBlock       = buildRepoContextBlock(fileResult.chunks)
          chunksFound           += fileResult.chunks.length
          for (const f of fileResult.matched_files) retrievedFiles.add(f)
        }
        console.debug(
          `[retrieval] file-aware: detectedPath=${detectedPath}` +
          ` matched=${fileResult.matched_files.length} chunks=${fileResult.chunks.length}`
        )
      } catch (err) {
        console.warn('[retrieval] file-aware search failed:', err)
      }
    }

    // ── Symbol search ─────────────────────────────────────────────────────
    try {
      const symbolQuery = extractedTerms || sanitizedQuery
      const symbols     = symbolQuery ? await searchSymbols(symbolQuery, 5, projectRoot ?? undefined) : []
      symbolsFound      = symbols.length
      symbolContextBlock = buildSymbolContextBlock(symbols)
      for (const sym of symbols) retrievedFiles.add(sym.file_path)
      console.debug(
        `[retrieval] symbol search: query="${symbolQuery}" hits=${symbolsFound}`
      )
    } catch (err) {
      console.warn('[retrieval] symbol search failed:', err)
    }

    // ── FTS chunk search (with filename fallback) ─────────────────────────
    if (!usedFileAwareRetrieval) {
      try {
        const ftsQuery = extractedTerms || sanitizedQuery
        const chunks   = ftsQuery ? await searchChunks(ftsQuery, 5, projectRoot ?? undefined) : []
        chunksFound    = chunks.length
        if (chunks.length > 0) searchMode = getSearchMode(chunks)

        console.debug(
          `[retrieval] FTS chunk search: query="${ftsQuery}" hits=${chunksFound}`
        )

        if (chunks.length > 0) {
          repoContextBlock = buildRepoContextBlock(chunks)
          for (const c of chunks) retrievedFiles.add(c.file_path)
        } else {
          // Filename hint fallback
          const hints = extractFilenameHints(extractedTerms || sanitizedQuery)
          console.debug(`[retrieval] FTS returned 0 — filename hints: [${hints.join(', ')}]`)
          for (const hint of hints) {
            try {
              const fileResult = await searchChunksByFile(hint, projectRoot ?? undefined)
              if (fileResult.matched_files.length > 0) {
                usedFilenameFallback  = true
                repoContextBlock     += (repoContextBlock ? '\n\n' : '') + buildRepoContextBlock(fileResult.chunks)
                chunksFound          += fileResult.chunks.length
                for (const f of fileResult.matched_files) retrievedFiles.add(f)
                console.debug(
                  `[retrieval] filename fallback "${hint}": matched=${fileResult.matched_files.length}` +
                  ` chunks=${fileResult.chunks.length}`
                )
              }
            } catch (err) {
              console.warn(`[retrieval] filename fallback "${hint}" failed:`, err)
            }
          }
        }
      } catch (err) {
        console.warn('[retrieval] FTS chunk search failed:', err)
      }
    }

    // ── Graph expansion ───────────────────────────────────────────────────
    let graphFilesFound = 0
    if (retrievedFiles.size > 0 && graphSnapshot) {
      try {
        const related     = getRelatedFilesForMany([...retrievedFiles], GRAPH_RETRIEVAL_DEPTH)
        graphFilesFound   = related.dependencies.length + related.dependents.length
        graphContextBlock = buildRelatedFilesContextBlock(related)
        console.debug(
          `[retrieval] graph expansion: seed=${retrievedFiles.size}` +
          ` deps=${related.dependencies.length} dependents=${related.dependents.length}`
        )
      } catch (err) {
        console.warn('[retrieval] graph expansion failed:', err)
      }
    } else if (retrievedFiles.size === 0) {
      console.debug('[retrieval] graph expansion skipped: no seed files')
    } else {
      console.debug('[retrieval] graph expansion skipped: no graph snapshot')
    }

    const filesRetrieved = [...retrievedFiles]

    const noContextFound =
      chunksFound === 0 && symbolsFound === 0 && filesRetrieved.length === 0

    console.debug(
      `[retrieval] summary: chunks=${chunksFound} symbols=${symbolsFound}` +
      ` files=${filesRetrieved.length} graphFiles=${graphFilesFound}` +
      ` noContext=${noContextFound}`
    )

    const stats: RetrievalStats = {
      originalQuery:       question,
      sanitizedQuery,
      extractedTerms,
      chunksFound,
      symbolsFound,
      filesRetrieved:      filesRetrieved.map(f => f.replace(/\\/g, '/')),
      usedFilenameFallback,
      noContextFound,
      searchMode,
    }

    return { repoContextBlock, symbolContextBlock, graphContextBlock, semanticContextBlock, stats, editorMetadata }
  }

  return { runRetrieval }
}


