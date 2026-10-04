// lib/repoScanner/languageAdapters/SwiftAdapter.ts
import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class SwiftAdapter implements LanguageAdapter {
  readonly name = 'Swift'
  readonly extensions = ['swift'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const proto = line.match(/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?protocol\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (proto) { symbols.push({ name: proto[1], kind: 'interface', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const en = line.match(/^(?:public\s+|private\s+|internal\s+|fileprivate\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (en) { symbols.push({ name: en[1], kind: 'enum', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const st = line.match(/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (st) { symbols.push({ name: st[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const cls = line.match(/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const fn = line.match(/^(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|static\s+|class\s+|mutating\s+|override\s+|@objc\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (fn) { symbols.push({ name: fn[1], kind: 'function', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const tv = line.match(/^(?:public\s+|private\s+|internal\s+|static\s+)?(?:var|let)\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (tv) { symbols.push({ name: tv[1], kind: 'variable', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /^import\s+(\w+)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      imports.push({ specifier: m[1], namedImports: [], defaultImport: m[1], namespaceImport: null, isRelative: false })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content)
      .filter(s => !content.slice(0, content.indexOf(s.name)).trimEnd().endsWith('private'))
      .map(s => ({ name: s.name, kind: (s.kind === 'class' ? 'class' : 'function') as any }))
  }

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const re = /(?::\s*|as\s+|is\s+)([A-Z][A-Za-z0-9_]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1], line, fromSpecifier: null })
    }
    return refs
  }
}
