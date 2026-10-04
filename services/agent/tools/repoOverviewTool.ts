// services/agent/tools/repoOverviewTool.ts
//
// Tool: get_repo_overview
//
// Returns a compact architectural overview of the open project derived from
// the latest scan result. The overview is assembled from the in-memory
// ScanResult (already present from the last indexFolder / refreshGraph call)
// so it is instantaneous — no additional disk I/O or subprocess needed.
//
// Output schema (RepoOverview):
//   projectRoot       — absolute path of the project
//   totalFiles        — number of indexed source files
//   totalLines        — aggregate line count
//   languages         — breakdown of file counts by extension
//   topLevelFolders   — immediate subdirectories of the project root
//   largestFiles      — top-10 files by line count (good complexity proxy)
//   mostImported      — top-10 files by how many other files import them
//   entryPoints       — heuristic list of likely entry-point files
//   exports           — total exported symbol count across the repo
//   symbols           — per-kind symbol totals (functions, classes, …)
//   parseErrors       — number of files that failed to parse
//   lastIndexedAt     — ISO timestamp of the last completed scan
//
// The result is also written to `<projectRoot>/.rachna/repo-summary.json`
// so external tools and CI pipelines can read it without running the IDE.

import { invoke }       from '@tauri-apps/api/core'
import { useRepoIndex } from '../../../store/useRepoIndex'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'
import type { ScanResult, FileNode } from '../../../lib/repo-scanner/src/repoScanner/types'

// ── Output types ────────────────────────────────────────────────────────────

export interface LanguageBreakdown {
  extension: string
  fileCount: number
  lineCount: number
}

export interface FileRef {
  path: string         // relative path
  lineCount: number
}

export interface FileImportCount {
  path: string         // relative path
  importedByCount: number
}

export interface SymbolTotals {
  functions:   number
  classes:     number
  interfaces:  number
  types:       number
  enums:       number
  components:  number
  variables:   number
  other:       number
}

export interface RepoOverview {
  projectRoot:     string
  totalFiles:      number
  totalLines:      number
  languages:       LanguageBreakdown[]
  topLevelFolders: string[]
  largestFiles:    FileRef[]
  mostImported:    FileImportCount[]
  entryPoints:     string[]
  exports:         number
  symbols:         SymbolTotals
  parseErrors:     number
  lastIndexedAt:   string | null
}

// ── Implementation ──────────────────────────────────────────────────────────

