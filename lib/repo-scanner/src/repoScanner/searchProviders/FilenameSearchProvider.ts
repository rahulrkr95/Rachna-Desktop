// lib/repoScanner/searchProviders/FilenameSearchProvider.ts
//
// Wraps the filename/folder half of the existing path-search stage
// (symbolSearch.ts's pathSearch()). Import-specifier matches are handled
// separately by DependencyGraphProvider, since they represent a different
// kind of signal (graph proximity vs. "the user named this file/folder").

import { pathSearch } from '../symbolSearch'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

export class FilenameSearchProvider implements SearchProvider {
  readonly kind = 'filename' as const
  readonly label = 'Filename'
  /** High priority -- naming a file/folder directly is a strong, low-noise signal. */
  readonly defaultWeight = 0.7

  isAvailable(ctx: SearchProviderContext): boolean {
    return ctx.queryTokens.length > 0
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const matches = pathSearch(ctx.queryTokens, ctx.index.files).filter(m => m.reason !== 'import')
    if (matches.length === 0) return []

    const byFile = new Map<string, { score: number; reasons: Set<string> }>()
    for (const m of matches) {
      const entry = byFile.get(m.relativePath) ?? { score: 0, reasons: new Set<string>() }
      entry.score += m.matchStrength
      entry.reasons.add(m.reason)
      byFile.set(m.relativePath, entry)
    }

    return [...byFile.entries()].map(([relativePath, { score, reasons }]) => ({
      relativePath,
      score,
      confidence: Math.min(1, score),
      detail: `matched ${[...reasons].join('/')}`,
    }))
  }
}
