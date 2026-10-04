// lib/repoScanner/searchProviders/RegexSearchProvider.ts
//
// Regex search over file contents, for the Node-side repo-scanner package.
//
// This is a genuine (not stubbed) implementation: it reads each file's
// current contents from disk (like semanticRetrieval.ts's fileToEmbeddingInputs
// already does) and runs a regular expression against it. It's opt-in --
// most queries are natural language, not intended-as-regex source -- via
// RetrievalOptions.regexPattern (explicit pattern) or
// RetrievalOptions.useRegexFallback (treat the raw query itself as a
// pattern). When neither is set, isAvailable() returns false and the
// provider contributes nothing, so it never surprises callers of the
// existing hybrid/rankFiles APIs.
//
// For a live, IDE-integrated regex/grep search across the *working tree*
// (rather than the last-scanned index), see
// services/agent/tools/grepCodebaseTool.ts, which shells out to
// ripgrep/grep via the Tauri backend. That tool is unaffected by this
// provider and continues to work exactly as before.

import * as fs from 'fs'

import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

const MAX_FILES_SCANNED = 500
const MAX_MATCHES_PER_FILE = 20
const MAX_FILE_BYTES = 500_000 // skip very large files for latency's sake

export class RegexSearchProvider implements SearchProvider {
  readonly kind = 'regex' as const
  readonly label = 'Regex'
  readonly defaultWeight = 0.5

  isAvailable(ctx: SearchProviderContext): boolean {
    return !!ctx.options.regexPattern || (!!ctx.options.useRegexFallback && ctx.query.trim().length > 0)
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const source = ctx.options.regexPattern ?? ctx.query
    let re: RegExp
    try {
      re = new RegExp(source, ctx.options.regexFlags ?? 'gi')
    } catch {
      // Invalid pattern -- fail closed rather than throwing, so one bad
      // pattern can't take down the whole hybrid search.
      return []
    }

    const results: ProviderMatch[] = []
    let scanned = 0

    for (const file of ctx.index.files) {
      if (scanned >= MAX_FILES_SCANNED) break
      if (file.metadata.sizeBytes > MAX_FILE_BYTES) continue
      scanned++

      let content: string
      try {
        content = fs.readFileSync(file.path, 'utf-8')
      } catch {
        continue
      }

      const match = countMatches(re, content)
      if (match.count === 0) continue

      results.push({
        relativePath: file.relativePath,
        score: match.count,
        confidence: Math.min(1, match.count / 5),
        detail: `${match.count} regex match${match.count === 1 ? '' : 'es'}` +
          (match.firstLine !== null ? `, first at line ${match.firstLine}` : ''),
      })
    }

    return results
  }
}

function countMatches(re: RegExp, content: string): { count: number; firstLine: number | null } {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let count = 0
  let firstLine: number | null = null
  let m: RegExpExecArray | null

  while (count < MAX_MATCHES_PER_FILE && (m = global.exec(content))) {
    count++
    if (firstLine === null) {
      firstLine = content.slice(0, m.index).split('\n').length
    }
    if (m.index === global.lastIndex) global.lastIndex++ // guard against zero-width matches looping forever
  }

  return { count, firstLine }
}