function buildOverview(scan: ScanResult, lastIndexedAt: string | null): RepoOverview {
  const files = scan.files

  // ── Language breakdown ───────────────────────────────────────────────────
  const langMap = new Map<string, { fileCount: number; lineCount: number }>()
  for (const f of files) {
    const ext = f.extension || 'unknown'
    const cur = langMap.get(ext) ?? { fileCount: 0, lineCount: 0 }
    langMap.set(ext, {
      fileCount: cur.fileCount + 1,
      lineCount: cur.lineCount + (f.metadata?.lineCount ?? 0),
    })
  }
  const languages: LanguageBreakdown[] = [...langMap.entries()]
    .map(([extension, v]) => ({ extension, ...v }))
    .sort((a, b) => b.fileCount - a.fileCount)

  // ── Top-level folders ────────────────────────────────────────────────────
  const folderSet = new Set<string>()
  for (const f of files) {
    const parts = f.relativePath.split('/')
    if (parts.length > 1) folderSet.add(parts[0])
  }
  const topLevelFolders = [...folderSet].sort()

  // ── Largest files ────────────────────────────────────────────────────────
  const largestFiles: FileRef[] = files
    .map(f => ({ path: f.relativePath, lineCount: f.metadata?.lineCount ?? 0 }))
    .sort((a, b) => b.lineCount - a.lineCount)
    .slice(0, 10)

  // ── Most imported files ──────────────────────────────────────────────────
  const importCounts = new Map<string, number>()
  for (const f of files) {
    for (const imp of f.imports ?? []) {
      if (imp.resolvedPath) {
        const count = importCounts.get(imp.resolvedPath) ?? 0
        importCounts.set(imp.resolvedPath, count + 1)
      }
    }
  }
  // Resolve absolute paths to relative for display
  const absToRel = new Map(files.map(f => [f.path, f.relativePath]))
  const mostImported: FileImportCount[] = [...importCounts.entries()]
    .map(([absPath, importedByCount]) => ({
      path: absToRel.get(absPath) ?? absPath,
      importedByCount,
    }))
    .sort((a, b) => b.importedByCount - a.importedByCount)
    .slice(0, 10)

  // ── Entry points (heuristic) ─────────────────────────────────────────────
  // Files that are likely entry points: index.* at root, main.*, App.*, etc.
  const entryPatterns = [
    /^(src\/)?index\.[jt]sx?$/,
    /^(src\/)?main\.[jt]sx?$/,
    /^(src\/)?App\.[jt]sx?$/,
    /^main\.rs$/,
    /^main\.go$/,
    /^main\.py$/,
    /^Program\.cs$/,
    /^Dockerfile$/i,
    /^docker-compose\.ya?ml$/i,
  ]
  const entryPoints: string[] = files
    .filter(f => entryPatterns.some(p => p.test(f.relativePath)))
    .map(f => f.relativePath)
    .sort()

  // ── Export count ─────────────────────────────────────────────────────────
  const exportTotal = files.reduce((sum, f) => sum + (f.exports?.length ?? 0), 0)

  // ── Symbol totals ────────────────────────────────────────────────────────
  const symbolTotals: SymbolTotals = {
    functions:  0,
    classes:    0,
    interfaces: 0,
    types:      0,
    enums:      0,
    components: 0,
    variables:  0,
    other:      0,
  }
  for (const f of files) {
    for (const s of f.symbols ?? []) {
      switch (s.type) {
        case 'function': symbolTotals.functions++;  break
        case 'class':    symbolTotals.classes++;    break
        case 'interface':symbolTotals.interfaces++; break
        case 'type':     symbolTotals.types++;      break
        case 'enum':     symbolTotals.enums++;      break
        case 'component':symbolTotals.components++; break
        case 'variable': symbolTotals.variables++;  break
        default:         symbolTotals.other++;      break
      }
    }
  }

  return {
    projectRoot:     scan.projectRoot,
    totalFiles:      scan.totalFiles,
    totalLines:      scan.totalLines,
    languages,
    topLevelFolders,
    largestFiles,
    mostImported,
    entryPoints,
    exports:         exportTotal,
    symbols:         symbolTotals,
    parseErrors:     Object.keys(scan.errors ?? {}).length,
    lastIndexedAt,
  }
}

/** Persists the overview to <projectRoot>/.rachna/repo-summary.json via Tauri. */
async function persistSummary(overview: RepoOverview, projectRoot: string): Promise<void> {
  try {
    const json = JSON.stringify(overview, null, 2)
    // save_file with explicit path creates parent dirs automatically
    await invoke('save_file', {
      path: `${projectRoot}/.rachna/repo-summary.json`,
      content: json,
      defaultName: null,
    })
  } catch {
    // Non-fatal — the tool still returns the overview even if disk write fails
  }
}

// ── Tool definition ──────────────────────────────────────────────────────────

export interface GetRepoOverviewArgs {
  /** When true, skips writing repo-summary.json (default: false) */
  skipPersist?: boolean
}

export const getRepoOverviewTool: AgentTool<GetRepoOverviewArgs, RepoOverview> = {
  declaration: {
    name: 'get_repo_overview',
    description:
      'Returns a structural overview of the open project: language breakdown, ' +
      'file/line counts, largest files, most-imported modules, heuristic entry ' +
      'points, and symbol totals (functions, classes, components, etc.). ' +
      'Use this at the start of an unfamiliar codebase to orient yourself before ' +
      'diving into specific files. Also writes the result to ' +
      '.rachna/repo-summary.json for external tools. ' +
      'Requires a project folder to be open and indexed.',
    parameters: {
      type: 'object',
      properties: {
        skipPersist: {
          type: 'boolean',
          description: 'Set to true to skip writing .rachna/repo-summary.json (default: false).',
        },
      },
      required: [],
    },
  },

  describeCall: () => 'Generating repo overview…',

  execute: async (args, ctx: ToolContext) => {
    const { scanResult, lastIndexedAt } = useRepoIndex.getState()

    if (!scanResult) {
      return toolErr(
        'No repository index available. Open a project folder first — ' +
        'the repo must be indexed before get_repo_overview can run.'
      )
    }

    const overview = buildOverview(scanResult, lastIndexedAt)

    // Persist to .rachna/repo-summary.json (fire-and-forget — non-fatal)
    if (!args.skipPersist && ctx.projectRoot) {
      persistSummary(overview, ctx.projectRoot).catch(() => { /* ignore */ })
    }

    return toolOk<RepoOverview>(overview)
  },
}
