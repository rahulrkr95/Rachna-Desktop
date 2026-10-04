// lib/repoScanner/languageAdapters/GraphQLAdapter.ts
//
// LanguageAdapter for GraphQL schema and operation files (.graphql, .gql).
//
// Extracts:
//   - type / input / interface / union / scalar definitions → 'interface'
//   - enum definitions → 'enum'
//   - query / mutation / subscription operations → 'function'
//   - fragment definitions → 'variable'
//   - directive definitions → 'variable'

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class GraphQLAdapter implements LanguageAdapter {
  readonly name = 'GraphQL'
  readonly extensions = ['graphql', 'gql'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    // Strip block comments (""" ... """) and line comments (#)
    const cleaned = content.replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '')

    const patterns: Array<{ re: RegExp; kind: Symbol['kind'] }> = [
      { re: /\btype\s+([A-Za-z_][A-Za-z0-9_]*)/g,             kind: 'interface' },
      { re: /\binput\s+([A-Za-z_][A-Za-z0-9_]*)/g,            kind: 'interface' },
      { re: /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/g,        kind: 'interface' },
      { re: /\bunion\s+([A-Za-z_][A-Za-z0-9_]*)/g,            kind: 'type'      },
      { re: /\bscalar\s+([A-Za-z_][A-Za-z0-9_]*)/g,           kind: 'type'      },
      { re: /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/g,             kind: 'enum'      },
      { re: /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/g,            kind: 'function'  },
      { re: /\bmutation\s+([A-Za-z_][A-Za-z0-9_]*)/g,         kind: 'function'  },
      { re: /\bsubscription\s+([A-Za-z_][A-Za-z0-9_]*)/g,     kind: 'function'  },
      { re: /\bfragment\s+([A-Za-z_][A-Za-z0-9_]*)\s+on\b/g,  kind: 'variable'  },
      { re: /\bdirective\s+@([A-Za-z_][A-Za-z0-9_]*)/g,       kind: 'variable'  },
    ]

    for (const { re, kind } of patterns) {
      let m: RegExpExecArray | null
      re.lastIndex = 0
      while ((m = re.exec(cleaned)) !== null) {
        const name    = m[1]
        const lineNum = cleaned.substring(0, m.index).split('\n').length
        // Skip built-in type system names
        if (['Query', 'Mutation', 'Subscription', 'String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) continue
        symbols.push({ name, kind, startLine: lineNum, endLine: lineNum })
      }
    }

    return symbols
  }

  extractImports(): Import[] { return [] }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content).map(s => ({ name: s.name, kind: 'variable' as const }))
  }

  extractReferences(): Reference[] { return [] }
}
