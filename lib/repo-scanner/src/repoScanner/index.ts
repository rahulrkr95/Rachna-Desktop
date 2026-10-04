// lib/repoScanner/index.ts
//
// Public API surface of the Repo Scanner module.
// Consumers should import only from this file.
//
// @example
//   import { repoScanner, RepoScanner } from '../repoScanner'
//   import type { ScanResult, FileNode, ImportRecord } from '../repoScanner'

export { RepoScanner, repoScanner } from './scanner'

export type {
  // Core node
  FileNode,
  ImportRecord,
  ExportRecord,
  ExportKind,
  FileMetadata,
  SymbolRecord,

  // Scan lifecycle
  ScanResult,
  ScanOptions,

  // File summaries
  FileSummary,
  CustomSummarizer,
  SummarizeOptions,

  // Dependency graph
  DependencyGraph,
  DependencyGraphEntry,

  // Repo index (persisted summaries + dependency graph)
  RepoIndex,

  // Retrieval ranking
  RetrievalOptions,
  ScoredFile,

  // Context building
  ContextBuildOptions,
  ContextChunk,
  ContextFile,
  BuiltContext,
} from './types'

export { DEFAULT_TOP_K } from './types'

// Re-export parseFile lazily, for advanced/testing use cases only.
// A static `export { parseFile } from './fileParser'` would `require()`
// fileParser.ts (and therefore ts-morph) the moment ANYTHING imports this
// package's entry point — defeating the point of lazy-loading ts-morph
// inside the scanner. Nothing in this codebase uses parseFile directly;
// callers that need it can await getParseFile().
export async function getParseFile() {
  const { parseFile } = await import('./fileParser')
  return parseFile
}
export type { ParsedFile } from './fileParser'

// ── Language detection ──────────────────────────────────────────────────
// Classifies files by language/pipeline and summarizes a repo's (or scan
// batch's) language composition — used by the scanner to decide whether
// ts-morph needs to be initialized at all. No ts-morph dependency.
export { detectRepositoryLanguages, TS_JS_EXTS, HTML_EXTS, CSS_EXTS } from './languageDetection'
export type { RepoLanguageProfile, LanguageStat, ScannerPipeline } from './languageDetection'

// Re-export pure utils so callers can reuse them without reimplementing
export {
  extOf,
  toRelative,
  resolveRelativeImport,
  isRelativeSpecifier,
  countLines,
  pLimit,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_EXTENSIONS,
} from './utils'

// ── Alias-aware import resolver ───────────────────────────────────────────
export { resolveImport, loadProjectConfig, invalidateConfigCache } from './importResolver'
export type { ProjectConfig } from './importResolver'

// ── File summaries ─────────────────────────────────────────────────────────
export { generateFileSummary, generateFileSummaries } from './summarizer'

// ── Dependency graph ──────────────────────────────────────────────────────
export { buildDependencyGraph, neighborsOf } from './dependencyGraph'

// ── Repo index (build + persist) ───────────────────────────────────────────
export {
  buildRepoIndex,
  saveRepoIndex,
  loadRepoIndex,
  repoIndexExists,
  DEFAULT_INDEX_FILENAME,
  LEGACY_INDEX_FILENAME,
  buildOrUpdateVectorIndex,
  loadVectorIndex,
  // New SQLite-specific APIs
  openRepoIndexDb,
  upsertRepoIndex,
} from './repoIndex'

// ── SQLite index store (lazy / incremental access) ─────────────────────────
export { RepoIndexDb, DEFAULT_INDEX_DB_FILENAME } from './repoIndexDb'

// ── Retrieval ranking ───────────────────────────────────────────────────────
export { rankFiles, tokenize } from './retrieval'

// ── Hybrid retrieval (multi-stage: symbol/path/keyword/embedding-fallback) ──
export { hybridRetrieve } from './hybridRetrieval'
export type { HybridRetrievalResult } from './hybridRetrieval'
export { detectIntent, getIntentBias } from './intentDetector'
export type { QueryIntent, IntentBias } from './intentDetector'
export { exactSymbolSearch, pathSearch, SYMBOL_KIND_WEIGHT } from './symbolSearch'
export type { SymbolMatch, PathMatch } from './symbolSearch'
export { BM25Index } from './bm25'
export type { BM25Document } from './bm25'

// ── AI context building ─────────────────────────────────────────────────────
export { buildContext, extractRelevantChunks } from './contextBuilder'

// ── Vector index ────────────────────────────────────────────────────────────
export { VectorIndex, VECTOR_INDEX_FILENAME } from './vectorIndex'
export type { VectorEntry, VectorSearchResult } from './vectorIndex'

// ── Embedding provider ──────────────────────────────────────────────────────
export {
  LocalEmbeddingProvider,
  defaultEmbeddingProvider,
  buildEmbeddingText,
} from './embeddingProvider'
export type { EmbeddingProvider, ChunkEmbeddingInput } from './embeddingProvider'

// ── Semantic retrieval ──────────────────────────────────────────────────────
export {
  buildVectorIndex,
  updateVectorIndex,
  semanticSearch,
} from './semanticRetrieval'
export type { BuildVectorIndexOptions, SemanticSearchResult } from './semanticRetrieval'

// ── Types (new semantic additions) ─────────────────────────────────────────
export type { VectorChunkHit } from './types'

// ── Match explanations (new: which provider(s) contributed to a result) ────
export type { MatchExplanation, SearchProviderKind } from './types'

// ── Search Provider Framework ───────────────────────────────────────────────
//
// Pluggable search providers (Semantic, FTS, Symbol, AST, Regex, Filename,
// Dependency Graph) with a common interface, plus SearchManager, which runs
// them in parallel, merges/dedupes results, and produces a single
// hybrid-ranked, explainable result list. hybridRetrieve()/rankFiles() above
// remain the primary, backward-compatible retrieval API and now attach
// `matchExplanations` to every ScoredFile using these same underlying
// stages; use SearchManager directly for the new pluggable-provider
// workflow (e.g. adding a custom provider, or surfacing full per-provider
// debug info in the UI).
export {
  SymbolSearchProvider,
  FilenameSearchProvider,
  DependencyGraphProvider,
  expandScoresViaDependencyGraph,
  FTSSearchProvider,
  getOrBuildBM25,
  SemanticSearchProvider,
  RegexSearchProvider,
  ASTSearchProvider,
  SearchManager,
  createDefaultSearchManager,
} from './searchProviders'
export type {
  SearchProvider,
  SearchProviderContext,
  ProviderMatch,
  SearchManagerOptions,
  HybridSearchResult,
  SearchManagerRunResult,
} from './searchProviders'

