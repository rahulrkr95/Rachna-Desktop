// lib/repoScanner/languageAdapters/SqlAdapter.ts
//
// LanguageAdapter for SQL files (.sql, .psql, .mysql, .sqlite).
//
// Extracts:
//   - CREATE TABLE → 'class'
//   - CREATE VIEW  → 'interface'
//   - CREATE FUNCTION / PROCEDURE → 'function'
//   - CREATE TRIGGER → 'variable'
//   - CREATE INDEX  → 'variable'
//   - CREATE TYPE (PostgreSQL) → 'type'

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class SqlAdapter implements LanguageAdapter {
  readonly name = 'SQL'
  readonly extensions = ['sql', 'psql', 'mysql', 'sqlite', 'pgsql'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    const patterns: Array<{ re: RegExp; kind: Symbol['kind'] }> = [
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/i,          kind: 'class'     },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?(\w+)/i,              kind: 'interface' },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:\w+\.)?(\w+)/i,                                                       kind: 'function'  },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(?:\w+\.)?(\w+)/i,                                                      kind: 'function'  },
      { re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(?:\w+\.)?(\w+)/i,                                                        kind: 'variable'  },
      { re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?(\w+)/i,                             kind: 'variable'  },
      { re: /\bCREATE\s+TYPE\s+(?:\w+\.)?(\w+)/i,                                                                               kind: 'type'      },
    ]

    for (let i = 0; i < lines.length; i++) {
      const line    = lines[i]
      const lineNum = i + 1
      if (line.trim().startsWith('--')) continue

      for (const { re, kind } of patterns) {
        const m = line.match(re)
        if (m) {
          symbols.push({ name: m[1], kind, startLine: lineNum, endLine: lineNum })
          break
        }
      }
    }

    return symbols
  }

  extractImports(): Import[] { return [] }
  extractExports(): Export[] { return [] }
  extractReferences(): Reference[] { return [] }
}
