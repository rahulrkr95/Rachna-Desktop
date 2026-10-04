// lib/dependencyGraph/graphEngine.ts
//
// DependencyGraphEngine — converts a ScanResult into an in-memory graph
// and exposes high-level query methods.
//
// Design decisions:
//   • All data lives in Maps for O(1) lookups by file path.
//   • Both forward (imports) and reverse (dependents) edges are stored.
//   • Cycle detection cache is invalidated whenever the graph mutates.
//   • The engine is serialisable to JSON for persistence / IPC transfer.

import type { ScanResult, FileNode } from '../repoScanner/types'
import type {
  DependencyGraph,
  DependencyEdge,
  CycleRecord,
  RelatedFilesOptions,
  GraphStats,
} from './types'
import {
  detectCycles,
  bfsForward,
  bfsReverse,
  shortestPath,
  topologicalSort,
} from './algorithms'

// ── DependencyGraphEngine ─────────────────────────────────────────────────

export class DependencyGraphEngine {

  private graph: DependencyGraph = {
    adjacencyMap: new Map(),
    reverseMap:   new Map(),
    edges:        [],
  }

  // Lazily computed, cleared whenever the graph mutates
  private _cycleCache: CycleRecord[] | null = null

  // ── Build ──────────────────────────────────────────────────────────────

  /**
   * Builds the graph from a `ScanResult` produced by `RepoScanner.scan()`.
   *
   * Only edges where both endpoints are known files in the scan result
   * are included (external / unresolved imports are ignored so the graph
   * stays local-first).
   *
   * Time: O(F + I) where F = files, I = total import records
   */
  buildFromScan(scanResult: ScanResult): this {
    this.graph        = { adjacencyMap: new Map(), reverseMap: new Map(), edges: [] }
    this._cycleCache  = null

    // Index all known file paths for O(1) membership checks
    const knownPaths = new Set(scanResult.files.map(f => f.path))

    // Seed every file as a node (even if it has no edges)
    for (const file of scanResult.files) {
      this.ensureNode(file.path)
    }

    // Add edges for all resolved relative imports
    for (const file of scanResult.files) {
      for (const imp of file.imports) {
        if (imp.resolvedPath && knownPaths.has(imp.resolvedPath)) {
          this.addEdge(file.path, imp.resolvedPath, imp.specifier)
        }
      }
    }

    return this
  }

  // ── Core mutation ──────────────────────────────────────────────────────

  /**
   * Adds a directed edge `from → to`.
   * Deduplicates: a duplicate edge (same from + to) is silently ignored.
   */
  addEdge(from: string, to: string, specifier = ''): this {
    this.ensureNode(from)
    this.ensureNode(to)

    // Dedup check
    const forwardList = this.graph.adjacencyMap.get(from)!
    if (forwardList.includes(to)) return this

    forwardList.push(to)
    this.graph.reverseMap.get(to)!.push(from)
    this.graph.edges.push({ from, to, specifier })
    this._cycleCache = null

    return this
  }

  /**
   * Removes all edges between `from` and `to` (in both directions).
   */
  removeEdge(from: string, to: string): this {
    const fwd = this.graph.adjacencyMap.get(from)
    if (fwd) {
      const idx = fwd.indexOf(to)
      if (idx !== -1) fwd.splice(idx, 1)
    }
    const rev = this.graph.reverseMap.get(to)
    if (rev) {
      const idx = rev.indexOf(from)
      if (idx !== -1) rev.splice(idx, 1)
    }
    this.graph.edges = this.graph.edges.filter(e => !(e.from === from && e.to === to))
    this._cycleCache = null
    return this
  }

  /**
   * Removes a file node and all its incident edges.
   * Call this when a file is deleted from the project.
   */
  removeNode(filePath: string): this {
    // Remove outbound edges
    for (const to of this.graph.adjacencyMap.get(filePath) ?? []) {
      const rev = this.graph.reverseMap.get(to)
      if (rev) {
        const idx = rev.indexOf(filePath)
        if (idx !== -1) rev.splice(idx, 1)
      }
    }
    // Remove inbound edges
    for (const from of this.graph.reverseMap.get(filePath) ?? []) {
      const fwd = this.graph.adjacencyMap.get(from)
      if (fwd) {
        const idx = fwd.indexOf(filePath)
        if (idx !== -1) fwd.splice(idx, 1)
      }
    }

    this.graph.adjacencyMap.delete(filePath)
    this.graph.reverseMap.delete(filePath)
    this.graph.edges = this.graph.edges.filter(
      e => e.from !== filePath && e.to !== filePath,
    )
    this._cycleCache = null
    return this
  }

  // ── Query: direct lookups ──────────────────────────────────────────────

  /**
   * Returns the direct imports of `filePath` (one hop, forward).
   * i.e., the files that `filePath` depends on.
   *
   * Time: O(1)
   */
  getDependencies(filePath: string): string[] {
    return [...(this.graph.adjacencyMap.get(filePath) ?? [])]
  }

  /**
   * Returns the direct dependents of `filePath` (one hop, reverse).
   * i.e., the files that import `filePath`.
   *
   * Time: O(1)
   */
  getDependents(filePath: string): string[] {
    return [...(this.graph.reverseMap.get(filePath) ?? [])]
  }

  /**
   * Returns all edges originating from `filePath`.
   */
  getEdgesFrom(filePath: string): DependencyEdge[] {
    return this.graph.edges.filter(e => e.from === filePath)
  }

  /**
   * Returns all edges pointing to `filePath`.
   */
  getEdgesTo(filePath: string): DependencyEdge[] {
    return this.graph.edges.filter(e => e.to === filePath)
  }

