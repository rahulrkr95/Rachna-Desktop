// lib/repoScanner/languageAdapters/LuaAdapter.ts
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class LuaAdapter implements LanguageAdapter {
  readonly name = 'Lua'
  readonly extensions = ['lua'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const fn1 = line.match(/^(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.:]*)/)
      if (fn1) { symbols.push({ name: fn1[1].split('.').pop()!, kind: 'function', startLine: i+1, endLine: i+1 }); continue }
      const fn2 = line.match(/^(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function/)
      if (fn2) { symbols.push({ name: fn2[1], kind: 'function', startLine: i+1, endLine: i+1 }); continue }
      const cls = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\}/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i+1, endLine: i+1 }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      imports.push({ specifier: m[1], namedImports: [], defaultImport: null, namespaceImport: null, isRelative: m[1].startsWith('.') })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content).map(s => ({ name: s.name, kind: 'function' as any }))
  }

  extractReferences(content: string): Reference[] { return [] }
}
