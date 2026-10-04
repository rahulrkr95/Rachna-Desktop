// lib/repoScanner/scanner.ts
//
// Main RepoScanner class.  Walks a project directory, discovers source files,
// detects the repository's language composition, and routes each file to its
// own independent parser pipeline with configurable concurrency.
//
// File routing:
//   ts / tsx / js / jsx / mts / mjs / cts / cjs → ts-morph pipeline (lazy-loaded)
//   html / htm / xhtml / shtml                  → htmlParser pipeline
//   css / scss / less / pcss / postcss           → cssParser pipeline
//   everything else with a known adapter         → pluggable LanguageAdapter pipeline
//
// ts-morph is a TS/JS *plugin*, not the foundation of the scan: the ts-morph
// module (and the fileParser module that depends on it) is only
// dynamically imported — and a ts-morph Project only ever constructed —
// when the current file set actually contains TS/JS source. Repositories
// (or incremental batches) with no TS/JS files never pay ts-morph's
// startup/memory cost.
//
// .gitignore: parsed at project root; matched dirs/files are skipped.

import * as fs   from 'fs'
import * as path from 'path'

import type { ScanOptions, ScanResult, ScanStats, ScanStreamOptions, FileNode, ImportRecord, ExportRecord, SymbolRecord } from './types'
import { parseHtmlFile } from './htmlParser'
import { parseCssFile }  from './cssParser'
import {
  readMetadata, toRelative, extOf, pLimit,
  DEFAULT_IGNORE_DIRS, DEFAULT_EXTENSIONS,
  parseGitignore, matchesGitignore,
  type GitignoreRules,
} from './utils'
import { defaultRegistry } from './languageAdapters'
import {
  TS_JS_EXTS, HTML_EXTS, CSS_EXTS,
  detectRepositoryLanguages,
  type RepoLanguageProfile,
} from './languageDetection'

// A single unit of work in any pipeline: parse one file, return a FileNode
// (or null if parsing failed — the error is recorded in the shared `errors` map).
type ParseTask = () => Promise<FileNode | null>

/** Return type of `RepoScanner.scanWithContent()` — see that method's doc. */
export interface ScanWithContentResult {
  result: ScanResult
  contentCache: Map<string, string>
}

// Extensions handled by the LanguageAdapter system — derived at startup
// from the adapter registry so this set is always in sync with available adapters.
// The ts-morph pipeline handles TS_JS_EXTS directly, so we exclude those here
// even if the TypeScriptAdapter also lists them (it's used as a lightweight
// fallback/ranking adapter, not the primary TS/JS parser).
const ADAPTER_EXTS: Set<string> = (() => {
  const adapterExts = defaultRegistry.allExtensions()
  // Remove extensions handled by dedicated parsers above
  for (const ext of [...TS_JS_EXTS, ...HTML_EXTS, ...CSS_EXTS]) {
    adapterExts.delete(ext)
  }
  return adapterExts
})()

// Full discovery set: all extensions the scanner can handle
const ALL_KNOWN_EXTS = new Set([
  ...DEFAULT_EXTENSIONS,
  ...TS_JS_EXTS,
  ...HTML_EXTS,
  ...CSS_EXTS,
  ...ADAPTER_EXTS,
])

// ── RepoScanner ───────────────────────────────────────────────────────────

export class RepoScanner {

  /**
   * Scans the project at `options.projectRoot` and returns a structured
   * ScanResult containing all discovered FileNodes plus a summary.
   *
   * Thin wrapper around `scanWithContent()` that drops the content cache —
   * use this when you only need the parsed `ScanResult` (the common case).
   * Callers that go on to do further disk-bound processing on the same
   * files in the same indexing run (chunking, embedding, …) should call
   * `scanWithContent()` instead, so that work can reuse the content already
   * read here instead of reading each file again.
   */
  async scan(options: ScanOptions): Promise<ScanResult> {
    const { result } = await this.scanWithContent(options)
    return result
  }