  // ── Query: traversal ───────────────────────────────────────────────────

  /**
   * Returns all files reachable from `filePath` within `depth` hops.
   *
   * `direction`:
   *   - 'imports'    → what this file (transitively) depends on
   *   - 'dependents' → what (transitively) depends on this file
   *   - 'both'       → union of both  (default)
   *
   * Time: O(V + E)
   */
  getRelatedFiles(
    filePath: string,
    options: RelatedFilesOptions = {},
  ): string[] {
    const { depth = 1, direction = 'both' } = options
    const result = new Set<string>()

    if (direction === 'imports' || direction === 'both') {
      for (const f of bfsForward(this.graph, filePath, depth)) result.add(f)
    }
    if (direction === 'dependents' || direction === 'both') {
      for (const f of bfsReverse(this.graph, filePath, depth)) result.add(f)
    }

    return [...result]
  }

  /**
   * Returns all files that `filePath` transitively depends on.
   * Equivalent to getRelatedFiles(f, { direction: 'imports', depth: Infinity })
   * but more explicit.
   *
   * Time: O(V + E)
   */
  getAllDependencies(filePath: string): string[] {
    return [...bfsForward(this.graph, filePath, Infinity as number)]
  }

  /**
   * Returns all files that transitively import `filePath`.
   *
   * Time: O(V + E)
   */
  getAllDependents(filePath: string): string[] {
    return [...bfsReverse(this.graph, filePath, Infinity as number)]
  }

  /**
   * Finds the shortest import path from `from` to `to`.
   * Returns null if no path exists.
   *
   * Useful for explaining why file A depends on file B.
   *
   * Time: O(V + E)
   */
  findPath(from: string, to: string): string[] | null {
    return shortestPath(this.graph, from, to)
  }

  /**
   * Returns nodes in topological order (leaves first, entry points last).
   * Cyclic nodes appear in an arbitrary order at the end.
   *
   * Time: O(V + E)
   */
  topologicalOrder(): string[] {
    return topologicalSort(this.graph)
  }

  // ── Cycle detection ────────────────────────────────────────────────────

  /**
   * Detects all circular dependency cycles in the graph.
   * Results are cached — call is O(1) if the graph hasn't mutated.
   *
   * Time: O(V + E) on first call, O(1) on subsequent calls
   */
  detectCycles(): CycleRecord[] {
    if (this._cycleCache === null) {
      this._cycleCache = detectCycles(this.graph)
    }
    return this._cycleCache
  }

  /**
   * Returns true if the graph contains at least one circular dependency.
   */
  hasCycles(): boolean {
    return this.detectCycles().length > 0
  }

  /**
   * Returns all cycles that involve `filePath`.
   */
  getCyclesFor(filePath: string): CycleRecord[] {
    return this.detectCycles().filter(c => c.cycle.includes(filePath))
  }

  // ── Graph stats ────────────────────────────────────────────────────────

  /**
   * Returns lightweight statistics about the current graph state.
   * Does not trigger cycle detection (use hasCycles() / detectCycles() for that).
   */
  getStats(): GraphStats {
    const { adjacencyMap, reverseMap, edges } = this.graph
    const nodes = [...adjacencyMap.keys()]

    let mostDepended: GraphStats['mostDepended'] = null
    let mostImports:  GraphStats['mostImports']  = null
    let maxIn  = -1
    let maxOut = -1

    for (const node of nodes) {
      const outCount = adjacencyMap.get(node)!.length
      const inCount  = reverseMap.get(node)!.length

      if (outCount > maxOut) {
        maxOut = outCount
        mostImports = { file: node, count: outCount }
      }
      if (inCount > maxIn) {
        maxIn = inCount
        mostDepended = { file: node, count: inCount }
      }
    }

    return {
      nodeCount:    nodes.length,
      edgeCount:    edges.length,
      cycleCount:   this._cycleCache?.length ?? 0,
      mostDepended,
      mostImports,
    }
  }

  // ── Serialisation ──────────────────────────────────────────────────────

  /**
   * Returns a plain JSON-serialisable snapshot of the graph.
   * Useful for sending over Tauri IPC or persisting to disk.
   */
  toJSON(): {
    nodes: string[]
    edges: DependencyEdge[]
    cycles: CycleRecord[]
  } {
    return {
      nodes:  [...this.graph.adjacencyMap.keys()],
      edges:  this.graph.edges,
      cycles: this.detectCycles(),
    }
  }

  /**
   * Rebuilds the engine from a previously serialised snapshot.
   */
  fromJSON(snapshot: { nodes: string[]; edges: DependencyEdge[] }): this {
    this.graph        = { adjacencyMap: new Map(), reverseMap: new Map(), edges: [] }
    this._cycleCache  = null

    for (const node of snapshot.nodes) this.ensureNode(node)
    for (const { from, to, specifier } of snapshot.edges) {
      this.addEdge(from, to, specifier)
    }

    return this
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private ensureNode(filePath: string): void {
    if (!this.graph.adjacencyMap.has(filePath)) {
      this.graph.adjacencyMap.set(filePath, [])
    }
    if (!this.graph.reverseMap.has(filePath)) {
      this.graph.reverseMap.set(filePath, [])
    }
  }

  /** Raw graph access — for advanced consumers only */
  getRawGraph(): Readonly<DependencyGraph> {
    return this.graph
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

/** Pre-constructed singleton for use in the renderer process */
export const dependencyGraphEngine = new DependencyGraphEngine()
