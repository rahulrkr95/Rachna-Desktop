// lib/repoScanner/utils.ts
//
// Pure helper utilities consumed by the scanner service.
// No ts-morph dependency here — keep this layer fast and testable in isolation.

import * as path from 'path'
import * as fs   from 'fs'
import type { FileMetadata, ExportKind } from './types'
export { resolveImport, loadProjectConfig, invalidateConfigCache } from './importResolver'
export type { ProjectConfig } from './importResolver'

// ── Constants ─────────────────────────────────────────────────────────────

/** Directory names always excluded from scanning */
export const DEFAULT_IGNORE_DIRS = new Set([
  // JavaScript / Node
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.output',
  // Python
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'venv',
  '.venv',
  'env',
  '.env',          // common virtualenv name (not .env file)
  'site-packages',
  // Rust
  'target',
  // Go
  'vendor',
  // Ruby
  '.bundle',
  // Java / Kotlin / Scala
  'bin',
  'obj',
  // Version control
  '.git',
  '.svn',
  '.hg',
  // CI / tooling
  '.github',
  '.gitlab',
  '__mocks__',
  '__tests__',   // still walk tests, skip only generated outputs
  'tmp',
  'temp',
])

/** File extensions included by default (without the leading dot).
 *  NOTE: The scanner extends this dynamically with adapter-registered
 *  extensions — do not add new languages here; add them via an Adapter. */
export const DEFAULT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'html', 'htm', 'css', 'scss'])

// ── .gitignore support ────────────────────────────────────────────────────

export interface GitignoreRules {
  /** Directory base-names to skip (e.g. "dist", "coverage") */
  ignoreDirNames: Set<string>
  /** Glob-like patterns for file paths (supports * wildcard only) */
  ignorePatterns: string[]
}

/**
 * Reads and parses a `.gitignore` file into `GitignoreRules`.
 * Returns empty rules when the file doesn't exist or can't be read.
 *
 * Handles:
 *  - Blank lines and `#` comments (ignored)
 *  - Negation patterns (`!`) are skipped (complex to implement safely)
 *  - Trailing-slash patterns like `dist/` → treated as directory names
 *  - Simple glob `*.ext` → converted to suffix match
 *  - Plain names like `.env` → treated as exact filename patterns
 */
