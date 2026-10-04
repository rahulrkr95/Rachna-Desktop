// lib/semanticSearch.ts
//
// Renderer-side semantic (vector) search for the AI chat retrieval pipeline.
//
// Architecture:
//   The vector-index.json is written to disk by the Node scanner process
//   (~/.rachna-ide/vector-cache/vector-index.json).  The renderer loads it
//   once via Tauri's read_file command, keeps it in memory, and runs cosine
//   similarity search entirely in the renderer (no IPC round-trip per query).
//
// ── Usage ──────────────────────────────────────────────────────────────────
//   import { semanticSearchManager } from '../lib/semanticSearch'
//
//   // After a repo scan completes:
//   await semanticSearchManager.loadIndex()
//
//   // At query time:
//   const hits = await semanticSearchManager.search("authentication flow", 10)
//
// ── Graceful degradation ───────────────────────────────────────────────────
//   If the vector index is missing (first run, build failure, etc.) all
//   search() calls return [] — the retrieval pipeline falls through to FTS
//   and symbol search as before.

import { invoke } from '@tauri-apps/api/core'

// ── Types (mirror of vectorIndex.ts / semanticRetrieval.ts) ───────────────

export interface SemanticHit {
  id:           string
  relativePath: string
  symbolName:   string
  startLine:    number
  endLine:      number
  content:      string
  similarity:   number
}

interface SerializedEntry {
  id:               string
  relativePath:     string
  symbolName:       string
  startLine:        number
  endLine:          number
  content:          string
  fileLastModified: string
  embedding:        number[]
}

interface SerializedIndex {
  version:      number
  embeddingDim: number
  generatedAt:  string
  entries:      SerializedEntry[]
}

// ── Embedding (mirrors LocalEmbeddingProvider in embeddingProvider.ts) ────
//
// We duplicate the local embedding logic here so the renderer bundle has no
// dependency on Node-only modules (fs, path) from the scanner package.

const LOCAL_DIM = 512

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 1
}

