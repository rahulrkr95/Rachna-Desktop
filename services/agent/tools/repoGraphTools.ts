// services/agent/tools/repoGraphTools.ts
//
// Tools: find_dependencies, find_dependents, trace_import_chain,
//        find_component_usage, find_hook_usage
//
// Wraps the existing in-memory `dependencyGraphEngine` (built from the
// repo scan in store/useRepoIndex.ts) and the cached `scanResult` (for
// symbol/import metadata not present in the bare graph) so the agent can
// navigate the codebase structurally instead of brute-force searching.
//
// No new graph implementation — these are thin adapters over:
//   - lib/repo-scanner/src/dependencyGraph/graphEngine.ts
//   - store/useRepoIndex.ts (scanResult)

import { dependencyGraphEngine } from '../../../lib/repo-scanner/src/dependencyGraph/graphEngine'
import { useRepoIndex } from '../../../store/useRepoIndex'
import type { FileNode } from '../../../lib/repo-scanner/src/repoScanner/types'
import { resolveWorkspacePath } from '../pathUtils'
import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'

// ── Shared helpers ──────────────────────────────────────────────────────

/** Returns the cached scan result's file list, or null if no scan yet. */
function getScannedFiles(): FileNode[] | null {
  const { scanResult } = useRepoIndex.getState()
  return scanResult?.files ?? null
}

/**
 * Resolves a model-supplied path to the absolute path used as the graph's
 * node key. Falls back to matching by `relativePath` (normalising slashes)
 * against the scanned file list, since the model often supplies short
 * paths like "src/App.tsx" while the graph is keyed by absolute paths.
 */
function resolveGraphFilePath(
  inputPath: string,
  ctx: ToolContext
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = inputPath.trim()
  if (!trimmed) return { ok: false, error: 'filePath must not be empty.' }

  const normalized = trimmed.replace(/\\/g, '/')

  // 1. Exact match against known graph nodes (absolute path as scanned)
  const nodes = dependencyGraphEngine.getRawGraph().adjacencyMap
  for (const node of nodes.keys()) {
    if (node.replace(/\\/g, '/') === normalized) return { ok: true, path: node }
  }

  // 2. Match by relativePath in the scan result
  const files = getScannedFiles()
  if (files) {
    const byRelative = files.find(
      f => f.relativePath.replace(/\\/g, '/') === normalized
    )
    if (byRelative) return { ok: true, path: byRelative.path }

    // 2b. Suffix match — model gave a partial path like "App.tsx" or
    // "components/App.tsx"
    const bySuffix = files.find(f =>
      f.relativePath.replace(/\\/g, '/').endsWith(normalized)
    )
    if (bySuffix) return { ok: true, path: bySuffix.path }
  }

  // 3. Fall back to resolving against the project root (absolute paths,
  //    or relative paths when no scan-based match was found)
  const resolved = resolveWorkspacePath(trimmed, ctx.projectRoot)
  if (resolved.ok && nodes.has(resolved.path)) {
    return { ok: true, path: resolved.path }
  }

  return {
    ok: false,
    error: `File "${inputPath}" was not found in the repository index. ` +
      `Make sure the project has been indexed and the path is correct.`,
  }
}

/** Converts an absolute graph path to a project-relative display path. */
function toRelative(absPath: string): string {
  const files = getScannedFiles()
  const match = files?.find(f => f.path === absPath)
  if (match) return match.relativePath.replace(/\\/g, '/')

  const { projectRoot } = useRepoIndex.getState()
  if (projectRoot && absPath.startsWith(projectRoot)) {
    return absPath.slice(projectRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  }
  return absPath.replace(/\\/g, '/')
}

function ensureGraphReady(): { ok: true } | { ok: false; error: string } {
  const { graphSnapshot, status } = useRepoIndex.getState()
  if (!graphSnapshot || status === 'idle') {
    return {
      ok: false,
      error:
        'The repository has not been indexed yet. Ask the user to open a ' +
        'folder so the dependency graph can be built.',
    }
  }
  return { ok: true }
}

// ── find_dependencies ──────────────────────────────────────────────────

export interface FindDependenciesArgs {
  filePath: string
}

export interface FindDependenciesResult {
  filePath: string
  dependencies: string[]
  count: number
}

export const findDependenciesTool: AgentTool<FindDependenciesArgs, FindDependenciesResult> = {
  declaration: {
    name: 'find_dependencies',
    description:
      'Returns the files directly imported by the given file (one hop, ' +
      'forward edges in the dependency graph). Use this to see what a ' +
      'file depends on.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file, e.g. "src/components/Dashboard.tsx" ' +
            '(relative to project root) or an absolute path.',
        },
      },
      required: ['filePath'],
    },
  },

  describeCall: (args) => `Finding dependencies of ${args.filePath}…`,

  execute: async (args, ctx: ToolContext) => {
    const ready = ensureGraphReady()
    if (!ready.ok) return toolErr(ready.error)

    const resolved = resolveGraphFilePath(args.filePath, ctx)
    if (!resolved.ok) return toolErr(resolved.error)

    const deps = dependencyGraphEngine.getDependencies(resolved.path).map(toRelative)

    return toolOk<FindDependenciesResult>({
      filePath: toRelative(resolved.path),
      dependencies: deps,
      count: deps.length,
    })
  },
}

