// lib/chunkSearch.ts
//
// Thin wrapper around the `search_repo` Tauri command.
//
// This is the ONLY file the React/AI layer needs to touch when adding
// retrieval to the chat pipeline.  Keep this file free of UI or AI logic.
//
// Architecture:
//   React UI
//     ↓  searchChunks(query)
//   lib/chunkSearch.ts          ← you are here
//     ↓  invoke('search_repo')
//   src-tauri/src/commands.rs   (search_repo command)
//     ↓  db::search_chunks()
//   SQLite  chunks / chunks_fts

import { invoke } from '@tauri-apps/api/core'

// ── FTS query sanitization ──────────────────────────────────────────────

/**
 * Common English stop-words stripped out when extracting search keywords
 * from a natural-language question. Kept intentionally small — we only
 * want to drop words that add noise to FTS matching, not words that could
 * plausibly be meaningful identifiers.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'do', 'does', 'did', 'doing',
  'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must',
  'of', 'on', 'in', 'at', 'to', 'for', 'with', 'about', 'as', 'by', 'from',
  'and', 'or', 'but', 'if', 'than',
  'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'our', 'their', 'its',
  'please', 'show', 'tell', 'give', 'find', 'me',
])

/**
 * Sanitizes a raw string for safe use as a SQLite FTS5 MATCH query.
 *
 * FTS5 treats `? : " ' ( ) [ ] * ^ - .` (and a few others) as syntax —
 * passing a raw natural-language question (e.g. one containing `?`)
 * directly into `MATCH` throws `fts5: syntax error near "?"`.
 *
 * This function:
 *   - Removes FTS5 special/operator characters entirely (rather than
 *     escaping), since for retrieval purposes we just want the bare terms.
 *   - Collapses whitespace.
 *   - Drops empty/leftover tokens.
 *
 * The result is a plain space-separated list of terms, which FTS5 treats
 * as an implicit AND of bare tokens — always syntactically valid.
 *
 * NOTE: a raw user question must NEVER be passed directly to FTS MATCH.
 * Always sanitize (and prefer {@link extractSearchTerms} for queries that
 * are full natural-language questions).
 */
