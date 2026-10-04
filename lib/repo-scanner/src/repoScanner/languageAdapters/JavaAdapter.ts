// lib/repoScanner/languageAdapters/JavaAdapter.ts
//
// LanguageAdapter for Java (.java).

import type { LanguageAdapter, Symbol, Import, Export, Reference, ExportKind } from './types'
import { findSymbolEndLine } from './adapterUtils'

export class JavaAdapter implements LanguageAdapter {
  readonly name = 'Java'
  readonly extensions = ['java'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // interface FooBar
      const iface = line.match(/(?:^|\s)(?:public\s+|protected\s+|private\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (iface) { symbols.push({ name: iface[1], kind: 'interface', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // enum FooBar
      const enm = line.match(/(?:^|\s)(?:public\s+|protected\s+|private\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (enm) { symbols.push({ name: enm[1], kind: 'enum', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // class / abstract class / record
      const cls = line.match(/(?:^|\s)(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+)?(?:class|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (cls) { symbols.push({ name: cls[1], kind: 'class', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // method: returnType methodName(
      const method = line.match(/(?:public|protected|private|static|final|synchronized|abstract|native|\s)+\s+(?:[\w<>\[\],\s]+)\s+([a-z_$][A-Za-z0-9_$]*)\s*\(/)
      if (method && !line.includes('=') && !line.startsWith('//')) {
        symbols.push({ name: method[1], kind: 'method', startLine: i + 1, endLine: findSymbolEndLine(lines, i) })
        continue
      }
    }
    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const importRe = /^import\s+(?:static\s+)?([\w.]+\*?);/gm
    let m: RegExpExecArray | null
    while ((m = importRe.exec(content)) !== null) {
      const specifier = m[1]
      const parts     = specifier.split('.')
      const lastName  = parts[parts.length - 1]
      const isWildcard = lastName === '*'
      imports.push({
        specifier,
        namedImports: isWildcard ? [] : [lastName],
        defaultImport: null,
        namespaceImport: null,
        isRelative: false,
      })
    }
    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  // Java's export concept = public top-level types in the file.
  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const seen = new Set<string>()

    const re = /^public\s+(?:(?:abstract|final|sealed|non-sealed)\s+)?(?:(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*))/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const rawKind = m[1] as string
      const name    = m[2]
      if (!seen.has(name)) {
        seen.add(name)
        const kind: ExportKind =
          rawKind === 'interface' ? 'interface' :
          rawKind === 'enum'      ? 'enum'      : 'class'
        exports.push({ name, kind })
      }
    }
    return exports
  }

  // ── extractReferences ────────────────────────────────────────────────────
  extractReferences(content: string): Reference[] {
    const importedNames = new Map<string, string>()
    for (const imp of this.extractImports(content)) {
      for (const n of imp.namedImports) importedNames.set(n, imp.specifier)
    }

    const refs: Reference[] = []
    const seen = new Set<string>()
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*import\s/.test(line)) continue
      const useRe = /\b([A-Z][A-Za-z0-9_$]*)\b/g
      let m: RegExpExecArray | null
      while ((m = useRe.exec(line)) !== null) {
        const name = m[1]
        if (!importedNames.has(name)) continue
        const key = `${name}:${i + 1}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({ symbolName: name, line: i + 1, fromSpecifier: importedNames.get(name) ?? null })
        }
      }
    }
    return refs
  }
}
