// lib/repoScanner/types.ts
//
// All TypeScript interfaces used by the Repo Scanner service.
// Kept in a dedicated file so the graph engine and UI layers can import
// without pulling in ts-morph or any scanning logic.

// ── Core Node ─────────────────────────────────────────────────────────────

/** One indexed code symbol (function/class/interface/type/enum/component/export) */
export interface SymbolRecord {
  /** Symbol name, e.g. "AuthProvider", "useLogin", "UserService" */
  name: string
  /** Symbol kind */
  type: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'component' | 'variable' | 'default' | 'style-rule'
  /** 1-based inclusive start line */
  startLine: number
  /** 1-based inclusive end line */
  endLine: number
}

/** A single source file discovered during scanning */
export interface FileNode {
  /** Absolute path on disk */
  path: string
  /** Path relative to the project root, e.g. "src/components/App.tsx" */
  relativePath: string
  /** File extension without the dot, e.g. "ts", "tsx", "js", "jsx" */
  extension: string
  /** Resolved import specifiers from this file (relative paths + bare module names) */
  imports: ImportRecord[]
  /** All top-level exports found in this file */
  exports: ExportRecord[]
  /** Indexed code symbols (functions, classes, interfaces, types, enums, components) */
  symbols: SymbolRecord[]
  /** Light metadata captured without parsing */
  metadata: FileMetadata
  /**
   * Line-windowed chunks with optional embedding vectors, populated only
   * when the scanner is run with `--embed` (see run.ts). Absent otherwise.
   */
  chunks?: EmbeddedChunk[]
}

/**
 * A line-windowed chunk of a file's source, optionally carrying an
 * embedding vector generated via a local embedding model (see embedder.ts).
 */
export interface EmbeddedChunk {
  /** Stable chunk id: "<relativePath>:<startLine>:<endLine>" */
  id: string
  /** Path relative to the project root */
  relativePath: string
  /** 1-based inclusive start line */
  startLine: number
  /** 1-based inclusive end line */
  endLine: number
  /** Chunk source content */
  content: string
  /**
   * Embedding vector for `content`, if `--embed` was passed and the local
   * Ollama server was reachable. Omitted (not just empty) when embedding
   * generation wasn't requested.
   */
  embedding?: number[]
}

// ── Import / Export detail ────────────────────────────────────────────────

/** One import declaration extracted from a file */
export interface ImportRecord {
  /** The raw module specifier as written in source, e.g. "../utils/helpers" */
  specifier: string
  /** Resolved absolute path when the specifier is a relative import; null for bare specifiers */
  resolvedPath: string | null
  /** Named symbols imported: ["useState", "useEffect"] — empty for side-effect-only imports */
  namedImports: string[]
  /** Default import name if present, e.g. "React" */
  defaultImport: string | null
  /** Namespace import name if present, e.g. "fs" for `import * as fs` */
  namespaceImport: string | null
}

/** One export extracted from a file */
export interface ExportRecord {
  /** The exported name, e.g. "MyComponent", "default" */
  name: string
  /** Structural kind of the export */
  kind: ExportKind
}

export type ExportKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'default'
  | 're-export'

// ── Metadata ──────────────────────────────────────────────────────────────

export interface FileMetadata {
  /** File size in bytes */
  sizeBytes: number
  /** Last modification time as ISO-8601 string */
  lastModified: string
  /** Approximate line count (newline-based, fast) */
  lineCount: number
}

// ── Scan Result ───────────────────────────────────────────────────────────

export interface ScanStats {
  projectRoot: string
  scannedAt: string
  totalFiles: number
  totalLines: number
  chunksIndexed?: number
  symbolsIndexed: number
  errors: Record<string, string>
  languages?: import('./languageDetection').RepoLanguageProfile
  elapsedMs?: number
}

export interface ScanFileEvent {
  file: FileNode
  content: string
}

export interface ScanStreamOptions extends ScanOptions {
  onFile: (event: ScanFileEvent) => void | Promise<void>
  onError?: (absolutePath: string, error: string) => void | Promise<void>
}

