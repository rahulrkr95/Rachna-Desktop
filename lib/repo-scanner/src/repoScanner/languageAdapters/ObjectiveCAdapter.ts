// lib/repoScanner/languageAdapters/ObjectiveCAdapter.ts
//
// LanguageAdapter for Objective-C implementation and mixed Obj-C/C++ files.
//
// Extension coverage:
//   .m   — Objective-C implementation
//   .mm  — Objective-C++ implementation
//
// Note: .h headers are already claimed by CppAdapter (which handles both
// C and C++ headers). Objective-C @interface declarations in .h files will
// be picked up by CppAdapter as class-like symbols via its heuristic patterns.
// This adapter covers the .m / .mm files where method bodies are defined.
//
// Extracted as symbols:
//   @interface ClassName : SuperClass   → kind: 'class'
//   @interface ClassName (Category)     → kind: 'class'   (category)
//   @interface ClassName <Protocol>     → kind: 'class'
//   @implementation ClassName           → kind: 'class'
//   @protocol ProtocolName              → kind: 'interface'
//   - (ReturnType)methodName:           → kind: 'method'  (instance method)
//   + (ReturnType)methodName:           → kind: 'method'  (class method)
//   @property (attrs) Type name         → kind: 'field'
//   void C_functionName(                → kind: 'function' (C functions in .m)
//
// Extracted as imports:
//   #import <Framework/Header.h>        → isRelative: false
//   #import "LocalHeader.h"             → isRelative: true
//   @import Framework;                  → isRelative: false  (module import)
//
// Extracted as exports:
//   @interface (public API) methods and properties
//   All publicly visible class / protocol / method symbols
//
// References:
//   [receiver message:] message-send syntax
//   Self / super / ClassName method calls

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

// Column-0 depth tracking for Obj-C block end (braces)
function findObjCBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0
  let foundOpen = false
  const limit = Math.min(startIdx + 2000, lines.length)

  for (let i = startIdx; i < limit; i++) {
    const stripped = stripObjCComments(lines[i])
    for (const ch of stripped) {
      if (ch === '{') { depth++; foundOpen = true }
      else if (ch === '}') {
        depth--
        if (foundOpen && depth <= 0) return i + 1
      }
    }
  }
  return startIdx + 1
}

function stripObjCComments(line: string): string {
  // Remove // comments
  const ci = line.indexOf('//')
  const noLine = ci >= 0 ? line.slice(0, ci) : line
  // Remove block /* */ comments on one line
  return noLine.replace(/\/\*.*?\*\//g, '')
}

// Normalise an Obj-C method selector into a single readable name.
// "- (void)viewWillAppear:(BOOL)animated" → "viewWillAppear:"
// "+ (instancetype)initWithFrame:(CGRect)frame title:(NSString *)title" → "initWithFrame:title:"
function parseMethodSelector(line: string): string | null {
  // Must start with - or + followed by whitespace or (
  const m = line.trim().match(/^[+-]\s*\([^)]+\)\s*(.+)/)
  if (!m) return null
  const rest = m[1]

  // Collect selector parts: word optionally followed by : (param)
  const parts: string[] = []
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*\([^)]+\)\s*[A-Za-z_][A-Za-z0-9_]*\s*)?/g
  let seg: RegExpExecArray | null
  while ((seg = re.exec(rest)) !== null) {
    const word = seg[0]
    // Check if this piece includes a colon (keyword parameter)
    if (rest.slice(seg.index).match(/^[A-Za-z_][A-Za-z0-9_]*\s*:/)) {
      parts.push(seg[1] + ':')
      // Advance past the colon + param
      re.lastIndex = seg.index + rest.slice(seg.index).indexOf(':') + 1
    } else {
      parts.push(seg[1])
      break
    }
  }
  return parts.join('') || null
}

export class ObjectiveCAdapter implements LanguageAdapter {
  readonly name = 'Objective-C'
  readonly extensions = ['m', 'mm'] as const

  // ── extractSymbols ───────────────────────────────────────────────────────

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    const seen = new Set<string>()

