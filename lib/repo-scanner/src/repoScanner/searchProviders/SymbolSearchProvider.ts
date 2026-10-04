// lib/repoScanner/searchProviders/SymbolSearchProvider.ts
//
// Wraps the existing exact-symbol-search stage (symbolSearch.ts) in the
// common SearchProvider interface. No search logic is duplicated here --
// this is a thin adapter over exactSymbolSearch()/scoreSymbolMatches(),
// which is also what hybridRetrieval.ts's Stage A.1 uses directly.

import { exactSymbolSearch, scoreSymbolMatches } from '../symbolSearch'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

export class SymbolSearchProvider implements SearchProvider {
  readonly kind = 'symbol' as const
  readonly label = 'Symbol'
  /** Highest-priority signal -- a real identifier match beats everything else. */
  readonly defaultWeight = 1.0

  isAvailable(ctx: SearchProviderContext): boolean {
    return ctx.queryTokens.length > 0
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const matches = exactSymbolSearch(ctx.queryTokens, ctx.index.files)
    if (matches.length === 0) return []

    const scoreMap = scoreSymbolMatches(matches)

    // Track the single strongest symbol match per file for the detail string.
    const bestPerFile = new Map<string, { name: string; type: string; matchStrength: number }>()
    for (const m of matches) {
      const prev = bestPerFile.get(m.relativePath)
      if (!prev || m.matchStrength > prev.matchStrength) {
        bestPerFile.set(m.relativePath, {
          name: m.symbol.name,
          type: m.symbol.type,
          matchStrength: m.matchStrength,
        })
      }
    }

    const out: ProviderMatch[] = []
    for (const [relativePath, score] of scoreMap) {
      const best = bestPerFile.get(relativePath)
      out.push({
        relativePath,
        score,
        confidence: best ? best.matchStrength : 0.5,
        detail: best ? `matched ${best.type} "${best.name}"` : undefined,
      })
    }
    return out
  }
}
