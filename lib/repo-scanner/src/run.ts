// src/run.ts
//
// CLI entry point.
//
// Usage:
//   ts-node src/run.ts /absolute/path/to/your/project
//   ts-node src/run.ts /absolute/path/to/your/project --json
//   ts-node src/run.ts /absolute/path/to/your/project --graph
//   ts-node src/run.ts /absolute/path/to/your/project --cycles
//   ts-node src/run.ts /absolute/path/to/your/project --file src/App.tsx
//
// Flags:
//   --json         dump the full ScanResult as pretty-printed JSON
//   --graph        dump the dependency graph (nodes + edges + cycles) as JSON
//   --cycles       print only detected circular dependencies
//   --file         print deps/dependents for a specific relative path
//   --embed        generate embeddings for each chunk via a local Ollama
//                  server (nomic-embed-text). Default: off.
//   --ollama-url   base URL of the Ollama server (default: http://localhost:11434)

import * as path from 'path'
import * as os   from 'os'
import * as fs   from 'fs'
import { repoScanner }           from './repoScanner'
import { dependencyGraphEngine } from './dependencyGraph'
import {
  buildRepoIndex,
  saveRepoIndex,
  loadRepoIndex,
  repoIndexExists,
  upsertRepoIndex,
  buildOrUpdateVectorIndex,
} from './repoScanner/repoIndex'
import { getEmbedding, DEFAULT_OLLAMA_URL } from './repoScanner/embedder'
import type { EmbeddedChunk } from './repoScanner/types'
import { ChunkSqliteWriter } from './repoScanner/chunkSqlite'

// ── Chunking (mirrors src-tauri/src/db.rs make_chunks: 100-line windows, ──
// ── 20-line overlap — kept in sync so chunk ids match between scanner and ──
// ── the Rust-side `chunks` table when both index the same file). ─────────
const CHUNK_SIZE    = 100
const CHUNK_OVERLAP = 20

function chunkFileContent(relativePath: string, content: string): EmbeddedChunk[] {
  const lines = content.split('\n')
  const total = lines.length
  if (total === 0) return []

  const step = Math.max(CHUNK_SIZE - CHUNK_OVERLAP, 1)
  const chunks: EmbeddedChunk[] = []

  let start = 0 // 0-based
  while (start < total) {
    const end = Math.min(start + CHUNK_SIZE, total) // exclusive

    const startLine = start + 1
    const endLine   = end

    chunks.push({
      id: `${relativePath}:${startLine}:${endLine}`,
      relativePath,
      startLine,
      endLine,
      content: lines.slice(start, end).join('\n'),
    })

    if (end === total) break
    start += step
  }

  return chunks
}

/**
 * Simple counting semaphore so we never have more than `limit` in-flight
 * embedding requests against Ollama at once.
 */
