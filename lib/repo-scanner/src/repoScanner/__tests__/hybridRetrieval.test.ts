// lib/repoScanner/__tests__/hybridRetrieval.test.ts
//
// Regression coverage for hybridRetrieve(): confirms the refactor into
// pluggable search providers (searchProviders/) didn't change the existing
// numeric ranking behaviour, and that the new `matchExplanations` field is
// populated consistently with the score breakdown already returned.

import { describe, it, expect } from 'vitest'
import { hybridRetrieve } from '../hybridRetrieval'
import { rankFiles } from '../retrieval'
import { buildFixtureRepoIndex } from './testFixtures'

describe('hybridRetrieve — backward compatibility', () => {
  it('ranks an exact symbol match first', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('AuthProvider', index)

    expect(scored.length).toBeGreaterThan(0)
    expect(scored[0].relativePath).toBe('src/auth/AuthProvider.tsx')
    expect(scored[0].symbolScore).toBeGreaterThan(0)
    expect(scored[0].totalScore).toBeGreaterThan(0)
  })

  it('still returns every original ScoredFile field', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('AuthProvider', index)

    for (const s of scored) {
      expect(s).toHaveProperty('relativePath')
      expect(s).toHaveProperty('semanticScore')
      expect(s).toHaveProperty('symbolScore')
      expect(s).toHaveProperty('dependencyScore')
      expect(s).toHaveProperty('vectorScore')
      expect(s).toHaveProperty('activeFileBoost')
      expect(s).toHaveProperty('totalScore')
    }
  })

  it('totalScore is exactly the sum of its component scores (unchanged math)', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('authentication', index)

    for (const s of scored) {
      const expected = Math.round(
        (s.symbolScore + s.semanticScore + s.vectorScore + s.dependencyScore + s.activeFileBoost) * 100,
      ) / 100
      expect(s.totalScore).toBeCloseTo(expected, 2)
    }
  })

  it('rankFiles() (the pre-existing public entry point) keeps working unmodified', async () => {
    const index = buildFixtureRepoIndex()
    const scored = await rankFiles('useAuth', index)

    expect(scored.length).toBeGreaterThan(0)
    expect(scored[0].relativePath).toBe('src/auth/useAuth.ts')
  })

  it('propagates score to a dependency-graph neighbor of a strong symbol match', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('AuthProvider', index)

    // useAuth.ts imports AuthProvider.tsx (a resolved, in-repo import), so a
    // strong AuthProvider match should propagate a nonzero dependencyScore
    // to useAuth.ts even though "AuthProvider" isn't its own symbol/name.
    const useAuth = scored.find(s => s.relativePath === 'src/auth/useAuth.ts')
    expect(useAuth).toBeDefined()
    expect(useAuth!.dependencyScore).toBeGreaterThan(0)
  })
})

describe('hybridRetrieve — matchExplanations (new)', () => {
  it('attaches a symbol explanation for an exact symbol match', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('AuthProvider', index)

    const top = scored[0]
    expect(top.matchExplanations).toBeDefined()
    const symbolExplanation = top.matchExplanations!.find(e => e.provider === 'symbol')
    expect(symbolExplanation).toBeDefined()
    expect(symbolExplanation!.label).toBe('Symbol')
    expect(symbolExplanation!.score).toBeGreaterThan(0)
    expect(symbolExplanation!.confidence).toBeGreaterThan(0)
    expect(symbolExplanation!.confidence).toBeLessThanOrEqual(1)
  })

  it('attaches a dependency_graph explanation to the propagated neighbor', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('AuthProvider', index)

    const useAuth = scored.find(s => s.relativePath === 'src/auth/useAuth.ts')!
    const depExplanation = useAuth.matchExplanations?.find(
      e => e.provider === 'dependency_graph' && e.detail?.includes('propagated'),
    )
    expect(depExplanation).toBeDefined()
  })

  it('attaches an fts explanation when only the summary text matches, not the symbol name', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('authentication', index)

    const authProvider = scored.find(s => s.relativePath === 'src/auth/AuthProvider.tsx')!
    const ftsExplanation = authProvider.matchExplanations?.find(e => e.provider === 'fts')
    expect(ftsExplanation).toBeDefined()
    expect(ftsExplanation!.label).toBe('Full-Text Search')
  })

  it('attaches a dependency_graph explanation for a direct import-specifier match', async () => {
    const index = buildFixtureRepoIndex()
    const { scored } = await hybridRetrieve('authLib', index)

    const loginPage = scored.find(s => s.relativePath === 'src/pages/LoginPage.tsx')!
    const importExplanation = loginPage.matchExplanations?.find(
      e => e.provider === 'dependency_graph' && e.detail === 'matched import specifier',
    )
    expect(importExplanation).toBeDefined()
  })
})
