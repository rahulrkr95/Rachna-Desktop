// lib/repoScanner/semanticRetrieval.ts
//
// Semantic (embedding-based) retrieval for the repo scanner.
//
// This module is the bridge between:
//   • The scanner's FileNode / SymbolRecord data
//   • The EmbeddingProvider that converts text → dense vectors
//   • The VectorIndex that stores and searches those vectors
//
// ── Entry creation strategy ───────────────────────────────────────────────
//
// We create one vector entry per *symbol* (function, class, component …).
// For files with no parseable symbols we fall back to creating one entry
// per 100-line window (matching the SQLite chunk boundaries).
//
// Symbol-level granularity is preferable because:
//   - Symbol names appear in the embedding text, strongly anchoring the
//     vector to the semantic concept the symbol represents.
//   - Cosine similarity between "implement login flow" and a chunk that
//     begins with "function handleLogin" is much higher than a 100-line
//     window that starts 50 lines before handleLogin.
//
// ── Incremental indexing ───────────────────────────────────────────────────
//
// buildVectorIndex()   — full build from a RepoIndex (first run)
// updateVectorIndex()  — partial update: re-embeds only files whose
//                        lastModified timestamp has changed since the
//                        last vector-index save.
//
// Both functions return the updated VectorIndex which the caller should
// save to disk via index.save(directory).

import * as fs from 'fs'

import type { FileNode, SymbolRecord, RepoIndex } from './types'
import { VectorIndex, type VectorEntry } from './vectorIndex'
import {
  defaultEmbeddingProvider,
  buildEmbeddingText,
  type EmbeddingProvider,
  type ChunkEmbeddingInput,
} from './embeddingProvider'
import { pLimit } from './utils'

// ── Constants ──────────────────────────────────────────────────────────────

/** Max lines per fallback window (for files with no extractable symbols). */
const FALLBACK_CHUNK_SIZE = 100
const FALLBACK_CHUNK_STEP = 80   // 20-line overlap

/** Max content length fed to the embedder per chunk (chars). */
const MAX_CONTENT_CHARS = 2048

/** Concurrency for embedding batch calls. */
const DEFAULT_EMBED_CONCURRENCY = 8

// ── Public API ─────────────────────────────────────────────────────────────

export interface BuildVectorIndexOptions {
  provider?:    EmbeddingProvider
  concurrency?: number
  /** Callback fired after each file is embedded (for progress reporting). */
  onProgress?:  (done: number, total: number) => void
  /**
   * Raw file content keyed by absolute path, e.g. from
   * `RepoScanner.scanWithContent()`. When a file's content is present here,
   * it's reused instead of a fresh `fs.readFileSync()` — this is normally
   * the last stage in the indexing pipeline to need a file's raw content,
   * so each entry is deleted from the cache immediately after use to free
   * memory as soon as that file is fully processed. Falls back to reading
   * from disk for any file not present in the cache.
   */
  contentCache?: Map<string, string>
}

/**
 * Full vector-index build from a RepoIndex.
 *
 * Embeds every file's symbols (or line-window chunks for symbol-less files)
 * and returns a populated VectorIndex ready to save.
 *
 * Use this on first run; for subsequent scans prefer `updateVectorIndex()`.
 */
export async function buildVectorIndex(
  repoIndex: RepoIndex,
  options:   BuildVectorIndexOptions = {},
): Promise<VectorIndex> {
  const idx = VectorIndex.empty()
  await embedFiles(repoIndex.files, idx, options)
  return idx
}

/**
 * Incremental vector-index update.
 *
 * Loads `existingIndex`, then re-embeds only files whose on-disk
 * lastModified timestamp differs from what was recorded in the index.
 * Unchanged files are kept as-is; deleted files are pruned.
 *
 * Returns the updated VectorIndex (mutated in place, also returned for
 * convenience).
 */
export async function updateVectorIndex(
  repoIndex:     RepoIndex,
  existingIndex: VectorIndex,
  options:       BuildVectorIndexOptions = {},
): Promise<VectorIndex> {
  const { provider = defaultEmbeddingProvider, concurrency = DEFAULT_EMBED_CONCURRENCY, onProgress, contentCache } = options

  // Determine which files actually changed
  const filesToEmbed: FileNode[] = []
  const currentPaths = new Set(repoIndex.files.map(f => f.relativePath))

  // Prune entries for files no longer in the scan
  for (const file of repoIndex.files) {
    const storedMtime = existingIndex.getFileLastModified(file.relativePath)
    if (storedMtime !== file.metadata.lastModified) {
      existingIndex.deleteFile(file.relativePath)
      filesToEmbed.push(file)
    }
  }

  // Remove entries for files that disappeared entirely
  // (We can't enumerate VectorIndex entries by path directly, but
  //  deleteFile is a no-op if the path isn't present, so we call it for
  //  any path no longer in the scan.)
  // NOTE: this is best-effort — the index may retain stale entries for
  // paths not currently in repoIndex.files.  They are harmless (orphan
  // vectors that won't match any retrieval result) and get pruned on the
  // next full buildVectorIndex().

  await embedFiles(filesToEmbed, existingIndex, { provider, concurrency, onProgress, contentCache })

  return existingIndex
}

// ── Semantic search ────────────────────────────────────────────────────────

