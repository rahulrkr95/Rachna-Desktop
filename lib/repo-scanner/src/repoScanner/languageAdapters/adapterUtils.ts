// lib/repoScanner/languageAdapters/adapterUtils.ts
//
// Shared helpers for regex-based LanguageAdapters.
//
// findSymbolEndLine — brace-counting symbol end detector
// ────────────────────────────────────────────────────────
// Regex adapters historically set `endLine === startLine` because they only
// matched the opening declaration line and had no way to locate the closing
// brace. This utility walks forward from the declaration line, tracking brace
// depth, and returns the 1-based line number of the matching closing `}` so
// symbols have accurate ranges for chunk retrieval and diff highlighting.
//
// Usage (inside an extractSymbols loop that already has `lines: string[]`):
//
//   const endLine = findSymbolEndLine(lines, startLineIdx)
//   symbols.push({ name, kind, startLine: startLineIdx + 1, endLine })
//
// Where `startLineIdx` is the 0-based index of the opening declaration line.
//
// Edge cases:
//  • If the opening `{` is on a subsequent line (e.g. Allman style) the scan
//    still finds it and counts from there.
//  • Strings and single-line comments (// ...) are stripped before counting
//    so braces inside them don't confuse the depth tracker.
//  • If no matching `}` is found within MAX_SCAN_LINES the function returns
//    startLineIdx + 1 (1-based start line) as a safe fallback.
//  • For one-liner blocks ({ … } on the same line) the depth drops to 0 on
//    the same line and that line number is returned.

/** Maximum lines to scan forward from the opening declaration. */
const MAX_SCAN_LINES = 2000

/**
 * Walks forward from `startIdx` (0-based), tracking `{` / `}` depth, and
 * returns the 1-based line number where depth reaches 0 (the closing brace).
 *
 * @param lines     Full file split by `\n` (0-based index = line N+1).
 * @param startIdx  0-based index of the line containing the symbol declaration.
 * @returns         1-based end-line number, or `startIdx + 1` as fallback.
 */
export function findSymbolEndLine(lines: string[], startIdx: number): number {
  let depth = 0
  let foundOpen = false
  const limit = Math.min(startIdx + MAX_SCAN_LINES, lines.length)

  for (let i = startIdx; i < limit; i++) {
    // Strip single-line comments and string contents (best-effort) so
    // braces inside them don't skew the depth counter.
    const stripped = stripLineNoise(lines[i])

    for (const ch of stripped) {
      if (ch === '{') {
        depth++
        foundOpen = true
      } else if (ch === '}') {
        depth--
        if (foundOpen && depth <= 0) {
          return i + 1  // 1-based
        }
      }
    }
  }

  // No matching closing brace found — fall back to start line
  return startIdx + 1
}

/**
 * Strips the noisy parts of a source line that could contain braces we
 * don't want to count: single-line comments and quoted string literals.
 * This is intentionally lightweight (no full tokenizer) — good enough for
 * brace-depth tracking in well-formed source files.
 */
function stripLineNoise(line: string): string {
  // Remove // line comments (but not inside strings — acceptable trade-off)
  const commentIdx = line.indexOf('//')
  const noComment = commentIdx >= 0 ? line.slice(0, commentIdx) : line

  // Remove # line comments (Shell, Python, Ruby, etc.)
  const hashIdx = noComment.indexOf('#')
  const noHash = hashIdx >= 0 ? noComment.slice(0, hashIdx) : noComment

  // Strip string literals (single + double quoted, non-greedy) so braces
  // in strings don't mislead depth counting.
  return noHash
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
}
