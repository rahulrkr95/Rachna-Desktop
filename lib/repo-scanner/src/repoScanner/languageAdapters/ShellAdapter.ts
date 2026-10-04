// lib/repoScanner/languageAdapters/ShellAdapter.ts
import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class ShellAdapter implements LanguageAdapter {
  readonly name = 'Shell'
  readonly extensions = ['sh', 'bash', 'zsh', 'fish'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      const fn = line.match(/^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{?/)
      if (fn && !line.startsWith('#')) {
        symbols.push({ name: fn[1], kind: 'function', startLine: i+1, endLine: findSymbolEndLine(lines, i) })
        continue
      }
      const vr = line.match(/^([A-Z_][A-Z0-9_]+)=/)
      if (vr) { symbols.push({ name: vr[1], kind: 'variable', startLine: i+1, endLine: findSymbolEndLine(lines, i) }); continue }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /^(?:\.\s+|source\s+)['"]?([^\s'"]+)['"]?/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      imports.push({ specifier: m[1], namedImports: [], defaultImport: null, namespaceImport: null, isRelative: true })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const re = /^export\s+(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      exports.push({ name: m[1], kind: 'function' })
    }
    return exports
  }

  extractReferences(content: string): Reference[] { return [] }
}
