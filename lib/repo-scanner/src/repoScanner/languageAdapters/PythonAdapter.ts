// lib/repoScanner/languageAdapters/PythonAdapter.ts
//
// LanguageAdapter for Python (.py, .pyi stub files).
//
// ── Architecture ────────────────────────────────────────────────────────────
//
// Two-tier parsing strategy:
//
//  Tier 1 – Tree-sitter AST (PythonAstParser)
//    Uses web-tree-sitter + the Python WASM grammar for accurate, nested,
//    decoration-aware symbol extraction.  Matches the depth of the ts-morph
//    TypeScript adapter.  Activated automatically when the WASM grammar file
//    is available at one of the standard search paths.
//
//  Tier 2 – Regex fallback (PythonRegexParser)
//    The original line-by-line extraction, improved with nesting/decorator
//    support.  Runs when web-tree-sitter is not installed or the WASM grammar
//    cannot be loaded (e.g. browser contexts that haven't bundled it yet).
//
// The public `PythonAdapter` class tries Tier 1 and silently degrades to
// Tier 2, so existing callers see no API changes.
//
// ── Tree-sitter grammar file ────────────────────────────────────────────────
//
// Install via:
//   npm install --save web-tree-sitter
//   # Then place tree-sitter-python.wasm in one of the paths below:
//
// The WASM file is searched (in order):
//   1. process.env.TREE_SITTER_PYTHON_WASM  (explicit override)
//   2. <repo-scanner-package>/tree-sitter-python.wasm
//   3. <repo-scanner-package>/node_modules/tree-sitter-python/tree-sitter-python.wasm
//   4. <cwd>/node_modules/tree-sitter-python/tree-sitter-python.wasm
//
// ── Extracted metadata ──────────────────────────────────────────────────────
//
//  Symbols  : class · function · method · async function/method · variable ·
//             type-alias · decorator names
//  Relations: parent symbol (nested class / nested function)
//             inheritance (baseClasses[] on class symbols)
//             decorators attached to each symbol
//  Imports  : `import foo`, `from foo import bar`, star-imports, aliases,
//             relative imports (.., ..package)
//  Exports  : __all__ list → named exports; public top-level symbols fallback
//  References: imported name usages in the file body (call sites + attribute
//             access)

import type {
  LanguageAdapter,
  Symbol,
  Import,
  Export,
  Reference,
  SymbolKind,
  ExportKind,
} from './types'

// ── Extended symbol type (superset of the required Symbol interface) ─────────

export interface PythonSymbol extends Symbol {
  /** Dotted parent path, e.g. "MyClass" for a method, "Outer.Inner" for nested */
  parent?:       string
  /** Decorator names (without @), e.g. ["staticmethod", "cache"] */
  decorators?:   string[]
  /** Base class names for class symbols */
  baseClasses?:  string[]
  /** True when declared with `async def` */
  isAsync?:      boolean
  /** Raw parameter list string, e.g. "(self, x: int, y: str = 'hi')" */
  signature?:    string
  /** Return-type annotation string, e.g. "list[str]" */
  returnType?:   string
  /** First string literal in the body (docstring) */
  docstring?:    string
  /** True for dunder methods like __init__, __repr__ */
  isDunder?:     boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 2 – Regex-based parser (fallback)
// ────────────────────────────────────────────────────────────────────────────

class PythonRegexParser {
  extractSymbols(content: string): PythonSymbol[] {
    const symbols: PythonSymbol[] = []
    const lines = content.split('\n')
    const scopeStack: Array<{ indent: number; name: string; kind: SymbolKind }> = []
    const pendingDecorators: string[] = []

    for (let i = 0; i < lines.length; i++) {
      const raw    = lines[i]!
      const line   = raw.trimStart()
      const indent = raw.length - line.length

      while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1]!.indent >= indent) {
        scopeStack.pop()
      }

