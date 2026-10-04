// lib/dependencyGraph/index.ts
//
// Public API surface of the Dependency Graph module.

export { DependencyGraphEngine, dependencyGraphEngine } from './graphEngine'

export type {
  DependencyGraph,
  DependencyEdge,
  CycleRecord,
  RelatedFilesOptions,
  GraphStats,
} from './types'

// Re-export algorithms for advanced / testing use cases
export {
  detectCycles,
  bfsForward,
  bfsReverse,
  shortestPath,
  topologicalSort,
} from './algorithms'
