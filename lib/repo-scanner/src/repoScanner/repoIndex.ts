// lib/repoScanner/repoIndex.ts
//
// Builds, persists, and loads the `RepoIndex` — the on-disk artefact that
// powers retrieval.
//
// ── Storage backend (v2) ──────────────────────────────────────────────────
// The legacy JSON flat-file (repo-index.json) has been replaced with a
// SQLite database (repo-index.db) backed by `better-sqlite3`.
//
// Key benefits:
//   • Incremental writes — only changed files are updated; no full rewrite
//   • WAL mode — concurrent reads from multiple renderer threads
//   • Normalized schema — per-column indexes allow fast symbol/path queries
//   • Lazy loading — single FileNode fetched by relativePath on demand
//   • Migration — existing repo-index.json imported automatically on first run
//
// ── Public API (unchanged from v1) ────────────────────────────────────────
//   buildRepoIndex(scanResult, options)  → Promise<RepoIndex>
//   saveRepoIndex(index, destination)    → string
//   loadRepoIndex(source)                → RepoIndex
//   repoIndexExists(source)              → boolean
//   DEFAULT_INDEX_FILENAME               (kept for backward compat; .db now)
//
// ── New APIs ──────────────────────────────────────────────────────────────
//   openRepoIndexDb(source)              → RepoIndexDb  (lazy accessor)
//   upsertRepoIndex(scanResult, …)       → Promise<void>  (incremental save)
//
// ── Vector index ──────────────────────────────────────────────────────────
// Unchanged from v1 — still stored as vector-index.json alongside the DB.

import * as fs   from 'fs'
import * as path from 'path'

import type { RepoIndex, ScanResult, SummarizeOptions } from './types'
import { generateFileSummaries }  from './summarizer'
import { buildDependencyGraph }   from './dependencyGraph'
import { VectorIndex, VECTOR_INDEX_FILENAME } from './vectorIndex'
import {
  buildVectorIndex,
  updateVectorIndex,
  type BuildVectorIndexOptions,
} from './semanticRetrieval'
import { RepoIndexDb, DEFAULT_INDEX_DB_FILENAME } from './repoIndexDb'

// ── Filename constants ─────────────────────────────────────────────────────

/** Primary database filename — used when destination is a directory */
export const DEFAULT_INDEX_FILENAME = DEFAULT_INDEX_DB_FILENAME  // 'repo-index.db'

/**
 * Legacy JSON filename — kept so callers that hard-code the name
 * can still trigger migration logic.
 */
export const LEGACY_INDEX_FILENAME  = 'repo-index.json'

// ── Build ─────────────────────────────────────────────────────────────────

export async function buildRepoIndex(
  scanResult: ScanResult,
  options: SummarizeOptions = {},
): Promise<RepoIndex> {
  const [summaries, dependencyGraph] = await Promise.all([
    generateFileSummaries(scanResult.files, options),
    Promise.resolve(buildDependencyGraph(scanResult.files)),
  ])

  return {
    projectRoot:     scanResult.projectRoot,
    scannedAt:       scanResult.scannedAt,
    generatedAt:     new Date().toISOString(),
    totalFiles:      scanResult.totalFiles,
    totalLines:      scanResult.totalLines,
    files:           scanResult.files,
    summaries,
    dependencyGraph,
    errors:          scanResult.errors,
  }
}

// ── Vector index build / update ───────────────────────────────────────────

/**
 * Builds or incrementally updates the vector index for `repoIndex`.
 * Unchanged from v1 — still saves to vector-index.json.
 */