/** The full output of a scan run */
export interface ScanResult {
  /** Absolute path of the scanned project root */
  projectRoot: string
  /** ISO-8601 timestamp of when the scan completed */
  scannedAt: string
  /** Total number of files discovered */
  totalFiles: number
  /** Total lines across all files */
  totalLines: number
  /** All discovered file nodes, keyed for quick lookup */
  files: FileNode[]
  /** Any paths that failed to parse (path → error message) */
  errors: Record<string, string>
  /**
   * Language composition of this scan, detected before any parser pipeline
   * ran (see languageDetection.ts). Optional for backward compatibility
   * with any code constructing a ScanResult-shaped object by hand; always
   * populated by RepoScanner.scan().
   */
  languages?: import('./languageDetection').RepoLanguageProfile
}

// ── Config ────────────────────────────────────────────────────────────────

/** Options accepted by RepoScanner.scan() */
export interface ScanOptions {
  /** Absolute path to the project root directory */
  projectRoot: string
  /**
   * Additional directory names to ignore (merged with the built-in list:
   * node_modules, dist, build, .git, .next, out, coverage)
   */
  extraIgnoreDirs?: string[]
  /**
   * Additional file extensions to include (merged with: ts, tsx, js, jsx)
   * — provide WITHOUT the leading dot, e.g. ["mts", "mjs"]
   */
  extraExtensions?: string[]
  /**
   * Maximum number of files to process concurrently.
   * Default: 20 — balances CPU and memory on large repos.
   */
  concurrency?: number
  /**
   * When set, only these absolute file paths are scanned (incremental mode).
   * All other discovery is skipped.  Used by the file-watcher to re-index
   * only changed files without a full project re-scan.
   */
  onlyFiles?: string[]
}

// ── File Summaries ───────────────────────────────────────────────────────
//
// Lightweight, retrieval-friendly metadata generated for every file during
// indexing. Summaries are small enough to send for the *entire* repo as
// part of an AI context window, letting the model decide which files are
// worth fetching in full.

/** Compact, retrieval-oriented description of a single file */
export interface FileSummary {
  /** Path relative to the project root (matches FileNode.relativePath) */
  path: string
  /**
   * Short natural-language description covering:
   *  - the file's main responsibility
   *  - important components / classes / functions it defines
   *  - its purpose within the project
   */
  summary: string
  /** Names of symbols this file exports (mirrors FileNode.exports[].name) */
  exports: string[]
  /** Raw import specifiers referenced by this file (mirrors FileNode.imports[].specifier) */
  imports: string[]
}

/**
 * Optional hook for higher-quality, model-generated summaries.
 * Return `null`/`undefined`/empty string to fall back to the built-in
 * heuristic summary for that file.
 */
export type CustomSummarizer = (file: FileNode) => string | null | undefined | Promise<string | null | undefined>

export interface SummarizeOptions {
  /** Optional LLM-backed (or otherwise custom) summarizer, used per-file */
  customSummarizer?: CustomSummarizer
  /**
   * Maximum number of files summarized concurrently when a (potentially
   * async/network-bound) customSummarizer is supplied. Default: 5.
   */
  concurrency?: number
}

// ── Dependency Graph ──────────────────────────────────────────────────────

/** Adjacency information for one file, keyed by relativePath */
export interface DependencyGraphEntry {
  /** relativePaths of files this file imports from (resolved, in-repo only) */
  dependsOn: string[]
  /** relativePaths of files that import from this file */
  dependedOnBy: string[]
}

/** Full project dependency graph, keyed by relativePath */
export type DependencyGraph = Record<string, DependencyGraphEntry>

// ── Repo Index ────────────────────────────────────────────────────────────
//
// The persisted artifact produced by `buildRepoIndex()`. Combines the raw
// ScanResult with generated FileSummaries and a precomputed dependency graph
// so retrieval/context-building never needs to re-scan or re-parse.

export interface RepoIndex {
  /** Absolute path of the scanned project root */
  projectRoot: string
  /** ISO-8601 timestamp of the underlying scan */
  scannedAt: string
  /** ISO-8601 timestamp of when summaries/index were generated */
  generatedAt: string
  /** Total number of files discovered */
  totalFiles: number
  /** Total lines across all files */
  totalLines: number
  /** All discovered file nodes (full parsed detail) */
  files: FileNode[]
  /** Per-file retrieval summaries, in the same order as `files` */
  summaries: FileSummary[]
  /** Precomputed import/export dependency graph, keyed by relativePath */
  dependencyGraph: DependencyGraph
  /** Any paths that failed to parse during scanning */
  errors: Record<string, string>
}

