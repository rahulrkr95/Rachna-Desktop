// lib/dependencyGraph/types.ts
//
// TypeScript interfaces for the in-memory dependency graph engine.

// ── Core graph primitives ─────────────────────────────────────────────────

/** A directed edge representing "file `from` imports from file `to`" */
export interface DependencyEdge {
  /** Absolute path of the importing file */
  from: string
  /** Absolute path of the imported file */
  to:   string
  /**
   * The raw import specifier as written in source, e.g. "../utils/helpers"
   * Useful for displaying in UIs without resolving back.
   */
  specifier: string
}

/**
 * The main graph structure.
 *
 * - `adjacencyMap`  maps each file → files it imports (forward edges)
 * - `reverseMap`    maps each file → files that import it (reverse edges)
 *
 * Both maps are maintained in sync on every mutation.
 * Storing both directions trades memory for O(1) dependent lookups.
 */
export interface DependencyGraph {
  /** Forward edges: file → its direct imports (absolute paths) */
  adjacencyMap: Map<string, string[]>
  /** Reverse edges: file → files that directly import it */
  reverseMap:   Map<string, string[]>
  /** All raw edges in the graph (deduplicated) */
  edges:        DependencyEdge[]
}

// ── Cycle detection ───────────────────────────────────────────────────────

/** One detected circular dependency chain */
export interface CycleRecord {
  /** The files forming the cycle in order, last element imports first */
  cycle: string[]
  /** Human-readable representation, e.g. "A → B → C → A" */
  display: string
}

// ── Traversal options ─────────────────────────────────────────────────────

export interface RelatedFilesOptions {
  /**
   * How many hops away from `startFile` to include.
   * depth=1 → direct imports + direct dependents
   * depth=2 → add their imports/dependents, etc.
   * Default: 1
   */
  depth?: number
  /**
   * Which direction(s) to traverse.
   * 'imports'   → follow forward edges (what this file needs)
   * 'dependents'→ follow reverse edges (what needs this file)
   * 'both'      → follow both directions  (default)
   */
  direction?: 'imports' | 'dependents' | 'both'
}

// ── Graph stats ───────────────────────────────────────────────────────────

export interface GraphStats {
  /** Total nodes (unique files) in the graph */
  nodeCount: number
  /** Total directed edges */
  edgeCount: number
  /** Number of detected cycles */
  cycleCount: number
  /** File with the most inbound edges (most-depended-on) */
  mostDepended: { file: string; count: number } | null
  /** File with the most outbound edges (most imports) */
  mostImports:  { file: string; count: number } | null
}
