// lib/repoScanner/searchProviders/index.ts
//
// Public surface of the Search Provider Framework. Consumers outside the
// repoScanner package should import from '../../repoScanner' (the package
// root index.ts), which re-exports the pieces below.

export type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

export { SymbolSearchProvider } from './SymbolSearchProvider'
export { FilenameSearchProvider } from './FilenameSearchProvider'
export { DependencyGraphProvider, expandScoresViaDependencyGraph } from './DependencyGraphProvider'
export { FTSSearchProvider, getOrBuildBM25 } from './FTSSearchProvider'
export { SemanticSearchProvider } from './SemanticSearchProvider'
export { RegexSearchProvider } from './RegexSearchProvider'
export { ASTSearchProvider } from './ASTSearchProvider'

export { SearchManager, createDefaultSearchManager } from './SearchManager'
export type {
  SearchManagerOptions,
  HybridSearchResult,
  SearchManagerRunResult,
} from './SearchManager'