    const push = (key: string, sym: Symbol) => {
      if (!seen.has(key)) { seen.add(key); symbols.push(sym) }
    }

    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]
      const lineNum = i + 1

      // Block comment tracking
      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end === -1) continue
        line = line.slice(end + 2)
        inBlockComment = false
      }
      if (line.includes('/*')) {
        const start = line.indexOf('/*')
        const end = line.indexOf('*/', start + 2)
        if (end === -1) { line = line.slice(0, start); inBlockComment = true }
        else line = line.slice(0, start) + line.slice(end + 2)
      }
      line = stripObjCComments(line)
      const trimmed = line.trim()
      if (!trimmed) continue

      // @interface ClassName : SuperClass / (Category) / <Protocol>
      const ifaceM = trimmed.match(/^@interface\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (ifaceM) {
        push(`iface:${ifaceM[1]}:${lineNum}`, {
          name: ifaceM[1],
          kind: 'class',
          startLine: lineNum,
          endLine: findKeywordEnd(lines, i, '@end'),
        })
        continue
      }

      // @implementation ClassName
      const implM = trimmed.match(/^@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (implM) {
        push(`impl:${implM[1]}:${lineNum}`, {
          name: implM[1],
          kind: 'class',
          startLine: lineNum,
          endLine: findKeywordEnd(lines, i, '@end'),
        })
        continue
      }

      // @protocol ProtocolName
      const protoM = trimmed.match(/^@protocol\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (protoM) {
        push(`proto:${protoM[1]}`, {
          name: protoM[1],
          kind: 'interface',
          startLine: lineNum,
          endLine: findKeywordEnd(lines, i, '@end'),
        })
        continue
      }

      // Instance / class method
      if (trimmed.match(/^[+-]\s*\(/)) {
        const selector = parseMethodSelector(trimmed)
        if (selector) {
          const isClass = trimmed.trimStart().startsWith('+')
          push(`method:${selector}:${lineNum}`, {
            name: (isClass ? '+' : '-') + selector,
            kind: 'method',
            startLine: lineNum,
            endLine: findObjCBlockEnd(lines, i),
          })
        }
        continue
      }

      // @property (nonatomic, strong) NSString *propertyName;
      const propM = trimmed.match(/^@property\s*(?:\([^)]*\)\s*)?\S+\s+(?:\*\s*)*([A-Za-z_][A-Za-z0-9_]*)/)
      if (propM) {
        push(`prop:${propM[1]}`, {
          name: propM[1],
          kind: 'field',
          startLine: lineNum,
          endLine: lineNum,
        })
        continue
      }

      // C-style function definitions inside .m files
      // ReturnType functionName( — must not start with if/for/while etc.
      if (
        !trimmed.startsWith('@') &&
        !trimmed.startsWith('-') &&
        !trimmed.startsWith('+') &&
        !trimmed.startsWith('#') &&
        trimmed.includes('(')
      ) {
        const cFnM = trimmed.match(
          /^(?:(?:static|extern|inline|NS_INLINE)\s+)*(?:[\w*<> ]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/
        )
        const SKIP = new Set(['if', 'for', 'while', 'switch', 'return', 'else'])
        if (cFnM && !SKIP.has(cFnM[1])) {
          push(`cfn:${cFnM[1]}:${lineNum}`, {
            name: cFnM[1],
            kind: 'function',
            startLine: lineNum,
            endLine: findObjCBlockEnd(lines, i),
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

    // #import <Framework/Header.h>
    const sysRe = /^#\s*import\s*<([^>]+)>/gm
    let m: RegExpExecArray | null
    while ((m = sysRe.exec(content)) !== null) {
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: null,
        isRelative: false,
      })
    }

    // #import "LocalHeader.h"
    const localRe = /^#\s*import\s*"([^"]+)"/gm
    while ((m = localRe.exec(content)) !== null) {
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: null,
        isRelative: true,
      })
    }

    // @import Framework;  (Clang module import)
    const atRe = /^@import\s+([\w.]+)\s*;/gm
    while ((m = atRe.exec(content)) !== null) {
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: m[1],
        isRelative: false,
      })
    }

    return imports
  }

  // ── extractExports ────────────────────────────────────────────────────────

  extractExports(content: string): Export[] {
    // In Obj-C, "public" API is whatever is declared in @interface / @protocol.
    // Instance/class methods and @property items declared there are the exports.
    return this.extractSymbols(content)
      .filter(s => s.kind === 'class' || s.kind === 'interface' || s.kind === 'method' || s.kind === 'field')
      .map(s => ({
        name: s.name,
        kind: (s.kind === 'class'
          ? 'class'
          : s.kind === 'interface'
          ? 'interface'
          : s.kind === 'method'
          ? 'function'
          : 'variable') as any,
      }))
  }

  // ── extractReferences ─────────────────────────────────────────────────────

  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().startsWith('//')) continue

      // [receiver message] and [receiver message:arg]
      // Capture the message (selector start)
      const msgRe = /\[([A-Za-z_][A-Za-z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g
      let m: RegExpExecArray | null
      while ((m = msgRe.exec(line)) !== null) {
        refs.push({ symbolName: m[2], line: i + 1, fromSpecifier: m[1] })
      }

      // ClassName.property or ClassName alloc]/init style
      const classRefRe = /\b([A-Z][A-Za-z0-9_]*)\s*\*/g
      while ((m = classRefRe.exec(line)) !== null) {
        refs.push({ symbolName: m[1], line: i + 1, fromSpecifier: null })
      }
    }

    return refs
  }
}

// ── @end block scanner ────────────────────────────────────────────────────
//
// Obj-C @interface / @implementation / @protocol blocks close with @end.
// Scan forward for the next @end keyword.

function findKeywordEnd(lines: string[], startIdx: number, keyword: string): number {
  const limit = Math.min(startIdx + 2000, lines.length)
  for (let i = startIdx + 1; i < limit; i++) {
    if (lines[i].trim().startsWith(keyword)) return i + 1
  }
  return startIdx + 1
}