export function parseGitignore(gitignorePath: string): GitignoreRules {
  const rules: GitignoreRules = { ignoreDirNames: new Set(), ignorePatterns: [] }

  let raw: string
  try {
    raw = fs.readFileSync(gitignorePath, 'utf-8')
  } catch {
    return rules
  }

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue

    // Trailing slash → directory name
    if (line.endsWith('/')) {
      const dirName = line.slice(0, -1).replace(/^\//, '')
      // Only add if it's a simple name (no path separators remaining)
      if (!dirName.includes('/') && !dirName.includes('*')) {
        rules.ignoreDirNames.add(dirName)
      }
      continue
    }

    // No path separator (or leading slash only) → add as pattern
    const clean = line.replace(/^\//, '')

    // Simple directory names without wildcards → also add to ignoreDirNames
    // (gitignore treats plain names as matching both files and directories)
    if (!clean.includes('/') && !clean.includes('*') && !clean.includes('?')) {
      rules.ignoreDirNames.add(clean)
      rules.ignorePatterns.push(clean)
      continue
    }

    rules.ignorePatterns.push(clean)
  }

  return rules
}

/**
 * Returns `true` when `filePath` matches any pattern in `rules`.
 * Only the base-name of the file is tested against non-path patterns.
 */
export function matchesGitignore(filePath: string, rules: GitignoreRules): boolean {
  const basename = path.basename(filePath)
  for (const pattern of rules.ignorePatterns) {
    if (globMatch(pattern, basename) || globMatch(pattern, filePath)) return true
  }
  return false
}

/**
 * Minimal glob matcher supporting `*` (any sequence of non-separator chars)
 * and `**` (any sequence including separators).
 */
function globMatch(pattern: string, str: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')   // placeholder for **
    .replace(/\*/g,   '[^/]*')    // * → match non-separator chars
    .replace(/\u0001/g, '.*')     // ** → match anything
  try {
    return new RegExp(`^${escaped}$`).test(str)
  } catch {
    return false
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────

/**
 * Returns the extension of `filePath` without the leading dot.
 * Returns an empty string for files with no extension.
 *
 * @example extOf('/src/App.tsx') → 'tsx'
 */
export function extOf(filePath: string): string {
  const filename = path.basename(filePath).toLowerCase()
  if (filename === 'dockerfile' || filename.startsWith('dockerfile.')) {
    return 'dockerfile'
  }
  return path.extname(filePath).replace(/^\./, '').toLowerCase()
}

/**
 * Converts an absolute path to a path relative to `root`.
 * Always uses forward slashes so output is platform-independent.
 *
 * @example toRelative('/proj', '/proj/src/App.tsx') → 'src/App.tsx'
 */
export function toRelative(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/')
}

/**
 * Given a relative import specifier (starts with `.` or `..`) and the
 * absolute path of the file that contains it, tries to resolve the
 * specifier to an absolute path on disk.
 *
 * Attempts bare path, then with each of the given extensions appended,
 * then /index.<ext> for directory imports.
 *
 * Returns `null` when the specifier cannot be resolved (file not found).
 */
export function resolveRelativeImport(
  specifier: string,
  fromFile: string,
  extensions: Set<string>,
): string | null {
  if (!isRelativeSpecifier(specifier)) return null

  const fromDir   = path.dirname(fromFile)
  const candidate = path.resolve(fromDir, specifier)

  // 1. Exact match (e.g., import "./style.css")
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate
  }

  // 2. Try adding each extension
  for (const ext of extensions) {
    const withExt = `${candidate}.${ext}`
    if (fs.existsSync(withExt)) return withExt
  }

  // 3. Try as a directory index file
  for (const ext of extensions) {
    const indexFile = path.join(candidate, `index.${ext}`)
    if (fs.existsSync(indexFile)) return indexFile
  }

  return null
}

/** Returns true when a specifier starts with "." or ".." */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./')
      || specifier.startsWith('../')
      || specifier === '.'
      || specifier === '..'
}

// ── Metadata helpers ──────────────────────────────────────────────────────

/**
 * Reads lightweight metadata for a file without loading its full content.
 * Uses a single `stat` call — no reads.
 */
export function readMetadata(filePath: string, content: string): FileMetadata {
  const stat = fs.statSync(filePath)
  return {
    sizeBytes:    stat.size,
    lastModified: stat.mtime.toISOString(),
    lineCount:    countLines(content),
  }
}

/**
 * Fast newline counter — avoids splitting the string into an array.
 * O(n) but allocation-free for the line array.
 */
export function countLines(content: string): number {
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* '\n' */) count++
  }
  return count
}

// ── Export kind classifier ────────────────────────────────────────────────

/**
 * Maps a ts-morph SyntaxKind number to a human-readable ExportKind string.
 * Falls back to "variable" for anything not explicitly mapped.
 */
export function classifyExportKind(syntaxKindName: string): ExportKind {
  const map: Record<string, ExportKind> = {
    FunctionDeclaration:    'function',
    ArrowFunction:          'function',
    FunctionExpression:     'function',
    ClassDeclaration:       'class',
    ClassExpression:        'class',
    InterfaceDeclaration:   'interface',
    TypeAliasDeclaration:   'type',
    EnumDeclaration:        'enum',
    VariableStatement:      'variable',
    VariableDeclaration:    'variable',
    ExportAssignment:       'default',
    ExportDeclaration:      're-export',
  }
  return map[syntaxKindName] ?? 'variable'
}

// ── Concurrency helper ────────────────────────────────────────────────────

/**
 * Runs `tasks` in parallel with a maximum of `concurrency` running at once.
 * Preserves order of results (matches order of `tasks`).
 *
 * This avoids spawning thousands of Promises simultaneously on very large
 * repos, which would cause memory pressure and I/O contention.
 *
 * @example
 * const results = await pLimit(files.map(f => () => parseFile(f)), 20)
 */
export async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let   nextIndex    = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      results[index] = await tasks[index]()
    }
  }

  // Launch `concurrency` workers in parallel
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  await Promise.all(workers)
  return results
}
