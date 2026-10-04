// lib/repoScanner/summarizer.ts
//
// Generates FileSummary metadata for indexed files.
//
// By default this uses fast, dependency-free heuristics derived purely from
// the data already produced by the scanner (path conventions, exports,
// symbols, imports, line counts). This keeps `buildRepoIndex()` usable on
// every scan with zero extra cost.
//
// For higher-quality natural-language summaries, callers can pass a
// `customSummarizer` (e.g. backed by Gemini/Claude/OpenAI) to SummarizeOptions.
// Its result is used verbatim when non-empty; the heuristic summary is the
// fallback for any file where the custom summarizer returns nothing (or
// throws).

import * as fs from 'fs'

import type {
  FileNode,
  FileSummary,
  SummarizeOptions,
} from './types'
import { pLimit } from './utils'

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Generates a FileSummary for a single FileNode using built-in heuristics.
 * Pure and synchronous — never touches disk beyond what `file` already holds.
 */
export function generateFileSummary(file: FileNode): FileSummary {
  return {
    path:    file.relativePath,
    summary: heuristicSummary(file),
    exports: file.exports.map(e => e.name),
    imports: file.imports.map(i => i.specifier),
  }
}

/**
 * Generates FileSummary metadata for every file in `files`.
 *
 * If `options.customSummarizer` is provided it is invoked per file (with
 * bounded concurrency) to obtain a richer description; any file for which it
 * returns a falsy value falls back to `generateFileSummary()`.
 */
export async function generateFileSummaries(
  files: FileNode[],
  options: SummarizeOptions = {},
): Promise<FileSummary[]> {
  const { customSummarizer, concurrency = 5 } = options

  // Fast path: no custom summarizer — fully synchronous, no scheduling.
  if (!customSummarizer) {
    return files.map(generateFileSummary)
  }

  const tasks = files.map(file => async (): Promise<FileSummary> => {
    const base = generateFileSummary(file)
    try {
      const custom = await customSummarizer(file)
      if (custom && custom.trim().length > 0) {
        return { ...base, summary: custom.trim() }
      }
    } catch {
      // Custom summarizer failed (e.g. network/LLM error) — keep heuristic.
    }
    return base
  })

  return pLimit(tasks, Math.max(1, concurrency))
}

// ── Heuristic summary generation ───────────────────────────────────────────

/**
 * Builds a short, information-dense description of `file` from path
 * conventions, exports, and indexed symbols — no source reading required.
 */
function heuristicSummary(file: FileNode): string {
  const role        = describeRole(file)
  const highlights  = describeHighlights(file)
  const dependency  = describeDependencies(file)

  const parts = [role]
  if (highlights) parts.push(highlights)
  if (dependency) parts.push(dependency)

  return parts.join(' ')
}

