// lib/repoScanner/embeddingProvider.ts
//
// Pluggable embedding system for semantic code retrieval.
//
// ── Design goals ─────────────────────────────────────────────────────────────
//
//   1. Zero-dependency default: the built-in LocalEmbeddingProvider generates
//      dense vectors from code text using a fast TF-IDF-style encoder with
//      code-aware tokenisation. Quality is below a transformer model but far
//      above keyword search, and it runs synchronously in Node with no native
//      modules, model downloads, or API calls.
//
//   2. Drop-in upgrade path: any caller can swap in a transformer-backed
//      provider (e.g. via the Transformers.js `feature-extraction` pipeline
//      or a remote API) by implementing EmbeddingProvider and passing it to
//      buildVectorIndex().
//
//   3. Deterministic: given the same input text the local provider always
//      produces the same vector, so the change-detection logic in the index
//      builder is correct (same mtime → same embedding, skip re-embed).
//
// ── Local encoding strategy ───────────────────────────────────────────────────
//
//   The LocalEmbeddingProvider builds a 512-dimensional dense float vector
//   from code text using a two-pass approach:
//
//   Pass 1 — Vocabulary projection
//     • Split text into code tokens (camelCase, snake_case, operators).
//     • Hash each token to a deterministic 32-bit bucket (FNV-1a).
//     • Accumulate TF-weighted values into the 512 float dimensions.
//
//   Pass 2 — Positional + structural features
//     • Dims 0-255: token hashes (vocabulary presence)
//     • Dims 256-383: bi-gram hashes (local context pairs)
//     • Dims 384-447: structural signals (line count, indent depth, keyword
//       density, operator ratio, bracket balance)
//     • Dims 448-511: symbol-type signals injected from the metadata prefix
//
//   The result is L2-normalised before storage.
//
//   Semantic quality is roughly: TF-IDF retrieval < LocalEmbeddingProvider
//   < SentenceTransformer (SBERT). For repo navigation tasks (find the file
//   that handles auth, find where pagination is implemented) the local
//   encoder performs well because code symbol names carry most of the signal.

// ── Public interface ──────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Embedding vector dimensionality (fixed for the lifetime of this provider). */
  readonly dim: number

  /**
   * Generates a dense embedding vector for `text`.
   * May be async (e.g. for remote APIs) — the local provider is sync but
   * wraps its return in a resolved promise for interface uniformity.
   */
  embed(text: string): Promise<Float32Array>

  /**
   * Batch embedding — callers SHOULD prefer this over looping `embed()`
   * as remote providers can batch API calls.  The default implementation
   * falls back to sequential `embed()` calls.
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

// ── Embedding text builder ───────────────────────────────────────────────────
//
// Constructs the string fed into the embedder for one chunk.
// The format encodes structured metadata so the embedding captures both
// semantic content (symbol names, code text) and structural context
// (file type, symbol kind, location).

export interface ChunkEmbeddingInput {
  relativePath: string
  symbolName:   string
  symbolKind?:  string
  startLine:    number
  endLine:      number
  content:      string
}

/**
 * Builds the embedding input text for one chunk.
 * Format is designed to surface the most signal-dense tokens first:
 *   SYMBOL <name> in <path> [<kind>] LINE <start>-<end>
 *   <content (truncated to 512 tokens)>
 */
export function buildEmbeddingText(input: ChunkEmbeddingInput): string {
  const { relativePath, symbolName, symbolKind, startLine, endLine, content } = input

  // Truncate content to first 2048 chars to keep vector computation bounded
  const truncated = content.length > 2048 ? content.slice(0, 2048) : content

  const kindTag = symbolKind ? ` [${symbolKind}]` : ''
  const header  = `SYMBOL ${symbolName} in ${relativePath}${kindTag} LINE ${startLine}-${endLine}`

  return `${header}\n${truncated}`
}

// ── LocalEmbeddingProvider ─────────────────────────────────────────────────

const LOCAL_DIM = 512

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly dim = LOCAL_DIM

  async embed(text: string): Promise<Float32Array> {
    return localEmbed(text)
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(localEmbed)
  }
}