// ── find_dependents ────────────────────────────────────────────────────

export interface FindDependentsArgs {
  filePath: string
}

export interface FindDependentsResult {
  filePath: string
  dependents: string[]
  count: number
}

export const findDependentsTool: AgentTool<FindDependentsArgs, FindDependentsResult> = {
  declaration: {
    name: 'find_dependents',
    description:
      'Returns the files that directly import the given file (one hop, ' +
      'reverse edges in the dependency graph). Use this to find out what ' +
      'would be affected if you change or remove this file — e.g. ' +
      '"what depends on AuthContext?" or "what breaks if I modify this file?"',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file, e.g. "src/context/AuthContext.tsx" ' +
            '(relative to project root) or an absolute path.',
        },
      },
      required: ['filePath'],
    },
  },

  describeCall: (args) => `Finding files that depend on ${args.filePath}…`,

  execute: async (args, ctx: ToolContext) => {
    const ready = ensureGraphReady()
    if (!ready.ok) return toolErr(ready.error)

    const resolved = resolveGraphFilePath(args.filePath, ctx)
    if (!resolved.ok) return toolErr(resolved.error)

    const dependents = dependencyGraphEngine.getDependents(resolved.path).map(toRelative)

    return toolOk<FindDependentsResult>({
      filePath: toRelative(resolved.path),
      dependents,
      count: dependents.length,
    })
  },
}

// ── trace_import_chain ─────────────────────────────────────────────────

export interface TraceImportChainArgs {
  filePath: string
  direction?: 'imports' | 'dependents' | 'both'
  depth?: number
}

export interface TraceImportChainResult {
  filePath: string
  direction: 'imports' | 'dependents' | 'both'
  depth: number
  dependencies: string[]
  dependents: string[]
}

export const traceImportChainTool: AgentTool<TraceImportChainArgs, TraceImportChainResult> = {
  declaration: {
    name: 'trace_import_chain',
    description:
      'Returns the transitive import relationships for a file: every file ' +
      'it (eventually) depends on, every file that (eventually) depends on ' +
      'it, or both. Use this to understand the full dependency chain for a ' +
      'file, e.g. "show the dependency chain for Dashboard.tsx".',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description:
            'Path to the file, e.g. "src/pages/Dashboard.tsx" ' +
            '(relative to project root) or an absolute path.',
        },
        direction: {
          type: 'string',
          enum: ['imports', 'dependents', 'both'],
          description:
            '"imports" = what this file transitively depends on, ' +
            '"dependents" = what transitively depends on this file, ' +
            '"both" = both directions. Defaults to "both".',
        },
        depth: {
          type: 'number',
          description:
            'Maximum number of hops to traverse. Omit or set to a large ' +
            'number (e.g. 100) for the full transitive closure. Defaults to ' +
            'unlimited.',
        },
      },
      required: ['filePath'],
    },
  },

  describeCall: (args) => `Tracing import chain for ${args.filePath}…`,

  execute: async (args, ctx: ToolContext) => {
    const ready = ensureGraphReady()
    if (!ready.ok) return toolErr(ready.error)

    const resolved = resolveGraphFilePath(args.filePath, ctx)
    if (!resolved.ok) return toolErr(resolved.error)

    const direction = args.direction ?? 'both'
    const depth = args.depth ?? Infinity

    let dependencies: string[] = []
    let dependents: string[] = []

    if (direction === 'imports' || direction === 'both') {
      dependencies =
        depth === Infinity
          ? dependencyGraphEngine.getAllDependencies(resolved.path)
          : dependencyGraphEngine.getRelatedFiles(resolved.path, { depth, direction: 'imports' })
    }

    if (direction === 'dependents' || direction === 'both') {
      dependents =
        depth === Infinity
          ? dependencyGraphEngine.getAllDependents(resolved.path)
          : dependencyGraphEngine.getRelatedFiles(resolved.path, { depth, direction: 'dependents' })
    }

    return toolOk<TraceImportChainResult>({
      filePath: toRelative(resolved.path),
      direction,
      depth: depth === Infinity ? -1 : depth,
      dependencies: dependencies.map(toRelative),
      dependents: dependents.map(toRelative),
    })
  },
}

// ── find_component_usage ───────────────────────────────────────────────

export interface FindComponentUsageArgs {
  componentName: string
}

export interface ComponentUsageMatch {
  file: string
  /** How the component appears in this file's imports. */
  importedAs: 'named' | 'default' | 'namespace' | 'declared-here'
  /** The import specifier the component was imported from, if applicable. */
  from?: string
}

export interface FindComponentUsageResult {
  componentName: string
  matches: ComponentUsageMatch[]
  count: number
}