function codeTokenise(text: string): string[] {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return spaced
    .toLowerCase()
    .split(/[\s\-_.,;:!?@#$%^&*()\[\]{}|<>\/\\'"=+`~]+/)
    .filter(t => t.length > 0 && t.length <= 40)
}

function addToBucket(vec: Float32Array, bucket: number, value: number, size: number): void {
  vec[bucket % size] += value
}

function localEmbed(text: string): Float32Array {
  const vec    = new Float32Array(LOCAL_DIM)
  const tokens = codeTokenise(text)
  const tf     = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  const total = tokens.length || 1

  // Unigrams → dims 0-255
  for (const [token, count] of tf) {
    const w = Math.sqrt(count / total) * (1 + Math.log1p(token.length))
    addToBucket(vec, fnv1a(token),       w,       256)
    addToBucket(vec, fnv1a(token) + 128, w * 0.5, 256)
  }

  // Bigrams → dims 256-383
  for (let i = 0; i < tokens.length - 1; i++) {
    addToBucket(vec, 256 + fnv1a(`${tokens[i]}|${tokens[i+1]}`) % 128, 1 / total, LOCAL_DIM)
  }

  // Structural → dims 384-447
  const lines = text.split('\n')
  vec[384] = Math.log1p(lines.length) / Math.log1p(1000)

  const CODE_KEYWORDS = new Set(['function','class','const','let','var','return','if','else',
    'for','while','import','export','default','async','await','new','this','try','catch',
    'throw','interface','type','enum','extends','implements','public','private','protected','static',
    'def','pass','lambda','yield','with','from','as'])
  let kw = 0
  for (const t of tokens) if (CODE_KEYWORDS.has(t)) kw++
  vec[386] = Math.min(1, kw / (total * 0.3))

  // Path components → dims 448-511
  const pathParts = text.split('\n')[0].split(/[/\\.]/)
  for (const part of pathParts) {
    if (part.length > 0) addToBucket(vec, 448 + fnv1a(part) % 64, 2.0, LOCAL_DIM)
  }

  // L2 normalise
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) { const inv = 1 / norm; for (let i = 0; i < vec.length; i++) vec[i] *= inv }
  return vec
}

// ── Cosine similarity ─────────────────────────────────────────────────────

function cosineSim(q: Float32Array, b: Float32Array): number {
  let dot = 0, bNorm = 0
  for (let i = 0; i < q.length; i++) {
    dot   += q[i] * b[i]
    bNorm += b[i] * b[i]
  }
  if (bNorm === 0) return 0
  return Math.max(0, Math.min(1, dot / Math.sqrt(bNorm)))
}

// ── SemanticSearchManager ─────────────────────────────────────────────────

class SemanticSearchManager {
  private entries: Array<{ meta: Omit<SerializedEntry, 'embedding'>; vec: Float32Array }> = []
  private loaded  = false
  private loading = false

  /**
   * Loads (or reloads) the vector index from disk via Tauri.
   *
   * `root` is the currently-open project's absolute path. It's required —
   * `get_vector_index_path` hashes it to find that project's own cache
   * folder (~/.rachna-ide/vector-cache/<hash>/vector-index.json). Without
   * it, every project would resolve to the same file/none at all.
   */
  async loadIndex(root: string): Promise<void> {
    if (this.loading) return
    this.loading = true

    try {
      // Ask Tauri for the path to this project's vector-index.json
      const indexPath = await invoke<string>('get_vector_index_path', { root })

      // Read the file via Tauri's read_file command
      const result = await invoke<{ content: string; kind: string }>('read_file', { path: indexPath })

      if (result.kind !== 'text' || !result.content) {
        console.debug('[semantic] vector-index.json not found or empty — semantic search disabled')
        this.entries = []
        this.loaded  = true
        return
      }

      const data: SerializedIndex = JSON.parse(result.content)

      this.entries = data.entries.map(e => ({
        meta: {
          id:               e.id,
          relativePath:     e.relativePath,
          symbolName:       e.symbolName,
          startLine:        e.startLine,
          endLine:          e.endLine,
          content:          e.content,
          fileLastModified: e.fileLastModified,
        },
        vec: new Float32Array(e.embedding),
      }))

      console.debug(`[semantic] loaded vector index: ${this.entries.length} entries`)
      this.loaded = true
    } catch (err) {
      console.debug('[semantic] vector index load failed (non-fatal):', err)
      this.entries = []
      this.loaded  = true
    } finally {
      this.loading = false
    }
  }

  /** True once loadIndex() has completed (success or failure). */
  get isLoaded(): boolean { return this.loaded }

  /** Number of indexed chunks. */
  get size(): number { return this.entries.length }

  /**
   * Returns the top-k chunks most semantically similar to `query`.
   * Returns [] immediately if the index is not loaded or is empty.
   */
  async search(query: string, topK: number = 10): Promise<SemanticHit[]> {
    if (!this.loaded || this.entries.length === 0) return []

    const qVec  = localEmbed(query)
    const scored = this.entries.map(e => ({
      meta: e.meta,
      sim:  cosineSim(qVec, e.vec),
    }))

    scored.sort((a, b) => b.sim - a.sim)

    return scored.slice(0, topK).map(({ meta, sim }) => ({
      id:           meta.id,
      relativePath: meta.relativePath,
      symbolName:   meta.symbolName,
      startLine:    meta.startLine,
      endLine:      meta.endLine,
      content:      meta.content,
      similarity:   Math.round(sim * 10000) / 10000,
    }))
  }

  /** Clears the in-memory index (call before re-indexing). */
  clear(): void {
    this.entries = []
    this.loaded  = false
  }
}

/** Singleton used throughout the renderer. */
export const semanticSearchManager = new SemanticSearchManager()

// ── Ollama + sqlite-vec semantic search ───────────────────────────────────
//
// A second, independent retrieval path that talks directly to:
//   1. A local Ollama server (nomic-embed-text) to embed the *query* text.
//   2. The Tauri `semantic_search_repo` command, which runs a k-NN lookup
//      against the `chunk_embeddings` sqlite-vec table populated by
//      `store_embedding` (see store/useRepoIndex.ts — chunks are embedded
//      and stored there once per scan, when Ollama is detected).
//
// This is deliberately separate from SemanticSearchManager above (which
// reads the vector-index.json built by the Node scanner subprocess via
// Gemini/local TF-IDF embeddings). Both paths degrade gracefully to []
// when their respective backing service isn't available, so callers can
// freely combine results from either.

const OLLAMA_BASE_URL   = 'http://localhost:11434'
const OLLAMA_EMBED_MODEL = 'nomic-embed-text'

export interface SemanticChunk {
  filePath: string
  chunkId:  string
  content:  string
  distance: number
}

interface OllamaEmbeddingsResponse {
  embedding?: number[]
}

interface RawSemanticResult {
  chunk_id:  string
  file_path: string
  distance:  number
}

interface RawReadFileResult {
  content: string
  kind:    string
}

/** Requests an embedding for `text` from the local Ollama server. Returns [] on any failure. */
async function embedQueryViaOllama(text: string): Promise<number[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
    })

    if (!res.ok) {
      console.debug(`[semanticSearch] Ollama returned ${res.status} ${res.statusText} — skipping`)
      return []
    }

    const data = (await res.json()) as OllamaEmbeddingsResponse
    return Array.isArray(data.embedding) ? data.embedding : []
  } catch (err) {
    console.debug('[semanticSearch] Ollama unreachable, skipping semantic search:', err)
    return []
  }
}

/**
 * Embeds `queryText` via the local Ollama server (nomic-embed-text), runs a
 * k-NN search against the sqlite-vec chunk index via the Tauri
 * `semantic_search_repo` command, and hydrates each hit's content via
 * `read_file`.
 *
 * Returns [] silently (never throws) whenever Ollama or the Tauri backend
 * is unavailable, so callers can use this as an optional retrieval source.
 */
export async function semanticSearch(queryText: string, limit: number = 10): Promise<SemanticChunk[]> {
  const trimmed = queryText?.trim()
  if (!trimmed) return []

  const embedding = await embedQueryViaOllama(trimmed)
  if (embedding.length === 0) return []

  let results: RawSemanticResult[]
  try {
    results = await invoke<RawSemanticResult[]>('semantic_search_repo', { embedding, limit })
  } catch (err) {
    console.debug('[semanticSearch] semantic_search_repo failed:', err)
    return []
  }

  if (!results || results.length === 0) return []

  const chunks = await Promise.all(
    results.map(async (r): Promise<SemanticChunk> => {
      try {
        const file = await invoke<RawReadFileResult>('read_file', { path: r.file_path })
        return {
          filePath: r.file_path,
          chunkId:  r.chunk_id,
          content:  file.kind === 'text' ? file.content : '',
          distance: r.distance,
        }
      } catch (err) {
        console.debug(`[semanticSearch] read_file failed for ${r.file_path}:`, err)
        return {
          filePath: r.file_path,
          chunkId:  r.chunk_id,
          content:  '',
          distance: r.distance,
        }
      }
    })
  )

  return chunks
}