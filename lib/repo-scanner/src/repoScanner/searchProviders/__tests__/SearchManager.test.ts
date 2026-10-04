// lib/repoScanner/searchProviders/__tests__/SearchManager.test.ts
//
// Unit tests for the Search Provider Framework's fusion/ranking core.
// Uses small fake providers (not the real Symbol/FTS/etc. ones) so these
// tests exercise SearchManager's merging/ranking logic in isolation --
// see integration.test.ts for tests against the real providers.

import { describe, it, expect } from 'vitest'
import { SearchManager, createDefaultSearchManager } from '../SearchManager'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from '../types'
import { buildFixtureRepoIndex } from '../../__tests__/testFixtures'

function fakeProvider(opts: {
  kind: SearchProvider['kind']
  label: string
  defaultWeight: number
  matches: ProviderMatch[]
  available?: boolean
  throws?: boolean
}): SearchProvider {
  return {
    kind: opts.kind,
    label: opts.label,
    defaultWeight: opts.defaultWeight,
    isAvailable: () => opts.available ?? true,
    search: async () => {
      if (opts.throws) throw new Error(`${opts.label} provider failed`)
      return opts.matches
    },
  }
}

describe('SearchManager — merging & deduplication', () => {
  it('merges matches from multiple providers on the same file into one result', async () => {
    const index = buildFixtureRepoIndex()
    const symbolLike = fakeProvider({
      kind: 'symbol',
      label: 'Symbol',
      defaultWeight: 1.0,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 3, confidence: 1 }],
    })
    const ftsLike = fakeProvider({
      kind: 'fts',
      label: 'Full-Text Search',
      defaultWeight: 0.4,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 5, confidence: 0.8 }],
    })

    const manager = new SearchManager([symbolLike, ftsLike])
    const { results, providersRun } = await manager.search('auth', index)

    expect(providersRun.sort()).toEqual(['fts', 'symbol'])
    expect(results).toHaveLength(1)
    expect(results[0].relativePath).toBe('src/auth/AuthProvider.tsx')
    expect(results[0].matchExplanations).toHaveLength(2)
    expect(results[0].matchExplanations.map(e => e.provider).sort()).toEqual(['fts', 'symbol'])
  })

  it('keeps only the strongest match per file from a single provider (dedup)', async () => {
    const index = buildFixtureRepoIndex()
    const provider = fakeProvider({
      kind: 'symbol',
      label: 'Symbol',
      defaultWeight: 1.0,
      matches: [
        { relativePath: 'src/auth/AuthProvider.tsx', score: 1, confidence: 0.5, detail: 'weak' },
        { relativePath: 'src/auth/AuthProvider.tsx', score: 4, confidence: 0.9, detail: 'strong' },
      ],
    })

    const manager = new SearchManager([provider])
    const { results } = await manager.search('auth', index)

    expect(results).toHaveLength(1)
    // Only the stronger of the two same-provider matches should survive.
    expect(results[0].matchExplanations).toHaveLength(1)
    expect(results[0].matchExplanations[0].detail).toBe('strong')
  })

  it('drops matches below the configured minConfidence', async () => {
    const index = buildFixtureRepoIndex()
    const provider = fakeProvider({
      kind: 'regex',
      label: 'Regex',
      defaultWeight: 0.5,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 2, confidence: 0.1 }],
    })

    const manager = new SearchManager([provider])
    const { results } = await manager.search('auth', index, {}, { minConfidence: 0.5 })

    expect(results).toHaveLength(0)
  })
})