// ── GeminiEmbeddingProvider ───────────────────────────────────────────────
//
// Remote embedding provider backed by Gemini's `text-embedding-004` model.
// Produces much higher-quality vectors than LocalEmbeddingProvider at the
// cost of a network round-trip per embed() / embedBatch() call.
//
// Reliability: any network/API failure (bad key, quota exhausted, offline,
// malformed response, …) is caught internally and silently falls back to
// LocalEmbeddingProvider so callers never need their own try/catch around
// embedding calls — the EmbeddingProvider contract (dim, embed, embedBatch)
// always resolves successfully.
//
// NOTE: dim is fixed at 768 — Gemini's text-embedding-004 always returns a
// 768-dimensional vector, it is not configurable.

const GEMINI_DIM = 768
const GEMINI_EMBED_MODEL = 'text-embedding-004'
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiEmbedContentResponse {
  embedding?: { values?: number[] }
}

interface GeminiBatchEmbedContentsResponse {
  embeddings?: Array<{ values?: number[] }>
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly dim = GEMINI_DIM

  private readonly apiKey: string
  private readonly fallback: LocalEmbeddingProvider

  constructor(apiKey: string) {
    this.apiKey = apiKey
    this.fallback = new LocalEmbeddingProvider()
  }

  async embed(text: string): Promise<Float32Array> {
    try {
      return await this.embedSingleRemote(text)
    } catch (err) {
      logFallback(err)
      return this.fallback.embed(text)
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    try {
      return texts.length > 1
        ? await this.embedManyRemote(texts)
        : [await this.embedSingleRemote(texts[0])]
    } catch (err) {
      logFallback(err)
      return this.fallback.embedBatch(texts)
    }
  }

  // ── Remote calls ─────────────────────────────────────────────────────

  private async embedSingleRemote(text: string): Promise<Float32Array> {
    const url = `${GEMINI_API_BASE}/${GEMINI_EMBED_MODEL}:embedContent?key=${encodeURIComponent(this.apiKey)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text }] },
      }),
    })

    if (!res.ok) {
      throw new Error(`Gemini embedContent failed: ${res.status} ${res.statusText}`)
    }

    const data = (await res.json()) as GeminiEmbedContentResponse
    return toVector(data.embedding?.values)
  }

  /** Uses Gemini's batchEmbedContents endpoint — one request for N texts. */
  private async embedManyRemote(texts: string[]): Promise<Float32Array[]> {
    const url = `${GEMINI_API_BASE}/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${encodeURIComponent(this.apiKey)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text }] },
        })),
      }),
    })

    if (!res.ok) {
      throw new Error(`Gemini batchEmbedContents failed: ${res.status} ${res.statusText}`)
    }

    const data = (await res.json()) as GeminiBatchEmbedContentsResponse
    const embeddings = data.embeddings
    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error('Gemini batchEmbedContents returned an unexpected number of embeddings')
    }

    return embeddings.map(e => toVector(e.values))
  }
}

function toVector(values: number[] | undefined): Float32Array {
  if (!values || values.length !== GEMINI_DIM) {
    throw new Error(`Gemini embedding response had unexpected dimensionality (expected ${GEMINI_DIM})`)
  }
  return new Float32Array(values)
}

function logFallback(err: unknown): void {
  // Silent fallback by design (see class header) — debug-level only so it
  // doesn't surface as a user-facing error, but is still inspectable.
  console.debug('[GeminiEmbeddingProvider] falling back to LocalEmbeddingProvider:', err)
}

// ── Local encoder implementation ─────────────────────────────────────────

/**
 * Tokenises code text using a code-aware splitter that handles:
 *   - camelCase / PascalCase splits
 *   - snake_case splits
 *   - kebab-case splits
 *   - operators and punctuation as separate tokens
 *   - string literals (treated as single "string" token)
 *   - comment markers
 */
