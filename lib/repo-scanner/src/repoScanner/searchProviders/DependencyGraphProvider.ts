// lib/repoScanner/searchProviders/DependencyGraphProvider.ts
//
// Two related but distinct pieces of "dependency graph" signal:
//
//  1. DependencyGraphProvider (the SearchProvider) -- matches query tokens
//     against each file's raw import specifiers (reusing pathSearch()'s
//     'import' reason). This runs independently, in parallel with every
//     other provider, like any other SearchProvider.
//
//  2. expandScoresViaDependencyGraph() -- a fusion-stage utility that
//     propagates a fraction of each *already-scored* file's score to its
//     direct (and, for some intents, second-hop) dependency-graph
//     neighbors. This can't be a parallel, independent provider because it
//     depends on the merged output of the other providers -- it's the
//     same "Stage D" expansion hybridRetrieval.ts always performed, kept
//     available as a shared, reusable step now that the deterministic
//     stages are broken out into providers.

import { neighborsOf } from '../dependencyGraph'
import { pathSearch } from '../symbolSearch'
import type { DependencyGraph } from '../types'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

export class DependencyGraphProvider implements SearchProvider {
  readonly kind = 'dependency_graph' as const
  readonly label = 'Dependency Graph'
  readonly defaultWeight = 0.45

  isAvailable(ctx: SearchProviderContext): boolean {
    return ctx.queryTokens.length > 0
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const matches = pathSearch(ctx.queryTokens, ctx.index.files).filter(m => m.reason === 'import')
    if (matches.length === 0) return []

    const byFile = new Map<string, number>()
    for (const m of matches) {
      byFile.set(m.relativePath, (byFile.get(m.relativePath) ?? 0) + m.matchStrength)
    }

    return [...byFile.entries()].map(([relativePath, score]) => ({
      relativePath,
      score,
      confidence: Math.min(1, score),
      detail: 'matched import specifier',
    }))
  }
}

/**
 * Propagates a fraction (`propagationFactor`) of each seed file's score to
 * its dependency-graph neighbors, `hops` levels deep, decaying by half on
 * each additional hop. Returns a fresh Map of relativePath -> propagated
 * score to be added on top of a file's existing score.
 *
 * This is the exact expansion hybridRetrieval.ts's Stage D always
 * performed; it's exposed here so both the legacy hybridRetrieve() path
 * and any new caller of SearchManager can reuse the same logic.
 */
export function expandScoresViaDependencyGraph(
  graph: DependencyGraph,
  seedScores: Map<string, number>,
  hops: number,
  propagationFactor: number,
): Map<string, number> {
  const propagated = new Map<string, number>()
  if (hops <= 0) return propagated

  for (const [relPath, directScore] of seedScores) {
    if (directScore <= 0) continue

    const boost = directScore * propagationFactor
    let frontier = neighborsOf(graph, relPath)
    let decay = 1
    for (let hop = 1; hop <= hops; hop++) {
      for (const neighbor of frontier) {
        propagated.set(neighbor, (propagated.get(neighbor) ?? 0) + boost * decay)
      }
      if (hop < hops) {
        const next = new Set<string>()
        for (const n of frontier) for (const nn of neighborsOf(graph, n)) next.add(nn)
        frontier = [...next]
        decay *= 0.5
      }
    }
  }

  return propagated
}
