// lib/graphRetrieval.ts
//
// Graph-aware context expansion for the AI chat retrieval pipeline.
//
// After FTS / file-aware / symbol retrieval identifies the files relevant
// to a user's question, this module expands that set with the file's
// direct dependencies and direct dependents (or further, if `depth` > 1)
// using the existing in-memory `dependencyGraphEngine`.
//
// This module does NOT perform any retrieval itself — it purely augments
// retrieval results that have already been computed elsewhere. The FTS
// pipeline in chunkSearch.ts / AiChat.tsx is untouched.

import { dependencyGraphEngine } from './repo-scanner/src/dependencyGraph/graphEngine'

// ── Types ─────────────────────────────────────────────────────────────────

export interface RelatedFiles {
  /** Files that `filePath` (transitively, within `depth` hops) depends on. */
  dependencies: string[]
  /** Files that (transitively, within `depth` hops) depend on `filePath`. */
  dependents: string[]
}

// ── API ───────────────────────────────────────────────────────────────────

/**
 * Returns the files directly (or transitively, within `depth` hops) related
 * to `filePath` via the dependency graph — split into dependencies (what it
 * imports) and dependents (what imports it).
 *
 * `filePath` itself is never included in either list.
 *
 * @param filePath  Absolute path of the file to expand from.
 * @param depth     How many hops to traverse in each direction. Default 1
 *                   (direct dependencies + direct dependents only).
 */
export function getRelatedFiles(filePath: string, depth = 1): RelatedFiles {
  if (!filePath || depth <= 0) {
    return { dependencies: [], dependents: [] }
  }

  const dependencies = dependencyGraphEngine.getRelatedFiles(filePath, {
    depth,
    direction: 'imports',
  })

  const dependents = dependencyGraphEngine.getRelatedFiles(filePath, {
    depth,
    direction: 'dependents',
  })

  // Defensive: neither list should ever contain the source file itself.
  return {
    dependencies: dependencies.filter(f => f !== filePath),
    dependents: dependents.filter(f => f !== filePath),
  }
}

/**
 * Expands `getRelatedFiles` across multiple files (e.g. all files matched
 * by FTS/file-aware/symbol retrieval) and returns the de-duplicated union,
 * with `seedFiles` excluded from the result.
 *
 * @param seedFiles  Files already identified as relevant by retrieval.
 * @param depth      Traversal depth, forwarded to {@link getRelatedFiles}.
 */
export function getRelatedFilesForMany(seedFiles: string[], depth = 1): RelatedFiles {
  const seedSet = new Set(seedFiles)
  const dependencies = new Set<string>()
  const dependents = new Set<string>()

  for (const file of seedFiles) {
    const related = getRelatedFiles(file, depth)
    for (const f of related.dependencies) if (!seedSet.has(f)) dependencies.add(f)
    for (const f of related.dependents) if (!seedSet.has(f)) dependents.add(f)
  }

  return {
    dependencies: [...dependencies],
    dependents: [...dependents],
  }
}

// ── Prompt context builder ──────────────────────────────────────────────

/**
 * Formats related-files info into a context block for injection into the
 * Gemini prompt, in the same style as `buildRepoContextBlock` /
 * `buildSymbolContextBlock` from chunkSearch.ts.
 *
 * Output format:
 *
 *   === Related Files ===
 *   Dependencies (files this code imports):
 *   - src/utils/helpers.ts
 *   - src/hooks/useAuth.ts
 *
 *   Dependents (files that import this code):
 *   - src/App.tsx
 *   === End Related Files ===
 *
 * Returns '' if both lists are empty.
 */
export function buildRelatedFilesContextBlock(related: RelatedFiles): string {
  const { dependencies, dependents } = related

  if (dependencies.length === 0 && dependents.length === 0) return ''

  const sections: string[] = []

  if (dependencies.length > 0) {
    sections.push(
      [
        'Dependencies (files this code imports):',
        ...dependencies.map(f => `- ${f.replace(/\\/g, '/')}`),
      ].join('\n'),
    )
  }

  if (dependents.length > 0) {
    sections.push(
      [
        'Dependents (files that import this code):',
        ...dependents.map(f => `- ${f.replace(/\\/g, '/')}`),
      ].join('\n'),
    )
  }

  return ['=== Related Files ===', sections.join('\n\n'), '=== End Related Files ==='].join('\n')
}
