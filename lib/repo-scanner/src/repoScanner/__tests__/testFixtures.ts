// lib/repoScanner/__tests__/testFixtures.ts
//
// Small, hand-built RepoIndex used across retrieval/provider tests. Not a
// *.test.ts file itself, so vitest's `**/__tests__/**/*.test.ts` include
// pattern won't try to run it directly -- import it from actual test files.

import type {
  DependencyGraph,
  ExportRecord,
  FileMetadata,
  FileNode,
  FileSummary,
  ImportRecord,
  RepoIndex,
  SymbolRecord,
} from '../types'
import { buildDependencyGraph } from '../dependencyGraph'

function metadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return { sizeBytes: 512, lastModified: '2026-01-01T00:00:00.000Z', lineCount: 40, ...overrides }
}

function imp(specifier: string, resolvedPath: string | null): ImportRecord {
  return { specifier, resolvedPath, namedImports: [], defaultImport: null, namespaceImport: null }
}

function exp(name: string, kind: ExportRecord['kind'] = 'function'): ExportRecord {
  return { name, kind }
}

function sym(name: string, type: SymbolRecord['type'], startLine = 1, endLine = 10): SymbolRecord {
  return { name, type, startLine, endLine }
}

/**
 * Builds a small, deterministic fixture repo:
 *
 *   src/auth/AuthProvider.tsx  -- exports/defines the `AuthProvider` component
 *   src/auth/useAuth.ts        -- imports AuthProvider.tsx (resolved, in-repo)
 *   src/pages/LoginPage.tsx    -- imports useAuth.ts, and an external "authLib" package
 *   src/utils/mathUtils.ts     -- unrelated: defines `sum`
 *
 * `AuthProvider`'s summary mentions "authentication" so FTS/BM25 has a
 * keyword signal distinct from the exact symbol-name match.
 */
export function buildFixtureRepoIndex(): RepoIndex {
  const authProviderPath = '/repo/src/auth/AuthProvider.tsx'
  const useAuthPath = '/repo/src/auth/useAuth.ts'
  const loginPagePath = '/repo/src/pages/LoginPage.tsx'
  const mathUtilsPath = '/repo/src/utils/mathUtils.ts'

  const files: FileNode[] = [
    {
      path: authProviderPath,
      relativePath: 'src/auth/AuthProvider.tsx',
      extension: 'tsx',
      imports: [],
      exports: [exp('AuthProvider', 'default')],
      symbols: [sym('AuthProvider', 'component', 1, 30)],
      metadata: metadata(),
    },
    {
      path: useAuthPath,
      relativePath: 'src/auth/useAuth.ts',
      extension: 'ts',
      imports: [imp('./AuthProvider', authProviderPath)],
      exports: [exp('useAuth', 'function')],
      symbols: [sym('useAuth', 'function', 1, 15)],
      metadata: metadata(),
    },
    {
      path: loginPagePath,
      relativePath: 'src/pages/LoginPage.tsx',
      extension: 'tsx',
      imports: [imp('../auth/useAuth', useAuthPath), imp('authLib', null)],
      exports: [exp('LoginPage', 'default')],
      symbols: [sym('LoginPage', 'component', 1, 20)],
      metadata: metadata(),
    },
    {
      path: mathUtilsPath,
      relativePath: 'src/utils/mathUtils.ts',
      extension: 'ts',
      imports: [],
      exports: [exp('sum', 'function')],
      symbols: [sym('sum', 'function', 1, 5)],
      metadata: metadata(),
    },
  ]

  const summaries: FileSummary[] = [
    {
      path: 'src/auth/AuthProvider.tsx',
      summary: 'Provides authentication context and manages the login session for the app.',
      exports: ['AuthProvider'],
      imports: [],
    },
    {
      path: 'src/auth/useAuth.ts',
      summary: 'Hook for reading the current authentication state.',
      exports: ['useAuth'],
      imports: ['./AuthProvider'],
    },
    {
      path: 'src/pages/LoginPage.tsx',
      summary: 'Renders the login form and handles sign-in submission.',
      exports: ['LoginPage'],
      imports: ['../auth/useAuth', 'authLib'],
    },
    {
      path: 'src/utils/mathUtils.ts',
      summary: 'Miscellaneous arithmetic helper functions.',
      exports: ['sum'],
      imports: [],
    },
  ]

  const dependencyGraph: DependencyGraph = buildDependencyGraph(files)

  return {
    projectRoot: '/repo',
    scannedAt: '2026-01-01T00:00:00.000Z',
    generatedAt: '2026-01-01T00:00:00.000Z',
    totalFiles: files.length,
    totalLines: files.reduce((sum, f) => sum + f.metadata.lineCount, 0),
    files,
    summaries,
    dependencyGraph,
    errors: {},
  }
}
