// lib/repoScanner/languageAdapters/CSharpAdapter.ts
//
// LanguageAdapter for C# (.cs).

import type { LanguageAdapter, Symbol, Import, Export, Reference, ExportKind } from './types'
import { findSymbolEndLine } from './adapterUtils'

export class CSharpAdapter implements LanguageAdapter {
  readonly name = 'C#'
  readonly extensions = ['cs'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // namespace Foo.Bar
      const ns = line.match(/^namespace\s+([\w.]+)/)
      if (ns) { symbols.push({ name: ns[1], kind: 'namespace', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // interface IFoo
      const iface = line.match(/(?:public|internal|protected|private)?\s*interface\s+([A-Za-z_][A-Za-z0-9_<>,\s]*)(?:\s*[:{\n])/)
      if (iface) { symbols.push({ name: iface[1].trim().split(/[<\s]/)[0], kind: 'interface', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // enum
      const enm = line.match(/(?:public|internal|protected|private)?\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (enm) { symbols.push({ name: enm[1], kind: 'enum', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // class / abstract class / record / struct
      const cls = line.match(/(?:public|internal|protected|private|sealed|abstract|static|partial|\s)*(?:class|record|struct)\s+([A-Za-z_][A-Za-z0-9_<>, ]*)(?:\s*[:{\n])/)
      if (cls) { symbols.push({ name: cls[1].trim().split(/[<\s]/)[0], kind: 'class', startLine: i + 1, endLine: findSymbolEndLine(lines, i) }); continue }

      // method
      const method = line.match(/(?:public|protected|private|static|virtual|override|async|abstract|sealed|\s)+\s+(?:[\w<>\[\],?]+)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[(<]/)
      if (method && !line.includes('=') && !line.startsWith('//') && !line.startsWith('*')) {
        symbols.push({ name: method[1], kind: 'method', startLine: i + 1, endLine: findSymbolEndLine(lines, i) })
        continue
      }
    }
    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  // C# uses `using` directives (namespace imports), not file imports.
  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const usingRe = /^using\s+(?:static\s+)?([\w.]+);/gm
    let m: RegExpExecArray | null
    while ((m = usingRe.exec(content)) !== null) {
      const specifier = m[1]
      imports.push({
        specifier,
        namedImports: [],
        defaultImport: null,
        namespaceImport: specifier.split('.').pop() ?? null,
        isRelative: false,
      })
    }
    // using alias: using Foo = Some.Long.Namespace
    const aliasRe = /^using\s+(\w+)\s*=\s*([\w.]+);/gm
    while ((m = aliasRe.exec(content)) !== null) {
      imports.push({
        specifier: m[2],
        namedImports: [],
        defaultImport: null,
        namespaceImport: m[1],
        isRelative: false,
      })
    }
    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  // In C# "public" = exported from the assembly.
  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const seen = new Set<string>()

    const re = /^(?:public|internal)\s+(?:(?:abstract|sealed|static|partial|readonly)\s+)*?(class|interface|enum|record|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/gm
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
    const importedNames = new Set<string>()
    for (const imp of this.extractImports(content)) {
      if (imp.namespaceImport) importedNames.add(imp.namespaceImport)
    }

    const refs: Reference[] = []
    const seen = new Set<string>()
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^\s*using\s/.test(line)) continue
      const useRe = /\b([A-Z][A-Za-z0-9_]*)\s*[.(]/g
      let m: RegExpExecArray | null
      while ((m = useRe.exec(line)) !== null) {
        const name = m[1]
        if (!importedNames.has(name)) continue
        const key = `${name}:${i + 1}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({ symbolName: name, line: i + 1, fromSpecifier: null })
        }
      }
    }
    return refs
  }
}
