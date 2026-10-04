// lib/repoScanner/searchProviders/__tests__/providers.integration.test.ts
//
// Integration coverage using the *real* providers (not fakes) against the
// shared fixture RepoIndex, via createDefaultSearchManager().

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { createDefaultSearchManager } from '../SearchManager'
import { SymbolSearchProvider } from '../SymbolSearchProvider'
import { FilenameSearchProvider } from '../FilenameSearchProvider'
import { DependencyGraphProvider, expandScoresViaDependencyGraph } from '../DependencyGraphProvider'
import { FTSSearchProvider } from '../FTSSearchProvider'
import { ASTSearchProvider } from '../ASTSearchProvider'
import { RegexSearchProvider } from '../RegexSearchProvider'
import { SearchManager } from '../SearchManager'
import { buildFixtureRepoIndex } from '../../__tests__/testFixtures'
import { tokenize } from '../../tokenizer'
import type { SearchProviderContext } from '../types'

describe('real providers wired through SearchManager', () => {
  it('ranks the exact symbol match highest for a symbol-name query', async () => {
    const index = buildFixtureRepoIndex()
    const manager = createDefaultSearchManager()
    const { results } = await manager.search('AuthProvider', index)

    expect(results[0].relativePath).toBe('src/auth/AuthProvider.tsx')
    expect(results[0].matchExplanations.some(e => e.provider === 'symbol')).toBe(true)
  })

  it('finds a file by filename query via FilenameSearchProvider', async () => {
    const index = buildFixtureRepoIndex()
    const manager = new SearchManager([new FilenameSearchProvider()])
    const { results } = await manager.search('mathUtils', index)

    expect(results[0].relativePath).toBe('src/utils/mathUtils.ts')
    expect(results[0].matchExplanations[0].provider).toBe('filename')
  })

  it('finds a file by summary keyword via FTSSearchProvider', async () => {
    const index = buildFixtureRepoIndex()
    const manager = new SearchManager([new FTSSearchProvider()])
    const { results } = await manager.search('authentication session', index)

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].relativePath).toBe('src/auth/AuthProvider.tsx')
  })

  it('finds an import-specifier match via DependencyGraphProvider', async () => {
    const index = buildFixtureRepoIndex()
    const manager = new SearchManager([new DependencyGraphProvider()])
    // 'lib' (not 'auth') so this only matches LoginPage's "authLib" import,
    // not useAuth.ts's own "./AuthProvider" import (which also contains "auth").
    const { results } = await manager.search('lib', index)

    expect(results[0].relativePath).toBe('src/pages/LoginPage.tsx')
    expect(results[0].matchExplanations[0].detail).toBe('matched import specifier')
  })

  it('ASTSearchProvider stays inactive for non-structural queries', async () => {
    const index = buildFixtureRepoIndex()
    const manager = createDefaultSearchManager()
    const { providersRun } = await manager.search('AuthProvider', index)

    expect(providersRun).not.toContain('ast')
  })
})

describe('expandScoresViaDependencyGraph (fusion utility)', () => {
  it('propagates a decaying fraction of score to 1-hop and 2-hop neighbors', () => {
    const index = buildFixtureRepoIndex()
    const seeds = new Map([['src/auth/AuthProvider.tsx', 10]])

    const oneHop = expandScoresViaDependencyGraph(index.dependencyGraph, seeds, 1, 0.3)
    expect(oneHop.get('src/auth/useAuth.ts')).toBeCloseTo(3, 5) // 10 * 0.3

    const twoHop = expandScoresViaDependencyGraph(index.dependencyGraph, seeds, 2, 0.3)
    // 2nd hop (LoginPage.tsx, via useAuth.ts) gets the same boost decayed by 0.5
    expect(twoHop.get('src/pages/LoginPage.tsx')).toBeCloseTo(1.5, 5) // 10 * 0.3 * 0.5
  })

  it('returns an empty map for zero or negative seed scores', () => {
    const index = buildFixtureRepoIndex()
    const seeds = new Map([['src/auth/AuthProvider.tsx', 0]])
    const propagated = expandScoresViaDependencyGraph(index.dependencyGraph, seeds, 1, 0.3)
    expect(propagated.size).toBe(0)
  })
})

describe('SymbolSearchProvider', () => {
  it('is unavailable for an empty query', async () => {
    const provider = new SymbolSearchProvider()
    const ctx: SearchProviderContext = {
      query: '',
      queryTokens: tokenize(''),
      index: buildFixtureRepoIndex(),
      options: {},
    }
    expect(provider.isAvailable(ctx)).toBe(false)
  })
})

