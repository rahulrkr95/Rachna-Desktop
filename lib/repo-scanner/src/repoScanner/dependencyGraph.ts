// lib/repoScanner/dependencyGraph.ts
//
// Builds a project-wide import/export dependency graph from already-parsed
// FileNodes. Used by the retrieval ranker to compute "dependency graph
// proximity" — files that are directly connected to a strong textual match
// are often relevant even if they don't mention the query terms themselves.

import type { DependencyGraph, FileNode } from './types'

/**
 * Builds a `relativePath -> { dependsOn, dependedOnBy }` adjacency map.
 *
 * Only resolved, in-repo imports are included — external/bare module
 * specifiers (e.g. "react") have no corresponding FileNode and are skipped.
 */
export function buildDependencyGraph(files: FileNode[]): DependencyGraph {
  const graph: DependencyGraph = {}

  // Index files by absolute path so import.resolvedPath can be mapped back
  // to a relativePath in the graph.
  const byAbsPath = new Map<string, FileNode>()
  for (const file of files) {
    byAbsPath.set(file.path, file)
    graph[file.relativePath] = { dependsOn: [], dependedOnBy: [] }
  }

  for (const file of files) {
    const entry = graph[file.relativePath]

    for (const imp of file.imports) {
      if (!imp.resolvedPath) continue

      const target = byAbsPath.get(imp.resolvedPath)
      if (!target || target.relativePath === file.relativePath) continue

      if (!entry.dependsOn.includes(target.relativePath)) {
        entry.dependsOn.push(target.relativePath)
      }

      const targetEntry = graph[target.relativePath]
      if (!targetEntry.dependedOnBy.includes(file.relativePath)) {
        targetEntry.dependedOnBy.push(file.relativePath)
      }
    }
  }

  return graph
}

/**
 * Returns the set of relativePaths directly connected to `relativePath` in
 * either direction (dependencies and dependents) — i.e. its 1-hop neighbors.
 */
export function neighborsOf(graph: DependencyGraph, relativePath: string): string[] {
  const entry = graph[relativePath]
  if (!entry) return []
  return [...new Set([...entry.dependsOn, ...entry.dependedOnBy])]
}
