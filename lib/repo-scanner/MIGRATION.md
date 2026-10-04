# SQLite Index Migration Guide

## What changed

The flat-file `repo-index.json` has been replaced with a normalized SQLite
database `repo-index.db` backed by [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

| | Before (v1) | After (v2) |
|---|---|---|
| Storage | `repo-index.json` (JSON) | `repo-index.db` (SQLite WAL) |
| Write strategy | Full rewrite on every scan | Incremental upsert (only changed rows) |
| Startup read | `JSON.parse` entire file | Lazy row-by-row fetch |
| Concurrent reads | None (file lock) | WAL allows multiple readers |
| Symbol queries | Full `RepoIndex` load then filter | Direct SQL index scan |
| 100k file repo JSON size | ~500 MB+ | ~80 MB (binary, indexed) |

## Public API — no breaking changes

All existing call sites continue to compile and work without modification:

```ts
import {
  buildRepoIndex,
  saveRepoIndex,    // now writes repo-index.db
  loadRepoIndex,    // now reads repo-index.db (migrates JSON on first run)
  repoIndexExists,  // checks .db first, falls back to .json
  DEFAULT_INDEX_FILENAME,  // = 'repo-index.db'
} from '@rachna-ai-studio/reposcanner'
```

## New APIs

### `upsertRepoIndex(scanResult, destination, options?)` — incremental save

Use instead of `saveRepoIndex` when only a subset of files changed (e.g. from
the file-watcher). Only rows for modified/new/deleted files are written:

```ts
import { upsertRepoIndex } from '@rachna-ai-studio/reposcanner'

// Inside your file-watcher handler:
await upsertRepoIndex(incrementalScanResult, cacheDir)
```

### `openRepoIndexDb(source)` — lazy accessor

Returns a `RepoIndexDb` instance for fine-grained, lazy queries without
loading the entire index into RAM:

```ts
import { openRepoIndexDb } from '@rachna-ai-studio/reposcanner'

const db = openRepoIndexDb(cacheDir)

// Single file — O(log N) index scan
const file = db.getFile('src/components/App.tsx')

// Summary only — never loads FileNode children
const summary = db.getSummary('src/components/App.tsx')

// Symbol search across whole repo — uses idx_symbols_name index
const hits = db.findSymbolsByName('useAuth')

// Efficient change-detection (used by incremental scan)
const mtimes = db.getMtimeMap()

db.close()  // flushes WAL on graceful shutdown
```

### `RepoIndexDb` class (direct import)

```ts
import { RepoIndexDb } from '@rachna-ai-studio/reposcanner'

const db = RepoIndexDb.open('/path/to/repo-index.db')
db.saveAll(repoIndex)         // full atomic replace
db.upsertFiles(...)           // incremental update
db.toRepoIndex()              // reconstruct full RepoIndex
db.close()
```

## Automatic migration

The first call to `loadRepoIndex()` or `openRepoIndexDb()` checks whether
a `repo-index.json` exists alongside the new `repo-index.db`. If the DB
is empty (or doesn't exist yet) and the JSON is present, the JSON is
imported atomically into SQLite before the call returns.

The JSON file is **not deleted** automatically — you can remove it once
you've verified the migration succeeded.

## Tauri / Rust integration

If your Rust backend opens the same index directory, point it at
`repo-index.db` instead of `repo-index.json`. The WAL journal mode allows
the Rust process and the Node scanner to read concurrently without locking.

```rust
// Before
let idx = serde_json::from_str(&fs::read_to_string("repo-index.json")?)?;

// After — use rusqlite
let conn = Connection::open("repo-index.db")?;
conn.pragma_update(None, "journal_mode", "WAL")?;
```

## Schema

```sql
repo_meta     — projectRoot, scannedAt, generatedAt, totalFiles, totalLines
files         — relativePath PK, absolutePath, extension, sizeBytes, lastModified, lineCount
symbols       — id, relativePath FK, name, type, startLine, endLine
file_imports  — id, relativePath FK, specifier, resolvedPath, namedImports (JSON), ...
file_exports  — id, relativePath FK, name, kind
summaries     — relativePath PK FK, summary, exportsJson, importsJson
dependencies  — (fromPath, toPath) PK, fromPath FK
scan_errors   — absolutePath PK, errorMessage
```

Indexes on: `symbols(relativePath)`, `symbols(name)`, `file_imports(relativePath)`,
`file_exports(relativePath)`, `dependencies(fromPath)`, `dependencies(toPath)`,
`files(extension)`, `files(lastModified)`.
