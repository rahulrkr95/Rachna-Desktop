// lib/repoScanner/importResolver.ts
//
// ImportResolver — alias-aware, config-driven import resolution.
//
// Handles all modern frontend import patterns:
//   - Relative imports               ./foo, ../bar
//   - baseUrl-relative               components/Button  (when baseUrl = "src")
//   - Path alias mappings            @/utils → src/utils
//                                    ~/components → src/components
//   - Extensionless imports          import './Modal'   → Modal.tsx
//   - Directory index imports        import './Modal'   → Modal/index.tsx
//   - Mixed JS/TS repositories       .js extension → may resolve .ts
//   - Framework-specific aliases     React, Vite, Next.js, Angular, Vue
//
// Design:
//   - One ProjectConfig is loaded per project root and cached in a Map.
//   - Resolution is pure and synchronous after the config is loaded.
//   - No ts-morph dependency — importResolver is usable outside scan contexts.

import * as fs   from 'fs'
import * as path from 'path'

// ── Types ─────────────────────────────────────────────────────────────────

/** Raw shape of compilerOptions we care about from tsconfig / jsconfig */
interface CompilerOptions {
  baseUrl?: string
  paths?:   Record<string, string[]>
  rootDir?: string
  outDir?:  string
}

/** Parsed, resolved config for one project */
export interface ProjectConfig {
  /** Absolute path to the project root (directory containing tsconfig/jsconfig) */
  projectRoot:  string
  /** Absolute baseUrl if set, otherwise null */
  baseUrl:      string | null
  /**
   * Resolved alias mappings.
   * Key: pattern string (may end with `*`), e.g. "@/*", "~/*"
   * Value: array of resolved absolute replacement prefixes
   */
  aliases:      Array<{ pattern: string; targets: string[] }>
  /** Config source for debugging */
  configFile:   string | null
}

// ── Extension priority order ───────────────────────────────────────────────
//
// When trying to resolve an extensionless import, we probe in this order.
// TypeScript variants come before JavaScript to match TS compiler behaviour.
// `.js` → `.ts` mapping is included for projects that import TS files with
// the `.js` extension (a valid TS idiom per https://www.typescriptlang.org/docs/handbook/modules/theory.html).

const DEFAULT_PROBE_ORDER = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
] as const

// ── Config cache ──────────────────────────────────────────────────────────

const configCache = new Map<string, ProjectConfig>()

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Resolves a single import specifier to an absolute path on disk.
 *
 * @param importPath   The raw specifier as written in source, e.g.
 *                     `"@/components/Button"`, `"../utils"`, `"react"`
 * @param currentFile  Absolute path of the file that contains the import.
 * @param projectRoot  Absolute path of the project root.
 * @param extensions   Optional extra extensions to probe (no leading dot).
 *                     Merged with DEFAULT_PROBE_ORDER.
 * @returns            Absolute path if resolved, `null` if unresolvable
 *                     (external module, not on disk, etc.).
 */
export function resolveImport(
  importPath:  string,
  currentFile: string,
  projectRoot: string,
  extensions?: Set<string>,
): string | null {
  const config     = loadProjectConfig(projectRoot)
  const probeExts  = buildProbeList(extensions)

  // ── 1. Relative imports ───────────────────────────────────────────────
  if (isRelativeSpecifier(importPath)) {
    const fromDir = path.dirname(currentFile)
    return probeFile(path.resolve(fromDir, importPath), probeExts)
  }

  // ── 2. Alias mappings (tsconfig paths / common conventions) ──────────
  const aliasResolved = resolveAlias(importPath, config, probeExts)
  if (aliasResolved) return aliasResolved

  // ── 3. baseUrl-relative import ────────────────────────────────────────
  //    Only attempted when baseUrl is configured — avoids false positives
  //    on bare module names like "react" or "lodash".
  if (config.baseUrl) {
    const candidate = path.resolve(config.baseUrl, importPath)
    const hit = probeFile(candidate, probeExts)
    if (hit) return hit
  }

  // ── 4. Unresolvable (external/node_modules) ───────────────────────────
  return null
}