      // Decorator
      const decMatch = line.match(/^@([A-Za-z_][A-Za-z0-9_.]*)/)
      if (decMatch) { pendingDecorators.push(decMatch[1]!); continue }

      const parent = scopeStack.length > 0
        ? scopeStack.map(s => s.name).join('.')
        : undefined

      // class Foo / class Foo(Base1, Base2)
      const cls = line.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(\s*\(([^)]*)\))?/)
      if (cls) {
        const bases = cls[3] ? cls[3].split(',').map(b => b.trim()).filter(Boolean) : []
        symbols.push({
          name: cls[1]!, kind: 'class',
          startLine: i + 1, endLine: i + 1,
          parent, decorators: pendingDecorators.splice(0), baseClasses: bases,
        })
        scopeStack.push({ indent, name: cls[1]!, kind: 'class' })
        continue
      }

      // async def / def
      const fn = line.match(/^(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?(?:\s*->\s*([^:]+))?/)
      if (fn) {
        const name    = fn[2]!
        const isAsync = Boolean(fn[1])
        const sig     = fn[3] ?? '()'
        const ret     = fn[4]?.trim()
        const inClass = scopeStack.some(s => s.kind === 'class')
        const kind: SymbolKind = inClass ? 'method' : 'function'
        symbols.push({
          name, kind, startLine: i + 1, endLine: i + 1,
          parent, decorators: pendingDecorators.splice(0),
          isAsync, signature: sig, returnType: ret,
          isDunder: name.startsWith('__') && name.endsWith('__'),
        })
        scopeStack.push({ indent, name, kind })
        continue
      }

      pendingDecorators.length = 0

      if (indent === 0) {
        const varMatch = line.match(/^([A-Z_][A-Z0-9_]{2,})\s*(?::\s*[^=]+)?\s*=/)
        if (varMatch) {
          symbols.push({ name: varMatch[1]!, kind: 'variable', startLine: i + 1, endLine: i + 1 })
          continue
        }
        const typeAlias = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*TypeAlias\s*=/)
        if (typeAlias) {
          symbols.push({ name: typeAlias[1]!, kind: 'type', startLine: i + 1, endLine: i + 1 })
        }
      }
    }
    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const lines = content.split('\n')
    const joined: string[] = []
    for (let i = 0; i < lines.length; i++) {
      let ln = lines[i]!
      while (ln.trimEnd().endsWith('\\') && i + 1 < lines.length) {
        ln = ln.trimEnd().slice(0, -1) + lines[++i]!
      }
      joined.push(ln)
    }

    let multiLine = ''
    for (const raw of joined) {
      const combined = (multiLine + ' ' + raw).trim()
      if (combined.includes('(') && !combined.includes(')')) { multiLine = combined; continue }
      multiLine = ''
      const stripped = combined.trim()

      const fromImport = stripped.match(/^from\s+(\.{0,3}[\w.]*)\s+import\s+(.+)/)
      if (fromImport) {
        const specifier    = fromImport[1]!
        const clause       = fromImport[2]!.replace(/[()]/g, '').trim()
        const namedImports: string[] = []
        if (clause === '*') {
          imports.push({ specifier, namedImports: ['*'], defaultImport: null, namespaceImport: null, isRelative: specifier.startsWith('.') })
        } else {
          for (const n of clause.split(',')) {
            const parts = n.trim().split(/\s+as\s+/)
            const name  = (parts[parts.length - 1] ?? '').trim()
            if (name) namedImports.push(name)
          }
          imports.push({ specifier, namedImports, defaultImport: null, namespaceImport: null, isRelative: specifier.startsWith('.') })
        }
        continue
      }

      const plainImport = stripped.match(/^import\s+([\w.,\s]+)/)
      if (plainImport) {
        for (const part of plainImport[1]!.split(',')) {
          const tokens    = part.trim().split(/\s+as\s+/)
          const specifier = tokens[0]!.trim()
          const alias     = tokens[1]?.trim() ?? null
          imports.push({ specifier, namedImports: [], defaultImport: null, namespaceImport: alias, isRelative: false })
        }
      }
    }
    return imports
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tier 1 – Tree-sitter AST parser
// ────────────────────────────────────────────────────────────────────────────

