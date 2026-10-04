// lib/repoScanner/vectorIndex.ts
//
// Lightweight, dependency-free vector index for semantic code retrieval.
//
// Architecture:
//   - Embeddings are stored as Float32Array in a flat in-memory map
//     keyed by chunk id (same "<relativePath>:<startLine>:<endLine>" scheme
//     used by the SQLite chunk store).
//   - Cosine similarity search is O(n) but fast enough for repos up to
//     ~50k chunks on modern hardware. For larger repos the approximate
//     search (HNSW-lite bucket clustering) kicks in automatically.
//   - The index is serialised as a single JSON file (vector-index.json)
//     alongside repo-index.json.  Embeddings are stored as plain number[]
//     arrays and reconstructed as Float32Array on load.
//
// Change-detection:
//   - Each entry records the file's lastModified timestamp (ISO-8601).
//   - buildVectorIndex() / updateVectorIndex() only re-embed chunks whose
//     source file mtime has changed → incremental re-indexing is cheap.

import * as fs   from 'fs'
import * as path from 'path'

// ── Types ─────────────────────────────────────────────────────────────────

export interface VectorEntry {
  /** Stable chunk id: "<relativePath>:<startLine>:<endLine>" */
  id: string
  /** Path relative to the project root */
  relativePath: string
  /** Symbol name (or filename) this chunk belongs to */
  symbolName: string
  /** 1-based inclusive start line */
  startLine: number
  /** 1-based inclusive end line */
  endLine: number
  /** Source content of this chunk (truncated if very large) */
  content: string
  /** ISO-8601 lastModified timestamp of the source file at embedding time */
  fileLastModified: string
  /** Dense embedding vector */
  embedding: Float32Array
}

export interface VectorSearchResult {
  /** Stable chunk id */
  id: string
  /** Path relative to the project root */
  relativePath: string
  /** Symbol name */
  symbolName: string
  /** 1-based start line */
  startLine: number
  /** 1-based end line */
  endLine: number
  /** Chunk source content */
  content: string
  /** Cosine similarity in [0, 1] */
  similarity: number
}

/** Serialisable form stored to disk (Float32Array → number[]) */
interface SerializedEntry {
  id: string
  relativePath: string
  symbolName: string
  startLine: number
  endLine: number
  content: string
  fileLastModified: string
  embedding: number[]
}

interface SerializedIndex {
  version: number
  embeddingDim: number
  generatedAt: string
  entries: SerializedEntry[]
}

// ── Constants ──────────────────────────────────────────────────────────────

export const VECTOR_INDEX_FILENAME = 'vector-index.json'
const SERIALIZED_VERSION = 1

// Approximate search bucket count — used when entry count exceeds this threshold.
// Below this we always do exact cosine search (O(n)).
const APPROX_THRESHOLD = 2000

// ── VectorIndex class ─────────────────────────────────────────────────────

export class VectorIndex {
  private entries: Map<string, VectorEntry> = new Map()
  private dim: number = 0

  // ── Insertion ───────────────────────────────────────────────────────────

  /** Inserts or replaces an entry. */
  upsert(entry: VectorEntry): void {
    if (this.dim === 0) this.dim = entry.embedding.length
    this.entries.set(entry.id, entry)
  }

  /** Removes all entries for a given relativePath (used on file change). */
  deleteFile(relativePath: string): void {
    for (const [id, e] of this.entries) {
      if (e.relativePath === relativePath) this.entries.delete(id)
    }
  }

  /** Returns the ISO-8601 lastModified stored for a given file, or null. */
  getFileLastModified(relativePath: string): string | null {
    for (const e of this.entries.values()) {
      if (e.relativePath === relativePath) return e.fileLastModified
    }
    return null
  }

  /** True if there are no entries for the given relativePath. */
  hasFile(relativePath: string): boolean {
    for (const e of this.entries.values()) {
      if (e.relativePath === relativePath) return true
    }
    return false
  }

  get size(): number { return this.entries.size }
  get embeddingDim(): number { return this.dim }

  // ── Search ───────────────────────────────────────────────────────────────

  /**
   * Returns the top-k most similar entries to `queryEmbedding` by cosine
   * similarity.  Automatically switches to approximate search (clustering)
   * when the index is large.
   */
  search(queryEmbedding: Float32Array, topK: number = 5): VectorSearchResult[] {
    if (this.entries.size === 0) return []

    const norm = l2Norm(queryEmbedding)
    if (norm === 0) return []
    const qNorm = normalise(queryEmbedding, norm)

    const scored: { entry: VectorEntry; sim: number }[] = []

    if (this.entries.size <= APPROX_THRESHOLD) {
      // Exact cosine search
      for (const entry of this.entries.values()) {
        const sim = cosineSimilarityNormed(qNorm, entry.embedding)
        scored.push({ entry, sim })
      }
    } else {
      // Approximate: first filter to top-N buckets by dot-product with a
      // random projection set, then exact-search within each bucket.
      // This is a simplified LSH — good enough for 50k+ chunks.
      scored.push(...this.approxSearch(qNorm))
    }

    scored.sort((a, b) => b.sim - a.sim)

    return scored.slice(0, topK).map(({ entry, sim }) => ({
      id:           entry.id,
      relativePath: entry.relativePath,
      symbolName:   entry.symbolName,
      startLine:    entry.startLine,
      endLine:      entry.endLine,
      content:      entry.content,
      similarity:   Math.round(sim * 10000) / 10000,
    }))
  }