  /**
   * Streams parsed files to `onFile` as soon as each parser finishes.
   * Unlike `scanWithContent()`, this method never builds a full ScanResult or
   * content cache; each file is parsed in a tiny one-file scan, persisted by
   * the caller, and then both source text and FileNode references are dropped.
   */
  async scanStream(options: ScanStreamOptions): Promise<ScanStats> {
    const t0 = Date.now()
    const {
      projectRoot,
      extraIgnoreDirs = [],
      extraExtensions = [],
      onlyFiles,
    } = options

    const root = path.resolve(projectRoot)
    const ignoreDirs = new Set([...DEFAULT_IGNORE_DIRS, ...extraIgnoreDirs])
    const gitignoreRules = parseGitignore(path.join(root, '.gitignore'))
    for (const dir of gitignoreRules.ignoreDirNames) ignoreDirs.add(dir)
    const extensions = new Set([...ALL_KNOWN_EXTS, ...extraExtensions])
    const filePaths = onlyFiles && onlyFiles.length > 0
      ? onlyFiles.filter(p => extensions.has(extOf(p)) && fs.existsSync(p))
      : this.discoverFiles(root, ignoreDirs, extensions, gitignoreRules)

    const languages = detectRepositoryLanguages(filePaths)
    const errors: Record<string, string> = {}
    let totalFiles = 0
    let totalLines = 0
    let symbolsIndexed = 0

    for (const absPath of filePaths) {
      const { result, contentCache } = await this.scanWithContent({
        projectRoot: root,
        extraIgnoreDirs,
        extraExtensions,
        concurrency: 1,
        onlyFiles: [absPath],
      })

      for (const [p, err] of Object.entries(result.errors)) {
        errors[p] = err
        await options.onError?.(p, err)
      }

      const file = result.files[0]
      if (file) {
        const content = contentCache.get(file.path)
        if (content !== undefined) {
          await options.onFile({ file, content })
        }
        totalFiles++
        totalLines += file.metadata.lineCount
        symbolsIndexed += file.symbols?.length ?? 0
      }
      contentCache.clear()
    }

    return {
      projectRoot: root,
      scannedAt: new Date().toISOString(),
      totalFiles,
      totalLines,
      symbolsIndexed,
      errors,
      languages,
      elapsedMs: Date.now() - t0,
    }
  }

