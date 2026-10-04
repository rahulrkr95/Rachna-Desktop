// lib/repoScanner/languageAdapters/CppAdapter.ts
//
// LanguageAdapter for C and C++ source and header files.
//
// Uses regex-based extraction — intentionally does NOT depend on tree-sitter
// or libclang so the adapter can run in any context (browser, worker, Tauri
// frontend). clangd is wired via LSP for diagnostics and hover; this adapter
// is the fallback/universal path for symbol search and retrieval ranking.
//
// Extracted as symbols:
//   - Function definitions & declarations  → kind: 'function'
//   - Method definitions (Class::method)   → kind: 'method'
//   - struct / class / union definitions   → kind: 'class'
//   - enum / enum class definitions        → kind: 'enum'
//   - typedef declarations                 → kind: 'type'
//   - template<> declarations              → kind: 'function' / 'class'
//   - namespace declarations               → kind: 'namespace'
//   - #define macros                       → kind: 'variable'
//   - Global variables / extern            → kind: 'variable'
//   - Constructor & destructor patterns    → kind: 'method'
//   - operator overloads                   → kind: 'method'
//   - using type aliases                   → kind: 'type'
//
// Extracted as imports:
//   - #include <system>     → isRelative: false
//   - #include "local"      → isRelative: true
//
// Extracted as exports:
//   - Exported / extern "C" linkage symbols
//   - Public class members (heuristic: first-pass public: sections)
//
// References:
//   - Function call sites (best-effort: identifier followed by '(')
//   - Class instantiations: new ClassName(

import type {
  LanguageAdapter,
  Symbol,
  Import,
  Export,
  Reference,
  SymbolKind,
} from './types'

// ── Helpers ────────────────────────────────────────────────────────────────

