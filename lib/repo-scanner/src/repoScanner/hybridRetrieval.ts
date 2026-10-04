// lib/repoScanner/hybridRetrieval.ts
//
// Claude-Code-style hybrid retrieval pipeline (replaces fake-embedding
// primary ranking — see embeddingProvider.ts header for why).
//
// ── Retrieval flow ───────────────────────────────────────────────────────
//
//   query
//     │
//     ├─ A.1 exact symbol search   (classes/functions/methods/...)  ─┐
//     ├─ A.2 path search           (filename/folder/import match)   ├─ deterministic,
//     ├─ A.3 BM25 keyword search   (code-aware tokenized text)      ─┘ always run
//     └─ A.4 embedding similarity  (ONLY when stages 1–3 are weak)   — fallback only
//             │
//             ▼
//   B. Weighted ranking  (symbol > path > import/keyword > embedding)
//             │
//             ▼
//   C. Intent bias        (detectIntent() reweights the above per query type)
//             │
//             ▼
//   D. 1-hop graph expansion  (propagate score to import/export neighbors
//                              of the top-ranked files; bug-fix/architecture
//                              intents expand 2 hops)
//             │
//             ▼
//   Final ScoredFile[] sorted by totalScore, truncated to topK
//
// Stages A.1–A.3 run on every query and are fully deterministic — same
// query + same index always produces the same ranking. The embedding
// fallback (A.4) only activates when the deterministic stages return weak
// or no signal (e.g. a very vague query), and even then its contribution
// is capped low by HYBRID_WEIGHTS so it can never out-rank a real symbol
// or filename match.

import type { FileNode, RepoIndex, RetrievalOptions, ScoredFile, MatchExplanation } from './types'
import { DEFAULT_TOP_K } from './types'
import { tokenize } from './tokenizer'
import { exactSymbolSearch, pathSearch, scoreSymbolMatches, scorePathMatches } from './symbolSearch'
import { detectIntent, getIntentBias, type QueryIntent } from './intentDetector'
import { semanticSearch } from './semanticRetrieval'
import {
  GeminiEmbeddingProvider,
  defaultEmbeddingProvider as localEmbeddingProvider,
  type EmbeddingProvider,
} from './embeddingProvider'

// The deterministic stages below (symbol/path/keyword search, dependency-
// graph expansion) are now implemented as pluggable SearchProviders (see
// ./searchProviders/). hybridRetrieve() calls the same underlying
// functions those providers wrap directly -- rather than going through
// SearchManager -- so its numeric output (totalScore etc.) stays exactly
// backward compatible for existing callers. It additionally attaches
// `matchExplanations` (built from the same per-stage scores) to each
// ScoredFile so the UI can show which provider(s) contributed to a result.
import { getOrBuildBM25 } from './searchProviders/FTSSearchProvider'
import { expandScoresViaDependencyGraph } from './searchProviders/DependencyGraphProvider'

// ── Tuning constants ─────────────────────────────────────────────────────

/**
 * Base weights applied to each stage BEFORE intent bias is multiplied in.
 * Ordering encodes the spec's ranking priority:
 *   symbol match (highest) > filename match (high) >
 *   import/reference match & keyword match (medium) > embedding (lowest).
 */
const HYBRID_WEIGHTS = {
  symbol: 1.0,
  path: 0.7,
  import: 0.45,
  keyword: 0.4,   // BM25 scores are on a different scale than the rest —
                  // this weight is tuned so a strong BM25 hit lands near a
                  // medium path/import match, never above a symbol match.
  vector: 0.15,   // always the smallest multiplier — fallback signal only.
  dependencyPropagation: 0.3, // fraction of a file's direct score given to its 1-hop graph neighbors
}

/** Only fall back to embedding similarity when deterministic stages are this weak. */
const EMBEDDING_FALLBACK_THRESHOLD = 1.5