export interface SemanticSearchResult {
  /** Stable chunk id: "<relativePath>:<startLine>:<endLine>" */
  id:           string
  relativePath: string
  symbolName:   string
  startLine:    number
  endLine:      number
  content:      string
  /** Cosine similarity in [0, 1] */
  similarity:   number
}

/**
 * Searches the vector index for chunks semantically similar to `query`.
 * Returns up to `topK` results sorted by descending similarity.
 */
export async function semanticSearch(
  query:    string,
  index:    VectorIndex,
  topK:     number = 5,
  provider: EmbeddingProvider = defaultEmbeddingProvider,
): Promise<SemanticSearchResult[]> {
  if (index.size === 0) return []

  const queryEmbedding = await provider.embed(query)
  return index.search(queryEmbedding, topK)
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function embedFiles(
  files:   FileNode[],
  idx:     VectorIndex,
  options: BuildVectorIndexOptions,
): Promise<void> {
  const {
    provider    = defaultEmbeddingProvider,
    concurrency = DEFAULT_EMBED_CONCURRENCY,
    onProgress,
    contentCache,
  } = options

  if (files.length === 0) return

  let done = 0

  await pLimit(
    files.map(file => async () => {
      const chunks = fileToEmbeddingInputs(file, contentCache)

      if (chunks.length === 0) {
        done++
        onProgress?.(done, files.length)
        return
      }

      const texts  = chunks.map(buildEmbeddingText)
      const embeds = await provider.embedBatch(texts)

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const entry: VectorEntry = {
          id:               `${chunk.relativePath}:${chunk.startLine}:${chunk.endLine}`,
          relativePath:     chunk.relativePath,
          symbolName:       chunk.symbolName,
          startLine:        chunk.startLine,
          endLine:          chunk.endLine,
          content:          chunk.content.slice(0, MAX_CONTENT_CHARS),
          fileLastModified: file.metadata.lastModified,
          embedding:        embeds[i],
        }
        idx.upsert(entry)
      }

      done++
      onProgress?.(done, files.length)
    }),
    concurrency,
  )
}

/**
 * Converts a FileNode into a list of embeddable chunk inputs.
 *
 * Priority:
 *   1. One chunk per symbol (function/class/component/…) with its source
 *      lines read from disk.
 *   2. For files with no symbols (or that can't be read): line-window
 *      chunks of FALLBACK_CHUNK_SIZE lines.
 *
 * Reuses `contentCache` (populated by an earlier scan/chunk stage) instead
 * of re-reading `file.path` from disk when the content is already cached.
 * This is normally the last stage in the indexing pipeline to need a
 * file's raw content, so the entry is removed from the cache right after
 * use — freeing that file's in-memory source as soon as it's no longer
 * needed, rather than waiting for the whole cache to be released at once.
 */
function fileToEmbeddingInputs(file: FileNode, contentCache?: Map<string, string>): ChunkEmbeddingInput[] {
  let content = contentCache?.get(file.path)

  if (content !== undefined) {
    // Last consumer of this cached content in the indexing pipeline —
    // release it now instead of waiting for a later bulk clear().
    contentCache!.delete(file.path)
  } else {
    // Not cached (no scanWithContent() cache was supplied, or this file
    // wasn't part of that scan) — fall back to reading it directly.
    try {
      content = fs.readFileSync(file.path, 'utf-8')
    } catch {
      return []
    }
  }

  if (content.length === 0) return []

  const lines = content.split('\n')

  if (file.symbols.length > 0) {
    return symbolChunks(file, lines)
  }

  // Fallback: line-window chunks
  return lineWindowChunks(file, lines)
}

/** Creates one ChunkEmbeddingInput per indexed symbol. */
function symbolChunks(file: FileNode, lines: string[]): ChunkEmbeddingInput[] {
  const chunks: ChunkEmbeddingInput[] = []

  for (const sym of file.symbols) {
    const start = Math.max(0, sym.startLine - 1)        // 0-based
    const end   = Math.min(lines.length, sym.endLine)   // exclusive

    const symLines = lines.slice(start, end)
    if (symLines.length === 0) continue

    chunks.push({
      relativePath: file.relativePath,
      symbolName:   sym.name,
      symbolKind:   sym.type,
      startLine:    sym.startLine,
      endLine:      sym.endLine,
      content:      symLines.join('\n').slice(0, MAX_CONTENT_CHARS),
    })
  }

  return chunks
}

/** Creates overlapping line-window chunks for files without symbols. */
function lineWindowChunks(file: FileNode, lines: string[]): ChunkEmbeddingInput[] {
  const chunks: ChunkEmbeddingInput[] = []
  const total = lines.length

  let start = 0
  while (start < total) {
    const end       = Math.min(start + FALLBACK_CHUNK_SIZE, total)
    const startLine = start + 1
    const endLine   = end

    chunks.push({
      relativePath: file.relativePath,
      symbolName:   file.relativePath.split('/').pop()?.split('.')[0] ?? file.relativePath,
      startLine,
      endLine,
      content:      lines.slice(start, end).join('\n').slice(0, MAX_CONTENT_CHARS),
    })

    if (end === total) break
    start += FALLBACK_CHUNK_STEP
  }

  return chunks
}