export async function buildOrUpdateVectorIndex(
  repoIndex:   RepoIndex,
  destination: string,
  options:     BuildVectorIndexOptions = {},
): Promise<VectorIndex> {
  const dir       = resolveDirectory(destination)
  const indexPath = path.join(dir, VECTOR_INDEX_FILENAME)

  let idx: VectorIndex

  try {
    const existing = VectorIndex.load(indexPath)
    const changed = repoIndex.files.filter(f =>
      existing.getFileLastModified(f.relativePath) !== f.metadata.lastModified
    ).length
    console.log(`[vector-index] incremental: ${changed}/${repoIndex.files.length} files changed`)
    idx = await updateVectorIndex(repoIndex, existing, options)
  } catch {
    console.log(`[vector-index] full build: ${repoIndex.files.length} files`)
    idx = await buildVectorIndex(repoIndex, options)
  }

  fs.mkdirSync(dir, { recursive: true })
  idx.save(indexPath)
  console.log(`[vector-index] saved ${idx.size} entries to ${indexPath}`)

  return idx
}

/**
 * Loads a previously saved vector index from `source` directory.
 * Returns null on any error (missing file, parse failure, etc.).
 */
export function loadVectorIndex(source: string): VectorIndex | null {
  try {
    const dir  = resolveDirectory(source)
    return VectorIndex.load(path.join(dir, VECTOR_INDEX_FILENAME))
  } catch {
    return null
  }
}

// ── Persistence (public API — drop-in replacements) ───────────────────────

/**
 * Persists `index` to SQLite at `destination`.
 *
 * If a legacy `repo-index.json` exists in the same directory it is NOT
 * deleted, preserving the ability to roll back.  Callers that want to
 * clean it up can do so explicitly.
 *
 * @returns The resolved path of the SQLite database file written.
 */
export function saveRepoIndex(index: RepoIndex, destination: string): string {
  const dbPath = resolveDbPath(destination)
  const db = RepoIndexDb.open(dbPath)
  try {
    db.saveAll(index)
  } finally {
    db.close()
  }
  return dbPath
}

/**
 * Loads a RepoIndex from SQLite.
 *
 * Migration logic (first-run only):
 *   If the SQLite DB does not exist (or is empty) but a legacy
 *   `repo-index.json` is present in the same directory, the JSON is
 *   imported automatically into SQLite before returning.
 *
 * @param source  Path to the `.db` file, or a directory containing it.
 */
export function loadRepoIndex(source: string): RepoIndex {
  const dbPath = resolveDbPath(source)

  // Run migration if the DB is missing/empty but JSON exists
  _migrateIfNeeded(dbPath)

  const db = RepoIndexDb.open(dbPath)
  try {
    return db.toRepoIndex()
  } finally {
    db.close()
  }
}

/**
 * Returns true when a repo index (SQLite or legacy JSON) exists at `source`.
 */
export function repoIndexExists(source: string): boolean {
  const dbPath = resolveDbPath(source)
  if (existsAsFile(dbPath)) return true

  // Also accept the legacy JSON for backward compatibility
  const jsonPath = resolveLegacyJsonPath(source)
  return existsAsFile(jsonPath)
}

// ── Extended API — lazy / incremental access ──────────────────────────────

/**
 * Opens the RepoIndexDb at `source` without loading all data into memory.
 * The caller is responsible for calling `db.close()` when done.
 *
 * Migration from JSON is performed automatically on first open if needed.
 *
 * @example
 *   const db = openRepoIndexDb('/path/to/.rachna-ide')
 *   const file = db.getFile('src/App.tsx')   // single-row fetch
 *   db.close()
 */
export function openRepoIndexDb(source: string): RepoIndexDb {
  const dbPath = resolveDbPath(source)
  _migrateIfNeeded(dbPath)
  return RepoIndexDb.open(dbPath)
}

/**
 * Incrementally updates the SQLite index with a fresh ScanResult.
 *
 * Only rows for files whose `lastModified` timestamp has changed are
 * touched — the majority of unchanged files are skipped entirely.
 * This is the preferred path for file-watcher triggered re-indexes.
 *
 * @param scanResult  Latest scan output
 * @param destination Directory (or `.db` path) where the index lives
 * @param options     Summarization options
 */