/**
 * Loads (and caches) the ProjectConfig for `projectRoot`.
 * Searches for tsconfig.json, then jsconfig.json in the root.
 * If neither exists, returns a minimal no-alias config.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const cached = configCache.get(projectRoot)
  if (cached) return cached

  const config = parseConfig(projectRoot)
  configCache.set(projectRoot, config)
  return config
}

/**
 * Clears the config cache for a specific project root (or all roots).
 * Call this when the user's tsconfig.json changes.
 */
export function invalidateConfigCache(projectRoot?: string): void {
  if (projectRoot) {
    configCache.delete(projectRoot)
  } else {
    configCache.clear()
  }
}

// ── Config parsing ─────────────────────────────────────────────────────────

function parseConfig(projectRoot: string): ProjectConfig {
  const candidates = [
    path.join(projectRoot, 'tsconfig.json'),
    path.join(projectRoot, 'jsconfig.json'),
    // Some projects keep configs in sub-dirs
    path.join(projectRoot, 'src', 'tsconfig.json'),
  ]

  for (const configFile of candidates) {
    if (!fs.existsSync(configFile)) continue

    let raw: unknown
    try {
      raw = JSON.parse(stripJsonComments(fs.readFileSync(configFile, 'utf-8')))
    } catch {
      continue
    }

    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>

    // Handle "extends" — read parent config for inherited paths/baseUrl.
    // We do a single level of inheritance (enough for >95% of real projects).
    let parentOptions: CompilerOptions = {}
    if (typeof obj.extends === 'string') {
      parentOptions = readParentCompilerOptions(obj.extends, path.dirname(configFile))
    }

    const compilerOptions: CompilerOptions = {
      ...parentOptions,
      ...(obj.compilerOptions as CompilerOptions | undefined ?? {}),
    }

    const configDir = path.dirname(configFile)

    // Resolve baseUrl relative to the config file's directory
    let baseUrl: string | null = null
    if (compilerOptions.baseUrl) {
      baseUrl = path.resolve(configDir, compilerOptions.baseUrl)
    }

    // Build alias list from paths + common framework conventions
    const aliases = buildAliases(compilerOptions, configDir, baseUrl, projectRoot)

    return { projectRoot, baseUrl, aliases, configFile }
  }

  // No config found — return minimal config with common-convention aliases
  return {
    projectRoot,
    baseUrl:    null,
    aliases:    buildConventionalAliases(projectRoot),
    configFile: null,
  }
}

function readParentCompilerOptions(
  extendsValue: string,
  configDir: string,
): CompilerOptions {
  try {
    let parentPath: string
    if (extendsValue.startsWith('.')) {
      parentPath = path.resolve(configDir, extendsValue)
      if (!parentPath.endsWith('.json')) parentPath += '.json'
    } else {
      // node_modules package (e.g. @tsconfig/node18) — skip
      return {}
    }
    if (!fs.existsSync(parentPath)) return {}
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(parentPath, 'utf-8')))
    return (raw?.compilerOptions as CompilerOptions) ?? {}
  } catch {
    return {}
  }
}

// ── Alias building ─────────────────────────────────────────────────────────

interface AliasEntry {
  pattern: string
  targets: string[]
}

function buildAliases(
  opts:        CompilerOptions,
  configDir:   string,
  baseUrl:     string | null,
  projectRoot: string,
): AliasEntry[] {
  const aliases: AliasEntry[] = []
  const base = baseUrl ?? configDir

  // ── From tsconfig/jsconfig paths ─────────────────────────────────────
  for (const [pattern, rawTargets] of Object.entries(opts.paths ?? {})) {
    const targets = rawTargets.map(t => {
      // Targets are relative to baseUrl or config directory
      const abs = path.resolve(base, t)
      // Strip trailing /* so we can use it as a base for path joining
      return abs.endsWith('/*') ? abs.slice(0, -2) : abs
    })
    const normalPattern = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern
    aliases.push({ pattern: normalPattern, targets })
  }

  // ── Common framework conventions (fallback if not in paths) ──────────
  const srcDir = path.join(projectRoot, 'src')

  const addIfMissing = (p: string, tgt: string) => {
    if (!aliases.some(a => a.pattern === p)) {
      aliases.push({ pattern: p, targets: [tgt] })
    }
  }

  // @/* → src/* or projectRoot/*
  const atSrc = fs.existsSync(srcDir) ? srcDir : projectRoot
  addIfMissing('@', atSrc)

  // ~/* → src/* (Vue / Webpack convention)
  addIfMissing('~', atSrc)

  // src/* (when used as a bare alias in some Vite configs)
  addIfMissing('src', srcDir)

  return aliases
}

