// lib/repoScanner/searchProviders/FTSSearchProvider.ts
//
// "Full-text search" provider for the in-process repo index: a small,
// dependency-free BM25 index (bm25.ts) built over per-file documents
// (summary + path + exports + symbol names + import specifiers).
//
// This used to live inline in hybridRetrieval.ts (getOrBuildBM25 /
// buildDocumentText). It's relocated here, unchanged, so both the legacy
// hybridRetrieve() pipeline and the new SearchManager share a single BM25
// cache per RepoIndex rather than building/caching it twice.
//
// Note: this is distinct from the SQLite FTS5 full-text search used by the
// Tauri desktop shell (lib/chunkSearch.ts's searchChunks(), backed by
// src-tauri/src/db.rs) -- that path operates on-disk over indexed chunks
// and requires the Tauri runtime. FTSSearchProvider is the equivalent
// keyword-search stage for the standalone, Node-side repo-scanner package
// (used by the CLI scanner and any non-Tauri host), which has no SQLite
// dependency.

import { BM25Index, type BM25Document } from '../bm25'
import { tokenize } from '../tokenizer'
import type { FileNode, FileSummary, RepoIndex } from '../types'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

// Cache one BM25Index per RepoIndex object so repeated queries against the
// same index (the common case in a chat/search session) don't re-tokenize
// the entire repo on every call.
const bm25Cache = new WeakMap<RepoIndex, BM25Index>()

export function getOrBuildBM25(index: RepoIndex): BM25Index {
  const cached = bm25Cache.get(index)
  if (cached) return cached

  const summaryByPath = new Map<string, FileSummary>(index.summaries.map(s => [s.path, s]))
  const docs: BM25Document[] = index.files.map(file => {
    const summary = summaryByPath.get(file.relativePath)
    const text = buildDocumentText(file, summary)
    return { id: file.relativePath, tokens: tokenize(text) }
  })

  const bm25 = new BM25Index(docs)
  bm25Cache.set(index, bm25)
  return bm25
}

function buildDocumentText(file: FileNode, summary?: FileSummary): string {
  const parts = [
    summary?.summary ?? '',
    file.relativePath,
    ...(summary?.exports ?? file.exports.map(e => e.name)),
    ...file.symbols.map(s => s.name),
    ...(summary?.imports ?? file.imports.map(i => i.specifier)),
  ]
  return parts.join(' ')
}

export class FTSSearchProvider implements SearchProvider {
  readonly kind = 'fts' as const
  readonly label = 'Full-Text Search'
  readonly defaultWeight = 0.4

  isAvailable(ctx: SearchProviderContext): boolean {
    return ctx.queryTokens.length > 0
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const bm25 = getOrBuildBM25(ctx.index)
    const scoreMap = bm25.search(ctx.queryTokens)
    if (scoreMap.size === 0) return []

    const maxScore = Math.max(0, ...scoreMap.values())
    return [...scoreMap.entries()].map(([relativePath, score]) => ({
      relativePath,
      score,
      confidence: maxScore > 0 ? Math.min(1, score / maxScore) : 0,
      detail: 'BM25 keyword match',
    }))
  }
}