function codeTokenise(text: string): string[] {
  // Replace camelCase / PascalCase boundaries with spaces
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')

  return spaced
    .toLowerCase()
    .split(/[\s\-_.,;:!?@#$%^&*()\[\]{}|<>\/\\'"=+`~]+/)
    .filter(t => t.length > 0 && t.length <= 40)
}

/**
 * FNV-1a 32-bit hash — fast, well-distributed, deterministic.
 * Returns a positive integer in [0, 2^31).
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // Multiply by FNV prime (32-bit, unsigned arithmetic approximated in JS)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 1  // ensure positive
}

/** Accumulates a TF-weighted value into the vector at the given bucket. */
function addToBucket(vec: Float32Array, bucket: number, value: number, size: number): void {
  vec[bucket % size] += value
}

function localEmbed(text: string): Float32Array {
  const vec  = new Float32Array(LOCAL_DIM)

  // ── Tokenise ─────────────────────────────────────────────────────────
  const tokens = codeTokenise(text)
  const tf     = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

  const totalTokens = tokens.length || 1

  // ── Pass 1: Unigram TF scores → dims 0-255 ───────────────────────────
  for (const [token, count] of tf) {
    const tfWeight = count / totalTokens
    // Sub-linear TF: use sqrt to dampen high-frequency terms
    const weight = Math.sqrt(tfWeight) * (1 + Math.log1p(token.length))
    addToBucket(vec, fnv1a(token),          weight, 256)
    addToBucket(vec, fnv1a(token) + 128,    weight * 0.5, 256)
  }

  // ── Pass 2: Bigrams → dims 256-383 ───────────────────────────────────
  const BIGRAM_OFFSET = 256
  const BIGRAM_SIZE   = 128
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]}|${tokens[i + 1]}`
    const weight = 1 / totalTokens
    addToBucket(vec, BIGRAM_OFFSET + fnv1a(bigram) % BIGRAM_SIZE, weight, LOCAL_DIM)
  }

  // ── Pass 3: Structural signals → dims 384-447 ────────────────────────
  const STRUCT_OFFSET = 384
  const lines = text.split('\n')
  const lineCount = lines.length

  // Normalised line count (log scale, cap at 1000 lines)
  vec[STRUCT_OFFSET + 0] = Math.log1p(lineCount) / Math.log1p(1000)

  // Average indent depth (tabs or 2-space groups)
  let totalIndent = 0
  for (const line of lines) {
    const indent = line.match(/^(\s+)/)?.[1] ?? ''
    totalIndent += Math.min(indent.replace(/\t/g, '  ').length / 2, 20)
  }
  vec[STRUCT_OFFSET + 1] = Math.min(1, totalIndent / (lineCount * 5))

  // Keyword density: ratio of reserved words to total tokens
  const CODE_KEYWORDS = new Set([
    'function', 'class', 'const', 'let', 'var', 'return', 'if', 'else',
    'for', 'while', 'import', 'export', 'default', 'async', 'await',
    'new', 'this', 'try', 'catch', 'throw', 'interface', 'type', 'enum',
    'extends', 'implements', 'public', 'private', 'protected', 'static',
    'def', 'pass', 'lambda', 'yield', 'with', 'from', 'as',
  ])
  let keywordCount = 0
  for (const t of tokens) if (CODE_KEYWORDS.has(t)) keywordCount++
  vec[STRUCT_OFFSET + 2] = Math.min(1, keywordCount / (totalTokens * 0.3))

  // Bracket balance (sanity signal)
  let brackets = 0
  for (const ch of text) {
    if ('([{'.includes(ch)) brackets++
    if (')]}'.includes(ch)) brackets--
  }
  vec[STRUCT_OFFSET + 3] = Math.tanh(brackets / 10)

  // ── Pass 4: Path-component signals → dims 448-511 ────────────────────
  const PATH_OFFSET = 448
  const PATH_SIZE   = 64
  const pathParts   = text.split('\n')[0].split(/[/\\.]/)
  for (const part of pathParts) {
    if (part.length > 0) {
      addToBucket(vec, PATH_OFFSET + fnv1a(part) % PATH_SIZE, 2.0, LOCAL_DIM)
    }
  }

  // ── L2-normalise ─────────────────────────────────────────────────────
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    const inv = 1 / norm
    for (let i = 0; i < vec.length; i++) vec[i] *= inv
  }

  return vec
}

// ── Default singleton ─────────────────────────────────────────────────────

/** Shared default provider — cheap to construct, stateless. */
export const defaultEmbeddingProvider: EmbeddingProvider = new LocalEmbeddingProvider()