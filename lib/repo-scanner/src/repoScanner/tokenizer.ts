// lib/repoScanner/tokenizer.ts
//
// Single source of truth for "code-aware" tokenization, shared by:
//   - exact symbol search   (symbolSearch.ts)
//   - path / import search  (symbolSearch.ts)
//   - BM25 keyword search   (bm25.ts)
//   - legacy keyword scorer (retrieval.ts)
//
// Splits camelCase / PascalCase / snake_case / kebab-case identifiers into
// their constituent words so a natural-language query like "auth token"
// matches a symbol like "useAuthToken" or a file like "auth-token.ts".

/** Generic English stopwords stripped from free-text queries before scoring. */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'how', 'do', 'does', 'where', 'what', 'which', 'this', 'that',
  'it', 'its', 'be', 'as', 'by', 'from', 'at', 'we', 'i', 'you', 'your',
])

/**
 * Splits free text into lowercase tokens, additionally splitting
 * camelCase/PascalCase/snake_case/kebab-case identifiers (e.g.
 * "useAuthToken" → "use", "auth", "token") so natural-language queries
 * match code symbols, filenames and import paths alike.
 *
 * Stopwords are removed; pass `{ keepStopwords: true }` for contexts (like
 * BM25 document indexing) where stripping every short word is too lossy.
 */
export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const withSplitCase = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  const raw = withSplitCase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

  if (opts.keepStopwords) return raw.filter(t => t.length > 0)
  return raw.filter(t => t.length > 1 && !STOPWORDS.has(t))
}

/** Tokenizes a single identifier (symbol/file name) into its word parts. */
export function tokenizeIdentifier(name: string): string[] {
  return tokenize(name, { keepStopwords: true })
}