// ── Retrieval Ranking ─────────────────────────────────────────────────────

/** Default number of files returned by rankFiles()/buildContext() */
export const DEFAULT_TOP_K = 5

export interface RetrievalOptions {
  /**
   * Maximum number of files to return, sorted by descending relevance.
   * Default: DEFAULT_TOP_K (5).
   */
  topK?: number

  /**
   * Editor context metadata used as a retrieval ranking signal.
   *
   * IMPORTANT: These paths are used ONLY to boost retrieval scores —
   * actual file content is NEVER injected automatically. Content is
   * only included when retrieval determines a file is relevant to the
   * user's query (respecting token budgets).
   *
   * Provide relative paths (relative to project root) matching the
   * relativePath values stored in the RepoIndex.
   */
  activeFilePaths?: {
    /** The file currently open and focused in the editor. Gets the highest boost. */
    currentFile?: string
    /** All files open in editor tabs. Get a moderate boost. */
    openFiles?: string[]
    /** Files recently edited in this session. Get a small boost. */
    recentlyEditedFiles?: string[]
  }

  /**
   * Pre-loaded vector index for semantic (embedding) retrieval.
   * When provided, cosine similarity scores are blended into the final
   * ranking via the hybrid ranker.  When absent, only keyword/symbol/
   * dependency scoring is used (same behaviour as before).
   */
  vectorIndex?: import('./vectorIndex').VectorIndex

  /**
   * Embedding provider used to encode the query when `vectorIndex` is
   * supplied.  Defaults to the built-in LocalEmbeddingProvider.
   */
  embeddingProvider?: import('./embeddingProvider').EmbeddingProvider

  /**
   * Weight applied to the vector similarity score when blending with
   * keyword / symbol scores.  Default: 2.0.
   * Increase to make semantic similarity dominate; decrease to let
   * keyword matching dominate.
   */
  vectorWeight?: number

  /**
   * Override automatic query-intent detection (see intentDetector.ts).
   * When omitted, intent is inferred from the query text and used to bias
   * which retrieval stage (symbol/path/import/keyword/embedding) carries
   * the most weight and how far the dependency graph is expanded.
   */
  intent?: import('./intentDetector').QueryIntent

  /**
   * Explicit regex pattern (source string, no slashes) for RegexSearchProvider
   * to run against file contents, e.g. "TODO|FIXME". When omitted,
   * RegexSearchProvider is inactive unless `useRegexFallback` is set.
   */
  regexPattern?: string

  /** Flags passed to `new RegExp(regexPattern, regexFlags)`. Default: "gi". */
  regexFlags?: string

  /**
   * When true and `regexPattern` is not set, RegexSearchProvider treats the
   * raw query text itself as a regex pattern. Off by default since most
   * queries are natural language, not valid/intended regex source.
   */
  useRegexFallback?: boolean
}

/** A single candidate file with its computed relevance score breakdown */
export interface ScoredFile {
  /** Path relative to the project root */
  relativePath: string
  /** Keyword / text overlap against summary, path, exports and symbols */
  semanticScore: number
  /** Boost derived from dependency-graph proximity to other strong matches */
  dependencyScore: number
  /** Boost from query terms matching indexed symbol names */
  symbolScore: number
  /**
   * Vector embedding cosine-similarity score (0–1 scaled).
   * Zero when the vector index is not available or the file has no entries.
   */
  vectorScore: number
  /**
   * Boost applied when the file matches editor context metadata
   * (current file > open tabs > recently edited).
   * Only non-zero when activeFilePaths is provided to rankFiles().
   */
  activeFileBoost: number
  /** semanticScore + dependencyScore + symbolScore + vectorScore + activeFileBoost */
  totalScore: number
  /**
   * Per-provider breakdown of what contributed to this result, for
   * debugging/transparency in the UI (see searchProviders/). Optional and
   * additive -- existing consumers that only read the numeric score fields
   * above are unaffected. Populated by hybridRetrieve()/rankFiles() and by
   * SearchManager.search().
   */
  matchExplanations?: MatchExplanation[]
}

