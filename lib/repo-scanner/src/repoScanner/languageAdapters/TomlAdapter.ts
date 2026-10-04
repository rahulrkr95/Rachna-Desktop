// lib/repoScanner/languageAdapters/TomlAdapter.ts
//
// LanguageAdapter for TOML files (Cargo.toml, pyproject.toml, config.toml, etc.)
//
// Extracts:
//   - Section headers [section] and [[array.tables]] → 'namespace' (mapped to variable)
//   - Top-level keys → 'variable'
//   - Cargo.toml [[bin]] / [[lib]] names → 'function'

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class TomlAdapter implements LanguageAdapter {
  readonly name = 'TOML'
  readonly extensions = ['toml'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const lineNum = i + 1

      if (!line || line.startsWith('#')) continue

      // Array of tables: [[name]]
      const arrayTable = line.match(/^\[\[([^\]]+)\]\]/)
      if (arrayTable) {
        symbols.push({ name: arrayTable[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        continue
      }

      // Table header: [name] or [name.sub]
      const table = line.match(/^\[([^\]]+)\]/)
      if (table) {
        symbols.push({ name: table[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        continue
      }

      // Key = value at root level (no indent)
      const kv = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=/)
      if (kv) {
        symbols.push({ name: kv[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
      }
    }

    return symbols
  }

  extractImports(): Import[] { return [] }
  extractExports(): Export[] { return [] }
  extractReferences(): Reference[] { return [] }
}