export const findComponentUsageTool: AgentTool<FindComponentUsageArgs, FindComponentUsageResult> = {
  declaration: {
    name: 'find_component_usage',
    description:
      'Finds files that import or define a React component by name. Use ' +
      'this to answer questions like "where is UserCard used?" or "where ' +
      'is the Dashboard component defined?".',
    parameters: {
      type: 'object',
      properties: {
        componentName: {
          type: 'string',
          description: 'The component name, e.g. "UserCard" or "Dashboard". Case-sensitive, PascalCase.',
        },
      },
      required: ['componentName'],
    },
  },

  describeCall: (args) => `Finding usages of component "${args.componentName}"…`,

  execute: async (args, _ctx: ToolContext) => {
    const name = args.componentName?.trim()
    if (!name) return toolErr('componentName must not be empty.')

    const files = getScannedFiles()
    if (!files) {
      return toolErr(
        'The repository has not been indexed yet. Ask the user to open a folder first.'
      )
    }

    const matches: ComponentUsageMatch[] = []

    for (const file of files) {
      // Definition site: a component-kind symbol or export with this name.
      const definesHere =
        file.symbols.some(s => s.name === name && s.type === 'component') ||
        file.exports.some(e => e.name === name)

      if (definesHere) {
        matches.push({ file: file.relativePath.replace(/\\/g, '/'), importedAs: 'declared-here' })
      }

      // Usage site: imported via named/default/namespace import.
      for (const imp of file.imports) {
        if (imp.namedImports.includes(name)) {
          matches.push({
            file: file.relativePath.replace(/\\/g, '/'),
            importedAs: 'named',
            from: imp.specifier,
          })
        } else if (imp.defaultImport === name) {
          matches.push({
            file: file.relativePath.replace(/\\/g, '/'),
            importedAs: 'default',
            from: imp.specifier,
          })
        } else if (imp.namespaceImport === name) {
          matches.push({
            file: file.relativePath.replace(/\\/g, '/'),
            importedAs: 'namespace',
            from: imp.specifier,
          })
        }
      }
    }

    if (matches.length === 0) {
      return toolErr(`No usages or definitions of component "${name}" were found in the index.`)
    }

    return toolOk<FindComponentUsageResult>({ componentName: name, matches, count: matches.length })
  },
}

// ── find_hook_usage ─────────────────────────────────────────────────────

export interface FindHookUsageArgs {
  hookName: string
}

export interface HookUsageMatch {
  file: string
  importedAs: 'named' | 'default' | 'namespace' | 'declared-here'
  from?: string
}

export interface FindHookUsageResult {
  hookName: string
  matches: HookUsageMatch[]
  count: number
}

export const findHookUsageTool: AgentTool<FindHookUsageArgs, FindHookUsageResult> = {
  declaration: {
    name: 'find_hook_usage',
    description:
      'Finds files that import or define a React hook by name (e.g. ' +
      '"useAuth", "useRepoIndex"). Use this to answer questions like ' +
      '"where is useAuth used?" or "what files use the useRepoIndex store?".',
    parameters: {
      type: 'object',
      properties: {
        hookName: {
          type: 'string',
          description: 'The hook name, e.g. "useAuth". Conventionally starts with "use".',
        },
      },
      required: ['hookName'],
    },
  },

  describeCall: (args) => `Finding usages of hook "${args.hookName}"…`,

  execute: async (args, _ctx: ToolContext) => {
    const name = args.hookName?.trim()
    if (!name) return toolErr('hookName must not be empty.')

    if (!/^use[A-Z0-9]/.test(name)) {
      return toolErr(`"${name}" does not look like a hook name (expected something like "useAuth").`)
    }

    const files = getScannedFiles()
    if (!files) {
      return toolErr(
        'The repository has not been indexed yet. Ask the user to open a folder first.'
      )
    }

    const matches: HookUsageMatch[] = []

    for (const file of files) {
      const definesHere =
        file.symbols.some(s => s.name === name && (s.type === 'function' || s.type === 'variable')) ||
        file.exports.some(e => e.name === name)

      if (definesHere) {
        matches.push({ file: file.relativePath.replace(/\\/g, '/'), importedAs: 'declared-here' })
      }

      for (const imp of file.imports) {
        if (imp.namedImports.includes(name)) {
          matches.push({
            file: file.relativePath.replace(/\\/g, '/'),
            importedAs: 'named',
            from: imp.specifier,
          })
        } else if (imp.defaultImport === name) {
          matches.push({
            file: file.relativePath.replace(/\\/g, '/'),
            importedAs: 'default',
            from: imp.specifier,
          })
        } else if (imp.namespaceImport === name) {
          matches.push({
            file: file.relativePath.replace(/\\/g, '/'),
            importedAs: 'namespace',
            from: imp.specifier,
          })
        }
      }
    }

    if (matches.length === 0) {
      return toolErr(`No usages or definitions of hook "${name}" were found in the index.`)
    }

    return toolOk<FindHookUsageResult>({ hookName: name, matches, count: matches.length })
  },
}