// lib/dependencyGraph/algorithms.ts
//
// Pure graph algorithms operating on the DependencyGraph data structure.
// No state mutation — all functions are side-effect-free.
//
// Complexity notes are in terms of:
//   V = number of file nodes
//   E = number of directed edges

import type { DependencyGraph, CycleRecord } from './types'

// ── Cycle detection ───────────────────────────────────────────────────────

/**
 * Detects all simple cycles in the directed dependency graph using
 * iterative DFS with a colour-marking scheme (white / grey / black).
 *
 * Returns an array of CycleRecord — one per unique cycle found.
 * The same cycle is not reported multiple times regardless of entry node.
 *
 * Time:  O(V + E)
 * Space: O(V)  for the colour map + recursion stack
 */
export function detectCycles(graph: DependencyGraph): CycleRecord[] {
  const { adjacencyMap } = graph

  const WHITE  = 0  // undiscovered
  const GREY   = 1  // in current DFS path (on the recursion stack)
  const BLACK  = 2  // fully explored

  const color  = new Map<string, 0 | 1 | 2>()
  const parent = new Map<string, string | null>()
  const cycles: CycleRecord[] = []
  const seenCycles = new Set<string>() // dedup by canonical key

  // Initialise all nodes as WHITE
  for (const node of adjacencyMap.keys()) {
    color.set(node, WHITE)
  }

  // Iterative DFS to avoid call-stack overflow on deep graphs
  function dfs(start: string): void {
    // Stack entries: [node, iteratorIndex]
    const stack: Array<[string, number]> = [[start, 0]]
    const path:  string[] = [start]
    const pathSet = new Set<string>([start])

    color.set(start, GREY)

    while (stack.length > 0) {
      const [node, idx] = stack[stack.length - 1]
      const neighbours  = adjacencyMap.get(node) ?? []

      if (idx >= neighbours.length) {
        // Fully explored — pop and mark BLACK
        stack.pop()
        path.pop()
        pathSet.delete(node)
        color.set(node, BLACK)
        continue
      }

      // Advance the iterator index for the top frame
      stack[stack.length - 1][1]++

      const neighbour = neighbours[idx]

      if (!color.has(neighbour)) {
        // Neighbour not in adjacencyMap — skip (external/unresolved)
        continue
      }

      if (color.get(neighbour) === GREY) {
        // Back-edge found — we have a cycle
        const cycleStart = path.indexOf(neighbour)
        if (cycleStart !== -1) {
          const cycle = [...path.slice(cycleStart), neighbour]
          const key   = [...cycle].sort().join('|')

          if (!seenCycles.has(key)) {
            seenCycles.add(key)
            cycles.push({
              cycle,
              display: cycle.map(shortenPath).join(' → '),
            })
          }
        }
      } else if (color.get(neighbour) === WHITE) {
        color.set(neighbour, GREY)
        path.push(neighbour)
        pathSet.add(neighbour)
        stack.push([neighbour, 0])
      }
    }
  }

  for (const node of adjacencyMap.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node)
    }
  }

  return cycles
}

// ── BFS traversal ─────────────────────────────────────────────────────────

/**
 * Returns all nodes reachable from `startFile` within `maxDepth` hops
 * following forward edges (imports).
 *
 * Does NOT include `startFile` itself in the result.
 *
 * Time:  O(V + E)
 * Space: O(V)
 */
export function bfsForward(
  graph: DependencyGraph,
  startFile: string,
  maxDepth: number,
): Set<string> {
  return bfsGeneric(graph.adjacencyMap, startFile, maxDepth)
}

/**
 * Returns all nodes reachable from `startFile` within `maxDepth` hops
 * following reverse edges (dependents).
 *
 * Does NOT include `startFile` itself in the result.
 */
export function bfsReverse(
  graph: DependencyGraph,
  startFile: string,
  maxDepth: number,
): Set<string> {
  return bfsGeneric(graph.reverseMap, startFile, maxDepth)
}

/** Internal BFS over an arbitrary adjacency map */
function bfsGeneric(
  adjacency: Map<string, string[]>,
  start: string,
  maxDepth: number,
): Set<string> {
  const visited = new Set<string>()
  // Queue entries: [node, currentDepth]
  const queue: Array<[string, number]> = [[start, 0]]

  while (queue.length > 0) {
    const [node, depth] = queue.shift()!

    if (depth >= maxDepth) continue

    for (const neighbour of adjacency.get(node) ?? []) {
      if (!visited.has(neighbour) && neighbour !== start) {
        visited.add(neighbour)
        queue.push([neighbour, depth + 1])
      }
    }
  }

  return visited
}

// ── Shortest path ─────────────────────────────────────────────────────────

/**
 * Finds the shortest dependency path from `from` to `to` using BFS.
 *
 * Returns the ordered path array (inclusive of both endpoints),
 * or `null` if no path exists.
 *
 * Time:  O(V + E)
 */
export function shortestPath(
  graph: DependencyGraph,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from]

  const { adjacencyMap } = graph
  const visited = new Set<string>([from])
  const parentOf = new Map<string, string>()
  const queue: string[] = [from]

  while (queue.length > 0) {
    const node = queue.shift()!
    for (const neighbour of adjacencyMap.get(node) ?? []) {
      if (visited.has(neighbour)) continue
      visited.add(neighbour)
      parentOf.set(neighbour, node)

      if (neighbour === to) {
        // Reconstruct path
        const path: string[] = []
        let current: string | undefined = to
        while (current !== undefined) {
          path.unshift(current)
          current = parentOf.get(current)
        }
        return path
      }
      queue.push(neighbour)
    }
  }

  return null
}

// ── Topological sort ──────────────────────────────────────────────────────

/**
 * Returns nodes in topological order (leaves first, roots last).
 * If cycles exist, the algorithm returns a partial order — cyclic nodes
 * appear at the end in an unspecified order.
 *
 * Useful for: determining build order, processing order for tree-shaking.
 *
 * Time:  O(V + E)
 */
export function topologicalSort(graph: DependencyGraph): string[] {
  const { adjacencyMap } = graph
  const visited = new Set<string>()
  const result:  string[] = []

  function dfs(node: string): void {
    if (visited.has(node)) return
    visited.add(node)
    for (const neighbour of adjacencyMap.get(node) ?? []) {
      dfs(neighbour)
    }
    result.push(node)
  }

  for (const node of adjacencyMap.keys()) {
    dfs(node)
  }

  return result // leaves-first order
}

// ── Utility ───────────────────────────────────────────────────────────────

/**
 * Shortens an absolute path to its last two segments for display.
 * "/home/user/project/src/utils/helpers.ts" → "utils/helpers.ts"
 */
function shortenPath(absPath: string): string {
  const parts = absPath.replace(/\\/g, '/').split('/')
  return parts.slice(-2).join('/')
}
