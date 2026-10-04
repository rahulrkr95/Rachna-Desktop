// lib/repoScanner/languageAdapters/PrismaAdapter.ts
//
// LanguageAdapter for Prisma schema files (.prisma).
//
// Extracts:
//   - model definitions → 'class'
//   - enum definitions  → 'enum'
//   - datasource / generator blocks → 'variable'

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class PrismaAdapter implements LanguageAdapter {
  readonly name = 'Prisma'
  readonly extensions = ['prisma'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line    = lines[i].trim()
      const lineNum = i + 1
      if (line.startsWith('//')) continue

      const model = line.match(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/)
      if (model) { symbols.push({ name: model[1], kind: 'class', startLine: lineNum, endLine: lineNum }); continue }

      const enumDef = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/)
      if (enumDef) { symbols.push({ name: enumDef[1], kind: 'enum', startLine: lineNum, endLine: lineNum }); continue }

      const block = line.match(/^(?:datasource|generator)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/)
      if (block) { symbols.push({ name: block[1], kind: 'variable', startLine: lineNum, endLine: lineNum }) }
    }

    return symbols
  }

  extractImports(): Import[]  { return [] }
  extractExports(): Export[]  { return [] }
  extractReferences(): Reference[] { return [] }
}