/** Top-level sentence describing what kind of file this is and its purpose. */
function describeRole(file: FileNode): string {
  const { extension, relativePath, symbols, metadata } = file
  const lowerPath = relativePath.toLowerCase()
  const baseName  = lowerPath.split('/').pop() ?? lowerPath

  // ── Stylesheets ─────────────────────────────────────────────────────
  if (extension === 'css' || extension === 'scss') {
    const ruleCount = symbols.filter(s => s.type === 'style-rule').length
    const scope     = guessAreaFromPath(relativePath)
    return ruleCount > 0
      ? `Stylesheet defining ${ruleCount} rule${ruleCount === 1 ? '' : 's'}${scope ? ` for ${scope}` : ''}.`
      : `Stylesheet${scope ? ` for ${scope}` : ''}.`
  }

  // ── Markup ───────────────────────────────────────────────────────────
  if (extension === 'html' || extension === 'htm') {
    const scope = guessAreaFromPath(relativePath)
    return `HTML page/template${scope ? ` for ${scope}` : ''} with ${file.imports.length} linked asset${file.imports.length === 1 ? '' : 's'}.`
  }

  // ── Tests ───────────────────────────────────────────────────────────
  if (/\.(test|spec)\./.test(baseName) || lowerPath.includes('__tests__')) {
    const target = baseName.replace(/\.(test|spec)\.[a-z]+$/, '')
    return `Test suite covering ${target || 'this module'}.`
  }

  // ── Barrel / re-export modules ──────────────────────────────────────
  if (baseName.startsWith('index.') && file.exports.every(e => e.kind === 're-export')) {
    return `Barrel module re-exporting the public API of ${guessAreaFromPath(relativePath, true) || 'this directory'}.`
  }

  // ── Type-only modules ────────────────────────────────────────────────
  const typeSymbols = symbols.filter(s => s.type === 'interface' || s.type === 'type' || s.type === 'enum')
  if (typeSymbols.length > 0 && typeSymbols.length === symbols.length) {
    return `Type definitions module declaring shared interfaces/types used across ${guessAreaFromPath(relativePath, true) || 'the project'}.`
  }

  // ── React components ─────────────────────────────────────────────────
  const components = symbols.filter(s => s.type === 'component')
  if (components.length > 0) {
    const names = components.map(c => c.name)
    return `React component module implementing ${formatList(names)}.`
  }

  // ── Hooks ────────────────────────────────────────────────────────────
  const hooks = symbols.filter(s => /^use[A-Z]/.test(s.name))
  if (hooks.length > 0) {
    return `Custom React hook module providing ${formatList(hooks.map(h => h.name))}.`
  }

  // ── State management ────────────────────────────────────────────────
  if (/\b(store|slice|reducer|context)\b/.test(lowerPath)) {
    const names = symbols.filter(s => s.type !== 'style-rule').map(s => s.name)
    return `State management module${names.length ? ` defining ${formatList(names)}` : ''}.`
  }

  // ── Services / API / backend ────────────────────────────────────────
  if (/\b(api|routes?|controllers?|services?|handlers?|server)\b/.test(lowerPath)) {
    const fns = symbols.filter(s => s.type === 'function' || s.type === 'class')
    return `Service/API module${fns.length ? ` implementing ${formatList(fns.map(f => f.name))}` : ''} for ${guessAreaFromPath(relativePath, true) || 'backend logic'}.`
  }

  // ── Utilities / helpers ─────────────────────────────────────────────
  if (/\b(utils?|helpers?|lib)\b/.test(lowerPath)) {
    const fns = symbols.filter(s => s.type === 'function')
    return fns.length
      ? `Utility module providing helper function${fns.length === 1 ? '' : 's'} ${formatList(fns.map(f => f.name))}.`
      : `Utility module for ${guessAreaFromPath(relativePath, true) || 'shared helper logic'}.`
  }

  // ── Classes ──────────────────────────────────────────────────────────
  const classes = symbols.filter(s => s.type === 'class')
  if (classes.length > 0) {
    return `Module defining class${classes.length === 1 ? '' : 'es'} ${formatList(classes.map(c => c.name))}.`
  }

  // ── Generic functions/exports ───────────────────────────────────────
  const fns = symbols.filter(s => s.type === 'function' || s.type === 'default')
  if (fns.length > 0) {
    return `Module implementing ${formatList(fns.map(f => f.name))}.`
  }

  // ── Fallback ─────────────────────────────────────────────────────────
  const sizeNote = metadata.lineCount > 0 ? ` (${metadata.lineCount} lines)` : ''
  return `Source file ${baseName}${sizeNote} within ${guessAreaFromPath(relativePath, true) || 'the project'}.`
}

/**
 * Second sentence calling out exported symbols not already covered by the
 * role description, so the summary captures the file's full public surface.
 */
function describeHighlights(file: FileNode): string | null {
  const exportNames = file.exports
    .filter(e => e.kind !== 're-export' && e.name !== 'default')
    .map(e => e.name)

  if (exportNames.length === 0) return null

  return `Exports: ${formatList(exportNames, 8)}.`
}

/** Third sentence summarizing notable dependencies, to aid graph-based ranking. */
function describeDependencies(file: FileNode): string | null {
  if (file.imports.length === 0) return null

  // Prefer bare-module (external/library) specifiers — they're more
  // descriptive of *what kind* of file this is (e.g. "react", "express").
  const externals = file.imports
    .filter(i => !i.resolvedPath)
    .map(i => i.specifier)
    .filter(s => !s.startsWith('.'))

  const uniqueExternals = [...new Set(externals)]
  if (uniqueExternals.length === 0) return null

  return `Depends on ${formatList(uniqueExternals, 5)}.`
}

// ── Small formatting helpers ───────────────────────────────────────────────

/** Joins names as "a, b and c", truncating with "+N more" beyond `max`. */
function formatList(names: string[], max = 5): string {
  const unique = [...new Set(names.filter(Boolean))]
  if (unique.length === 0) return ''
  if (unique.length <= max) return joinWithAnd(unique)

  const shown   = unique.slice(0, max)
  const extra   = unique.length - max
  return `${joinWithAnd(shown)} (+${extra} more)`
}

function joinWithAnd(items: string[]): string {
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Derives a human-friendly "area" name from a file's directory path, e.g.
 *   "src/components/auth/LoginForm.tsx" → "auth"
 *   "src/utils/format.ts"                → "utils"
 *
 * When `preferParent` is true and the immediate directory is generic
 * (e.g. "components", "src"), walks up to find a more specific ancestor.
 */
function guessAreaFromPath(relativePath: string, preferParent = false): string | null {
  const segments = relativePath.split('/').slice(0, -1) // drop filename
  if (segments.length === 0) return null

  const generic = new Set(['src', 'app', 'lib', 'components', 'pages', 'index'])

  if (preferParent) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (!generic.has(segments[i].toLowerCase())) return segments[i]
    }
    return segments[segments.length - 1] ?? null
  }

  const last = segments[segments.length - 1]
  return generic.has(last.toLowerCase()) && segments.length > 1
    ? segments[segments.length - 2]
    : last
}

// Re-exported for callers that want to read raw content alongside a summary
// (e.g. a custom LLM summarizer that wants the file body too).
export function readFileSafe(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    return null
  }
}
