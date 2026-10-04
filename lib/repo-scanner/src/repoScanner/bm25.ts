// lib/repoScanner/bm25.ts
//
// Stage A.3 — Keyword search.
//
// A small, dependency-free BM25 index over per-file "documents" (summary +
// path + exports + symbol names + import specifiers). BM25 is used instead
// of raw term-frequency counting because it:
//   - normalizes for document length (a 2000-line file shouldn't win purely
//     by containing more incidental term repeats),
//   - saturates term frequency (the 10th occurrence of a term barely adds
//     more signal than the 3rd),
//   - down-weights terms that appear in almost every document (via IDF).
//
// This is deterministic and fully local — no model, no network call.

export interface BM25Document {
  id: string
  tokens: string[]
}

const K1 = 1.5   // term-frequency saturation
const B = 0.75    // length-normalization strength

export class BM25Index {
  private docs: Map<string, string[]> = new Map()
  private docFreq: Map<string, number> = new Map() // term -> # docs containing it
  private docLength: Map<string, number> = new Map()
  private avgDocLength = 0
  private totalDocs = 0

  constructor(documents: BM25Document[]) {
    this.totalDocs = documents.length
    let totalLength = 0

    for (const doc of documents) {
      this.docs.set(doc.id, doc.tokens)
      this.docLength.set(doc.id, doc.tokens.length)
      totalLength += doc.tokens.length

      for (const term of new Set(doc.tokens)) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1)
      }
    }

    this.avgDocLength = this.totalDocs > 0 ? totalLength / this.totalDocs : 0
  }

  /** Inverse document frequency, BM25's standard (Robertson-Sparck-Jones) formula. */
  private idf(term: string): number {
    const n = this.docFreq.get(term) ?? 0
    // +1 inside the log keeps IDF non-negative for very common terms.
    return Math.log(1 + (this.totalDocs - n + 0.5) / (n + 0.5))
  }

  /**
   * Scores every document against `queryTokens` and returns a
   * `docId -> score` map (only documents with score > 0 are included).
   */
  search(queryTokens: string[]): Map<string, number> {
    const scores = new Map<string, number>()
    if (queryTokens.length === 0) return scores

    for (const [docId, tokens] of this.docs) {
      const dl = this.docLength.get(docId) ?? 0
      const lengthNorm = 1 - B + B * (dl / (this.avgDocLength || 1))

      let score = 0
      for (const term of queryTokens) {
        const tf = countOccurrences(tokens, term)
        if (tf === 0) continue
        const idf = this.idf(term)
        score += idf * (tf * (K1 + 1)) / (tf + K1 * lengthNorm)
      }

      if (score > 0) scores.set(docId, score)
    }

    return scores
  }
}

function countOccurrences(tokens: string[], term: string): number {
  let count = 0
  for (const t of tokens) if (t === term) count++
  return count
}
