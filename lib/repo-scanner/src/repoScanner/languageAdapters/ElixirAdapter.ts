// lib/repoScanner/languageAdapters/ElixirAdapter.ts
//
// LanguageAdapter for Elixir source files, including Phoenix framework.
//
// Extracted as symbols:
//   defmodule / defprotocol / defimpl  → kind: 'namespace'
//   def / defp / defmacro / defmacrop  → kind: 'function'
//   defstruct                           → kind: 'type'  (struct field list)
//   @type / @typep / @opaque           → kind: 'type'
//   Phoenix controller actions          → kind: 'function' (already covered by def)
//   plug / pipeline / scope / resources → kind: 'function' (Phoenix router macros)
//
// Extracted as imports:
//   alias   → specifier = dotted module path, isRelative: false
//   use     → specifier = dotted module path
//   import  → specifier = dotted module path, namedImports from :only / :except
//   require → specifier = dotted module path
//
// Extracted as exports:
//   All public def / defmacro / defmodule / defprotocol → exported
//   (Private defp / defmacrop are excluded)
//
// References:
//   Module.function( call-sites captured from the function body

import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class ElixirAdapter implements LanguageAdapter {
  readonly name = 'Elixir'
  readonly extensions = ['ex', 'exs'] as const

  // ── extractSymbols ───────────────────────────────────────────────────────

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith('#')) continue

      // defmodule / defprotocol / defimpl → namespace
      const modM = trimmed.match(/^def(?:module|protocol|impl)\s+([\w.]+)/)
      if (modM) {
        symbols.push({
          name: modM[1],
          kind: 'namespace',
          startLine: i + 1,
          endLine: findElixirBlockEnd(lines, i),
        })
        continue
      }

      // def / defp / defmacro / defmacrop
      const fnM = trimmed.match(/^def(?:macro)?p?\s+([a-z_][a-zA-Z0-9_?!]*)/)
      if (fnM) {
        // Resolve guard clauses — the real name is before "when"
        const name = fnM[1]
        symbols.push({
          name,
          kind: 'function',
          startLine: i + 1,
          endLine: findElixirBlockEnd(lines, i),
        })
        continue
      }

      // defstruct → type (represents the struct schema)
      if (trimmed.startsWith('defstruct')) {
        // Try to derive the struct name from the enclosing module (best-effort: use file basename)
        symbols.push({
          name: '__struct__',
          kind: 'type',
          startLine: i + 1,
          endLine: i + 1,
        })
        continue
      }

      // @type / @typep / @opaque MyType :: ...
      const typeM = trimmed.match(/^@(?:type|typep|opaque)\s+([a-z_][a-zA-Z0-9_]*)\b/)
      if (typeM) {
        symbols.push({
          name: typeM[1],
          kind: 'type',
          startLine: i + 1,
          endLine: i + 1,
        })
        continue
      }

      // Phoenix router macros: get/post/put/patch/delete/head/options/resources/live
      const routerM = trimmed.match(
        /^(?:get|post|put|patch|delete|head|options|resources|live|live_session|forward)\s+"([^"]+)"/
      )
      if (routerM) {
        symbols.push({
          name: routerM[1],
          kind: 'function',
          startLine: i + 1,
          endLine: i + 1,
        })
        continue
      }

      // plug :action_name or plug ModuleName
      const plugM = trimmed.match(/^plug\s+(?::([a-z_][a-zA-Z0-9_]*)|([A-Z][\w.]*))/)
      if (plugM) {
        const name = plugM[1] ?? plugM[2]
        if (name) {
          symbols.push({
            name,
            kind: 'function',
            startLine: i + 1,
            endLine: i + 1,
          })
        }
        continue
      }
    }

    return symbols
  }

  // ── extractImports ────────────────────────────────────────────────────────

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#')) continue

      // alias Foo.Bar, as: Baz
      // alias Foo.{Bar, Baz}
      const aliasM = trimmed.match(/^alias\s+([\w.{}]+)(?:,\s*as:\s*(\w+))?/)
      if (aliasM) {
        const raw = aliasM[1]
        // Expand multi-alias: Foo.{Bar, Baz} → Foo.Bar, Foo.Baz
        if (raw.includes('{')) {
          const prefix = raw.slice(0, raw.indexOf('.{'))
          const inner = raw.slice(raw.indexOf('{') + 1, raw.lastIndexOf('}'))
          for (const part of inner.split(',')) {
            const specifier = `${prefix}.${part.trim()}`
            imports.push({
              specifier,
              namedImports: [],
              defaultImport: aliasM[2] ?? null,
              namespaceImport: null,
              isRelative: false,
            })
          }
        } else {
          imports.push({
            specifier: raw,
            namedImports: [],
            defaultImport: aliasM[2] ?? null,
            namespaceImport: null,
            isRelative: false,
          })
        }
        continue
      }

      // use Foo.Bar, some_option: :val
      const useM = trimmed.match(/^use\s+([\w.]+)/)
      if (useM) {
        imports.push({
          specifier: useM[1],
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: false,
        })
        continue
      }

      // import Foo.Bar, only: [func: 1]
      const importM = trimmed.match(/^import\s+([\w.]+)(?:,\s*only:\s*\[([^\]]*)\])?/)
      if (importM) {
        const onlyStr = importM[2] ?? ''
        // Extract function names from [func: 1, other: 2] → ['func', 'other']
        const named = onlyStr
          ? onlyStr.split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
          : []
        imports.push({
          specifier: importM[1],
          namedImports: named,
          defaultImport: null,
          namespaceImport: null,
          isRelative: false,
        })
        continue
      }

      // require Foo.Bar
      const requireM = trimmed.match(/^require\s+([\w.]+)/)
      if (requireM) {
        imports.push({
          specifier: requireM[1],
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: false,
        })
        continue
      }
    }

    return imports
  }

  // ── extractExports ────────────────────────────────────────────────────────

  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const lines = content.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#')) continue

      // Public defs only (defp / defmacrop are private)
      const pubFnM = trimmed.match(/^def(?:macro)?\s+([a-z_][a-zA-Z0-9_?!]*)/)
      if (pubFnM) {
        exports.push({ name: pubFnM[1], kind: 'function' })
        continue
      }

      // defmodule
      const modM = trimmed.match(/^defmodule\s+([\w.]+)/)
      if (modM) {
        exports.push({ name: modM[1], kind: 'class' })
        continue
      }

      // defprotocol
      const protoM = trimmed.match(/^defprotocol\s+([\w.]+)/)
      if (protoM) {
        exports.push({ name: protoM[1], kind: 'interface' })
        continue
      }
    }

    return exports
  }

  // ── extractReferences ─────────────────────────────────────────────────────

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')

    // Module.function( call-sites
    const callRe = /\b([A-Z][A-Za-z0-9.]*)\s*\.\s*([a-z_][a-zA-Z0-9_?!]*)\s*\(/g

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().startsWith('#')) continue

      let m: RegExpExecArray | null
      callRe.lastIndex = 0
      while ((m = callRe.exec(line)) !== null) {
        refs.push({
          symbolName: `${m[1]}.${m[2]}`,
          line: i + 1,
          fromSpecifier: m[1],
        })
      }
    }

    return refs
  }
}

