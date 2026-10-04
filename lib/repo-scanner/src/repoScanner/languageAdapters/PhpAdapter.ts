// lib/repoScanner/languageAdapters/PhpAdapter.ts
import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference, SymbolKind } from './types'

export class PhpAdapter implements LanguageAdapter {
  readonly name = 'PHP'
  readonly extensions = ['php', 'phtml', 'php3', 'php4', 'php5', 'php7', 'php8'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const ns = line.match(/^namespace\s+([\w\\]+)/)
      if (ns) { symbols.push({ name: ns[1], kind: 'namespace', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const iface = line.match(/(?:interface)\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (iface) { symbols.push({ name: iface[1], kind: 'interface', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const trait = line.match(/(?:trait)\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (trait) { symbols.push({ name: trait[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const cls = line.match(/(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const fn = line.match(/(?:public\s+|protected\s+|private\s+|static\s+)*function\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (fn) { symbols.push({ name: fn[1], kind: 'function', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
      const con = line.match(/(?:const|define\s*\(\s*['"])([A-Z_][A-Z0-9_]*)/)
      if (con) { symbols.push({ name: con[1], kind: 'variable', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /(?:require|include|require_once|include_once)\s*\(?\s*['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      imports.push({ specifier: m[1], namedImports: [], defaultImport: null, namespaceImport: null, isRelative: m[1].startsWith('.') })
    }
    const useRe = /use\s+([\w\\]+)(?:\s+as\s+(\w+))?/g
    while ((m = useRe.exec(content)) !== null) {
      const parts = m[1].split('\\')
      imports.push({ specifier: m[1], namedImports: [], defaultImport: parts[parts.length-1] ?? null, namespaceImport: m[2] ?? null, isRelative: false })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    return this.extractSymbols(content)
      .filter(s => content.includes('public') || s.kind === 'class')
      .map(s => ({ name: s.name, kind: (s.kind === 'class' ? 'class' : 'function') as any }))
  }

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const re = /(?:new\s+|instanceof\s+|extends\s+|implements\s+)([A-Za-z_][A-Za-z0-9_\\]*)/g
    let m: RegExpExecArray | null
    const lines = content.split('\n')
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1].split('\\').pop()!, line, fromSpecifier: null })
    }
    return refs
  }
}
