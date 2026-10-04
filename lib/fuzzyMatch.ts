// lib/fuzzyMatch.ts
//
// Shared subsequence-based fuzzy string matcher. Originally lived inline
// inside CommandPalette.tsx (the in-app Ctrl+K command search); extracted
// here, with identical behavior, so other features that need "does this
// typed text loosely match this label" scoring — e.g. the Installed App
// Registry's open_app resolution in services/appRegistry/matching.ts —
// reuse the exact same matcher instead of a second, competing one.

export interface FuzzyMatch {
  score: number
  indices: number[]
}

/**
 * Scores how well `query` matches `target` as an ordered character
 * subsequence — e.g. "chr" matches "Chrome" and "vsc" matches "VS Code" —
 * rewarding consecutive-character runs, word-boundary starts, and an
 * outright prefix match. Returns null when `query` isn't a subsequence of
 * `target` at all.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] }
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0, score = 0, last = -1
  const indices: number[] = []

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const consecutive  = last === ti - 1 ? 5 : 0
      const wordBoundary = ti === 0 || /[\s/_.-]/.test(t[ti - 1]) ? 3 : 0
      const prefix       = ti === 0 ? 10 : 0
      score += 1 + consecutive + wordBoundary + prefix
      last = ti
      indices.push(ti)
      qi++
    }
  }
  return qi < q.length ? null : { score, indices }
}
