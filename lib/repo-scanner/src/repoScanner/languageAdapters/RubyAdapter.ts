// lib/repoScanner/languageAdapters/RubyAdapter.ts
import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class RubyAdapter implements LanguageAdapter {
  readonly name = 'Ruby'
  readonly extensions = ['rb', 'rake', 'gemspec', 'ru'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const mod = line.match(/^module\s+([A-Za-z_][A-Za-z0-9_:]*)/)
      if (mod) { symbols.push({ name: mod[1], kind: 'namespace', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const cls = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_:]*)/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const fn = line.match(/^(?:def\s+self\.|def\s+)([A-Za-z_][A-Za-z0-9_?!]*)/)
      if (fn) { symbols.push({ name: fn[1], kind: 'function', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const attr = line.match(/^attr_(?:accessor|reader|writer)\s+:([A-Za-z_][A-Za-z0-9_]*)/)
      if (attr) { symbols.push({ name: attr[1], kind: 'field', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const con = line.match(/^([A-Z_][A-Z0-9_]+)\s*=/)
      if (con) { symbols.push({ name: con[1], kind: 'variable', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /(?:require|require_relative|autoload)\s+['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      imports.push({ specifier: m[1], namedImports: [], defaultImport: null, namespaceImport: null, isRelative: m[0].includes('relative') || m[1].startsWith('.') })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content)
      .filter(s => s.kind === 'class' || s.kind === 'function')
      .map(s => ({ name: s.name, kind: (s.kind === 'class' ? 'class' : 'function') as any }))
  }

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const re = /(?:include|extend|prepend|inherit_from|is_a\?\s*\()([A-Z][A-Za-z0-9_:]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1], line, fromSpecifier: null })
    }
    return refs
  }
}
