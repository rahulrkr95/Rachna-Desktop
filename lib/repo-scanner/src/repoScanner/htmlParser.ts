// lib/repoScanner/htmlParser.ts
//
// Lightweight HTML parser for the Repo Scanner.
// No external dependencies — pure regex / string scanning.
//
// Extracted from an HTML file:
//   • ImportRecord[]  for <link href>, <script src>, <img src>, <source src>
//   • inlineScripts   — raw text of each <script>…</script> block
//   • inlineStyles    — raw text of each <style>…</style> block
//
// Only relative paths (starting with . or / or a bare filename) are
// resolved; absolute URLs (http://, https://, //) are skipped.

import type { ImportRecord } from './types'
import { resolveRelativeImport } from './utils'

// ── Public types ──────────────────────────────────────────────────────────

export interface ParsedHtml {
  imports:      ImportRecord[]
  inlineScripts: string[]
  inlineStyles:  string[]
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Parses raw HTML text and extracts references + inline blocks.
 *
 * @param content    Full text of the HTML file
 * @param filePath   Absolute path of the HTML file on disk (used for resolution)
 * @param extensions The current extension set (forwarded to resolveRelativeImport)
 */
export function parseHtmlFile(
  content: string,
  filePath: string,
  extensions: Set<string>,
): ParsedHtml {
  return {
    imports:       extractHtmlImports(content, filePath, extensions),
    inlineScripts: extractInlineBlocks(content, 'script'),
    inlineStyles:  extractInlineBlocks(content, 'style'),
  }
}

// ── Import extraction ─────────────────────────────────────────────────────

/** Attribute patterns that represent file references we want to track */
const ATTR_PATTERNS: Array<{ tagPattern: RegExp; attr: string }> = [
  // <link rel="stylesheet" href="...">  or  <link href="...">
  { tagPattern: /<link\b([^>]*)>/gi,   attr: 'href' },
  // <script src="...">
  { tagPattern: /<script\b([^>]*)>/gi, attr: 'src' },
  // <img src="...">
  { tagPattern: /<img\b([^>]*)>/gi,    attr: 'src' },
  // <source src="..." srcset="...">  (video/picture)
  { tagPattern: /<source\b([^>]*)>/gi, attr: 'src' },
]

function extractHtmlImports(
  content: string,
  filePath: string,
  extensions: Set<string>,
): ImportRecord[] {
  const records: ImportRecord[] = []
  const seen = new Set<string>()

  for (const { tagPattern, attr } of ATTR_PATTERNS) {
    // Reset lastIndex between calls (global flag)
    tagPattern.lastIndex = 0

    let tagMatch: RegExpExecArray | null
    while ((tagMatch = tagPattern.exec(content)) !== null) {
      const attrs = tagMatch[1]
      const specifier = extractAttr(attrs, attr)
      if (!specifier) continue
      if (isExternalUrl(specifier)) continue
      if (seen.has(specifier)) continue
      seen.add(specifier)

      const resolvedPath = resolveRelativeImport(specifier, filePath, extensions)

      records.push({
        specifier,
        resolvedPath,
        namedImports:    [],
        defaultImport:   null,
        namespaceImport: null,
      })
    }
  }

  return records
}

// ── Inline block extraction ───────────────────────────────────────────────

/**
 * Returns the inner text of every <tagName>…</tagName> block.
 * Handles multiline content; strips the wrapping tags.
 */
function extractInlineBlocks(content: string, tagName: 'script' | 'style'): string[] {
  const blocks: string[] = []
  // Non-greedy match of tag content; ignore src= / type= attributes on opening tag
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const inner = m[1].trim()
    if (inner) blocks.push(inner)
  }
  return blocks
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extracts the value of `attrName` from a raw attribute string like:
 *   rel="stylesheet" href="./style.css" type="text/css"
 *
 * Handles single-quoted, double-quoted, and unquoted values.
 */
function extractAttr(attrs: string, attrName: string): string | null {
  // Double-quoted:  href="value"
  const dq = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i')
  const dqMatch = dq.exec(attrs)
  if (dqMatch) return dqMatch[1].trim()

  // Single-quoted:  href='value'
  const sq = new RegExp(`${attrName}\\s*=\\s*'([^']*)'`, 'i')
  const sqMatch = sq.exec(attrs)
  if (sqMatch) return sqMatch[1].trim()

  // Unquoted:  href=value
  const uq = new RegExp(`${attrName}\\s*=\\s*(\\S+)`, 'i')
  const uqMatch = uq.exec(attrs)
  if (uqMatch) return uqMatch[1].trim()

  return null
}

/** Returns true for absolute URLs we should not try to resolve on disk. */
function isExternalUrl(specifier: string): boolean {
  return /^https?:\/\//i.test(specifier)
    || /^\/\//i.test(specifier)
    || /^data:/i.test(specifier)
    || /^mailto:/i.test(specifier)
}
