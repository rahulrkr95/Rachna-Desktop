// lib/repoScanner/languageAdapters/HaskellAdapter.ts
//
// LanguageAdapter for Haskell source files (.hs, .lhs).
//
// Haskell uses layout rules (significant indentation) rather than braces, so
// standard brace-counting in adapterUtils.findSymbolEndLine does not apply.
// We provide a lightweight indentation-based end-finder instead.
//
// Extracted as symbols:
//   module Name where          → kind: 'namespace'
//   data / newtype             → kind: 'type'    (ADT / newtype definition)
//   type Alias                 → kind: 'type'    (type synonym)
//   class ClassName            → kind: 'interface' (typeclass declaration)
//   instance ClassName Type    → kind: 'class'    (typeclass instance)
//   functionName :: TypeSig    → kind: 'function' (top-level type signature)
//   functionName args =        → kind: 'function' (top-level binding, no sig)
//
// Extracted as imports:
//   import [qualified] Module [as Alias] [(hiding) (list)]
//
// Extracted as exports:
//   Symbols listed in the module header export list, or all top-level
//   public bindings when no explicit export list exists.
//
// References:
//   UpperCase (constructor / module-qualified) references in expressions

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class HaskellAdapter implements LanguageAdapter {
  readonly name = 'Haskell'
  readonly extensions = ['hs', 'lhs'] as const

  // ── extractSymbols ───────────────────────────────────────────────────────

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const rawLines = content.split('\n')
    // For Literate Haskell (.lhs) strip Bird-style '>' prefixes
    const lines = rawLines.map(l => (l.startsWith('> ') ? l.slice(2) : l.startsWith('>') ? l.slice(1) : l))
    const seen = new Set<string>()

    const push = (key: string, sym: Symbol) => {
      if (!seen.has(key)) { seen.add(key); symbols.push(sym) }
    }

    // Track which names already have a type signature so we don't double-add
    // a symbol when we later see the binding definition.
    const hasSig = new Set<string>()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      const lineNum = i + 1

      // Skip blank lines and comments
      if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('{-')) continue

      // module Name [(...)] where
      const modM = trimmed.match(/^module\s+([\w.]+)/)
      if (modM) {
        push(`mod:${modM[1]}`, { name: modM[1], kind: 'namespace', startLine: lineNum, endLine: lineNum })
        continue
      }

      // data / newtype TypeName [params]
      const dataM = trimmed.match(/^(?:data|newtype)\s+([A-Z][A-Za-z0-9_']*)/)
      if (dataM) {
        push(`data:${dataM[1]}`, {
          name: dataM[1],
          kind: 'type',
          startLine: lineNum,
          endLine: findHaskellBlockEnd(lines, i),
        })
        continue
      }

      // type TypeAlias = ...
      const typeM = trimmed.match(/^type\s+([A-Z][A-Za-z0-9_']*)/)
      if (typeM) {
        push(`type:${typeM[1]}`, { name: typeM[1], kind: 'type', startLine: lineNum, endLine: lineNum })
        continue
      }

      // class [Context =>] ClassName params [where]
      const classM = trimmed.match(/^class\s+(?:.*?=>\s*)?([A-Z][A-Za-z0-9_']*)/)
      if (classM) {
        push(`class:${classM[1]}`, {
          name: classM[1],
          kind: 'interface',
          startLine: lineNum,
          endLine: findHaskellBlockEnd(lines, i),
        })
        continue
      }

      // instance [Context =>] ClassName Type
      const instM = trimmed.match(/^instance\s+(?:.*?=>\s*)?([A-Z][A-Za-z0-9_']*)/)
      if (instM) {
        // Build a unique key from the full instance head (truncated)
        const head = trimmed.slice('instance'.length).trim().split('\n')[0].replace(/\s+/g, ' ').slice(0, 60)
        push(`inst:${head}`, {
          name: instM[1],
          kind: 'class',
          startLine: lineNum,
          endLine: findHaskellBlockEnd(lines, i),
        })
        continue
      }

      // Top-level type signature: functionName :: Type
      // Must start at column 0 and contain '::'
      if (line.match(/^[a-z_][A-Za-z0-9_']*/) && trimmed.includes('::')) {
        const sigM = trimmed.match(/^([a-z_][A-Za-z0-9_']*)\s*::/)
        if (sigM) {
          hasSig.add(sigM[1])
          push(`fn:${sigM[1]}`, {
            name: sigM[1],
            kind: 'function',
            startLine: lineNum,
            endLine: findHaskellBlockEnd(lines, i),
          })
          continue
        }
      }

      // Top-level binding definition (no signature seen yet):
      // functionName args = ...
      // Must start at column 0 (first char is lowercase or _ )
      if (line.match(/^[a-z_][A-Za-z0-9_']*/) && trimmed.includes('=')) {
        const bindM = trimmed.match(/^([a-z_][A-Za-z0-9_']*)\s+(?:[^=]*?)?=/)
        if (bindM && !hasSig.has(bindM[1])) {
          push(`fn:${bindM[1]}`, {
            name: bindM[1],
            kind: 'function',
            startLine: lineNum,
            endLine: findHaskellBlockEnd(lines, i),
          })
          continue
        }
      }
    }

    return symbols
  }

  // ── extractImports ────────────────────────────────────────────────────────

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    // Multi-line import: join lines that are part of the same import decl
    const lines = content.split('\n')
    let i = 0

    while (i < lines.length) {
      const line = lines[i].trim()
      if (!line.startsWith('import')) { i++; continue }

      // Collect continuation lines (the import list may span multiple lines)
      let full = line
      while (full.includes('(') && !full.includes(')') && i + 1 < lines.length) {
        i++
        full += ' ' + lines[i].trim()
      }

      // import [qualified] Module [as Alias] [(hiding) (item, ...)]
      const m = full.match(
        /^import\s+(qualified\s+)?([\w.]+)(?:\s+as\s+(\w+))?(?:\s+hiding\s*\(([^)]*)\))?(?:\s*\(([^)]*)\))?/
      )
      if (m) {
        const isQualified = !!m[1]
        const specifier = m[2]
        const alias = m[3] ?? null
        const hidingStr = m[4] ?? ''
        const namedStr = m[5] ?? ''

        const named = namedStr
          ? namedStr.split(',').map(s => s.trim().replace(/\(.*\)/, '').trim()).filter(Boolean)
          : []

        imports.push({
          specifier,
          namedImports: named,
          defaultImport: null,
          namespaceImport: isQualified ? (alias ?? specifier) : null,
          isRelative: false,
        })
      }

      i++
    }

    return imports
  }

  // ── extractExports ────────────────────────────────────────────────────────

  extractExports(content: string): Export[] {
    const exports: Export[] = []

    // Check for explicit export list: module Name (item1, item2, ..) where
    const moduleHead = content.match(/^module\s+[\w.]+\s*\(([^)]+)\)/m)
    if (moduleHead) {
      const items = moduleHead[1].split(',').map(s => s.trim().split('(')[0].trim()).filter(Boolean)
      for (const item of items) {
        if (!item || item === '..') continue
        const isType = /^[A-Z]/.test(item)
        exports.push({ name: item, kind: isType ? 'type' : 'function' })
      }
      return exports
    }

    // No explicit list → export all top-level bindings
    return this.extractSymbols(content)
      .filter(s => s.kind === 'function' || s.kind === 'type' || s.kind === 'interface')
      .map(s => ({
        name: s.name,
        kind: (s.kind === 'function' ? 'function' : s.kind === 'interface' ? 'interface' : 'type') as any,
      }))
  }

  // ── extractReferences ─────────────────────────────────────────────────────

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('--')) continue

      // Module-qualified references: Module.name or Module.Name
      const qualRe = /\b([A-Z][A-Za-z0-9_']*)\.([A-Za-z][A-Za-z0-9_']*)/g
      let m: RegExpExecArray | null
      while ((m = qualRe.exec(line)) !== null) {
        refs.push({ symbolName: `${m[1]}.${m[2]}`, line: i + 1, fromSpecifier: m[1] })
      }

      // Standalone uppercase identifiers (constructors / type uses)
      const upperRe = /\b([A-Z][A-Za-z0-9_']*)\b/g
      while ((m = upperRe.exec(line)) !== null) {
        // Skip if it's the LHS of a data/type/class/module decl
        if (/^(?:data|newtype|type|class|module|instance)\b/.test(trimmed)) break
        refs.push({ symbolName: m[1], line: i + 1, fromSpecifier: null })
      }
    }

    return refs
  }
}

// ── Layout-aware end-line scanner ─────────────────────────────────────────
//
// In Haskell, a top-level definition ends when a subsequent non-blank,
// non-comment line starts at column 0 (the same or earlier indentation
// than the definition) — unless it is a continuation (where / let / guard).
//
// We approximate by scanning forward for the next line that begins at
// column 0 (index 0 char is non-space) after the first non-empty line
// following `startIdx`.

function findHaskellBlockEnd(lines: string[], startIdx: number): number {
  const MAX = Math.min(startIdx + 500, lines.length)

  for (let i = startIdx + 1; i < MAX; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    // Line starts at column 0 with a non-space, non-comment character
    if (/^[^\s{-]/.test(line) && !line.startsWith('--')) {
      return i  // 1-based: previous line is the end
    }
  }

  return Math.min(startIdx + 1 + 1, lines.length)
}