export async function upsertRepoIndex(
  scanResult:  ScanResult,
  destination: string,
  options:     SummarizeOptions = {},
): Promise<void> {
  const dbPath = resolveDbPath(destination)
  _migrateIfNeeded(dbPath)

  const db = RepoIndexDb.open(dbPath)

  try {
    // Detect which files actually changed using the DB's mtime map
    const mtimes   = db.getMtimeMap()
    const changed  = scanResult.files.filter(
      f => mtimes.get(f.relativePath) !== f.metadata.lastModified,
    )
    const isNew    = changed.filter(f => !mtimes.has(f.relativePath))
    console.log(
      `[repo-index] incremental: ${isNew.length} new, ` +
      `${changed.length - isNew.length} modified, ` +
      `${scanResult.files.length - changed.length} unchanged`,
    )

    // Generate summaries only for changed files (expensive if using an LLM)
    const changedSummaries = await generateFileSummaries(changed, options)
    const depGraph = buildDependencyGraph(scanResult.files)
    const generatedAt = new Date().toISOString()

    db.upsertFiles(
      scanResult.files,
      // Merge existing summaries with newly generated ones
      mergeUpdatedSummaries(db.getAllSummaries(), changedSummaries),
      depGraph,
      {
        projectRoot:  scanResult.projectRoot,
        scannedAt:    scanResult.scannedAt,
        generatedAt,
        totalFiles:   scanResult.totalFiles,
        totalLines:   scanResult.totalLines,
      },
      scanResult.errors,
    )
  } finally {
    db.close()
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Returns the `.db` file path for a given directory-or-file argument */
function resolveDbPath(target: string): string {
  try {
    if (fs.statSync(target).isDirectory()) {
      return path.join(target, DEFAULT_INDEX_DB_FILENAME)
    }
  } catch { /* not yet created */ }
  const ext = path.extname(target)
  if (!ext) return path.join(target, DEFAULT_INDEX_DB_FILENAME)
  // Accept both `.db` and `.json` (the .json path redirects to sibling .db)
  if (ext === '.json') {
    return path.join(path.dirname(target), DEFAULT_INDEX_DB_FILENAME)
  }
  return target
}

/** Returns the legacy JSON path for a given directory-or-file argument */
function resolveLegacyJsonPath(target: string): string {
  try {
    if (fs.statSync(target).isDirectory()) {
      return path.join(target, LEGACY_INDEX_FILENAME)
    }
  } catch { /* ok */ }
  const ext = path.extname(target)
  if (!ext) return path.join(target, LEGACY_INDEX_FILENAME)
  if (ext === '.db') {
    return path.join(path.dirname(target), LEGACY_INDEX_FILENAME)
  }
  return target
}

function resolveDirectory(target: string): string {
  try {
    if (fs.statSync(target).isDirectory()) return target
  } catch { /* not yet */ }
  const ext = path.extname(target)
  return ext ? path.dirname(target) : target
}

function existsAsFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/**
 * Runs JSON→SQLite migration once if:
 *   • the `.db` file does not yet exist (or has no data), AND
 *   • a legacy `repo-index.json` exists in the same directory
 */
function _migrateIfNeeded(dbPath: string): void {
  const jsonPath = resolveLegacyJsonPath(dbPath)
  if (!existsAsFile(jsonPath)) return

  // If the DB already has data, migration already happened
  if (existsAsFile(dbPath)) {
    try {
      const db = RepoIndexDb.open(dbPath)
      const hasData = db.hasData()
      db.close()
      if (hasData) return
    } catch { /* fall through to migrate */ }
  }

  console.log(`[repo-index] migrating ${LEGACY_INDEX_FILENAME} → ${DEFAULT_INDEX_DB_FILENAME} …`)
  const db = RepoIndexDb.open(dbPath)
  try {
    db.importFromJson(jsonPath)
  } finally {
    db.close()
  }
}

/**
 * Merges a base set of summaries with a smaller set of updated summaries.
 * Updated summaries take precedence; entries absent from `updates` are
 * preserved from `existing`.
 */
function mergeUpdatedSummaries(
  existing: import('./types').FileSummary[],
  updates:  import('./types').FileSummary[],
): import('./types').FileSummary[] {
  const map = new Map(existing.map(s => [s.path, s]))
  for (const s of updates) map.set(s.path, s)
  return [...map.values()]
}
