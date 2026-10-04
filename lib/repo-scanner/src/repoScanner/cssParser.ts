// lib/repoScanner/cssParser.ts
//
// Lightweight CSS/SCSS parser for the Repo Scanner.
// No external dependencies — pure regex / string scanning.
//
// Extracts:
//   • ImportRecord[]   for @import "..." / @import url(...) / url(...) assets
//   • SymbolRecord[]   top-level CSS rules (selectors, @keyframes, @layer, etc.)
//     using the new 'style-rule' SymbolRecord type

import type { ImportRecord, SymbolRecord } from './types'
import { resolveRelativeImport } from './utils'

// ── Public types ──────────────────────────────────────────────────────────

export interface ParsedCss {
  imports: ImportRecord[]
  symbols: SymbolRecord[]
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Parses raw CSS/SCSS text and extracts import records and style-rule symbols.
 *
 * @param content    Full text of the CSS/SCSS file
 * @param filePath   Absolute path on disk (used for import resolution)
 * @param extensions The current extension set (forwarded to resolveRelativeImport)
 */
export function parseCssFile(
  content: string,
  filePath: string,
  extensions: Set<string>,
): ParsedCss {
  return {
    imports: extractCssImports(content, filePath, extensions),
    symbols: extractCssSymbols(content),
  }
}

// ── Import extraction ─────────────────────────────────────────────────────

// Matches:
//   @import "path"
//   @import 'path'
//   @import url("path")
//   @import url('path')
//   @import url(path)
const IMPORT_RE = /@import\s+(?:url\(\s*)?['"]?([^'"\)\s;]+)['"]?\s*\)?/gi

// Matches url(...) anywhere in the file (backgrounds, fonts, etc.)
// Captures the inner path/URL.
const URL_RE = /url\(\s*['"]?([^'"\)\s]+)['"]?\s*\)/gi

function extractCssImports(
  content: string,
  filePath: string,
  extensions: Set<string>,
): ImportRecord[] {
  const records: ImportRecord[] = []
  const seen = new Set<string>()

  // ── @import rules (highest priority — always references) ────────────
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const specifier = m[1].trim()
    if (!specifier || isExternalUrl(specifier) || seen.has(specifier)) continue
    seen.add(specifier)

    records.push({
      specifier,
      resolvedPath: resolveRelativeImport(specifier, filePath, extensions),
      namedImports:    [],
      defaultImport:   null,
      namespaceImport: null,
    })
  }

  // ── url() asset references (relative only) ───────────────────────────
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(content)) !== null) {
    const specifier = m[1].trim()
    if (!specifier) continue
    if (isExternalUrl(specifier)) continue
    if (specifier.startsWith('data:')) continue
    if (seen.has(specifier)) continue
    seen.add(specifier)

    // Only include if this looks like a relative path (not just a CSS value)
    if (!isRelativePath(specifier)) continue

    records.push({
      specifier,
      resolvedPath: resolveRelativeImport(specifier, filePath, extensions),
      namedImports:    [],
      defaultImport:   null,
      namespaceImport: null,
    })
  }

  return records
}

// ── Symbol extraction ─────────────────────────────────────────────────────
//
// Extracts top-level CSS rule selectors as SymbolRecords.
// Strategy: scan for `{` that open a top-level block, capture the
// preceding selector text as the symbol name, and find the matching `}`
// for the end line.
//
// Limitations of this regex approach:
//   - Only top-level rules (depth 0 before the `{`)
//   - Nested rules inside @media / @supports etc. are not individually
//     indexed (the outer @rule is the symbol)
//   - Handles single-line and multi-line selectors

/**
 * Matches a top-level CSS rule opener: captures (selector / at-rule) + `{`
 * Examples:
 *   .msgCopyBtn {
 *   #header, nav.sticky {
 *   @keyframes blink {
 *   @media (max-width: 768px) {
 *   h1, h2 {
 */
const RULE_START_RE = /^([^{}/]+)\{/gm

function extractCssSymbols(content: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = []
  const lines = content.split('\n')

  // Build a line-indexed list of `{` and `}` positions for depth tracking
  // We walk through RULE_START_RE matches and only keep those at depth 0.

  // First, build an array of {char_index, line_number, char} for all braces
  type BraceEvent = { index: number; line: number; open: boolean }
  const braces: BraceEvent[] = []
  let lineNum = 1
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (ch === '\n') { lineNum++; continue }
    if (ch === '{' || ch === '}') {
      braces.push({ index: i, line: lineNum, open: ch === '{' })
    }
  }

  // Walk top-level rule starts
  RULE_START_RE.lastIndex = 0
  let m: RegExpExecArray | null

  while ((m = RULE_START_RE.exec(content)) !== null) {
    const selectorRaw = m[1]
    const openBraceIndex = m.index + m[0].length - 1 // index of `{`

    // Calculate selector name
    const selector = selectorRaw.replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (!selector) continue

    // Find which brace event corresponds to this `{`
    const braceIdx = braces.findIndex(b => b.index === openBraceIndex && b.open)
    if (braceIdx === -1) continue

    // Make sure this `{` is at nesting depth 0 (not inside another rule)
    let depth = 0
    for (let i = 0; i < braceIdx; i++) {
      depth += braces[i].open ? 1 : -1
    }
    if (depth !== 0) continue

    // Find matching closing `}` — depth = 1 after the opening `{`
    let closeDepth = 1
    let closeBraceIdx = braceIdx + 1
    while (closeBraceIdx < braces.length && closeDepth > 0) {
      closeDepth += braces[closeBraceIdx].open ? 1 : -1
      closeBraceIdx++
    }

    const startLine = braces[braceIdx].line
    const endLine   = closeBraceIdx > braceIdx
      ? braces[closeBraceIdx - 1].line
      : startLine

    symbols.push({
      name:      selector,
      type:      'style-rule',
      startLine,
      endLine,
    })
  }

  return symbols
}

// ── Helpers ───────────────────────────────────────────────────────────────

function isExternalUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^\/\//i.test(s)
}

/** Returns true when the path is clearly relative (starts with . or ..) or
 *  looks like a relative asset path (contains .ext without a scheme). */
function isRelativePath(s: string): boolean {
  return s.startsWith('./') || s.startsWith('../') || s.startsWith('/')
    // bare filename with extension, e.g. bg.png, fonts/inter.woff2
    || /^[\w\-./]+\.[a-z0-9]{2,6}$/i.test(s)
}