  /**
   * Same as `scan()`, but also returns a `contentCache` — every file's raw
   * source, keyed by absolute path, captured the one time each pipeline
   * reads it off disk. This lets later indexing stages (chunking,
   * embedding, etc.) reuse that content instead of calling
   * `fs.readFileSync()` again for files already read during this scan.
   *
   * The cache holds an entry only for files that were successfully read;
   * files that failed to read are reflected in `result.errors` instead.
   * Callers are responsible for releasing it (e.g. `contentCache.clear()`)
   * once they're done reusing it, so the in-memory copies of every file's
   * source don't outlive the indexing run that needed them.
   *
   * The scan is performed in phases:
   *   1. **Discovery**       — fast recursive walk to collect file paths (sync)
   *   2. **Partition**       — bucket files by which pipeline handles them
   *   3. **Language detect** — summarize language composition of this batch
   *   4. **Pipeline build**  — build each pipeline's task list (ts-morph is
   *                            only initialized here, and only if needed)
   *   5. **Parse**           — run all pipelines' tasks with bounded concurrency,
   *                            each caching its file's content as it's read
   */
  async scanWithContent(options: ScanOptions): Promise<ScanWithContentResult> {
    const {
      projectRoot,
      extraIgnoreDirs = [],
      extraExtensions = [],
      concurrency     = 20,
      onlyFiles,
    } = options

    // Resolve root to an absolute path
    const root = path.resolve(projectRoot)

    // ── Merge ignore sets ─────────────────────────────────────────────────
    const ignoreDirs = new Set([
      ...DEFAULT_IGNORE_DIRS,
      ...extraIgnoreDirs,
    ])

    // ── Parse .gitignore ──────────────────────────────────────────────────
    const gitignoreRules = parseGitignore(path.join(root, '.gitignore'))
    // Merge .gitignore dir names into ignoreDirs for the walk
    for (const dir of gitignoreRules.ignoreDirNames) {
      ignoreDirs.add(dir)
    }

    // ── Merge extension sets ──────────────────────────────────────────────
    const extensions = new Set([
      ...ALL_KNOWN_EXTS,
      ...extraExtensions,
    ])

    // ── Phase 1: Discover source files ───────────────────────────────────
    // When onlyFiles is provided (incremental / file-watcher mode), skip the
    // full directory walk and use only the explicitly listed paths that
    // exist on disk and match a known extension.
    const filePaths = onlyFiles && onlyFiles.length > 0
      ? onlyFiles.filter(p => {
          const ext = extOf(p)
          return extensions.has(ext) && fs.existsSync(p)
        })
      : this.discoverFiles(root, ignoreDirs, extensions, gitignoreRules)

    // ── Phase 2: Partition discovered files by pipeline ────────────────────
    const tsJsFiles:    string[] = []
    const htmlFiles:    string[] = []
    const cssFiles:     string[] = []
    const adapterFiles: string[] = []

    for (const fp of filePaths) {
      const ext = extOf(fp)
      if (TS_JS_EXTS.has(ext))       tsJsFiles.push(fp)
      else if (HTML_EXTS.has(ext))   htmlFiles.push(fp)
      else if (CSS_EXTS.has(ext))    cssFiles.push(fp)
      else                           adapterFiles.push(fp)   // adapter or NullAdapter
    }

    // ── Phase 3: Detect language composition ───────────────────────────────
    // Computed from the same partition above, before any parser is touched.
    // This is what lets us decide — up front — whether ts-morph is even
    // relevant to this scan.
    const languageProfile = detectRepositoryLanguages(filePaths)

    const errors: Record<string, string> = {}

    // Shared across every pipeline below: each one reads its files from
    // disk exactly once and stashes the content here as it does, so no
    // pipeline (and no later indexing stage that reuses this cache) ever
    // issues a second fs.readFileSync() for the same path.
    const contentCache = new Map<string, string>()

    // ── Phase 4: Build each language's pipeline (independently) ───────────
    // Only the ts-js pipeline has a conditional, expensive setup step
    // (constructing a ts-morph Project). It is skipped entirely — including
    // the dynamic import of 'ts-morph' and './fileParser' — when this scan's
    // file set contains no TS/JS source.
    const tsJsTasks = tsJsFiles.length > 0
      ? await this.createTsJsPipeline(tsJsFiles, extensions, root, errors, contentCache)
      : []

    const htmlTasks    = this.createHtmlPipeline(htmlFiles, root, extensions, errors, contentCache)
    const cssTasks      = this.createCssPipeline(cssFiles, root, extensions, errors, contentCache)
    const adapterTasks = this.createAdapterPipeline(adapterFiles, root, errors, contentCache)

    console.log(
      'FILES FOUND:', filePaths.length,
      `(ts/js: ${tsJsFiles.length}, html: ${htmlFiles.length}, css: ${cssFiles.length}, adapter: ${adapterFiles.length})`,
      tsJsFiles.length > 0
        ? `— primary language: ${languageProfile.primaryLanguage}`
        : `— ts-morph skipped (no TS/JS files in this scan; primary language: ${languageProfile.primaryLanguage ?? 'none detected'})`,
    )

    // ── Phase 5: Parse everything with bounded concurrency ─────────────────
    const results = await pLimit([...tsJsTasks, ...htmlTasks, ...cssTasks, ...adapterTasks], concurrency)
    const files   = results.filter((n): n is FileNode => n !== null)

    // ── Summary ──────────────────────────────────────────────────────────
    const totalLines = files.reduce((sum, f) => sum + f.metadata.lineCount, 0)

    return {
      result: {
        projectRoot: root,
        scannedAt:   new Date().toISOString(),
        totalFiles:  files.length,
        totalLines,
        files,
        errors,
        languages:   languageProfile,
      },
      contentCache,
    }
  }

  // ── Pipeline builders ───────────────────────────────────────────────────
  // Each pipeline is independent: it owns its own file-reading, parsing, and
  // FileNode assembly, and none of them share parser state. This keeps
  // adding/removing a language's pipeline a localized change.

