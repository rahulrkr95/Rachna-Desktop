// lib/repoScanner/languageDetection.ts
//
// Classifies discovered files by language/pipeline and produces a
// `RepoLanguageProfile` summarizing the repository's language composition.
//
// This is the single source of truth for "which parser pipeline handles
// this extension" — the scanner uses these same extension sets to both
// partition files for parsing AND decide whether a pipeline needs to be
// initialized at all (most importantly: ts-morph, which is only ever
// created when the scanned file set actually contains TS/JS extensions).
//
// No ts-morph dependency here — this module (like utils.ts) stays fast
// and side-effect free so language detection never pulls in a parser.

import { extOf } from './utils'
import { defaultRegistry } from './languageAdapters'

// ── Extension sets for each dedicated parser pipeline ────────────────────
// Everything not in one of these sets falls through to the pluggable
// LanguageAdapter registry (or the NullAdapter/generic path for unknowns).

export const TS_JS_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'])
export const HTML_EXTS  = new Set(['html', 'htm', 'xhtml', 'shtml'])
export const CSS_EXTS   = new Set(['css', 'scss', 'less', 'pcss', 'postcss'])

/** Which independent scanning pipeline handles a given file. */
export type ScannerPipeline = 'ts-js' | 'html' | 'css' | 'adapter'

/** Aggregate stats for one detected language within the scanned file set. */
export interface LanguageStat {
  /** Human-readable language/adapter name, e.g. "TypeScript/JavaScript", "Python", "Go" */
  language: string
  /** Which pipeline handles this language */
  pipeline: ScannerPipeline
  /** Extensions (without leading dot) observed for this language */
  extensions: string[]
  /** Number of files detected for this language */
  fileCount: number
}

/** Summary of a repository's (or scanned batch's) language composition. */
export interface RepoLanguageProfile {
  /** Total number of files the profile was computed over */
  totalFiles: number
  /** Per-language stats, sorted by fileCount descending */
  languages: LanguageStat[]
  /** The language with the most files, or null if no files were scanned */
  primaryLanguage: string | null
  /** True when at least one TypeScript/JavaScript source file was detected */
  hasTsJs: boolean
  /** True when at least one HTML file was detected */
  hasHtml: boolean
  /** True when at least one CSS/SCSS/LESS file was detected */
  hasCss: boolean
}

/**
 * Resolves the pipeline + display language name for a single extension.
 * Dedicated pipelines (ts-js/html/css) take precedence over the generic
 * adapter registry so classification always matches the scanner's routing.
 */
function classifyExtension(ext: string): { pipeline: ScannerPipeline; language: string } {
  if (TS_JS_EXTS.has(ext)) return { pipeline: 'ts-js', language: 'TypeScript/JavaScript' }
  if (HTML_EXTS.has(ext))  return { pipeline: 'html',  language: 'HTML' }
  if (CSS_EXTS.has(ext))   return { pipeline: 'css',   language: 'CSS/SCSS/LESS' }

  // Falls through to whichever LanguageAdapter (or NullAdapter) is
  // registered for this extension — the adapter's `name` becomes the
  // display language (e.g. "Python", "Go", "Rust", "Unknown").
  const adapter = defaultRegistry.get(ext)
  return { pipeline: 'adapter', language: adapter.name }
}

/**
 * Detects the language composition of a set of file paths, before any
 * parsing/analysis begins. Used by the scanner to decide which pipelines
 * (most notably ts-morph) actually need to be initialized for this scan.
 *
 * Safe to call on either a full repository walk or an incremental
 * (file-watcher) batch — in the incremental case the profile describes
 * just that batch, which is exactly what the scanner needs to decide
 * whether to spin up ts-morph for the current run.
 */
export function detectRepositoryLanguages(filePaths: string[]): RepoLanguageProfile {
  const byLanguage = new Map<string, LanguageStat>()

  for (const filePath of filePaths) {
    const ext = extOf(filePath)
    const { pipeline, language } = classifyExtension(ext)

    let stat = byLanguage.get(language)
    if (!stat) {
      stat = { language, pipeline, extensions: [], fileCount: 0 }
      byLanguage.set(language, stat)
    }
    if (!stat.extensions.includes(ext)) stat.extensions.push(ext)
    stat.fileCount++
  }

  const languages = [...byLanguage.values()].sort((a, b) => b.fileCount - a.fileCount)

  return {
    totalFiles:      filePaths.length,
    languages,
    primaryLanguage: languages[0]?.language ?? null,
    hasTsJs:         languages.some(l => l.pipeline === 'ts-js'),
    hasHtml:         languages.some(l => l.pipeline === 'html'),
    hasCss:          languages.some(l => l.pipeline === 'css'),
  }
}