/**
 * Resolves the embedding provider used for the query-time embedding
 * fallback (Stage A.4 below). Pass a Gemini API key to use the
 * higher-quality GeminiEmbeddingProvider (`text-embedding-004`); omit it
 * (or pass an empty string) to keep using the built-in, zero-dependency
 * LocalEmbeddingProvider — the previous default behaviour. Network/API
 * failures inside GeminiEmbeddingProvider already fall back to
 * LocalEmbeddingProvider internally, so this never throws.
 */
export function defaultEmbeddingProvider(apiKey?: string): EmbeddingProvider {
  return apiKey ? new GeminiEmbeddingProvider(apiKey) : localEmbeddingProvider
}

const ACTIVE_FILE_BOOST = 1.8
const OPEN_FILE_BOOST = 0.9
const RECENT_EDIT_BOOST = 0.45

/** Extension boost applied when intent.preferredExtensions matches the file (e.g. frontend intent → html/css). */
const EXTENSION_INTENT_BOOST = 1.0

// ── Public API ────────────────────────────────────────────────────────────

export interface HybridRetrievalResult {
  scored: ScoredFile[]
  intent: QueryIntent
}

/**
 * Runs the full multi-stage hybrid retrieval pipeline against `index` for
 * `query` and returns ranked, scored files (already sorted + truncated to
 * `options.topK`).
 */