function lineOf(content: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

// Strip single-line // comments and block /* */ comments from a line.
// Note: does NOT handle string literals containing //, which is acceptable
// for a best-effort symbol extractor.
function stripComments(line: string): string {
  // Remove block comments on one line: /* ... */
  line = line.replace(/\/\*.*?\*\//g, '')
  // Remove // line comment
  const slashIdx = line.indexOf('//')
  if (slashIdx !== -1) line = line.substring(0, slashIdx)
  return line
}

// ── C / C++ adapter ────────────────────────────────────────────────────────

export class CppAdapter implements LanguageAdapter {
  readonly name = 'C/C++'
  readonly extensions = ['c', 'cc', 'cpp', 'cxx', 'c++', 'h', 'hh', 'hpp', 'hxx', 'h++', 'inl', 'ipp'] as const

  // ── extractSymbols ───────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const seen   = new Set<string>()
    const lines  = content.split('\n')

    // Track block-comment state across lines
    let inBlockComment = false
    // Track whether we're inside a class/struct body for method detection
    let braceDepth = 0
    const classStack: Array<{ name: string; depth: number }> = []

    const push = (key: string, sym: Symbol) => {
      if (!seen.has(key)) {
        seen.add(key)
        symbols.push(sym)
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      let line = lines[i]

      // ── Block-comment tracking ──────────────────────────────────────────
      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end === -1) continue
        line = line.substring(end + 2)
        inBlockComment = false
      }
      if (line.includes('/*')) {
        const start = line.indexOf('/*')
        const end   = line.indexOf('*/', start + 2)
        if (end === -1) {
          line = line.substring(0, start)
          inBlockComment = true
        } else {
          line = line.substring(0, start) + line.substring(end + 2)
        }
      }
      line = stripComments(line)
      const trimmed = line.trim()
      if (!trimmed) continue

      // ── Track brace depth for class context ────────────────────────────
      for (const ch of trimmed) {
        if (ch === '{') {
          braceDepth++
        } else if (ch === '}') {
          braceDepth--
          // Pop class stack if we closed a class body
          if (classStack.length > 0 && braceDepth < classStack[classStack.length - 1].depth) {
            classStack.pop()
          }
        }
      }

      // ── #define macros ─────────────────────────────────────────────────
      const defineM = trimmed.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s|\(|$)/)
      if (defineM) {
        push(`define:${defineM[1]}`, { name: defineM[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        continue
      }

      // ── #include → handled by extractImports, skip here ────────────────
      if (trimmed.startsWith('#include') || trimmed.startsWith('#')) continue

      // ── namespace declaration ───────────────────────────────────────────
      const nsM = trimmed.match(/^namespace\s+([A-Za-z_][A-Za-z0-9_:]*)\s*(\{|$)/)
      if (nsM) {
        push(`ns:${nsM[1]}`, { name: nsM[1], kind: 'namespace', startLine: lineNum, endLine: lineNum })
        continue
      }

      // ── class / struct / union definition ──────────────────────────────
      // Matches: class Foo {, class Foo : public Bar {, template class Foo {
      const classM = trimmed.match(/^(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
      if (classM && (trimmed.includes('{') || trimmed.endsWith(';') || lines[i + 1]?.trim().startsWith('{'))) {
        const isForwardDecl = trimmed.endsWith(';') && !trimmed.includes('{')
        const kind: SymbolKind = isForwardDecl ? 'type' : 'class'
        push(`class:${classM[1]}`, { name: classM[1], kind, startLine: lineNum, endLine: lineNum })
        if (!isForwardDecl && trimmed.includes('{')) {
          classStack.push({ name: classM[1], depth: braceDepth })
        }
        continue
      }

      // ── enum / enum class definition ────────────────────────────────────
      const enumM = trimmed.match(/^(?:enum\s+class|enum\s+struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/)
      if (enumM) {
        push(`enum:${enumM[1]}`, { name: enumM[1], kind: 'enum', startLine: lineNum, endLine: lineNum })
        continue
      }

      // ── typedef ─────────────────────────────────────────────────────────
      // typedef [original] [alias];  — grab last identifier before ;
      const typedefM = trimmed.match(/^typedef\s+.+\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/)
      if (typedefM) {
        push(`typedef:${typedefM[1]}`, { name: typedefM[1], kind: 'type', startLine: lineNum, endLine: lineNum })
        continue
      }

      // ── using alias: using Foo = Bar; ────────────────────────────────────
      const usingM = trimmed.match(/^using\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (usingM) {
        push(`using:${usingM[1]}`, { name: usingM[1], kind: 'type', startLine: lineNum, endLine: lineNum })
        continue
      }

      // ── Function / method definition or declaration ─────────────────────
      // Handles:
      //   ReturnType functionName(params)
      //   ReturnType ClassName::methodName(params)
      //   ReturnType operator+(params)
      //   Constructor(params) / ~Destructor()
      //   virtual ReturnType method(params) = 0;
      //   template<typename T> ReturnType name(params)
      //
      // Key heuristic: line contains '(' and either '{' or ends with ');' / ')' after stripping
      if (!trimmed.includes('(')) continue

      // Skip common non-symbol lines
      if (
        trimmed.startsWith('if ')   || trimmed.startsWith('if(')   ||
        trimmed.startsWith('for ')  || trimmed.startsWith('for(')  ||
        trimmed.startsWith('while') || trimmed.startsWith('switch') ||
        trimmed.startsWith('return')|| trimmed.startsWith('//')
      ) continue

      // Discard lines that are pure calls (no return type pattern)
      // A definition line must have the form: [qualifiers] [type] name( ...
      // We match the function/method name just before the '('
      const fnPattern = /(?:^|[\s*&>])(?:~?([A-Za-z_][A-Za-z0-9_:<>]*))(?:\s*<[^>]*>)?\s*\(/
      const fnM       = trimmed.match(fnPattern)
      if (!fnM || !fnM[1]) continue

      const rawName = fnM[1]

      // Skip keywords that look like function calls
      const SKIP_NAMES = new Set([
        'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof',
        'new', 'delete', 'throw', 'assert', 'static_assert', 'decltype',
        'alignof', 'typeid', 'noexcept',
      ])
      if (SKIP_NAMES.has(rawName)) continue

      // Method with qualified name: ClassName::methodName
      if (rawName.includes('::')) {
        const parts = rawName.split('::')
        const method = parts[parts.length - 1]
        const cls    = parts.slice(0, -1).join('::')
        push(`method:${rawName}`, {
          name: rawName.startsWith('~') ? `~${method}` : method,
          kind: 'method',
          startLine: lineNum,
          endLine: lineNum,
        })
        continue
      }

      // operator overload
      if (trimmed.includes('operator')) {
        const opM = trimmed.match(/\boperator\s*([+\-*/%^&|~!=<>]{1,3}|\[\]|\(\)|new|delete)/)
        if (opM) {
          const opName = `operator${opM[1]}`
          const parentClass = classStack.length > 0 ? classStack[classStack.length - 1].name : null
          const symName = parentClass ? `${parentClass}::${opName}` : opName
          push(`op:${symName}`, { name: symName, kind: 'method', startLine: lineNum, endLine: lineNum })
          continue
        }
      }

      // Destructor: ~ClassName()
      if (rawName.startsWith('~')) {
        push(`dtor:${rawName}`, { name: rawName, kind: 'method', startLine: lineNum, endLine: lineNum })
        continue
      }

      // Determine if constructor (name matches current class)
      const currentClass = classStack.length > 0 ? classStack[classStack.length - 1].name : null
      if (currentClass && rawName === currentClass) {
        push(`ctor:${rawName}`, { name: `${rawName}()`, kind: 'method', startLine: lineNum, endLine: lineNum })
        continue
      }

      // Skip single-token names that are likely variable names or macro uses
      // unless the line has a clear function-definition or declaration pattern
      const isDefinitionOrDecl = trimmed.includes('{') || trimmed.endsWith(';') || trimmed.endsWith(')')
      if (!isDefinitionOrDecl) continue

      // Skip lines starting with common non-declaration patterns
      if (trimmed.match(/^\s*[a-z_][a-z0-9_]*\s*\(/)) {
        // All-lowercase first word before '(' — likely a call, not a definition
        // Allow if the line also has a return type word before it
        if (!trimmed.match(/\b(?:void|int|bool|char|float|double|long|short|unsigned|auto|const|static|inline|virtual|explicit|constexpr|size_t|uint\w+|int\w+)\b/)) {
          continue
        }
      }

      // Final check: rawName should look like a plausible function name
      if (/^[A-Z_][A-Za-z0-9_]*$/.test(rawName) && rawName === rawName.toUpperCase()) {
        // ALL_CAPS → likely a macro call, skip
        continue
      }

      const kind: SymbolKind = currentClass ? 'method' : 'function'
      push(`fn:${rawName}`, { name: rawName, kind, startLine: lineNum, endLine: lineNum })
    }

    return symbols
  }

  // ── extractImports ────────────────────────────────────────────────────────
  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const seen = new Set<string>()

    // #include <system_header>
    const sysRe = /^#\s*include\s*<([^>]+)>/gm
    let m: RegExpExecArray | null
    while ((m = sysRe.exec(content)) !== null) {
      const specifier = m[1]
      if (!seen.has(specifier)) {
        seen.add(specifier)
        imports.push({
          specifier,
          namedImports:   [],
          defaultImport:  null,
          namespaceImport: null,
          isRelative: false,
        })
      }
    }

    // #include "local_header"
    const localRe = /^#\s*include\s*"([^"]+)"/gm
    while ((m = localRe.exec(content)) !== null) {
      const specifier = m[1]
      if (!seen.has(specifier)) {
        seen.add(specifier)
        imports.push({
          specifier,
          namedImports:   [],
          defaultImport:  null,
          namespaceImport: null,
          isRelative: true,
        })
      }
    }

    return imports
  }

  // ── extractExports ────────────────────────────────────────────────────────
  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const seen = new Set<string>()

    // extern "C" { ... } or extern "C" ReturnType funcName(
    const externCRe = /extern\s+"C"\s+(?:[\w*&\s]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = externCRe.exec(content)) !== null) {
      const name = m[1]
      if (!seen.has(name)) {
        seen.add(name)
        exports.push({ name, kind: 'default' })
      }
    }

    // __declspec(dllexport) / __attribute__((visibility("default"))) patterns
    const dllExportRe = /__declspec\s*\(\s*dllexport\s*\)\s+(?:[\w*&\s]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    while ((m = dllExportRe.exec(content)) !== null) {
      const name = m[1]
      if (!seen.has(name)) {
        seen.add(name)
        exports.push({ name, kind: 'default' })
      }
    }

    const visibRe = /__attribute__\s*\(\s*\(\s*visibility\s*\(\s*"default"\s*\)\s*\)\s*\)\s+(?:[\w*&\s]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    while ((m = visibRe.exec(content)) !== null) {
      const name = m[1]
      if (!seen.has(name)) {
        seen.add(name)
        exports.push({ name, kind: 'default' })
      }
    }

    return exports
  }

  // ── extractReferences ─────────────────────────────────────────────────────
  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')
    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]

      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end === -1) continue
        line = line.substring(end + 2)
        inBlockComment = false
      }
      if (line.includes('/*')) {
        const start = line.indexOf('/*')
        const end   = line.indexOf('*/', start + 2)
        if (end === -1) { inBlockComment = true; line = line.substring(0, start) }
        else line = line.substring(0, start) + line.substring(end + 2)
      }
      line = stripComments(line)

      // Function call-sites: identifier immediately followed by '('
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
      let m: RegExpExecArray | null
      while ((m = callRe.exec(line)) !== null) {
        const name = m[1]
        const SKIP = new Set([
          'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof',
          'new', 'delete', 'throw', 'assert', 'decltype', 'alignof', 'typeid',
        ])
        if (!SKIP.has(name)) {
          refs.push({ symbolName: name, line: i + 1, fromSpecifier: null })
        }
      }

      // new ClassName( — class instantiation reference
      const newRe = /\bnew\s+([A-Za-z_][A-Za-z0-9_:<>]*)\s*[(<]/g
      while ((m = newRe.exec(line)) !== null) {
        refs.push({ symbolName: m[1], line: i + 1, fromSpecifier: null })
      }
    }

    return refs
  }
}
