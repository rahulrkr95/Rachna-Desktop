// lib/repoScanner/languageAdapters/ScalaAdapter.ts
//
// LanguageAdapter for Scala source files — covers Scala 2 and Scala 3 syntax,
// OOP patterns (class / trait / object), FP patterns (case class, sealed trait,
// type aliases, given/using), and Spark job idioms (SparkSession, Dataset, RDD).
//
// Extracted as symbols:
//   class / case class / abstract class        → kind: 'class'
//   object / case object / companion object    → kind: 'class'
//   trait / sealed trait                       → kind: 'interface'
//   def                                        → kind: 'function' / 'method'
//   val / var / lazy val                       → kind: 'variable'
//   type                                       → kind: 'type'
//   enum (Scala 3)                             → kind: 'enum'
//   given (Scala 3 implicit)                   → kind: 'variable'
//   extension (Scala 3)                        → kind: 'function'
//
// Extracted as imports:
//   import foo.bar.Baz
//   import foo.bar.{Baz, Qux}
//   import foo.bar._
//
// Extracted as exports:
//   All top-level public defs and types (no Scala access modifier before them).
//
// References:
//   extends / with / new ClassName( call-sites

import { findSymbolEndLine } from './adapterUtils'
import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class ScalaAdapter implements LanguageAdapter {
  readonly name = 'Scala'
  readonly extensions = ['scala', 'sc'] as const

  // ── extractSymbols ───────────────────────────────────────────────────────

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    const seen = new Set<string>()

    const push = (key: string, sym: Symbol) => {
      if (!seen.has(key)) { seen.add(key); symbols.push(sym) }
    }

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()

      // Skip single-line comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

      const lineNum = i + 1

      // enum (Scala 3)
      const enumM = trimmed.match(/^(?:sealed\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (enumM) {
        push(`enum:${enumM[1]}`, { name: enumM[1], kind: 'enum', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }

      // trait / sealed trait / abstract sealed trait
      const traitM = trimmed.match(/^(?:(?:sealed|abstract)\s+)*trait\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (traitM) {
        push(`trait:${traitM[1]}`, { name: traitM[1], kind: 'interface', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }

      // class / case class / abstract class / final class
      const classM = trimmed.match(/^(?:(?:case|abstract|final|sealed|open|implicit)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (classM) {
        push(`class:${classM[1]}`, { name: classM[1], kind: 'class', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }

      // object / case object
      const objM = trimmed.match(/^(?:case\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (objM) {
        push(`obj:${objM[1]}`, { name: objM[1], kind: 'class', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }

      // def — method or function
      const defM = trimmed.match(
        /^(?:(?:override|final|protected|private(?:\[[\w.]+\])?|abstract|implicit|inline|transparent)\s+)*def\s+([A-Za-z_][A-Za-z0-9_$]*)/
      )
      if (defM) {
        push(`def:${defM[1]}:${lineNum}`, { name: defM[1], kind: 'function', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }

      // val / var / lazy val
      const valM = trimmed.match(
        /^(?:(?:override|final|protected|private(?:\[[\w.]+\])?|lazy|implicit|inline)\s+)*(?:val|var)\s+([A-Za-z_][A-Za-z0-9_$]*)/
      )
      if (valM) {
        push(`val:${valM[1]}:${lineNum}`, { name: valM[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        continue
      }

      // type alias
      const typeM = trimmed.match(/^(?:(?:protected|private(?:\[[\w.]+\])?|opaque|transparent)\s+)*type\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (typeM) {
        push(`type:${typeM[1]}`, { name: typeM[1], kind: 'type', startLine: lineNum, endLine: lineNum })
        continue
      }

      // Scala 3: given instance
      const givenM = trimmed.match(/^given\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s*:)?/)
      if (givenM && givenM[1]) {
        push(`given:${givenM[1]}`, { name: givenM[1], kind: 'variable', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }

      // Scala 3: extension
      const extM = trimmed.match(/^extension\s+\([^)]+\)\s*def\s+([A-Za-z_][A-Za-z0-9_$]*)/)
      if (extM) {
        push(`ext:${extM[1]}:${lineNum}`, { name: extM[1], kind: 'function', startLine: lineNum, endLine: findSymbolEndLine(lines, i) })
        continue
      }
    }

    return symbols
  }

  // ── extractImports ────────────────────────────────────────────────────────

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const re = /^import\s+([\w.]+)(?:\.\{([^}]+)\}|\.(\*))?/gm
    let m: RegExpExecArray | null

    while ((m = re.exec(content)) !== null) {
      const base = m[1]
      if (m[2]) {
        // import foo.bar.{Baz, Qux => Alias}
        for (const part of m[2].split(',')) {
          const clean = part.trim().split('=>')[0].trim()
          if (clean) {
            imports.push({
              specifier: `${base}.${clean}`,
              namedImports: [clean],
              defaultImport: null,
              namespaceImport: null,
              isRelative: false,
            })
          }
        }
      } else if (m[3]) {
        // import foo.bar._
        imports.push({
          specifier: `${base}._`,
          namedImports: [],
          defaultImport: null,
          namespaceImport: '*',
          isRelative: false,
        })
      } else {
        // import foo.bar.Baz
        imports.push({
          specifier: base,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: false,
        })
      }
    }

    return imports
  }

  // ── extractExports ────────────────────────────────────────────────────────

  extractExports(content: string): Export[] {
    // In Scala everything is public by default unless annotated with private/protected.
    // We surface top-level class/object/trait/def declarations that lack access modifiers.
    const exports: Export[] = []
    const seen = new Set<string>()

    const lines = content.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

      // Skip lines with private / protected
      if (/\bprivate\b|\bprotected\b/.test(trimmed)) continue

      const classM = trimmed.match(/^(?:(?:case|abstract|final|sealed|open)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (classM && !seen.has(classM[1])) { seen.add(classM[1]); exports.push({ name: classM[1], kind: 'class' }) }

      const traitM = trimmed.match(/^(?:(?:sealed|abstract)\s+)*trait\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (traitM && !seen.has(traitM[1])) { seen.add(traitM[1]); exports.push({ name: traitM[1], kind: 'interface' }) }

      const objM = trimmed.match(/^(?:case\s+)?object\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (objM && !seen.has(objM[1])) { seen.add(objM[1]); exports.push({ name: objM[1], kind: 'class' }) }

      const defM = trimmed.match(/^def\s+([A-Za-z_][A-Za-z0-9_$]*)/)
      if (defM && !seen.has(defM[1])) { seen.add(defM[1]); exports.push({ name: defM[1], kind: 'function' }) }

      const typeM = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (typeM && !seen.has(typeM[1])) { seen.add(typeM[1]); exports.push({ name: typeM[1], kind: 'type' }) }
    }

    return exports
  }

  // ── extractReferences ─────────────────────────────────────────────────────

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []

    // extends / with / implements TypeName
    const inheritRe = /\b(?:extends|with)\s+([A-Z][A-Za-z0-9_]*)(?:\[.*?\])?/g
    let m: RegExpExecArray | null
    while ((m = inheritRe.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1], line, fromSpecifier: null })
    }

    // new ClassName(
    const newRe = /\bnew\s+([A-Z][A-Za-z0-9_.]*)\s*[\[(]/g
    while ((m = newRe.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length
      refs.push({ symbolName: m[1], line, fromSpecifier: null })
    }

    return refs
  }
}