/** Minimal alias map for projects without a config file */
function buildConventionalAliases(projectRoot: string): AliasEntry[] {
  const srcDir = path.join(projectRoot, 'src')
  const hasSrc = fs.existsSync(srcDir)
  const root   = hasSrc ? srcDir : projectRoot

  return [
    { pattern: '@',   targets: [root] },
    { pattern: '~',   targets: [root] },
    { pattern: 'src', targets: [srcDir] },
  ]
}

// ── Resolution helpers ─────────────────────────────────────────────────────

/**
 * Attempts to match `importPath` against the alias table.
 * Supports both exact aliases (@/Button) and prefix aliases (@/components).
 */
function resolveAlias(
  importPath: string,
  config:     ProjectConfig,
  probeExts:  readonly string[],
): string | null {
  for (const { pattern, targets } of config.aliases) {
    // Exact match: import '@' or import '~'
    if (importPath === pattern || importPath === pattern + '/') {
      for (const target of targets) {
        const hit = probeFile(target, probeExts)
        if (hit) return hit
      }
      continue
    }

    // Prefix match: import '@/components/Button'
    const prefix = pattern.endsWith('/') ? pattern : pattern + '/'
    if (importPath.startsWith(prefix)) {
      const remainder = importPath.slice(prefix.length)
      for (const target of targets) {
        const candidate = path.join(target, remainder)
        const hit = probeFile(candidate, probeExts)
        if (hit) return hit
      }
    }
  }
  return null
}

/**
 * Probes `candidate` on disk with the following strategy:
 *   1. Exact match  (import './style.css', './image.png')
 *   2. With extensions appended  (import './Modal' → Modal.tsx)
 *   3. As a directory index  (import './Modal' → Modal/index.tsx)
 *   4. JS→TS remapping  (import './foo.js' → foo.ts, foo.tsx)
 */
function probeFile(candidate: string, probeExts: readonly string[]): string | null {
  // 1. Exact match
  if (isFile(candidate)) return candidate

  // 4. JS extension → TS remapping (TypeScript idiom)
  //    e.g. import './utils.js' → try utils.ts, utils.tsx first
  const ext = path.extname(candidate)
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const base = candidate.slice(0, -ext.length)
    const tsAlts = ['.ts', '.tsx', '.mts', '.cts']
    for (const alt of tsAlts) {
      if (isFile(base + alt)) return base + alt
    }
  }

  // 2. Extensionless — append each candidate extension
  if (!ext || ext === '') {
    for (const e of probeExts) {
      if (isFile(candidate + e)) return candidate + e
    }
  }

  // 3. Directory index
  if (!ext || ext === '') {
    for (const e of probeExts) {
      const idx = path.join(candidate, 'index' + e)
      if (isFile(idx)) return idx
    }
  }

  return null
}

/** Fast sync file existence check (stat-based, no throws). */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Builds the ordered probe list, merging in any caller-supplied extensions. */
function buildProbeList(extra?: Set<string>): readonly string[] {
  if (!extra || extra.size === 0) return DEFAULT_PROBE_ORDER
  const extras = [...extra].map(e => (e.startsWith('.') ? e : '.' + e))
  // Put caller extensions after the defaults to avoid overriding TS priority
  const merged = [...DEFAULT_PROBE_ORDER, ...extras.filter(e => !DEFAULT_PROBE_ORDER.includes(e as typeof DEFAULT_PROBE_ORDER[number]))]
  return merged
}

/** Returns true when a specifier starts with `.` or `..` */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier === '.'
    || specifier === '..'
    || specifier.startsWith('./')
    || specifier.startsWith('../')
}

// Strips block and line comments from JSONC (tsconfig/jsconfig).
// Standard JSON.parse rejects comments; tsconfig allows them.
function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}