export async function hybridRetrieve(
  query: string,
  index: RepoIndex,
  options: RetrievalOptions = {},
): Promise<HybridRetrievalResult> {
  const topK = options.topK ?? DEFAULT_TOP_K
  const queryTokens = tokenize(query)
  const intent = options.intent ?? detectIntent(query)
  const bias = getIntentBias(intent)

  const activeBoosts = buildActiveFileBoostMap(options.activeFilePaths)

  // No usable query text and no editor context — fall back to "most
  // connected files" so the model still gets something useful for repo-wide
  // questions like "give me an overview".
  if (queryTokens.length === 0 && activeBoosts.size === 0) {
    const scored = index.files
      .slice()
      .sort((a, b) => degree(index, b.relativePath) - degree(index, a.relativePath))
      .slice(0, topK)
      .map(f => zeroScore(f.relativePath))
    return { scored, intent }
  }

  // ── Stage A.1 — exact symbol search ─────────────────────────────────────
  const symbolMatches = exactSymbolSearch(queryTokens, index.files)
  const symbolScoreMap = scoreSymbolMatches(symbolMatches)

  // ── Stage A.2 — path search ──────────────────────────────────────────────
  const pathMatches = pathSearch(queryTokens, index.files)
  const { pathScore: pathScoreMap, importScore: importScoreMap } = scorePathMatches(pathMatches)

  // ── Stage A.3 — BM25 keyword search ─────────────────────────────────────
  const bm25 = getOrBuildBM25(index)
  const bm25ScoreMap = bm25.search(queryTokens)

  // ── Combine deterministic stages per file ───────────────────────────────
  const scores = new Map<string, ScoredFile>()
  for (const file of index.files) {
    const symbolRaw = symbolScoreMap.get(file.relativePath) ?? 0
    const pathRaw = pathScoreMap.get(file.relativePath) ?? 0
    const importRaw = importScoreMap.get(file.relativePath) ?? 0
    const keywordRaw = bm25ScoreMap.get(file.relativePath) ?? 0

    const symbolScore = round2(symbolRaw * HYBRID_WEIGHTS.symbol * bias.symbolWeight)
    const semanticScore = round2(
      pathRaw * HYBRID_WEIGHTS.path * bias.pathWeight +
      keywordRaw * HYBRID_WEIGHTS.keyword * bias.keywordWeight
    )
    const extensionBoost = matchesPreferredExtension(file, bias.preferredExtensions)
      ? EXTENSION_INTENT_BOOST
      : 0
    const activeFileBoost = round2(activeBoosts.get(normPath(file.relativePath)) ?? 0)

    // importRaw is tracked separately so Stage D can read it, but it folds
    // into dependencyScore alongside graph propagation below.
    const dependencyScoreBase = round2(importRaw * HYBRID_WEIGHTS.import * bias.importWeight)

    scores.set(file.relativePath, {
      relativePath: file.relativePath,
      semanticScore: round2(semanticScore + extensionBoost),
      symbolScore,
      dependencyScore: dependencyScoreBase,
      vectorScore: 0,
      activeFileBoost,
      totalScore: 0, // finalized below
    })
  }

  // ── Stage A.4 — embedding fallback (only when deterministic signal is weak) ──
  const strongestDeterministic = Math.max(
    0,
    ...[...scores.values()].map(s => s.symbolScore + s.semanticScore + s.dependencyScore)
  )
  const fileVectorScore = new Map<string, number>()
  if (options.vectorIndex && strongestDeterministic < EMBEDDING_FALLBACK_THRESHOLD) {
    const provider = options.embeddingProvider ?? defaultEmbeddingProvider()
    const vectorTopK = Math.min(options.vectorIndex.size, Math.max(topK * 10, 50))
    const vectorHits = await semanticSearch(query, options.vectorIndex, vectorTopK, provider)

    for (const hit of vectorHits) {
      const prev = fileVectorScore.get(hit.relativePath) ?? 0
      if (hit.similarity > prev) fileVectorScore.set(hit.relativePath, hit.similarity)
    }

    for (const [relPath, vecSim] of fileVectorScore) {
      const entry = scores.get(relPath)
      if (!entry) continue
      entry.vectorScore = round2(vecSim * HYBRID_WEIGHTS.vector * bias.vectorWeight * 10) // scale 0-1 sim into comparable range
    }
  }

  // ── Stage D — repository graph expansion (1 hop, or 2 for bug-fix/architecture) ──
  // Delegates to the shared expandScoresViaDependencyGraph() fusion utility
  // (searchProviders/DependencyGraphProvider.ts) rather than looping inline
  // — same math as before, now reused by anything built on the provider
  // framework too.
  const seedScores = new Map<string, number>()
  for (const [relPath, score] of scores) {
    const directScore = score.symbolScore + score.semanticScore + score.vectorScore
    if (directScore > 0) seedScores.set(relPath, directScore)
  }
  const propagated = expandScoresViaDependencyGraph(
    index.dependencyGraph,
    seedScores,
    bias.graphHops,
    HYBRID_WEIGHTS.dependencyPropagation,
  )
  for (const [relPath, boost] of propagated) {
    const entry = scores.get(relPath)
    if (entry) entry.dependencyScore += boost
  }

  // ── Finalize ─────────────────────────────────────────────────────────────
  const ranked = [...scores.values()].map(s => {
    const dependencyScore = round2(s.dependencyScore)
    const totalScore = round2(s.symbolScore + s.semanticScore + s.vectorScore + dependencyScore + s.activeFileBoost)
    return {
      ...s,
      dependencyScore,
      totalScore,
      matchExplanations: buildMatchExplanations({
        symbolRaw: symbolScoreMap.get(s.relativePath) ?? 0,
        symbolScore: s.symbolScore,
        pathRaw: pathScoreMap.get(s.relativePath) ?? 0,
        importRaw: importScoreMap.get(s.relativePath) ?? 0,
        importScore: round2((importScoreMap.get(s.relativePath) ?? 0) * HYBRID_WEIGHTS.import * bias.importWeight),
        keywordRaw: bm25ScoreMap.get(s.relativePath) ?? 0,
        keywordScore: round2((bm25ScoreMap.get(s.relativePath) ?? 0) * HYBRID_WEIGHTS.keyword * bias.keywordWeight),
        pathScore: round2((pathScoreMap.get(s.relativePath) ?? 0) * HYBRID_WEIGHTS.path * bias.pathWeight),
        vectorSimilarity: fileVectorScore.get(s.relativePath) ?? 0,
        vectorScore: s.vectorScore,
        graphPropagatedScore: round2(propagated.get(s.relativePath) ?? 0),
      }),
    }
  })

  ranked.sort((a, b) => b.totalScore - a.totalScore)
  return { scored: ranked.slice(0, topK), intent }
}

// ── Match explanations ────────────────────────────────────────────────────
//
// Builds the per-provider breakdown attached to each ScoredFile, using the
// same raw/weighted numbers already computed above for that file — no
// extra search work, and guaranteed consistent with the numeric totals.

