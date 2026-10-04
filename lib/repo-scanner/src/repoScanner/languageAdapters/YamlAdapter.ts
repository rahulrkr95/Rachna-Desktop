// lib/repoScanner/languageAdapters/YamlAdapter.ts
//
// LanguageAdapter for YAML / YML files.
//
// Uses regex-based extraction (no yaml parser dep) — intentionally lightweight.
// Extracts:
//   - Top-level keys (no leading whitespace, ends with colon) → 'variable'
//   - Anchor definitions (&anchor_name) → 'variable'
//   - GitHub Actions jobs/steps → 'function'
//   - Docker Compose service names → 'variable'

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class YamlAdapter implements LanguageAdapter {
  readonly name = 'YAML'
  readonly extensions = ['yaml', 'yml'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1
      if (!line.trim() || line.trim().startsWith('#')) continue

      // Top-level key: starts at column 0, is an identifier, ends with colon
      const topKey = line.match(/^([A-Za-z_$][A-Za-z0-9_$-]*):\s*/)
      if (topKey) {
        symbols.push({ name: topKey[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        continue
      }

      // YAML anchor: &anchor_name
      const anchor = line.match(/&([A-Za-z_][A-Za-z0-9_-]*)/)
      if (anchor) {
        symbols.push({ name: `&${anchor[1]}`, kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // GitHub Actions job id (2-space indent under `jobs:`)
      const ghJob = line.match(/^  ([A-Za-z_][A-Za-z0-9_-]*):\s*$/)
      if (ghJob) {
        symbols.push({ name: ghJob[1], kind: 'function', startLine: lineNum, endLine: lineNum })
      }
    }

    return symbols
  }

  extractImports(): Import[] { return [] }
  extractExports(): Export[] { return [] }
  extractReferences(): Reference[] { return [] }
}
