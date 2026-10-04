// lib/repoScanner/contextBuilder.ts
//
// Assembles an AI-ready context for a retrieval query against a RepoIndex:
//
//   1. File summaries are sent first (cheap repo-wide map).
//   2. Full file contents are sent only for the top-ranked files
//      (rankFiles(), default topK = 5).
//   3. Large top-ranked files are reduced to the chunks most relevant to the
//      query (around matching symbols, with surrounding context lines)
//      rather than sending the entire file.

import * as fs from 'fs'

import type {
  BuiltContext,
  ContextBuildOptions,
  ContextChunk,
  ContextFile,
  FileNode,
  FileSummary,
  RepoIndex,
} from './types'
import { DEFAULT_TOP_K } from './types'
import { rankFiles, tokenize } from './retrieval'

// ── Tuning defaults ─────────────────────────────────────────────────────────

const DEFAULT_MAX_FULL_FILE_LINES = 300
const DEFAULT_CHUNK_PADDING       = 8
/** When no symbol matches the query in an oversized file, fall back to its
 *  N largest top-level symbols rather than dumping the whole file. */
const FALLBACK_CHUNK_SYMBOL_COUNT = 3

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Builds an AI-ready context object for `query` against `index`.
 *
 * - `summaries` contains FileSummary entries for the whole repo (or just the
 *   ranked files, if `includeAllSummaries: false`) — send these first.
 * - `files` contains full content (or relevant chunks) for the top `topK`
 *   ranked files only.
 *
 * When `options.vectorIndex` is provided, hybrid keyword + semantic ranking
 * is used.  The caller is responsible for loading and passing the vector index.
 */
export async function buildContext(
  query: string,
  index: RepoIndex,
  options: ContextBuildOptions = {},
): Promise<BuiltContext> {
  const topK               = options.topK ?? DEFAULT_TOP_K
  const maxFullFileLines    = options.maxFullFileLines ?? DEFAULT_MAX_FULL_FILE_LINES
  const chunkPadding        = options.chunkPadding ?? DEFAULT_CHUNK_PADDING
  const includeAllSummaries = options.includeAllSummaries ?? true

  const ranked = await rankFiles(query, index, { topK, activeFilePaths: options.activeFilePaths, vectorIndex: options.vectorIndex, embeddingProvider: options.embeddingProvider, vectorWeight: options.vectorWeight })
  const queryTokens = tokenize(query)

  const fileByPath    = new Map<string, FileNode>(index.files.map(f => [f.relativePath, f]))
  const summaryByPath = new Map<string, FileSummary>(index.summaries.map(s => [s.path, s]))

  const summaries = includeAllSummaries
    ? index.summaries
    : ranked
        .map(r => summaryByPath.get(r.relativePath))
        .filter((s): s is FileSummary => s !== undefined)

  const files: ContextFile[] = []
  for (const score of ranked) {
    const file = fileByPath.get(score.relativePath)
    if (!file) continue

    const content = readFileSafe(file.path)
    if (content === null) continue // unreadable (deleted/moved since scan) — skip

    if (file.metadata.lineCount <= maxFullFileLines) {
      files.push({
        relativePath: file.relativePath,
        score,
        isFullFile: true,
        content,
      })
    } else {
      files.push({
        relativePath: file.relativePath,
        score,
        isFullFile: false,
        chunks: extractRelevantChunks(file, content, queryTokens, chunkPadding),
      })
    }
  }

  return { query, summaries, ranked, files }
}

// ── Chunk extraction ────────────────────────────────────────────────────────

/**
 * Extracts the source ranges most relevant to `queryTokens` from an
 * oversized file, padded by `padding` lines on each side and merged where
 * ranges overlap.
 *
 * Falls back to the file's largest top-level symbols when none of its
 * symbol names match the query, so a chunk is always returned for any file
 * that has indexed symbols.
 */
export function extractRelevantChunks(
  file: FileNode,
  content: string,
  queryTokens: string[],
  padding: number,
): ContextChunk[] {
  const lines = content.split('\n')
  const totalLines = lines.length

  let candidates = file.symbols.filter(sym => {
    const symbolTokens = tokenize(sym.name)
    return queryTokens.some(term => symbolTokens.includes(term) || sym.name.toLowerCase() === term)
  })

  if (candidates.length === 0) {
    // No symbol textually matches — fall back to the largest top-level
    // symbols (functions/classes/components first) as representative chunks.
    candidates = [...file.symbols]
      .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))
      .slice(0, FALLBACK_CHUNK_SYMBOL_COUNT)
  }

  if (candidates.length === 0) {
    // No indexed symbols at all (e.g. plain CSS without rules, or a config
    // file) — return the head of the file as a single chunk.
    const end = Math.min(totalLines, padding * 4 || 32)
    return [{
      symbol:    file.relativePath.split('/').pop() ?? file.relativePath,
      startLine: 1,
      endLine:   end,
      content:   sliceLines(lines, 1, end),
    }]
  }

  // Build padded ranges, then merge overlaps so we don't duplicate lines or
  // emit dozens of tiny adjacent chunks.
  const ranges = candidates
    .map(sym => ({
      name:  sym.name,
      start: Math.max(1, sym.startLine - padding),
      end:   Math.min(totalLines, sym.endLine + padding),
    }))
    .sort((a, b) => a.start - b.start)

  const merged: { names: string[]; start: number; end: number }[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      last.names.push(range.name)
    } else {
      merged.push({ names: [range.name], start: range.start, end: range.end })
    }
  }

  return merged.map(({ names, start, end }) => ({
    symbol:    names.join(', '),
    startLine: start,
    endLine:   end,
    content:   sliceLines(lines, start, end),
  }))
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns lines [start, end] (1-based, inclusive) joined back into text. */
function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n')
}

function readFileSafe(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    return null
  }
}
