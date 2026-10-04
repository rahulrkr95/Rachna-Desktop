// lib/repoScanner/languageAdapters/DartAdapter.ts
import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class DartAdapter implements LanguageAdapter {
  readonly name = 'Dart'
  readonly extensions = ['dart'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const mix = line.match(/^(?:abstract\s+)?mixin\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (mix) { symbols.push({ name: mix[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const cls = line.match(/^(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const en = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (en) { symbols.push({ name: en[1], kind: 'enum', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const fn = line.match(/^(?:(?:static|async|Future|void|String|int|bool|List|Map)\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
      if (fn) { symbols.push({ name: fn[1], kind: 'function', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const tv = line.match(/^(?:final\s+|const\s+|late\s+|static\s+)?(?:var\s+|[A-Z][A-Za-z0-9_<>?]*\s+)([a-z_][A-Za-z0-9_]*)(?:\s*=|\s*;)/)
      if (tv) { symbols.push({ name: tv[1], kind: 'variable', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /^import\s+['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      imports.push({ specifier: m[1], namedImports: [], defaultImport: null, namespaceImport: null, isRelative: m[1].startsWith('.') })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content)
      .filter(s => !s.name.startsWith('_'))
      .map(s => ({ name: s.name, kind: (s.kind === 'class' ? 'class' : 'function') as any }))
  }

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const re = /(?:extends\s+|implements\s+|with\s+|is\s+)([A-Z][A-Za-z0-9_]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1], line, fromSpecifier: null })
    }
    return refs
  }
}
