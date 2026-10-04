// lib/repoScanner/searchProviders/SemanticSearchProvider.ts
//
// Wraps the existing embedding-based retrieval stage (semanticRetrieval.ts
// + vectorIndex.ts) in the common SearchProvider interface. Requires a
// pre-built VectorIndex to be supplied via RetrievalOptions.vectorIndex --
// unlike the other providers, this one can't build its index from a
// RepoIndex alone (embedding a whole repo at query time isn't practical).

import { semanticSearch } from '../semanticRetrieval'
import { defaultEmbeddingProvider } from '../embeddingProvider'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

export class SemanticSearchProvider implements SearchProvider {
  readonly kind = 'semantic' as const
  readonly label = 'Semantic'
  /**
   * Lowest-priority signal by design -- it's a fallback for when the
   * deterministic stages (symbol/filename/FTS) return weak or no signal,
   * mirroring the original HYBRID_WEIGHTS.vector weighting.
   */
  readonly defaultWeight = 0.15

  isAvailable(ctx: SearchProviderContext): boolean {
    return !!ctx.options.vectorIndex && ctx.options.vectorIndex.size > 0 && ctx.query.trim().length > 0
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const vectorIndex = ctx.options.vectorIndex
    if (!vectorIndex) return []

    const provider = ctx.options.embeddingProvider ?? defaultEmbeddingProvider
    const topK = Math.min(vectorIndex.size, Math.max((ctx.options.topK ?? 5) * 10, 50))
    const hits = await semanticSearch(ctx.query, vectorIndex, topK, provider)
    if (hits.length === 0) return []

    // Multiple chunks in the same file can match -- keep the strongest.
    const bestPerFile = new Map<string, { similarity: number; symbolName: string }>()
    for (const hit of hits) {
      const prev = bestPerFile.get(hit.relativePath)
      if (!prev || hit.similarity > prev.similarity) {
        bestPerFile.set(hit.relativePath, { similarity: hit.similarity, symbolName: hit.symbolName })
      }
    }

    return [...bestPerFile.entries()].map(([relativePath, { similarity, symbolName }]) => ({
      relativePath,
      score: similarity,
      confidence: similarity,
      detail: `embedding similarity near "${symbolName}"`,
    }))
  }
}
