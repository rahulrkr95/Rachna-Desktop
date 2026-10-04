// lib/repoScanner/searchProviders/types.ts
//
// Common interface implemented by every pluggable search provider
// (SemanticSearchProvider, FTSSearchProvider, SymbolSearchProvider,
// ASTSearchProvider, RegexSearchProvider, FilenameSearchProvider,
// DependencyGraphProvider). SearchManager (../SearchManager.ts) executes a
// list of these in parallel, merges the results and produces a single
// hybrid-ranked list with per-provider match explanations.
//
// New providers can be added without touching SearchManager or any of the
// existing providers: implement this interface and pass an instance into
// `new SearchManager([...existingProviders, myNewProvider])` (or
// `manager.addProvider(myNewProvider)`).

import type { RepoIndex, RetrievalOptions, SearchProviderKind } from '../types'

/** One provider's raw hit for a single file, before fusion/weighting. */
export interface ProviderMatch {
  /** Path relative to the project root (matches RepoIndex.files[].relativePath). */
  relativePath: string
  /**
   * Raw, provider-local relevance score. Scale is provider-specific --
   * SearchManager normalizes contributions via each provider's
   * `defaultWeight` (or a caller-supplied override), so providers don't
   * need to agree on a shared scale.
   */
  score: number
  /** How confident this provider is in the match, in [0, 1]. */
  confidence: number
  /** Optional human-readable detail surfaced in match explanations. */
  detail?: string
}

/** Everything a provider needs to run a single search. */
export interface SearchProviderContext {
  /** Raw, unmodified query text. */
  query: string
  /** Tokenized query (see tokenizer.ts) -- shared so providers tokenize consistently. */
  queryTokens: string[]
  index: RepoIndex
  options: RetrievalOptions
}

/** The interface every search provider implements. */
export interface SearchProvider {
  /** Stable identifier used in MatchExplanation.provider and weight overrides. */
  readonly kind: SearchProviderKind
  /** Human-readable name shown in UI match explanations, e.g. "Symbol". */
  readonly label: string
  /**
   * Default fusion weight applied to this provider's scores by
   * SearchManager when no override is supplied. Mirrors the relative
   * priority historically encoded in HYBRID_WEIGHTS (hybridRetrieval.ts):
   * symbol > filename > dependency graph / keyword > semantic.
   */
  readonly defaultWeight: number
  /**
   * Cheap, synchronous check for whether this provider can contribute to
   * this particular search (e.g. SemanticSearchProvider requires a
   * vectorIndex to have been supplied). SearchManager skips unavailable
   * providers entirely rather than calling search() and getting an empty
   * array back, so it's also reflected in `providersRun`.
   */
  isAvailable(ctx: SearchProviderContext): boolean
  /**
   * Runs the search. Must not throw for "no results" -- return `[]`.
   * SearchManager still guards every call with Promise.allSettled, so a
   * thrown error is captured (as `providerErrors[kind]`) rather than
   * failing the whole search, but providers should prefer returning `[]`.
   */
  search(ctx: SearchProviderContext): Promise<ProviderMatch[]>
}

export type { SearchProviderKind }