// ── Elixir block-end helper ────────────────────────────────────────────────
//
// Elixir uses `do … end` blocks (not curly braces), so findSymbolEndLine
// from adapterUtils (which counts `{`/`}`) does not work.
//
// Strategy: track do/end keyword depth.  Inline `do:` forms (one-liners)
// are returned with endLine == startLine.

function findElixirBlockEnd(lines: string[], startIdx: number): number {
  // Inline do: (single-line form): def foo(x), do: x + 1
  const startLine = lines[startIdx].trim()
  if (/,\s*do:/.test(startLine) && !startLine.endsWith('do')) {
    return startIdx + 1
  }

  let depth = 0
  const limit = Math.min(startIdx + 2000, lines.length)

  for (let i = startIdx; i < limit; i++) {
    const stripped = stripElixirLine(lines[i])
    // Count do … end (not do: which is a keyword option)
    const doMatches = (stripped.match(/\bdo\b(?!\s*:)/g) ?? []).length
    const endMatches = (stripped.match(/\bend\b/g) ?? []).length
    depth += doMatches - endMatches
    // Once we opened a block and returned to depth 0 we found the end
    if (i > startIdx && depth <= 0) return i + 1
  }

  return startIdx + 1
}

/** Strip Elixir line comments so keyword counting isn't skewed. */
function stripElixirLine(line: string): string {
  const hashIdx = line.indexOf('#')
  if (hashIdx < 0) return line
  // Crude: ignore # inside strings (acceptable trade-off for depth counting)
  return line.slice(0, hashIdx)
}