let _cachedTsParser: unknown = undefined  // undefined = not yet attempted, null = failed

type TSNode = {
  type: string
  startPosition: { row: number; column: number }
  endPosition:   { row: number; column: number }
  children:      TSNode[]
  namedChildren: TSNode[]
  text:          string
  parent:        TSNode | null
  childForFieldName?(name: string): TSNode | null
}

type TSTree = { rootNode: TSNode }

interface TreeSitterParser {
  parse(source: string): TSTree
}

async function loadTreeSitter(): Promise<TreeSitterParser | null> {
  if (_cachedTsParser !== undefined) return _cachedTsParser as TreeSitterParser | null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Parser = require('web-tree-sitter') as {
      init(options?: unknown): Promise<void>
      new (): { setLanguage(lang: unknown): void; parse(s: string): TSTree }
      Language: { load(path: string): Promise<unknown> }
    }
    const wasmPath = findWasmPath()
    if (!wasmPath) { _cachedTsParser = null; return null }
    await Parser.init()
    const parser   = new Parser()
    const language = await Parser.Language.load(wasmPath)
    parser.setLanguage(language)
    _cachedTsParser = parser
    return parser as unknown as TreeSitterParser
  } catch {
    _cachedTsParser = null
    return null
  }
}

function findWasmPath(): string | null {
  try {
    const path = require('path') as typeof import('path')
    const fs   = require('fs')   as typeof import('fs')
    const candidates = [
      process.env['TREE_SITTER_PYTHON_WASM'] ?? '',
      path.join(__dirname, '..', '..', '..', 'tree-sitter-python.wasm'),
      path.join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'),
      path.join(process.cwd(), 'node_modules', 'tree-sitter-python', 'tree-sitter-python.wasm'),
    ].filter(Boolean)
    for (const p of candidates) { if (fs.existsSync(p)) return p }
  } catch { /* not a Node env */ }
  return null
}

// ── AST traversal helpers ──────────────────────────────────────────────────

function nodeText(n: TSNode): string { return n.text ?? '' }

function firstChildOfType(n: TSNode, ...types: string[]): TSNode | null {
  return n.children.find(c => types.includes(c.type)) ?? null
}

function namedChildrenOfType(n: TSNode, ...types: string[]): TSNode[] {
  return n.namedChildren.filter(c => types.includes(c.type))
}