describe('SearchManager — weighted + confidence-adjusted ranking', () => {
  it('ranks a high-weight, high-confidence provider above a low-weight, low-confidence one', async () => {
    const index = buildFixtureRepoIndex()
    const strong = fakeProvider({
      kind: 'symbol',
      label: 'Symbol',
      defaultWeight: 1.0,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 3, confidence: 1 }],
    })
    const weak = fakeProvider({
      kind: 'semantic',
      label: 'Semantic',
      defaultWeight: 0.15,
      matches: [{ relativePath: 'src/utils/mathUtils.ts', score: 3, confidence: 0.3 }],
    })

    const manager = new SearchManager([strong, weak])
    const { results } = await manager.search('query', index)

    expect(results[0].relativePath).toBe('src/auth/AuthProvider.tsx')
    expect(results[0].totalScore).toBeGreaterThan(results[1].totalScore)
  })

  it('a higher-confidence match outranks an equal-score, lower-confidence match', async () => {
    const index = buildFixtureRepoIndex()
    const provider = fakeProvider({
      kind: 'fts',
      label: 'Full-Text Search',
      defaultWeight: 1,
      matches: [
        { relativePath: 'src/auth/AuthProvider.tsx', score: 2, confidence: 1.0 },
        { relativePath: 'src/utils/mathUtils.ts', score: 2, confidence: 0.2 },
      ],
    })

    const manager = new SearchManager([provider])
    const { results } = await manager.search('query', index)

    expect(results[0].relativePath).toBe('src/auth/AuthProvider.tsx')
    expect(results[0].totalScore).toBeGreaterThan(results[1].totalScore)
  })

  it('respects weightOverrides', async () => {
    const index = buildFixtureRepoIndex()
    const provider = fakeProvider({
      kind: 'semantic',
      label: 'Semantic',
      defaultWeight: 0.1,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 10, confidence: 1 }],
    })

    const manager = new SearchManager([provider])
    const low = await manager.search('query', index)
    const high = await manager.search('query', index, {}, { weightOverrides: { semantic: 2 } })

    expect(high.results[0].totalScore).toBeGreaterThan(low.results[0].totalScore)
  })

  it('respects topK', async () => {
    const index = buildFixtureRepoIndex()
    const provider = fakeProvider({
      kind: 'fts',
      label: 'Full-Text Search',
      defaultWeight: 1,
      matches: [
        { relativePath: 'src/auth/AuthProvider.tsx', score: 3, confidence: 1 },
        { relativePath: 'src/utils/mathUtils.ts', score: 2, confidence: 1 },
      ],
    })

    const manager = new SearchManager([provider])
    const { results } = await manager.search('query', index, {}, { topK: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].relativePath).toBe('src/auth/AuthProvider.tsx')
  })
})

describe('SearchManager — parallel execution & fault tolerance', () => {
  it('runs providers in parallel and still returns results if one throws', async () => {
    const index = buildFixtureRepoIndex()
    const good = fakeProvider({
      kind: 'symbol',
      label: 'Symbol',
      defaultWeight: 1,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 2, confidence: 1 }],
    })
    const bad = fakeProvider({
      kind: 'ast',
      label: 'AST',
      defaultWeight: 0.6,
      matches: [],
      throws: true,
    })

    const manager = new SearchManager([good, bad])
    const { results, providersRun, providerErrors } = await manager.search('query', index)

    expect(results).toHaveLength(1)
    expect(providersRun).toEqual(['symbol'])
    expect(providerErrors.ast).toContain('AST provider failed')
  })

  it('skips unavailable providers entirely (not run, no error)', async () => {
    const index = buildFixtureRepoIndex()
    const unavailable = fakeProvider({
      kind: 'semantic',
      label: 'Semantic',
      defaultWeight: 0.15,
      matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 5, confidence: 1 }],
      available: false,
    })

    const manager = new SearchManager([unavailable])
    const { results, providersRun, providerErrors } = await manager.search('query', index)

    expect(results).toHaveLength(0)
    expect(providersRun).toEqual([])
    expect(providerErrors).toEqual({})
  })
})

describe('SearchManager — extensibility', () => {
  it('supports adding a new provider without modifying SearchManager itself', async () => {
    const index = buildFixtureRepoIndex()
    const manager = new SearchManager([])
    expect(manager.listProviders()).toHaveLength(0)

    manager.addProvider(
      fakeProvider({
        kind: 'regex',
        label: 'Custom Regex',
        defaultWeight: 0.5,
        matches: [{ relativePath: 'src/auth/AuthProvider.tsx', score: 1, confidence: 1 }],
      }),
    )

    expect(manager.listProviders()).toHaveLength(1)
    const { results } = await manager.search('query', index)
    expect(results).toHaveLength(1)
  })

  it('createDefaultSearchManager() wires up all 7 providers from the framework spec', () => {
    const manager = createDefaultSearchManager()
    const kinds = manager.listProviders().map(p => p.kind).sort()
    expect(kinds).toEqual(['ast', 'dependency_graph', 'filename', 'fts', 'regex', 'semantic', 'symbol'].sort())
  })
})
