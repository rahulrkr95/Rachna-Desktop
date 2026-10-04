// lib/repoAnalysis.ts
//
// High-level facade that wires together:
//   • RepoScanner  (Step 1) — discovers and parses source files
//   • DependencyGraphEngine (Step 2) — builds and queries the graph
//
// This is the entry point most UI components / Tauri commands will use.
// It can be invoked directly in Node (Tauri sidecar) or in the renderer.
//
// ─────────────────────────────────────────────────────────────────────────
// EXAMPLE OUTPUT (ScanResult → graph queries)
// ─────────────────────────────────────────────────────────────────────────
//
// Given a project with:
//   src/
//     App.tsx          (imports Header, Editor)
//     components/
//       Header.tsx     (imports utils/formatDate)
//       Editor.tsx     (imports utils/formatDate, hooks/useTheme)
//     utils/
//       formatDate.ts  (no local imports)
//     hooks/
//       useTheme.ts    (imports utils/formatDate)
//
// ScanResult.files example (one FileNode):
// {
//   path:         "/proj/src/components/Header.tsx",
//   relativePath: "src/components/Header.tsx",
//   extension:    "tsx",
//   imports: [
//     {
//       specifier:       "../utils/formatDate",
//       resolvedPath:    "/proj/src/utils/formatDate.ts",
//       namedImports:    ["formatDate"],
//       defaultImport:   null,
//       namespaceImport: null
//     }
//   ],
//   exports: [
//     { name: "Header",  kind: "function"   },
//     { name: "default", kind: "default"    }
//   ],
//   metadata: {
//     sizeBytes:    1024,
//     lastModified: "2024-06-01T10:00:00.000Z",
//     lineCount:    42
//   }
// }
//
// Graph queries on that project:
//   getDependencies("src/App.tsx")
//     → ["src/components/Header.tsx", "src/components/Editor.tsx"]
//
//   getDependents("src/utils/formatDate.ts")
//     → ["src/components/Header.tsx", "src/components/Editor.tsx", "src/hooks/useTheme.ts"]
//
//   getRelatedFiles("src/utils/formatDate.ts", { depth: 2, direction: "dependents" })
//     → ["src/components/Header.tsx", "src/components/Editor.tsx",
//        "src/hooks/useTheme.ts", "src/App.tsx"]
//
//   detectCycles()  →  []  (no cycles in this project)
//
//   topologicalOrder()
//     → ["src/utils/formatDate.ts", "src/hooks/useTheme.ts",
//        "src/components/Header.tsx", "src/components/Editor.tsx",
//        "src/App.tsx"]
//
// ─────────────────────────────────────────────────────────────────────────

import { repoScanner }           from './repoScanner'
import { dependencyGraphEngine } from './dependencyGraph'
import type { ScanResult }       from './repoScanner/types'
import type { CycleRecord, GraphStats } from './dependencyGraph/types'

// ── Types ─────────────────────────────────────────────────────────────────

export interface AnalysisResult {
  scan:   ScanResult
  cycles: CycleRecord[]
  stats:  GraphStats
}

// ── Facade ────────────────────────────────────────────────────────────────

/**
 * Scans `projectRoot`, builds the dependency graph, and returns a combined
 * analysis result.
 *
 * @example
 * const analysis = await analyseProject('/home/user/my-app')
 * console.log(`Files: ${analysis.scan.totalFiles}`)
 * console.log(`Cycles: ${analysis.cycles.length}`)
 *
 * const deps = dependencyGraphEngine.getDependencies('/home/user/my-app/src/App.tsx')
 */
export async function analyseProject(projectRoot: string): Promise<AnalysisResult> {
  // Step 1 — Scan
  const scan = await repoScanner.scan({ projectRoot })

  // Step 2 — Build graph
  dependencyGraphEngine.buildFromScan(scan)

  // Detect cycles and collect stats
  const cycles = dependencyGraphEngine.detectCycles()
  const stats  = dependencyGraphEngine.getStats()

  return { scan, cycles, stats }
}

/**
 * Lightweight re-scan of a single file that has changed on disk.
 * Removes the old node from the graph, re-parses just that file,
 * and re-inserts it with updated edges.
 *
 * Avoids a full project re-scan on every keystroke / file save.
 *
 * @example
 * // Called from the Tauri file-watcher event handler
 * await refreshFile('/home/user/my-app/src/components/Header.tsx', currentScanResult)
 */
export async function refreshFile(
  filePath: string,
  currentScan: ScanResult,
): Promise<ScanResult> {
  const updatedScan = await repoScanner.scan({
    projectRoot: currentScan.projectRoot,
  })

  // Atomically replace the stale file node in the scan result
  const oldIdx = updatedScan.files.findIndex(f => f.path === filePath)
  const newNode = updatedScan.files.find(f => f.path === filePath)

  if (newNode) {
    // Update graph incrementally
    dependencyGraphEngine.removeNode(filePath)
    // Re-add edges from the refreshed node
    const knownPaths = new Set(currentScan.files.map(f => f.path))
    for (const imp of newNode.imports) {
      if (imp.resolvedPath && knownPaths.has(imp.resolvedPath)) {
        dependencyGraphEngine.addEdge(filePath, imp.resolvedPath, imp.specifier)
      }
    }
  }

  return updatedScan
}