function extractDocstring(bodyNode: TSNode | null): string | undefined {
  if (!bodyNode) return undefined
  const first = bodyNode.namedChildren[0]
  if (!first) return undefined
  if (first.type === 'expression_statement') {
    const inner = first.namedChildren[0]
    if (inner && (inner.type === 'string' || inner.type === 'concatenated_string')) {
      return nodeText(inner).replace(/^("""|\'\'\"|"|')([\s\S]*?)(\1)$/, '$2').trim()
    }
  }
  return undefined
}

function extractDecorators(node: TSNode): string[] {
  const parent = node.parent
  if (!parent) return []
  const decorators: string[] = []
  const siblings = parent.children
  let idx = siblings.indexOf(node)
  while (idx > 0) {
    idx--
    const sib = siblings[idx]!
    if (sib.type === 'decorator') {
      decorators.unshift(nodeText(sib).replace(/^@/, '').split('(')[0]!.trim())
    } else if (['\n', 'comment', 'newline'].includes(sib.type)) {
      continue
    } else break
  }
  return decorators
}

function parentPath(stack: Array<{ name: string }>): string | undefined {
  return stack.length > 0 ? stack.map(s => s.name).join('.') : undefined
}

function extractReturnType(fnNode: TSNode): string | undefined {
  const ret = fnNode.childForFieldName?.('return_type')
  if (ret) return nodeText(ret).replace(/^->\s*/, '').trim()
  let hitArrow = false
  for (const c of fnNode.children) {
    if (nodeText(c) === '->') { hitArrow = true; continue }
    if (hitArrow && c.type !== ':') return nodeText(c).trim()
  }
  return undefined
}

function extractBaseClasses(argListNode: TSNode | null): string[] {
  if (!argListNode) return []
  return argListNode.namedChildren
    .filter(n => n.type === 'identifier' || n.type === 'attribute')
    .map(n => nodeText(n).trim())
    .filter(Boolean)
}

// ── Core AST walker ─────────────────────────────────────────────────────────

interface ScopeEntry { name: string; kind: SymbolKind }

class PythonAstParser {
  parseSymbols(root: TSNode): PythonSymbol[] {
    const out: PythonSymbol[] = []
    this._walkBody(root, [], out)
    return out
  }

  private _walkBody(node: TSNode, stack: ScopeEntry[], out: PythonSymbol[]): void {
    for (const child of node.children) this._visitNode(child, stack, out)
  }

  private _visitNode(node: TSNode, stack: ScopeEntry[], out: PythonSymbol[]): void {
    switch (node.type) {
      case 'class_definition':
        this._handleClass(node, stack, out)
        break
      case 'function_definition':
        this._handleFunction(node, stack, out)
        break
      case 'decorated_definition': {
        // decorated_definition wraps a class_definition or function_definition
        const inner = node.namedChildren[node.namedChildren.length - 1]
        if (inner) this._visitNode(inner, stack, out)
        break
      }
      case 'expression_statement':
        this._handleExpression(node, stack, out)
        break
      case 'if_statement':
      case 'for_statement':
      case 'while_statement':
      case 'with_statement':
      case 'try_statement':
      case 'match_statement':
        for (const child of node.namedChildren) {
          if (child.type === 'block') this._walkBody(child, stack, out)
        }
        break
    }
  }

  private _handleClass(node: TSNode, stack: ScopeEntry[], out: PythonSymbol[]): void {
    const nameNode = node.childForFieldName?.('name') ?? firstChildOfType(node, 'identifier')
    if (!nameNode) return
    const name       = nodeText(nameNode)
    const argList    = node.childForFieldName?.('superclasses') ?? firstChildOfType(node, 'argument_list')
    const baseClasses = extractBaseClasses(argList)
    const decorators  = extractDecorators(node)
    const bodyNode    = node.childForFieldName?.('body') ?? firstChildOfType(node, 'block')
    const docstring   = extractDocstring(bodyNode)

    out.push({
      name, kind: 'class',
      startLine: node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
      parent: parentPath(stack), decorators, baseClasses, docstring,
    })

    if (bodyNode) this._walkBody(bodyNode, [...stack, { name, kind: 'class' }], out)
  }

  private _handleFunction(node: TSNode, stack: ScopeEntry[], out: PythonSymbol[]): void {
    const nameNode = node.childForFieldName?.('name') ?? firstChildOfType(node, 'identifier')
    if (!nameNode) return
    const name    = nodeText(nameNode)
    const isAsync = node.children.some(c => nodeText(c) === 'async')
    const inClass = stack.some(s => s.kind === 'class')
    const kind: SymbolKind = inClass ? 'method' : 'function'

    const paramsNode = node.childForFieldName?.('parameters') ?? firstChildOfType(node, 'parameters')
    const signature  = paramsNode ? nodeText(paramsNode) : '()'
    const returnType = extractReturnType(node)
    const decorators = extractDecorators(node)
    const bodyNode   = node.childForFieldName?.('body') ?? firstChildOfType(node, 'block')
    const docstring  = extractDocstring(bodyNode)

    out.push({
      name, kind,
      startLine: node.startPosition.row + 1,
      endLine:   node.endPosition.row + 1,
      parent: parentPath(stack), decorators, isAsync, signature, returnType, docstring,
      isDunder: name.startsWith('__') && name.endsWith('__'),
    })

    if (bodyNode) this._walkBody(bodyNode, [...stack, { name, kind }], out)
  }

  private _handleExpression(node: TSNode, stack: ScopeEntry[], out: PythonSymbol[]): void {
    if (stack.length > 0) return  // only module-level

    // annotated_assignment: foo: TypeAlias = ...
    for (const child of [node, ...node.namedChildren]) {
      if (child.type === 'annotated_assignment') {
        const lhs = child.childForFieldName?.('left') ?? child.namedChildren[0]
        const ann  = child.childForFieldName?.('annotation') ?? child.namedChildren[1]
        if (lhs && ann) {
          const name    = nodeText(lhs)
          const annText = nodeText(ann)
          if (annText.includes('TypeAlias')) {
            out.push({ name, kind: 'type', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
            return
          }
          if (/^[A-Z_][A-Z0-9_]{2,}$/.test(name)) {
            out.push({ name, kind: 'variable', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
          }
        }
        return
      }
    }

    // Plain assignment: CONSTANT = ...
    const assign = firstChildOfType(node, 'assignment')
    if (assign) {
      const lhs = assign.childForFieldName?.('left') ?? assign.namedChildren[0]
      if (lhs) {
        const name = nodeText(lhs)
        if (/^[A-Z_][A-Z0-9_]{2,}$/.test(name)) {
          out.push({ name, kind: 'variable', startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 })
        }
      }
    }
  }

  // ── Import extraction ────────────────────────────────────────────────────

  parseImports(root: TSNode): Import[] {
    const out: Import[] = []
    this._collectImports(root, out)
    return out
  }

  private _collectImports(node: TSNode, out: Import[]): void {
    for (const child of node.children) {
      if (child.type === 'import_statement')      { this._handleImportStmt(child, out); continue }
      if (child.type === 'import_from_statement') { this._handleFromImportStmt(child, out); continue }
      // Handle TYPE_CHECKING blocks
      if (child.type === 'if_statement') {
        for (const n of child.namedChildren) {
          if (n.type === 'block') this._collectImports(n, out)
        }
      }
    }
  }

  private _handleImportStmt(node: TSNode, out: Import[]): void {
    for (const child of node.namedChildren) {
      if (child.type === 'dotted_name') {
        out.push({ specifier: nodeText(child), namedImports: [], defaultImport: null, namespaceImport: null, isRelative: false })
      } else if (child.type === 'aliased_import') {
        const nameNode  = firstChildOfType(child, 'dotted_name')
        const specifier = nameNode ? nodeText(nameNode) : nodeText(child)
        const aliasNodes = namedChildrenOfType(child, 'identifier')
        const alias     = aliasNodes[1] ? nodeText(aliasNodes[1]) : null
        out.push({ specifier, namedImports: [], defaultImport: null, namespaceImport: alias, isRelative: false })
      }
    }
  }

  private _handleFromImportStmt(node: TSNode, out: Import[]): void {
    let specifier = ''
    let dots      = ''
    let afterImport = false
    const namedImports: string[] = []

    for (const child of node.children) {
      const txt = nodeText(child)
      if (txt === 'from') continue
      if (txt === 'import') { afterImport = true; continue }

      if (!afterImport) {
        if (child.type === 'relative_import' || child.type === 'import_prefix') { dots = txt }
        else if (child.type === 'dotted_name') { specifier = dots + txt }
        else if (txt.startsWith('.')) { dots = txt }
        continue
      }

      if (child.type === 'wildcard_import' || txt === '*') {
        out.push({ specifier: specifier || dots || '.', namedImports: ['*'], defaultImport: null, namespaceImport: null, isRelative: true })
        return
      }
      if (child.type === 'identifier') {
        namedImports.push(txt)
      } else if (child.type === 'aliased_import') {
        const ids = namedChildrenOfType(child, 'identifier')
        if (ids[1]) namedImports.push(nodeText(ids[1]))
        else if (ids[0]) namedImports.push(nodeText(ids[0]))
      }
    }

    if (!specifier) specifier = dots || '.'
    out.push({ specifier, namedImports, defaultImport: null, namespaceImport: null, isRelative: specifier.startsWith('.') })
  }

  // ── Reference extraction ─────────────────────────────────────────────────

  parseReferences(root: TSNode, importedFrom: Map<string, string>): Reference[] {
    const refs: Reference[] = []
    const seen = new Set<string>()
    this._collectRefs(root, importedFrom, refs, seen)
    return refs
  }

  private _collectRefs(
    node: TSNode, importedFrom: Map<string, string>,
    out: Reference[], seen: Set<string>,
  ): void {
    if (node.type === 'import_statement' || node.type === 'import_from_statement') return

    if (node.type === 'call') {
      const fn = node.childForFieldName?.('function') ?? node.namedChildren[0]
      if (fn) {
        const name =
          fn.type === 'identifier' ? nodeText(fn) :
          fn.type === 'attribute'  ? nodeText(fn.childForFieldName?.('object') ?? fn.namedChildren[0] ?? fn) :
          ''
        if (name && importedFrom.has(name)) {
          const line = fn.startPosition.row + 1
          const key  = `${name}:${line}`
          if (!seen.has(key)) {
            seen.add(key)
            out.push({ symbolName: name, line, fromSpecifier: importedFrom.get(name) ?? null })
          }
        }
      }
    }

    for (const child of node.children) this._collectRefs(child, importedFrom, out, seen)
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Chunking helper – split file at AST symbol boundaries
// ────────────────────────────────────────────────────────────────────────────

export interface SymbolChunk {
  /** Dotted qualified name of the symbol */
  qualifiedName: string
  kind:          SymbolKind
  startLine:     number
  endLine:       number
  /** Raw source lines for this chunk */
  content:       string
}

/**
 * Split `source` into chunks aligned to top-level AST symbols.
 * Each chunk covers one class or function (including its full body).
 * Inter-symbol lines (module-level code) become their own "<module>" chunks.
 */
export function chunkBySymbols(source: string, symbols: PythonSymbol[]): SymbolChunk[] {
  const lines  = source.split('\n')
  const chunks: SymbolChunk[] = []

  const topLevel = symbols
    .filter(s => !s.parent && (s.kind === 'class' || s.kind === 'function'))
    .sort((a, b) => a.startLine - b.startLine)

  let cursor = 1

  for (const sym of topLevel) {
    if (cursor < sym.startLine) {
      const gapLines = lines.slice(cursor - 1, sym.startLine - 1)
      if (gapLines.some(l => l.trim())) {
        chunks.push({ qualifiedName: '<module>', kind: 'variable', startLine: cursor, endLine: sym.startLine - 1, content: gapLines.join('\n') })
      }
    }
    chunks.push({
      qualifiedName: sym.name,
      kind:          sym.kind,
      startLine:     sym.startLine,
      endLine:       sym.endLine,
      content:       lines.slice(sym.startLine - 1, sym.endLine).join('\n'),
    })
    cursor = sym.endLine + 1
  }

  if (cursor <= lines.length) {
    const tail = lines.slice(cursor - 1)
    if (tail.some(l => l.trim())) {
      chunks.push({ qualifiedName: '<module>', kind: 'variable', startLine: cursor, endLine: lines.length, content: tail.join('\n') })
    }
  }
  return chunks
}

// ────────────────────────────────────────────────────────────────────────────
// Public PythonAdapter — implements LanguageAdapter
// ────────────────────────────────────────────────────────────────────────────

const _regexParser = new PythonRegexParser()
const _astParser   = new PythonAstParser()

export class PythonAdapter implements LanguageAdapter {
  readonly name       = 'Python'
  readonly extensions = ['py', 'pyi'] as const

  private _ts: TreeSitterParser | null = _cachedTsParser === undefined
    ? null
    : (_cachedTsParser as TreeSitterParser | null)
  private _initDone = false

  // ── Async init (call once at startup for AST parsing) ──────────────────
  /**
   * Attempt to load web-tree-sitter.  Call once at startup before any
   * extractSymbols() calls if you want AST-based parsing.
   *
   * @example
   *   const adapter = new PythonAdapter()
   *   await adapter.initAsync()
   */
  async initAsync(): Promise<void> {
    if (this._initDone) return
    this._initDone = true
    this._ts = await loadTreeSitter()
  }

  // ── Internal: resolve active parser ─────────────────────────────────────

  private get _parser(): TreeSitterParser | null {
    // Prefer instance-level result (set by initAsync), then module-level cache
    return this._ts ?? (_cachedTsParser !== undefined ? (_cachedTsParser as TreeSitterParser | null) : null)
  }

  // ── LanguageAdapter implementation ──────────────────────────────────────

  extractSymbols(content: string): PythonSymbol[] {
    const p = this._parser
    if (p) {
      try { return _astParser.parseSymbols(p.parse(content).rootNode as unknown as TSNode) }
      catch { /* fall through */ }
    }
    return _regexParser.extractSymbols(content)
  }

  extractImports(content: string): Import[] {
    const p = this._parser
    if (p) {
      try { return _astParser.parseImports(p.parse(content).rootNode as unknown as TSNode) }
      catch { /* fall through */ }
    }
    return _regexParser.extractImports(content)
  }

  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const seen = new Set<string>()

    // __all__ = ['Foo', 'bar']  (handles multiline with `s` flag)
    const allMatch = content.match(/__all__\s*=\s*\[([^\]]+)\]/s)
    if (allMatch) {
      for (const m of allMatch[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
        if (!seen.has(m[1]!)) { seen.add(m[1]!); exports.push({ name: m[1]!, kind: 'variable' }) }
      }
      return exports
    }

    for (const sym of this.extractSymbols(content)) {
      if (sym.parent || sym.name.startsWith('_') || seen.has(sym.name)) continue
      seen.add(sym.name)
      const kind: ExportKind =
        sym.kind === 'class'    ? 'class' :
        sym.kind === 'function' ? 'function' :
        sym.kind === 'type'     ? 'type' :
        'variable'
      exports.push({ name: sym.name, kind })
    }
    return exports
  }

  extractReferences(content: string): Reference[] {
    const importedFrom = new Map<string, string>()
    for (const imp of this.extractImports(content)) {
      for (const n of imp.namedImports) { if (n !== '*') importedFrom.set(n, imp.specifier) }
      if (imp.namespaceImport) importedFrom.set(imp.namespaceImport, imp.specifier)
    }

    const p = this._parser
    if (p) {
      try { return _astParser.parseReferences(p.parse(content).rootNode as unknown as TSNode, importedFrom) }
      catch { /* fall through */ }
    }

    // Regex fallback
    const refs: Reference[] = []
    const seen = new Set<string>()
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (/^\s*(?:from|import)\s/.test(line)) continue
      const useRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*[.(]/g
      let m: RegExpExecArray | null
      while ((m = useRe.exec(line)) !== null) {
        const name = m[1]!
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

  // ── Extended API (Python-specific) ──────────────────────────────────────

  /**
   * Returns symbol-aligned chunks for context building.
   * Prefer this over regex-based chunking for Python files.
   */
  chunkBySymbols(content: string): SymbolChunk[] {
    return chunkBySymbols(content, this.extractSymbols(content))
  }
}