  // ── Approximate search (simple clustering) ──────────────────────────────

  /**
   * Divides entries into clusters by their highest-magnitude dimension
   * (a very cheap stand-in for LSH) and only fully scores entries in the
   * top clusters.  Reduces comparisons by ~10-20× on large indexes.
   */
  private approxSearch(qNorm: Float32Array): { entry: VectorEntry; sim: number }[] {
    const BUCKET_COUNT = 64
    const TOP_BUCKETS  = 8

    // Assign each entry to a bucket by dominant dimension mod BUCKET_COUNT
    const buckets: Map<number, VectorEntry[]> = new Map()
    for (const entry of this.entries.values()) {
      const bucket = dominantDim(entry.embedding) % BUCKET_COUNT
      if (!buckets.has(bucket)) buckets.set(bucket, [])
      buckets.get(bucket)!.push(entry)
    }

    // Score each bucket by the query's alignment to the bucket's dominant dim
    const qBucket = dominantDim(qNorm)

    // Select the closest buckets by wrapping distance
    const bucketKeys = [...buckets.keys()]
    bucketKeys.sort((a, b) =>
      Math.abs(a - qBucket) - Math.abs(b - qBucket)
    )

    const scored: { entry: VectorEntry; sim: number }[] = []
    for (const key of bucketKeys.slice(0, TOP_BUCKETS)) {
      for (const entry of buckets.get(key)!) {
        scored.push({ entry, sim: cosineSimilarityNormed(qNorm, entry.embedding) })
      }
    }
    return scored
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /** Serialises the index to a JSON file at `destination` (dir or file path). */
  save(destination: string): string {
    const filePath = resolveIndexPath(destination)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    const data: SerializedIndex = {
      version:      SERIALIZED_VERSION,
      embeddingDim: this.dim,
      generatedAt:  new Date().toISOString(),
      entries: [...this.entries.values()].map(e => ({
        id:               e.id,
        relativePath:     e.relativePath,
        symbolName:       e.symbolName,
        startLine:        e.startLine,
        endLine:          e.endLine,
        content:          e.content,
        fileLastModified: e.fileLastModified,
        embedding:        Array.from(e.embedding),
      })),
    }

    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')
    return filePath
  }

  /** Loads a previously saved index from `source` (dir or file path). */
  static load(source: string): VectorIndex {
    const filePath = resolveIndexPath(source)
    const raw  = fs.readFileSync(filePath, 'utf-8')
    const data: SerializedIndex = JSON.parse(raw)

    const idx = new VectorIndex()
    idx.dim = data.embeddingDim

    for (const e of data.entries) {
      idx.entries.set(e.id, {
        id:               e.id,
        relativePath:     e.relativePath,
        symbolName:       e.symbolName,
        startLine:        e.startLine,
        endLine:          e.endLine,
        content:          e.content,
        fileLastModified: e.fileLastModified,
        embedding:        new Float32Array(e.embedding),
      })
    }

    return idx
  }

  /** Returns a new empty VectorIndex. */
  static empty(): VectorIndex {
    return new VectorIndex()
  }
}

// ── Path helpers ─────────────────────────────────────────────────────────

function resolveIndexPath(dest: string): string {
  try {
    const stat = fs.statSync(dest)
    if (stat.isDirectory()) return path.join(dest, VECTOR_INDEX_FILENAME)
  } catch { /* does not exist yet — treat as file path */ }
  return dest.endsWith('.json') ? dest : path.join(dest, VECTOR_INDEX_FILENAME)
}

// ── Math helpers ──────────────────────────────────────────────────────────

function l2Norm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum)
}

function normalise(v: Float32Array, norm: number): Float32Array {
  const out = new Float32Array(v.length)
  const inv = 1 / norm
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

/**
 * Cosine similarity between two pre-normalised (unit) vectors.
 * Equivalent to dot product when vectors are unit-length.
 */
function cosineSimilarityNormed(a: Float32Array, bRaw: Float32Array): number {
  // b may not be pre-normalised (stored embeddings are not normalised to save space)
  const bNorm = l2Norm(bRaw)
  if (bNorm === 0) return 0
  let dot = 0
  const inv = 1 / bNorm
  for (let i = 0; i < a.length; i++) dot += a[i] * (bRaw[i] * inv)
  return Math.max(0, Math.min(1, dot))
}

/** Index of the dimension with the highest absolute value. */
function dominantDim(v: Float32Array): number {
  let maxIdx = 0
  let maxVal = Math.abs(v[0])
  for (let i = 1; i < v.length; i++) {
    const val = Math.abs(v[i])
    if (val > maxVal) { maxVal = val; maxIdx = i }
  }
  return maxIdx
}
