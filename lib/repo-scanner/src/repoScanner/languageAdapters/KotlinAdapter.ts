// lib/repoScanner/languageAdapters/KotlinAdapter.ts
import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class KotlinAdapter implements LanguageAdapter {
  readonly name = 'Kotlin'
  readonly extensions = ['kt', 'kts'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const iface = line.match(/^(?:fun\s+)?interface\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (iface) { symbols.push({ name: iface[1], kind: 'interface', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const obj = line.match(/^(?:companion\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (obj) { symbols.push({ name: obj[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const cls = line.match(/^(?:data\s+|sealed\s+|abstract\s+|open\s+|inner\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const en = line.match(/^enum\s+class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (en) { symbols.push({ name: en[1], kind: 'enum', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const fn = line.match(/^(?:(?:private|protected|public|internal|suspend|inline|override|operator|infix)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)/)
      if (fn) { symbols.push({ name: fn[1], kind: 'function', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const tv = line.match(/^(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (tv) { symbols.push({ name: tv[1], kind: 'variable', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const parts = m[1].split('.')
      imports.push({ specifier: m[1], namedImports: [], defaultImport: m[2] ?? parts[parts.length-1] ?? null, namespaceImport: null, isRelative: false })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content)
      .filter(s => !content.slice(0, content.indexOf(s.name)).trimEnd().endsWith('private'))
      .map(s => ({ name: s.name, kind: (s.kind === 'class' ? 'class' : s.kind === 'function' ? 'function' : 'variable') as any }))
  }

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const re = /(?::\s*|extends\s+|implements\s+|is\s+)([A-Z][A-Za-z0-9_]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1], line, fromSpecifier: null })
    }
    return refs
  }
}
