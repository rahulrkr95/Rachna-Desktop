// lib/repoScanner/languageAdapters/GoRegexFallback.ts
//
// Regex-based Go extractor used when Tree-sitter initialisation fails.
// This is a faithful preservation of the original GoAdapter logic,
// wrapped so the main adapter can delegate to it cleanly.
//
// It intentionally produces base Symbol / Import / Export / Reference
// values (no GoSymbol extras) so the caller can satisfy the LanguageAdapter
// interface without any AST dependency.

import type { Symbol, Import, Export, Reference, ExportKind } from './types'
import { findSymbolEndLine } from './adapterUtils'

export function extractSymbolsRegex(content: string): Symbol[] {
  const symbols: Symbol[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // type Foo struct / type Foo interface
    const typeDecl = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)/)
    if (typeDecl) {
      symbols.push({
        name: typeDecl[1],
        kind: typeDecl[2] === 'interface' ? 'interface' : 'class',
        startLine: i + 1,
        endLine: findSymbolEndLine(lines, i),
      })
      continue
    }

    // type Alias = SomeType  or  type NewType OldType
    const typeAlias = line.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+[A-Za-z]/)
    if (typeAlias) {
      symbols.push({ name: typeAlias[1], kind: 'type', startLine: i + 1, endLine: findSymbolEndLine(lines, i) })
      continue
    }

    // func (receiver) Name(  OR  func Name(
    // Capture whether a receiver is present to distinguish method from function
    const fn = line.match(/^func\s+(\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\[?/)
    if (fn) {
      const isMethod = !!fn[1]
      // fn[2] is the function/method name (after optional receiver)
      const name = fn[2]
      symbols.push({ name, kind: isMethod ? 'method' : 'function', startLine: i + 1, endLine: findSymbolEndLine(lines, i) })
      continue
    }

    // var / const — distinguish constants from variables
    const varDecl  = line.match(/^var\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|=)/)
    if (varDecl) {
      symbols.push({ name: varDecl[1], kind: 'variable', startLine: i + 1, endLine: i + 1 })
      continue
    }
    const constDecl = line.match(/^const\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|=)/)
    if (constDecl) {
      // SymbolKind has no 'constant' — use 'variable' as closest match (same as AST path)
      symbols.push({ name: constDecl[1], kind: 'variable', startLine: i + 1, endLine: i + 1 })
      continue
    }
  }

  return symbols
}

export function extractImportsRegex(content: string): Import[] {
  const imports: Import[] = []

  // Single import: import "fmt"  or  import myfmt "fmt"
  const singleRe = /^import\s+(?:(\w+)\s+)?["']([^"']+)["']/gm
  let m: RegExpExecArray | null
  while ((m = singleRe.exec(content)) !== null) {
    const alias     = m[1] ?? null
    const specifier = m[2]
    const pkgName   = alias ?? specifier.split('/').pop() ?? specifier
    imports.push({
      specifier,
      namedImports: [],
      defaultImport: null,
      namespaceImport: pkgName,
      isRelative: specifier.startsWith('.'),
    })
  }

  // Block import: import ( ... )
  const blockMatch = content.match(/^import\s*\(([^)]*)\)/m)
  if (blockMatch) {
    const block = blockMatch[1]
    const lineRe = /^\s*(?:(\w+)\s+)?["']([^"']+)["']/gm
    let lm: RegExpExecArray | null
    while ((lm = lineRe.exec(block)) !== null) {
      const alias     = lm[1] ?? null
      const specifier = lm[2]
      const pkgName   = alias ?? specifier.split('/').pop() ?? specifier
      imports.push({
        specifier,
        namedImports: [],
        defaultImport: null,
        namespaceImport: pkgName,
        isRelative: specifier.startsWith('.'),
      })
    }
  }

  return imports
}

export function extractExportsRegex(content: string): Export[] {
  const exports: Export[] = []
  const seen = new Set<string>()

  for (const sym of extractSymbolsRegex(content)) {
    if (/^[A-Z]/.test(sym.name) && !seen.has(sym.name)) {
      seen.add(sym.name)
      const kind: ExportKind =
        sym.kind === 'class'     ? 'class'     :
        sym.kind === 'interface' ? 'interface' :
        sym.kind === 'function'  ? 'function'  :
        sym.kind === 'type'      ? 'type'      : 'variable'
      exports.push({ name: sym.name, kind })
    }
  }
  return exports
}

export function extractReferencesRegex(content: string): Reference[] {
  const pkgAliases = new Map<string, string>()
  for (const imp of extractImportsRegex(content)) {
    if (imp.namespaceImport) pkgAliases.set(imp.namespaceImport, imp.specifier)
  }

  const refs: Reference[] = []
  const seen = new Set<string>()
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*import\s/.test(line) || /^\s*["']/.test(line)) continue

    const useRe = /\b([a-z_][A-Za-z0-9_]*)\.([A-Z][A-Za-z0-9_]*)/g
    let m: RegExpExecArray | null
    while ((m = useRe.exec(line)) !== null) {
      const pkg  = m[1]
      const name = m[2]
      if (!pkgAliases.has(pkg)) continue
      const key = `${pkg}.${name}:${i + 1}`
      if (!seen.has(key)) {
        seen.add(key)
        refs.push({
          symbolName: `${pkg}.${name}`,
          line: i + 1,
          fromSpecifier: pkgAliases.get(pkg) ?? null,
        })
      }
    }
  }
  return refs
}