export function sanitizeFtsQuery(raw: string): string {
  if (!raw) return ''

  return raw
    // Strip FTS5 special / operator characters: ? : " ' ( ) [ ] * ^ - + . , ! ; { } < > = ~ / \ |
    .replace(/[?:"'()[\]*^\-+.,!;{}<>=~/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Converts a natural-language question into a compact set of search
 * keywords suitable for FTS5 retrieval.
 *
 * Steps:
 *   1. Sanitize FTS-special characters (via {@link sanitizeFtsQuery}).
 *   2. Lowercase and split into tokens.
 *   3. Drop common English stop-words (what/are/the/offered/etc.) and
 *      tokens shorter than 2 chars.
 *   4. Re-join the remaining tokens, preserving original relative order.
 *
 * Example:
 *   "What are the software dev packages offered?"
 *     -> "software dev packages offered"
 *
 * If stop-word removal would leave nothing useful (e.g. a query made
 * entirely of stop-words), falls back to the sanitized-but-unfiltered
 * token list so callers always get *something* to search with.
 */
export function extractSearchTerms(question: string): string {
  const sanitized = sanitizeFtsQuery(question)
  if (!sanitized) return ''

  const tokens = sanitized.split(' ').filter(Boolean)

  const filtered = tokens.filter(
    t => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()),
  )

  return (filtered.length > 0 ? filtered : tokens).join(' ')
}

// ── Filename fallback search ────────────────────────────────────────────

/** Keywords that suggest the user is asking about pricing/offerings/services pages. */
const FALLBACK_FILENAME_HINTS = [
  'service', 'services',
  'package', 'packages',
  'pricing', 'price', 'prices',
  'offering', 'offerings',
  'solution', 'solutions',
  'plan', 'plans',
  'product', 'products',
]

/**
 * Returns true if `term` (already lowercase) looks like it's hinting at
 * a services/pricing/offerings-style page, for use by the filename
 * fallback search.
 */
function isFilenameHintTerm(term: string): boolean {
  return FALLBACK_FILENAME_HINTS.some(
    hint => term.includes(hint) || hint.includes(term),
  )
}

/**
 * Extracts the subset of extracted search terms that look like filename
 * hints (services, packages, pricing, offerings, solutions, ...), for use
 * by the filename-fallback search when FTS returns zero results.
 */
export function extractFilenameHints(terms: string): string[] {
  return terms
    .split(' ')
    .map(t => t.toLowerCase())
    .filter(Boolean)
    .filter(isFilenameHintTerm)
}

// ── Types ─────────────────────────────────────────────────────────────────

/** A single code chunk returned by the FTS5 search. */
export interface ChunkSearchResult {
  /** Stable id: "<abs_file_path>:<start_line>:<end_line>" */
  id: string
  /** Absolute path of the source file */
  file_path: string
  /** 1-based, inclusive start line */
  start_line: number
  /** 1-based, inclusive end line */
  end_line: number
  /** Raw source lines joined by "\n" */
  content: string
  /**
   * "hybrid" when semantic (Ollama embedding) re-ranking contributed to
   * this result, "fts5_only" when only full-text search was used (e.g.
   * Ollama wasn't reachable). Same value on every row in a given result set.
   */
  searchMode?: 'hybrid' | 'fts5_only'
}

// ── API ───────────────────────────────────────────────────────────────────

/**
 * Searches indexed repository chunks using SQLite FTS5.
 *
 * @param query   FTS5 query string.  Supports:
 *                  exact phrase   → "useAuth"
 *                  boolean        → useAuth OR login
 *                  prefix         → use*
 * @param limit   Maximum results (default 20, capped at 50 on the backend).
 *
 * @returns Ranked list of matching chunks, best match first.
 *
 * Throws if the Tauri backend returns an error (e.g. database not yet
 * initialised or empty — caller should handle gracefully).
 *
 * Future extension: pass these results to an embedding reranker before
 * injecting into the Gemini prompt.
 */
export async function searchChunks(
  query: string,
  limit = 20,
  projectRoot?: string,
): Promise<ChunkSearchResult[]> {
  if (!query.trim()) return []

  // NEVER pass a raw user question to SQLite FTS5 — sanitize first.
  const sanitized = sanitizeFtsQuery(query)
  if (!sanitized) return []

  return invoke<ChunkSearchResult[]>('search_repo', {
    query: sanitized,
    limit,
    projectRoot: projectRoot ?? null,
  })
}

/**
 * Reads the search mode off a result set (every chunk carries the same
 * value — see {@link ChunkSearchResult.searchMode}). Defaults to
 * "fts5_only" for empty result sets / results from a backend that hasn't
 * been upgraded to hybrid search yet.
 */
export function getSearchMode(results: ChunkSearchResult[]): 'hybrid' | 'fts5_only' {
  return results[0]?.searchMode ?? 'fts5_only'
}

// ── Symbol search types ──────────────────────────────────────────────────

/** A single indexed code symbol returned by `search_symbols`. */
export interface SymbolResult {
  id: number
  name: string
  type: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'component' | 'variable' | 'default' | 'style-rule'
  file_path: string
  start_line: number
  end_line: number
}

/** Result of a file-aware retrieval lookup. */
export interface FileChunkResult {
  matched_files: string[]
  chunks: ChunkSearchResult[]
}

// ── Retrieval diagnostics ────────────────────────────────────────────────

/**
 * Summary of a single retrieval pass, surfaced in the chat UI so the user
 * can see what (if anything) was actually retrieved before the model
 * answered.
 */
export interface RetrievalStats {
  /** Original, unmodified user query. */
  originalQuery: string
  /** Query after {@link sanitizeFtsQuery}. */
  sanitizedQuery: string
  /** Query after {@link extractSearchTerms}. */
  extractedTerms: string
  /** Number of chunks returned by FTS / file-aware retrieval. */
  chunksFound: number
  /** Number of symbols returned by symbol search. */
  symbolsFound: number
  /** De-duplicated list of files that contributed to retrieval. */
  filesRetrieved: string[]
  /** True if filename-fallback search was used (FTS returned 0 results). */
  usedFilenameFallback: boolean
  /** True if NO context (chunks, symbols, or files) was found at all. */
  noContextFound: boolean
  /**
   * "hybrid" when FTS5+embedding re-ranking was used for the chunk search
   * pass, "fts5_only" when Ollama wasn't reachable and FTS5 alone served
   * the results. Surfaced in the AiChat status bar.
   */
  searchMode?: 'hybrid' | 'fts5_only'
}

// ── File path detection ──────────────────────────────────────────────────

/**
 * Detects file-path-like tokens in a user query, e.g. "App.tsx",
 * "services/index.html", "package.json", "auth.ts".
 *
 * Heuristics:
 *   - A token containing at least one `.` followed by 1-10 word chars
 *     (a plausible extension), OR
 *   - A token containing a `/` (path-like), with or without an extension.
 *
 * Returns the FIRST plausible match found, or `null` if none.
 * Surrounding punctuation (commas, quotes, backticks, trailing `?`/`.`/`:`)
 * is stripped.
 */
export function detectFilePath(query: string): string | null {
  const tokens = query.split(/\s+/)

  const FILE_RE = /^[\w.\-/\\]+\.[A-Za-z0-9]{1,10}$/
  const PATH_RE = /^[\w.\-]+\/[\w.\-/\\]+$/

  for (const raw of tokens) {
    // Strip wrapping punctuation/quotes and trailing punctuation
    const token = raw.replace(/^[`'"(]+|[`'")?.,:;!]+$/g, '')
    if (!token) continue

    if (FILE_RE.test(token) || PATH_RE.test(token)) {
      return token
    }
  }

  return null
}

// ── File-aware retrieval API ───────────────────────────────────────────────

/**
 * Looks up all chunks belonging to indexed file(s) whose path ends with
 * `pathFragment` (filename or partial path).
 *
 * @returns `{ matched_files, chunks }`. `matched_files` is empty when no
 *          indexed file matches — callers should fall back to
 *          {@link searchChunks} (FTS) in that case.
 */
export async function searchChunksByFile(
  pathFragment: string,
  projectRoot?: string,
): Promise<FileChunkResult> {
  if (!pathFragment.trim()) return { matched_files: [], chunks: [] }

  return invoke<FileChunkResult>('search_repo_by_file', {
    pathFragment,
    projectRoot: projectRoot ?? null,
  })
}

// ── Symbol search API ───────────────────────────────────────────────────────

/**
 * Searches indexed code symbols (functions, classes, interfaces, types,
 * enums, React components, exported declarations) by name.
 *
 * Intended to run before chunk search for queries like:
 *   "Where is login implemented?"
 *   "Find AuthProvider"
 *   "Show UserService"
 */
export async function searchSymbols(
  query: string,
  limit = 10,
  projectRoot?: string,
): Promise<SymbolResult[]> {
  if (!query.trim()) return []

  return invoke<SymbolResult[]>('search_symbols', {
    query,
    limit,
    projectRoot: projectRoot ?? null,
  })
}

/**
 * Formats symbol search results into a context block for injection into
 * the Gemini prompt.
 */
export function buildSymbolContextBlock(symbols: SymbolResult[]): string {
  if (symbols.length === 0) return ''

  const lines = symbols.map(s => {
    const shortPath = s.file_path.replace(/\\/g, '/')
    return `- ${s.name} (${s.type}) — ${shortPath}:${s.start_line}-${s.end_line}`
  })

  return [
    '=== Matching Symbols ===',
    lines.join('\n'),
    '=== End Matching Symbols ===',
  ].join('\n')
}

// ── Prompt builder ────────────────────────────────────────────────────────

/**
 * Formats the top chunk results into a repository context block for
 * injection into the Gemini prompt.
 *
 * Output format:
 *
 *   === Repository Context ===
 *   [Chunk 1]
 *   File: src/auth/AuthService.ts
 *   Lines: 1–100
 *   export class AuthService { …
 *
 *   [Chunk 2]
 *   File: src/hooks/useAuth.ts
 *   Lines: 81–120
 *   export function useAuth() { …
 *
 *   === End Repository Context ===
 *
 * @param chunks          Results from searchChunks (pass top-N already sliced).
 * @param maxContentChars Hard cap per chunk to avoid token bloat (default 800).
 */
export function buildRepoContextBlock(
  chunks: ChunkSearchResult[],
  maxContentChars = 800,
): string {
  if (chunks.length === 0) return ''

  const sections = chunks.map((c, i) => {
    const shortPath = c.file_path.replace(/\\/g, '/')
    const excerpt = c.content.length > maxContentChars
      ? c.content.slice(0, maxContentChars) + '\n…'
      : c.content
    return [
      `[Chunk ${i + 1}]`,
      `File: ${shortPath}`,
      `Lines: ${c.start_line}–${c.end_line}`,
      excerpt,
    ].join('\n')
  })

  return [
    '=== Repository Context ===',
    sections.join('\n\n'),
    '=== End Repository Context ===',
  ].join('\n')
}