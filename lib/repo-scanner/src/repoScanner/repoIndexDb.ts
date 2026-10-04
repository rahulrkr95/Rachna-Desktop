// lib/repoScanner/repoIndexDb.ts
//
// SQLite-backed persistent store for the RepoIndex.
// Replaces the flat JSON repo-index.json with a normalized relational DB.
//
// ── Design goals ─────────────────────────────────────────────────────────
//   • relativePath is the primary lookup key across every table
//   • WAL mode + NORMAL synchronous for fast concurrent reads/writes
//   • Incremental upserts: only touch rows whose file mtime changed
//   • Lazy file loading: getFile() fetches one FileNode on demand
//   • Full backward-compat: toRepoIndex() reconstructs a complete RepoIndex
//   • Migration: importFromJson() imports an existing repo-index.json
//   • 100k+ file repos: minimal startup time, memory usage, and disk I/O
//
// ── Table layout ─────────────────────────────────────────────────────────
//   repo_meta   — top-level scalars (projectRoot, scannedAt, generatedAt, …)
//   files       — one row per FileNode (core metadata + mtime for change detection)
//   symbols     — N rows per file (SymbolRecord)
//   file_imports — N rows per file (ImportRecord)
//   file_exports — N rows per file (ExportRecord)
//   summaries   — one row per file (FileSummary)
//   dependencies — edges of the dependency graph
//   scan_errors — files that failed to parse
//
// ── Performance notes ────────────────────────────────────────────────────
//   • WAL checkpoint happens automatically; explicit checkpoint only needed
//     on graceful shutdown (db.pragma('wal_checkpoint(TRUNCATE)')).
//   • All multi-row writes are wrapped in a single BEGIN/COMMIT transaction
//     via better-sqlite3 transaction() helpers — critical for 100k-file repos.
//   • Prepared statements are cached as class properties to avoid
//     re-planning on every call inside tight loops.

import Database, { type Database as DB } from 'better-sqlite3'
import * as fs   from 'fs'
import * as path from 'path'

import type {
  RepoIndex,
  FileNode,
  FileSummary,
  DependencyGraph,
  DependencyGraphEntry,
  SymbolRecord,
  ImportRecord,
  ExportRecord,
  FileMetadata,
} from './types'

// ── Public filename constant ──────────────────────────────────────────────

export const DEFAULT_INDEX_DB_FILENAME = 'repo-index.db'

// ── DDL ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = /* sql */`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA cache_size=-32000;
PRAGMA temp_store=MEMORY;
PRAGMA mmap_size=268435456;