class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    return new Promise(resolve => {
      this.queue.push(() => {
        this.active++
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

const EMBED_CONCURRENCY = 4

/**
 * Chunks every file in `scan.files` and, when `embed` is true, fills in
 * `chunk.embedding` via Ollama with up to `EMBED_CONCURRENCY` requests
 * in flight at once. Mutates each FileNode in place (`file.chunks = ...`).
 *
 * Reuses `contentCache` (from `repoScanner.scanWithContent()`) instead of
 * re-reading each file from disk — the scanner already read every file
 * once while parsing it. This isn't the last consumer of the cache (the
 * vector-index build below still needs it), so entries are left in place
 * rather than deleted here.
 */
async function chunkAndEmbedFiles(
  scan: Awaited<ReturnType<typeof repoScanner.scan>>,
  contentCache: Map<string, string>,
  embed: boolean,
  ollamaUrl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const semaphore = new Semaphore(EMBED_CONCURRENCY)
  const allEmbedTasks: Promise<void>[] = []
  let done = 0
  const total = scan.files.length

  for (const file of scan.files) {
    let content = contentCache.get(file.path)
    if (content === undefined) {
      try {
        content = fs.readFileSync(file.path, 'utf-8')
      } catch {
        // Unreadable (binary, deleted between scan and now, etc.) — skip.
        done++
        onProgress?.(done, total)
        continue
      }
    }

    const chunks = chunkFileContent(file.relativePath, content)
    file.chunks = chunks

    if (!embed) {
      done++
      onProgress?.(done, total)
      continue
    }

    const fileTask = (async () => {
      await Promise.all(
        chunks.map(async chunk => {
          const release = await semaphore.acquire()
          try {
            chunk.embedding = await getEmbedding(chunk.content, ollamaUrl)
          } finally {
            release()
          }
        }),
      )
      done++
      onProgress?.(done, total)
    })()

    allEmbedTasks.push(fileTask)
  }

  await Promise.all(allEmbedTasks)
}

// FNV-1a 64-bit — deliberately NOT crypto.createHash. This has to produce
// byte-for-byte the same slug as `fnv1a64()` in src-tauri/src/commands.rs
// (get_vector_index_path), which is the READ side for this same cache dir.
// If the two ever disagree, semantic search silently finds nothing because
// it's looking in a different folder than the scanner wrote to.
function fnv1a64(input: string): bigint {
  const OFFSET_BASIS = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK64 = 0xffffffffffffffffn
  let hash = OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff)
    hash = (hash * PRIME) & MASK64
  }
  return hash
}

// Directory where the vector index is cached (alongside the scan artifacts).
//
// IMPORTANT: this must be unique per project. Every repo opened in the IDE
// gets its own subfolder, keyed by a hash of its normalized absolute path —
// the same normalization + hash the Rust side uses in
// src-tauri/src/commands.rs::get_vector_index_path, since that's what the
// renderer calls to find this same file for reading. Without this, every
// project would read/write the same repo-index.db and vector-index.json,
// silently overwriting each other's index the moment you switch between two
// open repos.
function vectorCacheDir(projectRoot: string): string {
  let normalized = path.resolve(projectRoot).replace(/\\/g, '/')
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  const slug = fnv1a64(normalized).toString(16).padStart(16, '0')
  return path.join(os.homedir(), '.rachna-ide', 'vector-cache', slug)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    console.error('Usage: ts-node src/run.ts <project-root> [--json] [--graph] [--cycles] [--file <relative-path>]')
    process.exit(1)
  }

  const projectRoot = path.resolve(args[0])
  const flags       = new Set(args.slice(1))
  const fileFlag    = args.indexOf('--file') !== -1
    ? args[args.indexOf('--file') + 1]
    : null
  const ollamaUrlFlagIdx = args.indexOf('--ollama-url')
  const ollamaUrl    = ollamaUrlFlagIdx !== -1
    ? args[ollamaUrlFlagIdx + 1]
    : DEFAULT_OLLAMA_URL
  const embedEnabled = flags.has('--embed')
  const sqliteDbFlagIdx = args.indexOf('--sqlite-db')
  const sqliteDbPath = sqliteDbFlagIdx !== -1 ? args[sqliteDbFlagIdx + 1] : null

  // ── Incremental mode: --files path1,path2,... ──────────────────────────
  // When the Tauri file-watcher calls scan_repo_files, it passes this flag
  // with a comma-separated list of absolute paths that changed on disk.
  // We scan ONLY those files and return a partial ScanResult so the frontend
  // can merge just the affected FileNodes without a full project re-scan.
  const filesFlag = args.indexOf('--files')
  if (filesFlag !== -1 && args[filesFlag + 1]) {
    const changedPaths = args[filesFlag + 1]
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)

    if (changedPaths.length > 0 && sqliteDbPath) {
      const t0inc = Date.now()
      const writer = new ChunkSqliteWriter(sqliteDbPath, 10)
      try {
        const stats = await repoScanner.scanStream({
          projectRoot,
          onlyFiles: changedPaths,
          onFile: ({ file, content }) => writer.addFile(file, content),
        })
        writer.close()
        const summary = {
          projectRoot: stats.projectRoot,
          scannedAt: stats.scannedAt,
          totalFiles: stats.totalFiles,
          totalLines: stats.totalLines,
          files: [],
          errors: stats.errors,
          languages: stats.languages,
          indexingStats: {
            filesIndexed: writer.filesIndexed,
            chunksCreated: writer.chunksIndexed,
            symbolsFound: writer.symbolsIndexed,
            elapsedMs: Date.now() - t0inc,
            errors: Object.keys(stats.errors).length,
            streamed: true,
            incremental: true,
          },
        }
        console.log(`⚡  Incremental streaming index: ${summary.indexingStats.filesIndexed} file(s) · ${summary.indexingStats.chunksCreated} chunks · ${summary.indexingStats.elapsedMs}ms`)
        if (flags.has('--json')) console.log(JSON.stringify(summary, null, 2))
        return
      } catch (err) {
        try { writer.close() } catch {}
        throw err
      }
    }

    if (changedPaths.length > 0) {
      const t0inc   = Date.now()
      const { result: scanInc, contentCache } = await repoScanner.scanWithContent({ projectRoot, onlyFiles: changedPaths })
      const t1inc   = Date.now()
      console.log(`⚡  Incremental scan: ${scanInc.totalFiles} file(s) · ${t1inc - t0inc}ms`)

      if (sqliteDbPath) {
        const writer = new ChunkSqliteWriter(sqliteDbPath)
        try {
          for (const file of scanInc.files) {
            const content = contentCache.get(file.path)
            if (content === undefined) continue
            writer.addFile(file, content)
            contentCache.delete(file.path)
          }
        } finally {
          writer.close()
        }
        console.log(`💾  Incremental SQLite chunks indexed: ${writer.chunksIndexed} chunks, ${writer.symbolsIndexed} symbols`)
      }

      // Persist only changed rows into the scanner's repo-index cache
      const cacheDir = vectorCacheDir(projectRoot)
      await upsertRepoIndex(scanInc, cacheDir)
      contentCache.clear()
      console.log(`💾  Incremental index updated`)

      if (flags.has('--json')) {
        console.log(JSON.stringify(scanInc, null, 2))
      }
      return
    }
  }

  if (sqliteDbPath && flags.has('--json') && !flags.has('--graph') && !flags.has('--cycles') && fileFlag === null) {
    console.log(`\n🔍  Streaming index: ${projectRoot}\n`)
    const writer = new ChunkSqliteWriter(sqliteDbPath, 25)
    const t0stream = Date.now()
    let seen = 0
    try {
      const stats = await repoScanner.scanStream({
        projectRoot,
        onlyFiles: filesFlag !== -1 && args[filesFlag + 1]
          ? args[filesFlag + 1].split(',').map(p => p.trim()).filter(Boolean)
          : undefined,
        onFile: ({ file, content }) => {
          writer.addFile(file, content)
          seen++
          if (seen % 5 === 0) {
            console.log(JSON.stringify({ type: 'progress', scanned: seen, total: 0, file: file.relativePath }))
          }
        },
      })
      writer.close()
      const summary = {
        projectRoot: stats.projectRoot,
        scannedAt: stats.scannedAt,
        totalFiles: stats.totalFiles,
        totalLines: stats.totalLines,
        files: [],
        errors: stats.errors,
        languages: stats.languages,
        indexingStats: {
          filesIndexed: writer.filesIndexed,
          chunksCreated: writer.chunksIndexed,
          symbolsFound: writer.symbolsIndexed,
          elapsedMs: Date.now() - t0stream,
          errors: Object.keys(stats.errors).length,
          streamed: true,
        },
      }
      console.log(`✅  Stream-indexed ${summary.totalFiles} files · ${summary.totalLines.toLocaleString()} lines · ${summary.indexingStats.chunksCreated} chunks · ${summary.indexingStats.elapsedMs}ms`)
      console.log(JSON.stringify(summary, null, 2))
      return
    } catch (err) {
      try { writer.close() } catch {}
      throw err
    }
  }

  console.log(`\n🔍  Scanning: ${projectRoot}\n`)
  const t0   = Date.now()
  const { result: scan, contentCache } = await repoScanner.scanWithContent({ projectRoot })
  const t1   = Date.now()

  console.log(`✅  Scanned ${scan.totalFiles} files · ${scan.totalLines.toLocaleString()} lines · ${t1 - t0}ms`)

  // ── Persist chunks directly to SQLite when requested by Tauri ───────────
  // This avoids attaching chunk content to the ScanResult JSON and avoids a
  // Rust-side re-read/re-chunk pass. Content is released per file after it is
  // written so large repositories do not retain source text longer than needed.
  if (sqliteDbPath) {
    const tChunk0 = Date.now()
    const writer = new ChunkSqliteWriter(sqliteDbPath)
    try {
      for (const file of scan.files) {
        const content = contentCache.get(file.path)
        if (content === undefined) continue
        writer.addFile(file, content)
        contentCache.delete(file.path)
      }
    } finally {
      writer.close()
    }
    console.log(`💾  SQLite chunks indexed: ${writer.chunksIndexed} chunks, ${writer.symbolsIndexed} symbols, ${writer.filesIndexed} files · ${Date.now() - tChunk0}ms`)
  } else {
    const tChunk0 = Date.now()
    await chunkAndEmbedFiles(scan, contentCache, embedEnabled, ollamaUrl, (done, doneTotal) => {
      if (embedEnabled && (done % 25 === 0 || done === doneTotal)) {
        process.stdout.write(`\r🔗  Chunking/embedding: ${done}/${doneTotal} files`)
      }
    })
    if (embedEnabled) {
      console.log(`\n✅  Chunked + embedded ${scan.files.length} files: ${Date.now() - tChunk0}ms`)
    }
  }

  if (Object.keys(scan.errors).length > 0) {
    console.warn(`\n⚠️  ${Object.keys(scan.errors).length} parse errors:`)
    for (const [p, err] of Object.entries(scan.errors)) {
      console.warn(`   ${p}: ${err}`)
    }
  }

  // ── Build graph ────────────────────────────────────────────────────────
  dependencyGraphEngine.buildFromScan(scan)
  const stats  = dependencyGraphEngine.getStats()
  const cycles = dependencyGraphEngine.detectCycles()

  console.log(`\n📊  Graph: ${stats.nodeCount} nodes · ${stats.edgeCount} edges · ${cycles.length} cycle(s)`)
  if (stats.mostDepended) {
    const short = stats.mostDepended.file.replace(projectRoot, '').replace(/^\//, '')
    console.log(`   Most depended-on : ${short}  (${stats.mostDepended.count} dependents)`)
  }
  if (stats.mostImports) {
    const short = stats.mostImports.file.replace(projectRoot, '').replace(/^\//, '')
    console.log(`   Most imports     : ${short}  (${stats.mostImports.count} imports)`)
  }

  // ── Build / update vector index (unless --json or --graph mode) ────────
  // We skip in --json mode because the Tauri backend only cares about the
  // ScanResult JSON.  Vector indexing happens as a background task.
  const isJsonMode = flags.has('--json') || flags.has('--graph') || flags.has('--cycles') || fileFlag !== null

  if (!isJsonMode) {
    try {
      const repoIndex = await buildRepoIndex(scan)
      const cacheDir  = vectorCacheDir(projectRoot)

      // ── Persist the repo index to SQLite ────────────────────────────────
      const t2db = Date.now()
      saveRepoIndex(repoIndex, cacheDir)
      console.log(`💾  Repo index saved to SQLite: ${Date.now() - t2db}ms`)

      const t2 = Date.now()
      await buildOrUpdateVectorIndex(repoIndex, cacheDir, {
        contentCache,
        onProgress: (done, total) => {
          if (done % 50 === 0 || done === total) {
            process.stdout.write(`\r🧠  Embedding: ${done}/${total} files`)
          }
        },
      })
      const t3 = Date.now()
      console.log(`\n✅  Vector index built: ${t3 - t2}ms`)
    } catch (err) {
      console.warn('⚠️  Vector index build failed (non-fatal):', err)
    }
  }

  // The embedding step above is the last stage that reuses cached file
  // content; it deletes each entry as it consumes it, but if that step
  // was skipped (isJsonMode) or failed partway through, this guarantees
  // nothing scanned in this run is held in memory beyond the run itself.
  contentCache.clear()

  // ── Mode: --cycles ─────────────────────────────────────────────────────
  if (flags.has('--cycles')) {
    if (cycles.length === 0) {
      console.log('\n✨  No circular dependencies detected.')
    } else {
      console.log(`\n🔄  Circular dependencies (${cycles.length}):`)
      for (const c of cycles) {
        console.log(`   ${c.display}`)
      }
    }
    return
  }

  // ── Mode: --file ───────────────────────────────────────────────────────
  if (fileFlag) {
    const absFile = path.resolve(projectRoot, fileFlag)
    console.log(`\n📄  File: ${fileFlag}`)

    const deps      = dependencyGraphEngine.getDependencies(absFile)
    const dependents = dependencyGraphEngine.getDependents(absFile)
    const related   = dependencyGraphEngine.getRelatedFiles(absFile, { depth: 2, direction: 'both' })
    const fileCycles = dependencyGraphEngine.getCyclesFor(absFile)

    console.log(`\n  Direct imports (${deps.length}):`)
    deps.forEach(d => console.log(`    → ${d.replace(projectRoot, '').replace(/^\//, '')}`))

    console.log(`\n  Direct dependents (${dependents.length}):`)
    dependents.forEach(d => console.log(`    ← ${d.replace(projectRoot, '').replace(/^\//, '')}`))

    console.log(`\n  Related files within 2 hops (${related.length}):`)
    related.forEach(d => console.log(`    ~ ${d.replace(projectRoot, '').replace(/^\//, '')}`))

    if (fileCycles.length > 0) {
      console.log(`\n  🔄 Cycles involving this file:`)
      fileCycles.forEach(c => console.log(`    ${c.display}`))
    }
    return
  }

  // ── Mode: --graph ──────────────────────────────────────────────────────
  if (flags.has('--graph')) {
    console.log('\n' + JSON.stringify(dependencyGraphEngine.toJSON(), null, 2))
    return
  }

  // ── Mode: --json ───────────────────────────────────────────────────────
  if (flags.has('--json')) {
    console.log('\n' + JSON.stringify(scan, null, 2))
    return
  }

  // ── Default: print summary table ───────────────────────────────────────
  console.log('\n── File Summary ──────────────────────────────────────────────────')
  for (const file of scan.files.slice(0, 30)) {
    const imports  = file.imports.length
    const exports  = file.exports.length
    const pad      = file.relativePath.padEnd(50)
    console.log(`  ${pad}  ${String(imports).padStart(2)} imports  ${String(exports).padStart(2)} exports  ${file.metadata.lineCount} lines`)
  }
  if (scan.files.length > 30) {
    console.log(`  … and ${scan.files.length - 30} more files`)
  }
  console.log()
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})