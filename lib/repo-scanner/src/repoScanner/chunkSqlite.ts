import Database, { type Database as DB } from 'better-sqlite3'
import type { FileNode, SymbolRecord } from './types'

const CHUNK_SIZE = 100
const CHUNK_OVERLAP = 20
const MAX_SYMBOL_CHUNK_LINES = CHUNK_SIZE * 3

interface ChunkRow { id: string; filePath: string; startLine: number; endLine: number; content: string; symbolName: string | null }

function lineCount(content: string): number { return content.length === 0 ? 0 : content.split('\n').length }
function sliceLines(lines: string[], startLine: number, endLine: number): string { return lines.slice(startLine - 1, endLine).join('\n') }
function makeWindowChunks(filePath: string, lines: string[], startLine: number, endLine: number, symbolName: string | null): ChunkRow[] {
  const out: ChunkRow[] = []
  const step = Math.max(CHUNK_SIZE - CHUNK_OVERLAP, 1)
  let start = startLine
  while (start <= endLine) {
    const end = Math.min(start + CHUNK_SIZE - 1, endLine)
    out.push({ id: `${filePath}:${start}:${end}`, filePath, startLine: start, endLine: end, content: sliceLines(lines, start, end), symbolName })
    if (end === endLine) break
    start += step
  }
  return out
}

export function makeChunksSymbolAware(filePath: string, content: string, symbols: SymbolRecord[]): ChunkRow[] {
  const lines = content.split('\n')
  const total = lineCount(content)
  if (total === 0) return []
  if (symbols.length === 0) return makeWindowChunks(filePath, lines, 1, total, null)

  const sorted = symbols
    .filter(s => s.startLine > 0 && s.endLine >= s.startLine)
    .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
  if (sorted.length === 0) return makeWindowChunks(filePath, lines, 1, total, null)

  const outer: SymbolRecord[] = []
  for (const sym of sorted) {
    if (!outer.some(o => sym.startLine >= o.startLine && sym.endLine <= o.endLine)) outer.push(sym)
  }

  const chunks: ChunkRow[] = []
  let cursor = 1
  for (const sym of outer) {
    if (sym.startLine > cursor) chunks.push(...makeWindowChunks(filePath, lines, cursor, sym.startLine - 1, null))
    const end = Math.min(sym.endLine, total)
    if (end - sym.startLine + 1 <= MAX_SYMBOL_CHUNK_LINES) {
      chunks.push({ id: `${filePath}:${sym.startLine}:${end}`, filePath, startLine: sym.startLine, endLine: end, content: sliceLines(lines, sym.startLine, end), symbolName: sym.name })
    } else {
      chunks.push(...makeWindowChunks(filePath, lines, sym.startLine, end, sym.name))
    }
    cursor = Math.max(cursor, end + 1)
  }
  if (cursor <= total) chunks.push(...makeWindowChunks(filePath, lines, cursor, total, null))
  return chunks
}

export class ChunkSqliteWriter {
  private db: DB
  private deleteFtsByFile: Database.Statement
  private deleteChunksByFile: Database.Statement
  private deleteSymbolsByFile: Database.Statement
  private insertChunk: Database.Statement
  private insertFts: Database.Statement
  private insertSymbol: Database.Statement
  private writeBatchTx: (rows: Array<{ file: FileNode; content: string }>) => void
  private pending: Array<{ file: FileNode; content: string }> = []
  chunksIndexed = 0
  symbolsIndexed = 0
  filesIndexed = 0

  constructor(dbPath: string, private readonly batchSize = 50) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        symbol_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, content);
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
    `)
    this.deleteFtsByFile = this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path = ?)')
    this.deleteChunksByFile = this.db.prepare('DELETE FROM chunks WHERE file_path = ?')
    this.deleteSymbolsByFile = this.db.prepare('DELETE FROM symbols WHERE file_path = ?')
    this.insertChunk = this.db.prepare('INSERT OR REPLACE INTO chunks (id, file_path, start_line, end_line, content, symbol_name) VALUES (?, ?, ?, ?, ?, ?)')
    this.insertFts = this.db.prepare('INSERT INTO chunks_fts (chunk_id, content) VALUES (?, ?)')
    this.insertSymbol = this.db.prepare('INSERT INTO symbols (name, type, file_path, start_line, end_line) VALUES (?, ?, ?, ?, ?)')
    this.writeBatchTx = this.db.transaction((rows) => {
      for (const { file, content } of rows) this.writeFileNow(file, content)
    })
  }

  addFile(file: FileNode, content: string): void {
    this.pending.push({ file, content })
    if (this.pending.length >= this.batchSize) this.flush()
  }

  flush(): void {
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    this.writeBatchTx(batch)
  }

  close(): void { this.flush(); this.db.close() }

  private writeFileNow(file: FileNode, content: string): void {
    this.deleteFtsByFile.run(file.path)
    this.deleteChunksByFile.run(file.path)
    this.deleteSymbolsByFile.run(file.path)
    const chunks = makeChunksSymbolAware(file.path, content, file.symbols ?? [])
    for (const c of chunks) { this.insertChunk.run(c.id, c.filePath, c.startLine, c.endLine, c.content, c.symbolName); this.insertFts.run(c.id, c.content) }
    for (const s of file.symbols ?? []) this.insertSymbol.run(s.name, s.type, file.path, s.startLine, s.endLine)
    this.filesIndexed++
    this.chunksIndexed += chunks.length
    this.symbolsIndexed += file.symbols?.length ?? 0
  }
}
