// lib/repoScanner/retrieval.ts
//
// Public retrieval entry point for RepoIndex.
//
// As of this version, ranking is delegated to the Claude-Code-style hybrid
// pipeline in hybridRetrieval.ts:
//
//   exact symbol search → path/import search → BM25 keyword search
//   → (embedding fallback, only when the above are weak)
//   → intent-biased weighted combination → 1-hop dependency-graph expansion
//
// The fake hashed-TF-IDF embedding (embeddingProvider.ts) is no longer used
// for primary ranking — it is now strictly a fallback signal for queries
// where the deterministic stages return little or no match. See
// hybridRetrieval.ts for the full flow and tuning constants.
//
// This file's exported API (`rankFiles`, `tokenize`) is unchanged so
// existing callers (contextBuilder.ts, the AI chat UI, etc.) work without
// modification.

import type { RepoIndex, RetrievalOptions, ScoredFile } from './types'
import { DEFAULT_TOP_K } from './types'
import { defaultRegistry } from './languageAdapters'
import { hybridRetrieve } from './hybridRetrieval'

// Re-export the shared tokenizer so existing imports of `tokenize` from
// this module keep working unchanged.
export { tokenize } from './tokenizer'

/**
 * Ranks every file in `index` against `query` and returns the top results
 * sorted by descending `totalScore`, using the multi-stage hybrid pipeline
 * (see module header). Pass `options.intent` to override automatic query
 * intent classification.
 */
export async function rankFiles(
  query: string,
  index: RepoIndex,
  options: RetrievalOptions = {},
): Promise<ScoredFile[]> {
  const { scored } = await hybridRetrieve(query, index, {
    topK: options.topK ?? DEFAULT_TOP_K,
    ...options,
  })
  return scored
}

// Re-export defaultRegistry so callers that import from retrieval.ts also
// get adapter access without an extra import.
export { defaultRegistry }