// -- Search Provider Framework ---------------------------------------------
//
// See ./searchProviders/ for the pluggable provider implementations
// (SemanticSearchProvider, FTSSearchProvider, SymbolSearchProvider,
// ASTSearchProvider, RegexSearchProvider, FilenameSearchProvider,
// DependencyGraphProvider) and SearchManager, which runs them in parallel
// and fuses their output. Kept here (rather than in searchProviders/types.ts)
// so ScoredFile can reference MatchExplanation without a circular import.

/** Identifies which search provider produced a given match/explanation. */
export type SearchProviderKind =
  | 'semantic'
  | 'fts'
  | 'symbol'
  | 'ast'
  | 'regex'
  | 'filename'
  | 'dependency_graph'

/**
 * Explains one provider's contribution to a single search result: which
 * provider fired, the (weighted) score it contributed, how confident that
 * provider was in the match, and an optional human-readable detail (e.g.
 * matched symbol "AuthProvider") for debugging/transparency in the UI.
 */
export interface MatchExplanation {
  provider: SearchProviderKind
  /** Human-readable provider name, e.g. "Symbol", "Full-Text Search". */
  label: string
  /** This provider's weighted score contribution. */
  score: number
  /** This provider's confidence in the match, in [0, 1]. */
  confidence: number
  /** Optional human-readable detail about the match. */
  detail?: string
}

// ── Semantic / Vector Retrieval ───────────────────────────────────────────

/**
 * A single chunk hit from the vector index, ready to surface in retrieval
 * results or the hybrid ranker.
 */
export interface VectorChunkHit {
  /** Stable chunk id: "<relativePath>:<startLine>:<endLine>" */
  id: string
  /** Path relative to the project root */
  relativePath: string
  /** Symbol name or filename this chunk represents */
  symbolName: string
  /** 1-based inclusive start line */
  startLine: number
  /** 1-based inclusive end line */
  endLine: number
  /** Chunk source content */
  content: string
  /** Cosine similarity in [0, 1] */
  similarity: number
}

// ── Context Building ─────────────────────────────────────────────────────

export interface ContextBuildOptions extends RetrievalOptions {
  /**
   * Files at or below this line count are sent in full once ranked into the
   * top results. Larger files are reduced to relevant chunks instead.
   * Default: 300.
   */
  maxFullFileLines?: number
  /**
   * Number of extra lines of surrounding context included above/below each
   * matched symbol when a file is chunked. Default: 8.
   */
  chunkPadding?: number
  /**
   * When true (default), summaries for *every* indexed file are included so
   * the model has a map of the whole repo, not just the top results.
   */
  includeAllSummaries?: boolean
}

/** A chunk of source extracted from a larger file around a relevant symbol */
export interface ContextChunk {
  /** Symbol name this chunk was extracted for */
  symbol: string
  /** 1-based inclusive start line within the original file (including padding) */
  startLine: number
  /** 1-based inclusive end line within the original file (including padding) */
  endLine: number
  /** Extracted source text for this range */
  content: string
}

/** Full or partial content for one top-ranked file, ready for an AI prompt */
export interface ContextFile {
  /** Path relative to the project root */
  relativePath: string
  /** Relevance score this file was ranked with */
  score: ScoredFile
  /**
   * True when `content` is the full file; false when `chunks` were used
   * instead because the file exceeded `maxFullFileLines`.
   */
  isFullFile: boolean
  /** Full file content — present only when `isFullFile` is true */
  content?: string
  /** Relevant excerpts — present only when `isFullFile` is false */
  chunks?: ContextChunk[]
}

/** The assembled AI context: lightweight repo map + full detail for top files */
export interface BuiltContext {
  /** The retrieval query this context was built for */
  query: string
  /** Summaries for all (or all relevant) indexed files — sent first */
  summaries: FileSummary[]
  /** Ranked candidates, in descending score order */
  ranked: ScoredFile[]
  /** Full content (or relevant chunks) for the top-ranked files */
  files: ContextFile[]
}
