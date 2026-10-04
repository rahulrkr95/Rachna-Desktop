// lib/repoScanner/symbolSearch.ts
//
// Stage A.1 (exact symbol search) and A.2 (path search) of the hybrid
// retrieval pipeline. Both are deterministic, index-lookup style matches —
// no scoring heuristics beyond "does this term match a real symbol /
// filename / import" — which is what makes them the highest-confidence
// signal in the ranker (see HYBRID_WEIGHTS in hybridRetrieval.ts).

import type { FileNode, SymbolRecord } from './types'
import { tokenize, tokenizeIdentifier } from './tokenizer'

/** Per-symbol-kind weight — components/classes/functions outrank plain variables. */
export const SYMBOL_KIND_WEIGHT: Record<string, number> = {
  component: 3,
  class: 2.5,
  function: 2,
  method: 1.8,
  default: 1.5,
  interface: 1,
  type: 1,
  enum: 1,
  variable: 1,
  field: 0.8,
  decorator: 0.8,
  namespace: 0.5,
  'style-rule': 0.5,
}

export interface SymbolMatch {
  relativePath: string
  symbol: SymbolRecord
  /** 1.0 for an exact name match, 0.5 for a token-level partial match. */
  matchStrength: number
}

export interface PathMatch {
  relativePath: string
  reason: 'filename' | 'folder' | 'import'
  matchStrength: number
}

// ── A.1 — Exact symbol search ───────────────────────────────────────────────

/**
 * Finds symbols (classes/functions/methods/interfaces/types/exports) whose
 * name exactly equals — or contains as a sub-word — a query token.
 *
 * Exact, case-insensitive full-name matches score highest; partial
 * (camelCase sub-word) matches score lower but still rank above plain
 * keyword overlap, since a real identifier matched is a strong signal.
 */
export function exactSymbolSearch(queryTokens: string[], files: FileNode[]): SymbolMatch[] {
  if (queryTokens.length === 0) return []
  const queryTokenSet = new Set(queryTokens)
  const matches: SymbolMatch[] = []

  for (const file of files) {
    for (const symbol of file.symbols) {
      const lowerName = symbol.name.toLowerCase()
      const symbolTokens = tokenizeIdentifier(symbol.name)

      if (queryTokenSet.has(lowerName)) {
        matches.push({ relativePath: file.relativePath, symbol, matchStrength: 1.0 })
        continue
      }
      if (symbolTokens.some(t => queryTokenSet.has(t))) {
        matches.push({ relativePath: file.relativePath, symbol, matchStrength: 0.5 })
      }
    }

    // Exports are sometimes not mirrored as symbols (e.g. re-exports) —
    // still treat an exact export-name match as a symbol-tier signal.
    for (const exp of file.exports) {
      const lowerName = exp.name.toLowerCase()
      if (queryTokenSet.has(lowerName)) {
        matches.push({
          relativePath: file.relativePath,
          symbol: { name: exp.name, type: 'default', startLine: 1, endLine: 1 },
          matchStrength: 0.8,
        })
      }
    }
  }

  return matches
}

/** Aggregates exactSymbolSearch() matches into a per-file weighted score. */
export function scoreSymbolMatches(matches: SymbolMatch[]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const m of matches) {
    const weight = SYMBOL_KIND_WEIGHT[m.symbol.type as string] ?? 1
    const prev = scores.get(m.relativePath) ?? 0
    scores.set(m.relativePath, prev + weight * m.matchStrength)
  }
  return scores
}

// ── A.2 — Path search (filename / folder / import matching) ────────────────

/**
 * Matches query tokens against filenames, folder segments and the raw
 * import specifiers each file references — useful when a user names a
 * file or module directly ("the auth middleware", "useLogin hook file").
 */
export function pathSearch(queryTokens: string[], files: FileNode[]): PathMatch[] {
  if (queryTokens.length === 0) return []
  const queryTokenSet = new Set(queryTokens)
  const matches: PathMatch[] = []

  for (const file of files) {
    const segments = file.relativePath.split('/')
    const filename = segments[segments.length - 1] ?? ''
    const folderSegments = segments.slice(0, -1)

    const filenameTokens = tokenizeIdentifier(filename)
    if (filenameTokens.some(t => queryTokenSet.has(t))) {
      const baseName = tokenize(filename.replace(/\.[^.]+$/, '')).join('')
      const exact = queryTokenSet.has(baseName)
      matches.push({ relativePath: file.relativePath, reason: 'filename', matchStrength: exact ? 1.0 : 0.7 })
    }

    for (const folder of folderSegments) {
      const folderTokens = tokenizeIdentifier(folder)
      if (folderTokens.some(t => queryTokenSet.has(t))) {
        matches.push({ relativePath: file.relativePath, reason: 'folder', matchStrength: 0.4 })
        break
      }
    }

    for (const imp of file.imports) {
      const importTokens = tokenize(imp.specifier)
      if (importTokens.some(t => queryTokenSet.has(t))) {
        matches.push({ relativePath: file.relativePath, reason: 'import', matchStrength: 0.5 })
        break
      }
    }
  }

  return matches
}

/** Aggregates pathSearch() matches into a per-file weighted score, split by reason. */
export function scorePathMatches(matches: PathMatch[]): {
  pathScore: Map<string, number>
  importScore: Map<string, number>
} {
  const pathScore = new Map<string, number>()
  const importScore = new Map<string, number>()

  for (const m of matches) {
    if (m.reason === 'import') {
      importScore.set(m.relativePath, (importScore.get(m.relativePath) ?? 0) + m.matchStrength)
    } else {
      pathScore.set(m.relativePath, (pathScore.get(m.relativePath) ?? 0) + m.matchStrength)
    }
  }

  return { pathScore, importScore }
}
