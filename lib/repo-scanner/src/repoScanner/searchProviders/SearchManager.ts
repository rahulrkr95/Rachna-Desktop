// lib/repoScanner/searchProviders/SearchManager.ts
//
// Executes a set of SearchProviders in parallel against a RepoIndex,
// merges their per-file matches (deduplicating multiple hits from the
// same provider on the same file), and produces a single hybrid-ranked
// list of results with a full per-provider explanation trail.
//
// ── Fusion model ────────────────────────────────────────────────────────
//
// For each file, every contributing provider produces a MatchExplanation:
//   { provider, label, score: rawScore * providerWeight, confidence, detail }
//
// The file's totalScore is the confidence-weighted sum of those
// contributions:
//
//   totalScore = Σ (explanation.score * (0.5 + 0.5 * explanation.confidence))
//
// i.e. a low-confidence hit from a heavily-weighted provider still counts,
// but at half strength; a full-confidence hit counts fully. This rewards
// results confirmed by multiple providers (each contributes independently)
// without letting a single low-confidence provider dominate the ranking.
//
// ── Adding a new provider ──────────────────────────────────────────────
//
// SearchManager has no knowledge of what any individual provider does --
// it only depends on the SearchProvider interface (./types.ts). Add a new
// provider by implementing that interface and passing it in; no changes
// to SearchManager or any existing provider are required.

import type { RepoIndex, RetrievalOptions, MatchExplanation, SearchProviderKind } from '../types'
import { tokenize } from '../tokenizer'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

import { SemanticSearchProvider } from './SemanticSearchProvider'
import { FTSSearchProvider } from './FTSSearchProvider'
import { SymbolSearchProvider } from './SymbolSearchProvider'
import { ASTSearchProvider } from './ASTSearchProvider'
import { RegexSearchProvider } from './RegexSearchProvider'
import { FilenameSearchProvider } from './FilenameSearchProvider'
import { DependencyGraphProvider } from './DependencyGraphProvider'

export interface SearchManagerOptions {
  /** Override a provider's `defaultWeight` for this call, keyed by provider kind. */
  weightOverrides?: Partial<Record<SearchProviderKind, number>>
  /** Drop individual provider matches below this confidence before fusion. Default: 0. */
  minConfidence?: number
  /** Cap on the number of fused results returned. Default: return everything. */
  topK?: number
}

/** One file's fused, ranked result. */
export interface HybridSearchResult {
  relativePath: string
  /** Confidence-weighted sum of every contributing provider's score. */
  totalScore: number
  /** Every provider that matched this file, sorted by descending score. */
  matchExplanations: MatchExplanation[]
}

export interface SearchManagerRunResult {
  results: HybridSearchResult[]
  /** Provider kinds that were available and ran without throwing. */
  providersRun: SearchProviderKind[]
  /** Provider kinds that were available but threw, mapped to the error message. */
  providerErrors: Partial<Record<SearchProviderKind, string>>
}

export class SearchManager {
  private providers: SearchProvider[]

  constructor(providers: SearchProvider[] = []) {
    this.providers = [...providers]
  }

  /** Registers an additional provider without touching the core pipeline or any existing provider. */
  addProvider(provider: SearchProvider): void {
    this.providers.push(provider)
  }

  listProviders(): readonly SearchProvider[] {
    return this.providers
  }

  /**
   * Runs every available provider in parallel against `query`, merges and
   * hybrid-ranks the results.
   */
  async search(
    query: string,
    index: RepoIndex,
    options: RetrievalOptions = {},
    managerOptions: SearchManagerOptions = {},
  ): Promise<SearchManagerRunResult> {
    const queryTokens = tokenize(query)
    const ctx: SearchProviderContext = { query, queryTokens, index, options }
    const minConfidence = managerOptions.minConfidence ?? 0

    const active = this.providers.filter(p => isAvailableSafe(p, ctx))

    // ── Run every available provider in parallel. Promise.allSettled means
    // one throwing provider can't take down the others. ──────────────────
    const settled = await Promise.allSettled(active.map(p => p.search(ctx)))

    const providersRun: SearchProviderKind[] = []
    const providerErrors: Partial<Record<SearchProviderKind, string>> = {}
    const perFile = new Map<string, MatchExplanation[]>()

    settled.forEach((outcome, i) => {
      const provider = active[i]

      if (outcome.status === 'rejected') {
        providerErrors[provider.kind] = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        return
      }

      providersRun.push(provider.kind)
      const weight = managerOptions.weightOverrides?.[provider.kind] ?? provider.defaultWeight

      // Deduplicate: a provider may return more than one match for the same
      // file (e.g. two symbols in one file) -- keep only its strongest.
      const bestPerFile = dedupeByFile(outcome.value, minConfidence)

      for (const match of bestPerFile.values()) {
        const list = perFile.get(match.relativePath) ?? []
        list.push({
          provider: provider.kind,
          label: provider.label,
          score: round2(match.score * weight),
          confidence: round2(clamp01(match.confidence)),
          detail: match.detail,
        })
        perFile.set(match.relativePath, list)
      }
    })

    // ── Fuse into a single ranked list ──────────────────────────────────
    let results: HybridSearchResult[] = [...perFile.entries()].map(([relativePath, matchExplanations]) => {
      matchExplanations.sort((a, b) => b.score - a.score)
      const totalScore = round2(
        matchExplanations.reduce((sum, e) => sum + e.score * (0.5 + 0.5 * e.confidence), 0),
      )
      return { relativePath, totalScore, matchExplanations }
    })

    results.sort((a, b) => b.totalScore - a.totalScore)
    if (managerOptions.topK !== undefined) results = results.slice(0, managerOptions.topK)

    return { results, providersRun, providerErrors }
  }
}

// ── Default provider set ────────────────────────────────────────────────

/**
 * Builds a SearchManager wired up with every provider in the framework
 * (semantic, FTS, symbol, AST, regex, filename, dependency graph). AST
 * AST search activates for the structural query patterns it supports.
 */
export function createDefaultSearchManager(): SearchManager {
  return new SearchManager([
    new SymbolSearchProvider(),
    new FilenameSearchProvider(),
    new DependencyGraphProvider(),
    new FTSSearchProvider(),
    new SemanticSearchProvider(),
    new RegexSearchProvider(),
    new ASTSearchProvider(),
  ])
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isAvailableSafe(provider: SearchProvider, ctx: SearchProviderContext): boolean {
  try {
    return provider.isAvailable(ctx)
  } catch {
    return false
  }
}

function dedupeByFile(matches: ProviderMatch[], minConfidence: number): Map<string, ProviderMatch> {
  const best = new Map<string, ProviderMatch>()
  for (const match of matches) {
    if (match.confidence < minConfidence) continue
    const prev = best.get(match.relativePath)
    if (!prev || match.score > prev.score) best.set(match.relativePath, match)
  }
  return best
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