CREATE TABLE IF NOT EXISTS repo_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS files (
  relative_path TEXT PRIMARY KEY,
  absolute_path TEXT NOT NULL,
  extension     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  last_modified TEXT NOT NULL,
  line_count    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS symbols (
  id            INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL REFERENCES files(relative_path) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS file_imports (
  id               INTEGER PRIMARY KEY,
  relative_path    TEXT NOT NULL REFERENCES files(relative_path) ON DELETE CASCADE,
  specifier        TEXT NOT NULL,
  resolved_path    TEXT,
  named_imports    TEXT NOT NULL,
  default_import   TEXT,
  namespace_import TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS file_exports (
  id            INTEGER PRIMARY KEY,
  relative_path TEXT NOT NULL REFERENCES files(relative_path) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS summaries (
  relative_path TEXT PRIMARY KEY REFERENCES files(relative_path) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  exports_json  TEXT NOT NULL,
  imports_json  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS dependencies (
  from_path TEXT NOT NULL REFERENCES files(relative_path) ON DELETE CASCADE,
  to_path   TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path)
) STRICT;

CREATE TABLE IF NOT EXISTS scan_errors (
  absolute_path TEXT PRIMARY KEY,
  error_message TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_symbols_path        ON symbols(relative_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name        ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_imports_path        ON file_imports(relative_path);
CREATE INDEX IF NOT EXISTS idx_exports_path        ON file_exports(relative_path);
CREATE INDEX IF NOT EXISTS idx_deps_from           ON dependencies(from_path);
CREATE INDEX IF NOT EXISTS idx_deps_to             ON dependencies(to_path);
CREATE INDEX IF NOT EXISTS idx_files_ext           ON files(extension);
CREATE INDEX IF NOT EXISTS idx_files_last_modified ON files(last_modified);
`

// ── Row types (internal) ─────────────────────────────────────────────────

interface FileRow {
  relative_path: string
  absolute_path: string
  extension:     string
  size_bytes:    number
  last_modified: string
  line_count:    number
}

interface SymbolRow {
  id:            number
  relative_path: string
  name:          string
  type:          string
  start_line:    number
  end_line:      number
}

interface ImportRow {
  id:               number
  relative_path:    string
  specifier:        string
  resolved_path:    string | null
  named_imports:    string
  default_import:   string | null
  namespace_import: string | null
}

interface ExportRow {
  id:            number
  relative_path: string
  name:          string
  kind:          string
}

interface SummaryRow {
  relative_path: string
  summary:       string
  exports_json:  string
  imports_json:  string
}

interface DepsRow {
  from_path: string
  to_path:   string
}

// ── RepoIndexDb ───────────────────────────────────────────────────────────

/**
 * SQLite-backed repository index.
 *
 * Lifecycle:
 *   const db = RepoIndexDb.open(dbPath)   // creates schema if new
 *   db.saveAll(repoIndex)                 // full replace
 *   db.upsertFiles(files, summaries)      // incremental update
 *   const idx = db.toRepoIndex()          // reconstruct full object
 *   db.close()                            // flush WAL + close
 */
export class RepoIndexDb {
  private readonly db: DB

  // Prepared statement cache (populated lazily on first use)
  private stmts: Record<string, Database.Statement> = {}

  private constructor(db: DB) {
    this.db = db
  }

  // ── Factory ─────────────────────────────────────────────────────────────

  /**
   * Opens (or creates) the SQLite database at `dbPath`.
   * Runs the full DDL idempotently so new tables/indexes are added
   * automatically when the schema evolves.
   */
  static open(dbPath: string): RepoIndexDb {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)

    // Apply all PRAGMA + DDL in a single exec call.
    // Each statement is separated by a semicolon; better-sqlite3's exec()
    // runs them sequentially without requiring individual prepare() calls.
    db.exec(SCHEMA_SQL)

    return new RepoIndexDb(db)
  }

  // ── Existence helpers ────────────────────────────────────────────────────

  /** True when the DB has at least one file indexed */
  hasData(): boolean {
    const row = this.db.prepare('SELECT 1 FROM files LIMIT 1').get()
    return row != null
  }

  /** ISO-8601 timestamp of the last scan stored in this DB, or null */
  getScannedAt(): string | null {
    const row = this.db
      .prepare('SELECT value FROM repo_meta WHERE key = ?')
      .get('scannedAt') as { value: string } | undefined
    return row?.value ?? null
  }

  // ── Full save ────────────────────────────────────────────────────────────

  /**
   * Atomically replaces the entire database content with `index`.
   * Suitable for first-run or forced full re-scan.
   * For incremental updates, prefer upsertFiles().
   */
  saveAll(index: RepoIndex): void {
    const save = this.db.transaction(() => {
      // Wipe existing data
      this.db.exec(`
        DELETE FROM scan_errors;
        DELETE FROM dependencies;
        DELETE FROM summaries;
        DELETE FROM file_exports;
        DELETE FROM file_imports;
        DELETE FROM symbols;
        DELETE FROM files;
        DELETE FROM repo_meta;
      `)

      // repo_meta
      const metaStmt = this.db.prepare(
        'INSERT INTO repo_meta(key, value) VALUES (?, ?)',
      )
      const meta: Record<string, string | number> = {
        projectRoot:  index.projectRoot,
        scannedAt:    index.scannedAt,
        generatedAt:  index.generatedAt,
        totalFiles:   index.totalFiles,
        totalLines:   index.totalLines,
      }
      for (const [k, v] of Object.entries(meta)) {
        metaStmt.run(k, String(v))
      }

      this._insertFiles(index.files)
      this._insertSummaries(index.summaries)
      this._insertDependencyGraph(index.dependencyGraph)
      this._insertErrors(index.errors)
    })

    save()
  }

  // ── Incremental upsert ───────────────────────────────────────────────────

  /**
   * Incrementally updates the index for a new scan.
   *
   * Algorithm:
   *   1. Load existing (relativePath → lastModified) map from DB
   *   2. INSERT new files, UPDATE changed files, DELETE removed files
   *   3. Update top-level metadata scalars
   *
   * Files whose lastModified is unchanged are skipped entirely —
   * no DELETE + re-INSERT of their child rows.
   *
   * @param files      Full list of FileNodes from the latest scan
   * @param summaries  Corresponding FileSummaries (same order / length as files)
   * @param depGraph   Updated dependency graph (full; rebuilt per scan)
   * @param meta       Top-level scalars to update (projectRoot, scannedAt, …)
   */
  upsertFiles(
    files:      FileNode[],
    summaries:  FileSummary[],
    depGraph:   DependencyGraph,
    meta: {
      projectRoot: string
      scannedAt:   string
      generatedAt: string
      totalFiles:  number
      totalLines:  number
    },
    errors: Record<string, string> = {},
  ): void {
    const upsert = this.db.transaction(() => {
      // 1. Existing mtime map
      const existing = new Map<string, string>(
        (this.db.prepare('SELECT relative_path, last_modified FROM files').all() as FileRow[])
          .map(r => [r.relative_path, r.last_modified])
      )

      // 2. Classify incoming files
      const toInsert: FileNode[] = []
      const toUpdate: FileNode[] = []
      const incomingPaths = new Set<string>()

      for (const f of files) {
        incomingPaths.add(f.relativePath)
        if (!existing.has(f.relativePath)) {
          toInsert.push(f)
        } else if (existing.get(f.relativePath) !== f.metadata.lastModified) {
          toUpdate.push(f)
        }
        // else: unchanged — skip
      }

      // 3. Delete removed files (CASCADE handles child rows)
      const removed = [...existing.keys()].filter(p => !incomingPaths.has(p))
      if (removed.length > 0) {
        const delStmt = this.db.prepare('DELETE FROM files WHERE relative_path = ?')
        for (const p of removed) delStmt.run(p)
      }

      // 4. Delete stale child rows for updated files before re-inserting
      if (toUpdate.length > 0) {
        const delChildren = this.db.prepare(
          'DELETE FROM files WHERE relative_path = ?',
        )
        for (const f of toUpdate) delChildren.run(f.relativePath)
      }

      // 5. Insert new + updated files
      this._insertFiles([...toInsert, ...toUpdate])

      // 6. Upsert summaries
      const summaryMap = new Map(summaries.map(s => [s.path, s]))
      const affectedPaths = new Set([
        ...toInsert.map(f => f.relativePath),
        ...toUpdate.map(f => f.relativePath),
      ])
      const affectedSummaries = [...affectedPaths]
        .map(p => summaryMap.get(p))
        .filter((s): s is FileSummary => s != null)
      this._insertSummaries(affectedSummaries, /* replace */ true)

      // 7. Replace full dependency graph (cheap: O(edges), not O(files))
      this.db.exec('DELETE FROM dependencies')
      this._insertDependencyGraph(depGraph)

      // 8. Replace scan errors
      this.db.exec('DELETE FROM scan_errors')
      this._insertErrors(errors)

      // 9. Update top-level metadata
      const metaUpsert = this.db.prepare(
        'INSERT INTO repo_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      const metaValues: Record<string, string | number> = {
        projectRoot:  meta.projectRoot,
        scannedAt:    meta.scannedAt,
        generatedAt:  meta.generatedAt,
        totalFiles:   meta.totalFiles,
        totalLines:   meta.totalLines,
      }
      for (const [k, v] of Object.entries(metaValues)) {
        metaUpsert.run(k, String(v))
      }

      console.log(
        `[repo-index-db] upsert: +${toInsert.length} new, ~${toUpdate.length} updated, -${removed.length} removed`,
      )
    })

    upsert()
  }

  // ── Lazy per-file reads ──────────────────────────────────────────────────

  /**
   * Fetches a single FileNode by relativePath.
   * Returns null if the file is not indexed.
   * This is the preferred low-memory access path for large repos.
   */
  getFile(relativePath: string): FileNode | null {
    const row = this.db
      .prepare('SELECT * FROM files WHERE relative_path = ?')
      .get(relativePath) as FileRow | undefined
    if (!row) return null
    return this._hydrate(row)
  }

  /**
   * Returns all indexed FileNodes.
   * For repos with 100k+ files, prefer getFile() or streaming queries
   * to avoid loading the full dataset into RAM at once.
   */
  getAllFiles(): FileNode[] {
    const rows = this.db
      .prepare('SELECT * FROM files')
      .all() as FileRow[]
    return rows.map(r => this._hydrate(r))
  }

  /** Returns files whose extension matches (without the leading dot). */
  getFilesByExtension(ext: string): FileNode[] {
    const rows = this.db
      .prepare('SELECT * FROM files WHERE extension = ?')
      .all(ext) as FileRow[]
    return rows.map(r => this._hydrate(r))
  }

  /** Returns the relativePath → lastModified map (cheap change-detection). */
  getMtimeMap(): Map<string, string> {
    return new Map<string, string>(
      (this.db.prepare('SELECT relative_path, last_modified FROM files').all() as FileRow[])
        .map(r => [r.relative_path, r.last_modified])
    )
  }

  // ── Summary reads ────────────────────────────────────────────────────────

  getSummary(relativePath: string): FileSummary | null {
    const row = this.db
      .prepare('SELECT * FROM summaries WHERE relative_path = ?')
      .get(relativePath) as SummaryRow | undefined
    if (!row) return null
    return this._hydrateSummary(row)
  }

  getAllSummaries(): FileSummary[] {
    return (this.db.prepare('SELECT * FROM summaries').all() as SummaryRow[])
      .map(r => this._hydrateSummary(r))
  }

  // ── Dependency graph ─────────────────────────────────────────────────────

  getDependencyGraph(): DependencyGraph {
    const graph: DependencyGraph = {}

    // Pre-populate with all known file paths so every file has an entry
    const allPaths = (
      this.db.prepare('SELECT relative_path FROM files').all() as { relative_path: string }[]
    ).map(r => r.relative_path)

    for (const p of allPaths) {
      graph[p] = { dependsOn: [], dependedOnBy: [] }
    }

    // Fill edges
    const rows = this.db.prepare('SELECT from_path, to_path FROM dependencies').all() as DepsRow[]
    for (const { from_path, to_path } of rows) {
      if (!graph[from_path]) graph[from_path] = { dependsOn: [], dependedOnBy: [] }
      if (!graph[to_path])   graph[to_path]   = { dependsOn: [], dependedOnBy: [] }
      graph[from_path].dependsOn.push(to_path)
      graph[to_path].dependedOnBy.push(from_path)
    }

    return graph
  }

  getDependents(relativePath: string): string[] {
    return (
      this.db
        .prepare('SELECT from_path FROM dependencies WHERE to_path = ?')
        .all(relativePath) as { from_path: string }[]
    ).map(r => r.from_path)
  }

  getDependencies(relativePath: string): string[] {
    return (
      this.db
        .prepare('SELECT to_path FROM dependencies WHERE from_path = ?')
        .all(relativePath) as { to_path: string }[]
    ).map(r => r.to_path)
  }

  // ── Error reads ──────────────────────────────────────────────────────────

  getErrors(): Record<string, string> {
    const rows = this.db
      .prepare('SELECT absolute_path, error_message FROM scan_errors')
      .all() as { absolute_path: string; error_message: string }[]
    return Object.fromEntries(rows.map(r => [r.absolute_path, r.error_message]))
  }

  // ── Reconstruct full RepoIndex ────────────────────────────────────────────

  /**
   * Reconstructs a complete in-memory RepoIndex from the SQLite store.
   * Equivalent to JSON.parse(fs.readFileSync('repo-index.json')) but
   * typically faster due to binary storage and lazy row deserialization.
   *
   * For very large repos, consider the lazy per-file APIs instead.
   */
  toRepoIndex(): RepoIndex {
    const getMeta = this.db.prepare('SELECT value FROM repo_meta WHERE key = ?')
    const get = (key: string) => (getMeta.get(key) as { value: string } | undefined)?.value ?? ''

    return {
      projectRoot:     get('projectRoot'),
      scannedAt:       get('scannedAt'),
      generatedAt:     get('generatedAt'),
      totalFiles:      Number(get('totalFiles')) || 0,
      totalLines:      Number(get('totalLines')) || 0,
      files:           this.getAllFiles(),
      summaries:       this.getAllSummaries(),
      dependencyGraph: this.getDependencyGraph(),
      errors:          this.getErrors(),
    }
  }

  // ── Symbols (direct query — useful for symbol search) ────────────────────

  findSymbolsByName(name: string): Array<{ relativePath: string } & SymbolRecord> {
    return (
      this.db
        .prepare('SELECT * FROM symbols WHERE name = ?')
        .all(name) as SymbolRow[]
    ).map(r => ({
      relativePath: r.relative_path,
      name:         r.name,
      type:         r.type as SymbolRecord['type'],
      startLine:    r.start_line,
      endLine:      r.end_line,
    }))
  }

  findSymbolsByNamePrefix(prefix: string): Array<{ relativePath: string } & SymbolRecord> {
    return (
      this.db
        .prepare('SELECT * FROM symbols WHERE name LIKE ?')
        .all(`${prefix}%`) as SymbolRow[]
    ).map(r => ({
      relativePath: r.relative_path,
      name:         r.name,
      type:         r.type as SymbolRecord['type'],
      startLine:    r.start_line,
      endLine:      r.end_line,
    }))
  }

  // ── Migration ─────────────────────────────────────────────────────────────

  /**
   * Imports an existing `repo-index.json` into this SQLite database.
   * Safe to call on a populated database — existing data is replaced atomically.
   *
   * @param jsonPath  Absolute path to the legacy repo-index.json file
   * @returns         True if migration succeeded, false if the file was absent
   */
  importFromJson(jsonPath: string): boolean {
    if (!fs.existsSync(jsonPath)) return false
    try {
      const raw   = fs.readFileSync(jsonPath, 'utf-8')
      const index = JSON.parse(raw) as RepoIndex
      this.saveAll(index)
      console.log(`[repo-index-db] migrated ${index.totalFiles} files from ${jsonPath}`)
      return true
    } catch (err) {
      console.error(`[repo-index-db] migration failed for ${jsonPath}:`, err)
      return false
    }
  }

  // ── WAL checkpoint / close ───────────────────────────────────────────────

  /**
   * Flushes the WAL to the main database file and closes the connection.
   * Call this on graceful shutdown for the smallest possible WAL file.
   */
  close(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch { /* ignore if already closed */ }
    this.db.close()
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _insertFiles(files: FileNode[]): void {
    const insertFile = this.db.prepare(/* sql */`
      INSERT INTO files(relative_path, absolute_path, extension, size_bytes, last_modified, line_count)
      VALUES (@relative_path, @absolute_path, @extension, @size_bytes, @last_modified, @line_count)
    `)
    const insertSymbol = this.db.prepare(/* sql */`
      INSERT INTO symbols(relative_path, name, type, start_line, end_line)
      VALUES (@relative_path, @name, @type, @start_line, @end_line)
    `)
    const insertImport = this.db.prepare(/* sql */`
      INSERT INTO file_imports(relative_path, specifier, resolved_path, named_imports, default_import, namespace_import)
      VALUES (@relative_path, @specifier, @resolved_path, @named_imports, @default_import, @namespace_import)
    `)
    const insertExport = this.db.prepare(/* sql */`
      INSERT INTO file_exports(relative_path, name, kind)
      VALUES (@relative_path, @name, @kind)
    `)

    for (const f of files) {
      insertFile.run({
        relative_path: f.relativePath,
        absolute_path: f.path,
        extension:     f.extension,
        size_bytes:    f.metadata.sizeBytes,
        last_modified: f.metadata.lastModified,
        line_count:    f.metadata.lineCount,
      })

      for (const s of f.symbols) {
        insertSymbol.run({
          relative_path: f.relativePath,
          name:          s.name,
          type:          s.type,
          start_line:    s.startLine,
          end_line:      s.endLine,
        })
      }

      for (const imp of f.imports) {
        insertImport.run({
          relative_path:    f.relativePath,
          specifier:        imp.specifier,
          resolved_path:    imp.resolvedPath ?? null,
          named_imports:    JSON.stringify(imp.namedImports),
          default_import:   imp.defaultImport ?? null,
          namespace_import: imp.namespaceImport ?? null,
        })
      }

      for (const exp of f.exports) {
        insertExport.run({
          relative_path: f.relativePath,
          name:          exp.name,
          kind:          exp.kind,
        })
      }
    }
  }

  private _insertSummaries(summaries: FileSummary[], replace = false): void {
    const stmt = replace
      ? this.db.prepare(/* sql */`
          INSERT INTO summaries(relative_path, summary, exports_json, imports_json)
          VALUES (@relative_path, @summary, @exports_json, @imports_json)
          ON CONFLICT(relative_path) DO UPDATE SET
            summary      = excluded.summary,
            exports_json = excluded.exports_json,
            imports_json = excluded.imports_json
        `)
      : this.db.prepare(/* sql */`
          INSERT INTO summaries(relative_path, summary, exports_json, imports_json)
          VALUES (@relative_path, @summary, @exports_json, @imports_json)
        `)

    for (const s of summaries) {
      stmt.run({
        relative_path: s.path,
        summary:       s.summary,
        exports_json:  JSON.stringify(s.exports),
        imports_json:  JSON.stringify(s.imports),
      })
    }
  }

  private _insertDependencyGraph(graph: DependencyGraph): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO dependencies(from_path, to_path) VALUES (?, ?)',
    )
    for (const [from, entry] of Object.entries(graph)) {
      for (const to of entry.dependsOn) {
        stmt.run(from, to)
      }
    }
  }

  private _insertErrors(errors: Record<string, string>): void {
    const stmt = this.db.prepare(
      'INSERT INTO scan_errors(absolute_path, error_message) VALUES (?, ?)',
    )
    for (const [absPath, msg] of Object.entries(errors)) {
      stmt.run(absPath, msg)
    }
  }

  /** Reconstructs a FileNode from a FileRow + child rows */
  private _hydrate(row: FileRow): FileNode {
    const relativePath = row.relative_path

    const symbolRows = this.db
      .prepare('SELECT * FROM symbols WHERE relative_path = ?')
      .all(relativePath) as SymbolRow[]

    const importRows = this.db
      .prepare('SELECT * FROM file_imports WHERE relative_path = ?')
      .all(relativePath) as ImportRow[]

    const exportRows = this.db
      .prepare('SELECT * FROM file_exports WHERE relative_path = ?')
      .all(relativePath) as ExportRow[]

    const symbols: SymbolRecord[] = symbolRows.map(r => ({
      name:      r.name,
      type:      r.type as SymbolRecord['type'],
      startLine: r.start_line,
      endLine:   r.end_line,
    }))

    const imports: ImportRecord[] = importRows.map(r => ({
      specifier:       r.specifier,
      resolvedPath:    r.resolved_path ?? null,
      namedImports:    JSON.parse(r.named_imports) as string[],
      defaultImport:   r.default_import ?? null,
      namespaceImport: r.namespace_import ?? null,
    }))

    const exports: ExportRecord[] = exportRows.map(r => ({
      name: r.name,
      kind: r.kind as ExportRecord['kind'],
    }))

    const metadata: FileMetadata = {
      sizeBytes:    row.size_bytes,
      lastModified: row.last_modified,
      lineCount:    row.line_count,
    }

    return {
      path:         row.absolute_path,
      relativePath: row.relative_path,
      extension:    row.extension,
      imports,
      exports,
      symbols,
      metadata,
    }
  }

  /** Reconstructs a FileSummary from a SummaryRow */
  private _hydrateSummary(row: SummaryRow): FileSummary {
    return {
      path:    row.relative_path,
      summary: row.summary,
      exports: JSON.parse(row.exports_json) as string[],
      imports: JSON.parse(row.imports_json) as string[],
    }
  }
}