  /**
   * TS/JS pipeline. The only pipeline with real setup cost: it lazily
   * imports 'ts-morph' and './fileParser' (which itself depends on
   * ts-morph) and constructs a Project. Callers must only invoke this when
   * `tsJsFiles.length > 0` — that check is what keeps ts-morph out of
   * memory entirely for non-TS/JS repositories.
   */
  private async createTsJsPipeline(
    tsJsFiles: string[],
    extensions: Set<string>,
    root: string,
    errors: Record<string, string>,
    contentCache: Map<string, string>,
  ): Promise<ParseTask[]> {
    // Dynamic imports: ts-morph (and its embedded TypeScript compiler) and
    // the fileParser module that wraps it are only loaded into memory right
    // here, right before they're needed — never at module load time.
    const [{ Project, ScriptTarget, ModuleKind }, { parseFile }] = await Promise.all([
      import('ts-morph'),
      import('./fileParser'),
    ])

    const project = new Project({
      compilerOptions: {
        target:              ScriptTarget.ESNext,
        module:              ModuleKind.ESNext,
        allowJs:             true,
        jsx:                 2,          // react
        allowSyntheticDefaultImports: true,
        esModuleInterop:     true,
      },
      skipAddingFilesFromTsConfig:  true,
      skipFileDependencyResolution: true,
    })

    project.addSourceFilesAtPaths(tsJsFiles)
    const sourceFiles = project.getSourceFiles()

    return sourceFiles.map(sourceFile => async (): Promise<FileNode | null> => {
      const absPath = sourceFile.getFilePath()
      try {
        // ts-morph already read this file's content off disk to build
        // `sourceFile` (via project.addSourceFilesAtPaths above) — reuse
        // that in-memory text instead of a second fs.readFileSync().
        const rawContent = sourceFile.getFullText()
        contentCache.set(absPath, rawContent)
        const parsed     = parseFile(sourceFile, extensions, root)
        const metadata   = readMetadata(absPath, rawContent)
        return {
          path:         absPath,
          relativePath: toRelative(root, absPath),
          extension:    extOf(absPath),
          imports:      parsed.imports,
          exports:      parsed.exports,
          symbols:      parsed.symbols,
          metadata,
        }
      } catch (err) {
        errors[absPath] = err instanceof Error ? err.message : String(err)
        return null
      }
    })
  }

  /** HTML pipeline — no parser initialization cost, always available. */
  private createHtmlPipeline(
    htmlFiles: string[],
    root: string,
    extensions: Set<string>,
    errors: Record<string, string>,
    contentCache: Map<string, string>,
  ): ParseTask[] {
    return htmlFiles.map(absPath => async (): Promise<FileNode | null> => {
      try {
        const rawContent = fs.readFileSync(absPath, 'utf-8')
        contentCache.set(absPath, rawContent)
        const parsed     = parseHtmlFile(rawContent, absPath, extensions)
        const metadata   = readMetadata(absPath, rawContent)
        return {
          path:         absPath,
          relativePath: toRelative(root, absPath),
          extension:    extOf(absPath),
          imports:      parsed.imports,
          exports:      [],
          symbols:      [],
          metadata,
        }
      } catch (err) {
        errors[absPath] = err instanceof Error ? err.message : String(err)
        return null
      }
    })
  }

  /** CSS/SCSS/LESS pipeline — no parser initialization cost, always available. */
  private createCssPipeline(
    cssFiles: string[],
    root: string,
    extensions: Set<string>,
    errors: Record<string, string>,
    contentCache: Map<string, string>,
  ): ParseTask[] {
    return cssFiles.map(absPath => async (): Promise<FileNode | null> => {
      try {
        const rawContent = fs.readFileSync(absPath, 'utf-8')
        contentCache.set(absPath, rawContent)
        const parsed     = parseCssFile(rawContent, absPath, extensions)
        const metadata   = readMetadata(absPath, rawContent)
        return {
          path:         absPath,
          relativePath: toRelative(root, absPath),
          extension:    extOf(absPath),
          imports:      parsed.imports,
          exports:      [],
          symbols:      parsed.symbols,
          metadata,
        }
      } catch (err) {
        errors[absPath] = err instanceof Error ? err.message : String(err)
        return null
      }
    })
  }