describe('RegexSearchProvider', () => {
  it('is inactive by default (no regexPattern / useRegexFallback)', async () => {
    const provider = new RegexSearchProvider()
    const ctx: SearchProviderContext = {
      query: 'TODO',
      queryTokens: tokenize('TODO'),
      index: buildFixtureRepoIndex(),
      options: {},
    }
    expect(provider.isAvailable(ctx)).toBe(false)
  })

  it('matches file contents when an explicit regexPattern is supplied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-provider-regex-'))
    const filePath = path.join(dir, 'sample.ts')
    fs.writeFileSync(filePath, 'function foo() {\n  // TODO: fix this\n  return 1\n}\n')

    try {
      const index = buildFixtureRepoIndex()
      index.files = [
        {
          path: filePath,
          relativePath: 'sample.ts',
          extension: 'ts',
          imports: [],
          exports: [],
          symbols: [],
          metadata: { sizeBytes: 100, lastModified: '2026-01-01T00:00:00.000Z', lineCount: 4 },
        },
      ]

      const provider = new RegexSearchProvider()
      const ctx: SearchProviderContext = {
        query: 'anything',
        queryTokens: [],
        index,
        options: { regexPattern: 'TODO' },
      }
      expect(provider.isAvailable(ctx)).toBe(true)

      const results = await provider.search(ctx)
      expect(results).toHaveLength(1)
      expect(results[0].relativePath).toBe('sample.ts')
      expect(results[0].detail).toContain('line 2')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed (returns []) for an invalid regex pattern instead of throwing', async () => {
    const provider = new RegexSearchProvider()
    const ctx: SearchProviderContext = {
      query: 'x',
      queryTokens: [],
      index: buildFixtureRepoIndex(),
      options: { regexPattern: '(unterminated' },
    }
    await expect(provider.search(ctx)).resolves.toEqual([])
  })
})

describe('ASTSearchProvider', () => {
  it('is available only for supported structural queries', async () => {
    const provider = new ASTSearchProvider()
    const ctx: SearchProviderContext = {
      query: 'find every catch block that swallows errors',
      queryTokens: tokenize('find every catch block that swallows errors'),
      index: buildFixtureRepoIndex(),
      options: {},
    }
    expect(provider.isAvailable(ctx)).toBe(true)
    expect(provider.isAvailable({ ...ctx, query: 'class Foo implements Bar' })).toBe(false)
  })

  it('finds swallowed catch blocks and JSX onClick props with locations', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-provider-ast-'))
    const tsPath = path.join(dir, 'errors.ts')
    const jsxPath = path.join(dir, 'Button.jsx')
    fs.writeFileSync(tsPath, 'try { work() } catch (error) {\n  console.log(error)\n}\ntry { work() } catch (error) { throw error }\n')
    fs.writeFileSync(jsxPath, 'export const Button = () => (\n  <button onClick={() => go()}>Go</button>\n)\n')
    try {
      const index = buildFixtureRepoIndex()
      index.files = [
        { path: tsPath, relativePath: 'errors.ts', extension: 'ts', imports: [], exports: [], symbols: [], metadata: { sizeBytes: 100, lastModified: '', lineCount: 4 } },
        { path: jsxPath, relativePath: 'Button.jsx', extension: 'jsx', imports: [], exports: [], symbols: [], metadata: { sizeBytes: 100, lastModified: '', lineCount: 3 } },
      ]
      const provider = new ASTSearchProvider()
      const base = { queryTokens: [], index, options: {} }
      const catches = await provider.search({ ...base, query: 'find every catch block that swallows errors' })
      expect(catches).toHaveLength(1)
      expect(catches[0]).toMatchObject({ relativePath: 'errors.ts', score: 1 })
      expect(catches[0].detail).toContain('line 1')

      const managed = await new SearchManager([provider]).search(
        'find every catch block that swallows errors', index)
      expect(managed.providersRun).toEqual(['ast'])
      expect(managed.results[0].relativePath).toBe('errors.ts')
      expect(managed.results[0].matchExplanations[0].provider).toBe('ast')

      const jsx = await provider.search({ ...base, query: 'find JSX elements with an onClick prop' })
      expect(jsx).toHaveLength(1)
      expect(jsx[0]).toMatchObject({ relativePath: 'Button.jsx', score: 1 })
      expect(jsx[0].detail).toContain('line 2')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