interface ExplanationInputs {
  symbolRaw: number
  symbolScore: number
  pathRaw: number
  pathScore: number
  importRaw: number
  importScore: number
  keywordRaw: number
  keywordScore: number
  vectorSimilarity: number
  vectorScore: number
  graphPropagatedScore: number
}

function buildMatchExplanations(inputs: ExplanationInputs): MatchExplanation[] {
  const explanations: MatchExplanation[] = []

  if (inputs.symbolRaw > 0) {
    explanations.push({
      provider: 'symbol',
      label: 'Symbol',
      score: inputs.symbolScore,
      confidence: round2(Math.min(1, inputs.symbolRaw)),
      detail: `raw symbol match score ${round2(inputs.symbolRaw)}`,
    })
  }

  if (inputs.pathRaw > 0) {
    explanations.push({
      provider: 'filename',
      label: 'Filename',
      score: inputs.pathScore,
      confidence: round2(Math.min(1, inputs.pathRaw)),
      detail: `raw filename/folder match score ${round2(inputs.pathRaw)}`,
    })
  }

  if (inputs.importRaw > 0) {
    explanations.push({
      provider: 'dependency_graph',
      label: 'Dependency Graph',
      score: inputs.importScore,
      confidence: round2(Math.min(1, inputs.importRaw)),
      detail: 'matched import specifier',
    })
  }

  if (inputs.graphPropagatedScore > 0) {
    explanations.push({
      provider: 'dependency_graph',
      label: 'Dependency Graph',
      score: inputs.graphPropagatedScore,
      confidence: 0.4, // indirect (propagated from a neighbor), always lower than a direct match
      detail: 'propagated from a related file via the import graph',
    })
  }

  if (inputs.keywordRaw > 0) {
    explanations.push({
      provider: 'fts',
      label: 'Full-Text Search',
      score: inputs.keywordScore,
      confidence: round2(Math.min(1, inputs.keywordRaw / 5)),
      detail: `BM25 keyword score ${round2(inputs.keywordRaw)}`,
    })
  }

  if (inputs.vectorScore > 0) {
    explanations.push({
      provider: 'semantic',
      label: 'Semantic',
      score: inputs.vectorScore,
      confidence: round2(inputs.vectorSimilarity),
      detail: `embedding cosine similarity ${round2(inputs.vectorSimilarity)}`,
    })
  }

  return explanations.sort((a, b) => b.score - a.score)
}

// ── Active-file boost map (unchanged behavior from the legacy ranker) ─────

function buildActiveFileBoostMap(activeFilePaths?: RetrievalOptions['activeFilePaths']): Map<string, number> {
  const map = new Map<string, number>()
  if (!activeFilePaths) return map

  const add = (rawPath: string | undefined | null, boost: number) => {
    if (!rawPath) return
    const key = normPath(rawPath)
    const existing = map.get(key) ?? 0
    if (boost > existing) map.set(key, boost)
  }

  add(activeFilePaths.currentFile, ACTIVE_FILE_BOOST)
  for (const p of activeFilePaths.openFiles ?? []) add(p, OPEN_FILE_BOOST)

  const recent = activeFilePaths.recentlyEditedFiles ?? []
  for (let i = 0; i < recent.length; i++) {
    add(recent[i], round2(RECENT_EDIT_BOOST * Math.pow(0.85, i)))
  }

  return map
}

function matchesPreferredExtension(file: FileNode, preferred: string[]): boolean {
  if (preferred.length === 0) return false
  return preferred.includes(file.extension.toLowerCase())
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

function degree(index: RepoIndex, relativePath: string): number {
  const entry = index.dependencyGraph[relativePath]
  if (!entry) return 0
  return entry.dependsOn.length + entry.dependedOnBy.length
}

function zeroScore(relativePath: string): ScoredFile {
  return { relativePath, semanticScore: 0, symbolScore: 0, dependencyScore: 0, vectorScore: 0, activeFileBoost: 0, totalScore: 0 }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}