  /**
   * Generic pipeline for every other language, via the pluggable
   * LanguageAdapter registry (Python, Go, Rust, Java, C#, etc.). The
   * NullAdapter returns empty arrays for unknown extensions so the file is
   * still indexed (content is chunked for FTS/semantic search) even
   * without symbol extraction. This is the "generic scanner" fallback for
   * any language without a dedicated pipeline above.
   */
  private createAdapterPipeline(
    adapterFiles: string[],
    root: string,
    errors: Record<string, string>,
    contentCache: Map<string, string>,
  ): ParseTask[] {
    const mapKind = this.mapAdapterKindToSymbolType.bind(this)

    return adapterFiles.map(absPath => async (): Promise<FileNode | null> => {
      try {
        const ext        = extOf(absPath)
        const adapter    = defaultRegistry.get(ext)
        const rawContent = fs.readFileSync(absPath, 'utf-8')
        contentCache.set(absPath, rawContent)
        const metadata   = readMetadata(absPath, rawContent)

        const adapterImports = adapter.extractImports(rawContent, absPath)
        const adapterExports = adapter.extractExports(rawContent, absPath)
        const adapterSymbols = adapter.extractSymbols(rawContent, absPath)

        const imports: ImportRecord[] = adapterImports.map(i => ({
          specifier:       i.specifier,
          resolvedPath:    null,
          namedImports:    i.namedImports,
          defaultImport:   i.defaultImport,
          namespaceImport: i.namespaceImport,
        }))

        const exports: ExportRecord[] = adapterExports.map(e => ({
          name: e.name,
          kind: e.kind,
        }))

        const symbols: SymbolRecord[] = adapterSymbols.map(s => ({
          name:      s.name,
          type:      mapKind(s.kind),
          startLine: s.startLine,
          endLine:   s.endLine,
        }))

        return {
          path:         absPath,
          relativePath: toRelative(root, absPath),
          extension:    ext,
          imports,
          exports,
          symbols,
          metadata,
        }
      } catch (err) {
        errors[absPath] = err instanceof Error ? err.message : String(err)
        return null
      }
    })
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Maps a LanguageAdapter SymbolKind to the legacy SymbolRecord['type']
   * used by the scanner's FileNode so the retrieval ranker's
   * SYMBOL_KIND_WEIGHT table always finds a match.
   */
  private mapAdapterKindToSymbolType(kind: string): SymbolRecord['type'] {
    switch (kind) {
      case 'component':  return 'component'
      case 'class':      return 'class'
      case 'interface':  return 'interface'
      case 'function':   return 'function'
      case 'type':       return 'type'
      case 'enum':       return 'enum'
      case 'variable':   return 'variable'
      case 'default':    return 'default'
      case 'style-rule': return 'style-rule'
      case 'method':     return 'function'
      case 'field':      return 'variable'
      case 'decorator':  return 'function'
      case 'namespace':  return 'variable'
      default:           return 'variable'
    }
  }

  /**
   * Recursively walks `dir` and collects absolute paths of files whose
   * extension is in `extensions`.  Directories in `ignoreDirs` are skipped.
   * Files matching gitignore patterns are also skipped.
   */
  private discoverFiles(
    dir: string,
    ignoreDirs: Set<string>,
    extensions: Set<string>,
    gitignoreRules: GitignoreRules,
    collected: string[] = [],
  ): string[] {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return collected
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name) && !matchesGitignore(absPath, gitignoreRules)) {
          this.discoverFiles(absPath, ignoreDirs, extensions, gitignoreRules, collected)
        }
      } else if (entry.isFile()) {
        const ext = extOf(entry.name)
        if (extensions.has(ext) && !matchesGitignore(absPath, gitignoreRules)) {
          collected.push(absPath)
        }
      }
    }

    return collected
  }
}

// ── Singleton helper ──────────────────────────────────────────────────────

/** Pre-constructed singleton for use in the Tauri renderer process */
export const repoScanner = new RepoScanner()

export type { RepoLanguageProfile }
