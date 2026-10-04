// lib/repoScanner/languageAdapters/TypeScriptAdapter.ts
//
// LanguageAdapter implementation for TypeScript and JavaScript.
//
// Uses regex-based extraction — intentionally does NOT depend on ts-morph
// so the adapter can run in any context (browser, worker, Tauri frontend).
// The scanner.ts still uses ts-morph for high-fidelity TS/JS parsing; this
// adapter is the fallback/universal path and is used for ranking/retrieval
// where exact AST accuracy is not required.

import type { LanguageAdapter, Symbol, Import, Export, Reference, SymbolKind, ExportKind } from './types'
import { findSymbolEndLine } from './adapterUtils'

// ── Helpers ───────────────────────────────────────────────────────────────

// ── TypeScript / JavaScript adapter ──────────────────────────────────────

export class TypeScriptAdapter implements LanguageAdapter {
  readonly name: string = 'TypeScript'
  readonly extensions: readonly string[] = ['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    const patterns: Array<{ re: RegExp; kind: SymbolKind }> = [
      // React component: const Foo = (…) => or function Foo(props)
      { re: /^export\s+(?:default\s+)?(?:const|function)\s+([A-Z][A-Za-z0-9_]*)/, kind: 'component' },
      // Regular function declaration
      { re: /^(?:export\s+)?(?:async\s+)?function\s+([a-z_$][A-Za-z0-9_$]*)/, kind: 'function' },
      // const/let arrow function
      { re: /^(?:export\s+)?const\s+([a-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/, kind: 'function' },
      // class
      { re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'class' },
      // interface
      { re: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'interface' },
      // type alias
      { re: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/, kind: 'type' },
      // enum
      { re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'enum' },
    ]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart()
      for (const { re, kind } of patterns) {
        const m = line.match(re)
        if (m) {
          symbols.push({ name: m[1], kind, startLine: i + 1, endLine: findSymbolEndLine(lines, i) })
          break
        }
      }
    }
    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  extractImports(content: string): Import[] {
    const imports: Import[] = []

    // Static import: import Foo, { bar, baz as b } from 'specifier'
    const staticRe = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = staticRe.exec(content)) !== null) {
      const clause = m[1].trim()
      const specifier = m[2]
      let defaultImport: string | null = null
      let namespaceImport: string | null = null
      const namedImports: string[] = []

      // namespace: * as foo
      const nsMatch = clause.match(/^\*\s+as\s+(\w+)/)
      if (nsMatch) {
        namespaceImport = nsMatch[1]
      } else {
        // default + named: Foo, { bar, baz }
        const parts = clause.split(',').map(s => s.trim())
        for (const part of parts) {
          const named = part.match(/^\{([^}]+)\}/)
          if (named) {
            for (const n of named[1].split(',')) {
              const name = n.trim().split(/\s+as\s+/).pop()!.trim()
              if (name) namedImports.push(name)
            }
          } else if (part && !part.startsWith('{') && !part.startsWith('*')) {
            defaultImport = part || null
          }
        }
      }

      imports.push({
        specifier,
        namedImports,
        defaultImport,
        namespaceImport,
        isRelative: specifier.startsWith('.'),
      })
    }

    // Dynamic import(): import('specifier')
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    while ((m = dynRe.exec(content)) !== null) {
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: null,
        isRelative: m[1].startsWith('.'),
      })
    }

    // require(): const x = require('specifier')
    const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    while ((m = reqRe.exec(content)) !== null) {
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: null,
        isRelative: m[1].startsWith('.'),
      })
    }

    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const seen = new Set<string>()

    const add = (name: string, kind: ExportKind) => {
      if (!seen.has(name)) { seen.add(name); exports.push({ name, kind }) }
    }

    // export default
    if (/^export\s+default\b/m.test(content)) add('default', 'default')

    // named exports: export { Foo, Bar }
    const namedRe = /^export\s*\{([^}]+)\}/gm
    let m: RegExpExecArray | null
    while ((m = namedRe.exec(content)) !== null) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(/\s+as\s+/).pop()!.trim()
        if (name) add(name, 're-export')
      }
    }

    // export function/class/const/interface/type/enum
    const declRe = /^export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
    while ((m = declRe.exec(content)) !== null) {
      const rawKind = m[1] as string
      const name    = m[2]
      const kind: ExportKind =
        rawKind === 'const' || rawKind === 'let' || rawKind === 'var' ? 'variable' :
        rawKind as ExportKind
      add(name, kind)
    }

    return exports
  }

  // ── extractReferences ────────────────────────────────────────────────────
  extractReferences(content: string): Reference[] {
    // Build a set of imported names so we can annotate references with their
    // source specifier.
    const importedFrom = new Map<string, string>()
    for (const imp of this.extractImports(content)) {
      for (const n of imp.namedImports) importedFrom.set(n, imp.specifier)
      if (imp.defaultImport) importedFrom.set(imp.defaultImport, imp.specifier)
      if (imp.namespaceImport) importedFrom.set(imp.namespaceImport, imp.specifier)
    }

    const refs: Reference[] = []
    const seen = new Set<string>()
    const lines = content.split('\n')

    // Simple heuristic: identifier call-sites and type references
    const useRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/g
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip import lines
      if (/^\s*import\s/.test(line)) continue
      let m: RegExpExecArray | null
      useRe.lastIndex = 0
      while ((m = useRe.exec(line)) !== null) {
        const name = m[1]
        if (!importedFrom.has(name)) continue
        const key = `${name}:${i + 1}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({ symbolName: name, line: i + 1, fromSpecifier: importedFrom.get(name) ?? null })
        }
      }
    }
    return refs
  }
}

// Shared JavaScript adapter re-uses TypeScript adapter
export class JavaScriptAdapter extends TypeScriptAdapter {
  override readonly name = 'JavaScript'
  override readonly extensions = ['js', 'jsx', 'mjs', 'cjs'] as const
}
