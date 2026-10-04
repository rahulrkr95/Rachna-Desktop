// lib/repoScanner/languageAdapters/GoAdapter.ts
//
// Tree-sitter powered Go LanguageAdapter.
//
// Architecture
// ────────────
//  ┌─────────────────────────────────────────────────────────┐
//  │ GoAdapter  (implements LanguageAdapter)                 │
//  │  • extractSymbols / extractImports / extractExports /   │
//  │    extractReferences  — synchronous, interface-compat   │
//  │  • analyzeFile()       — async, returns GoFileAnalysis  │
//  │  • GoRepoIndexer       — repo-wide index & graph APIs   │
//  └────────────┬────────────────────────────────────────────┘
//               │ Tree-sitter available?
//     yes ──────┤                         no ──────────────────►  GoRegexFallback
//               │
//               ▼
//  GoTreeSitter singleton (Parser + Go Language WASM)
//               │
//               ▼
//  GoAstWalker.walkGoTree()  →  WalkResult  {symbols, callEdges}
//               │
//               ▼
//  GoImportExtractor.extractImports()  →  GoImport[]
//
// Incremental / caching
// ─────────────────────
//  • AST cache keyed by (filePath, contentHash).
//  • On re-parse only changed files are walked.
//  • GoRepoIndexer accumulates all per-file results into a
//    repo-wide symbol map, import graph, and call graph.

import type { LanguageAdapter, Symbol, Import, Export, Reference, ExportKind } from './types'
import type {
  GoSymbol, GoImport, GoFileAnalysis, GoRepoIndex, CallEdge,
  ReceiverInfo, TypeParam, InterfaceMethod, EmbeddedInterface,
} from './GoTypes'

// ── Re-export extended types so consumers don't need a second import ──────
export type {
  GoSymbol, GoImport, GoFileAnalysis, GoRepoIndex, CallEdge,
  ReceiverInfo, TypeParam, InterfaceMethod, EmbeddedInterface,
} from './GoTypes'

// ── Regex fallback (used when WASM init fails) ────────────────────────────
import {
  extractSymbolsRegex,
  extractImportsRegex,
  extractExportsRegex,
  extractReferencesRegex,
} from './GoRegexFallback'

// ── Simple content hash (djb2) — no crypto dep needed ────────────────────
function hashContent(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return h >>> 0
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 1 — Tree-sitter singleton
// ═══════════════════════════════════════════════════════════════════════════

// Deferred require so the module loads fine in environments without WASM.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Parser: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let parserInstance: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let goLanguage: any = null
let tsInitPromise: Promise<boolean> | null = null
let tsAvailable = false

import * as nodePath from 'path'
import * as nodeFs   from 'fs'

function resolveWasmPath(filename: string): string {
  const bases = [
    __dirname,
    nodePath.join(__dirname, '..', '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
    nodePath.join(__dirname, '..', '..', '..', '..', '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
    nodePath.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out'),
  ]
  for (const base of bases) {
    const p = nodePath.join(base, filename)
    try { if (nodeFs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return nodePath.join(__dirname, filename)
}

function resolveWtsSelf(): string {
  const candidates = [
    nodePath.join(__dirname, '..', '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    nodePath.join(__dirname, '..', '..', '..', '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    nodePath.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  ]
  for (const p of candidates) {
    try { if (nodeFs.existsSync(p)) return p } catch { /* ignore */ }
  }
  return candidates[0]
}

async function initTreeSitter(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Parser = require('web-tree-sitter')
    const wtsSelf = resolveWtsSelf()
    await Parser.init({ locateFile: () => wtsSelf })
    parserInstance = new Parser()
    goLanguage = await Parser.Language.load(resolveWasmPath('tree-sitter-go.wasm'))
    parserInstance.setLanguage(goLanguage)
    tsAvailable = true
    return true
  } catch (err) {
    // Use console.error (not warn) so this is unmissable in the terminal
    // and easy to grep for when diagnosing low symbol counts or 5-chunk repos.
    console.error('[GoAdapter] Tree-sitter WASM init FAILED — falling back to regex. Symbols will be incomplete:', (err as Error).message)
    tsAvailable = false
    return false
  }
}

function ensureTreeSitter(): Promise<boolean> {
  if (!tsInitPromise) tsInitPromise = initTreeSitter()
  return tsInitPromise
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 2 — AST node helpers
// ═══════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstNode = any

function nodeText(n: AstNode): string { return n?.text ?? '' }
function row1(n: AstNode): number { return (n?.startPosition?.row ?? 0) + 1 }
function endRow1(n: AstNode): number { return (n?.endPosition?.row ?? 0) + 1 }

function childByType(n: AstNode, type: string): AstNode | null {
  return (n?.children as AstNode[] | undefined)?.find((c: AstNode) => c.type === type) ?? null
}
function childrenByType(n: AstNode, type: string): AstNode[] {
  return ((n?.children as AstNode[] | undefined) ?? []).filter((c: AstNode) => c.type === type)
}
function namedChildByType(n: AstNode, ...types: string[]): AstNode | null {
  return ((n?.namedChildren as AstNode[] | undefined) ?? []).find(
    (c: AstNode) => types.includes(c.type)
  ) ?? null
}
function namedChildrenByType(n: AstNode, ...types: string[]): AstNode[] {
  return ((n?.namedChildren as AstNode[] | undefined) ?? []).filter(
    (c: AstNode) => types.includes(c.type)
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 3 — GoDoc comment extraction
// ═══════════════════════════════════════════════════════════════════════════

function extractDoc(node: AstNode): string {
  const lines: string[] = []
  let prev: AstNode = node.previousNamedSibling
  while (prev && prev.type === 'comment') {
    lines.unshift(nodeText(prev).replace(/^\/\/\s?/, '').trim())
    prev = prev.previousNamedSibling
  }
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 4 — Receiver metadata
// ═══════════════════════════════════════════════════════════════════════════

function parseReceiver(paramListNode: AstNode | null): ReceiverInfo | null {
  if (!paramListNode) return null
  const param = namedChildByType(paramListNode, 'parameter_declaration')
  if (!param) return null

  const nameNode = childByType(param, 'identifier')
  const receiverName = nameNode ? nodeText(nameNode) : '_'

  const typeNode = (param.namedChildren as AstNode[]).find(
    (c: AstNode) => c.type !== 'identifier' && c.type !== ','
  )
  if (!typeNode) return null

  let isPointer = false
  let typeName = ''
  if (typeNode.type === 'pointer_type') {
    isPointer = true
    const inner = typeNode.namedChildren?.[0]
    typeName = inner ? nodeText(inner) : nodeText(typeNode).replace('*', '')
  } else {
    typeName = nodeText(typeNode)
  }
  // strip generic params: Server[T] → Server
  typeName = typeName.replace(/\[.*\]$/, '').trim()

  return { name: receiverName, typeName, isPointer }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 5 — Generic type parameters
// ═══════════════════════════════════════════════════════════════════════════

function parseTypeParams(node: AstNode): TypeParam[] {
  const tpl = childByType(node, 'type_parameter_list') ??
              namedChildByType(node, 'type_parameters', 'type_parameter_list')
  if (!tpl) return []

  const params: TypeParam[] = []
  for (const child of (tpl.namedChildren as AstNode[])) {
    if (child.type === 'type_parameter_declaration') {
      const names = childrenByType(child, 'identifier')
      const constraintNodes = (child.namedChildren as AstNode[]).filter(
        (c: AstNode) => c.type !== 'identifier' && c.type !== ','
      )
      const constraint = constraintNodes.map((c: AstNode) => nodeText(c)).join('') || 'any'
      for (const n of names) params.push({ name: nodeText(n), constraint })
    }
  }
  return params
}

function typeParamSig(tps: TypeParam[]): string {
  if (!tps.length) return ''
  return '[' + tps.map(p => `${p.name} ${p.constraint}`).join(', ') + ']'
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 6 — Interface body
// ═══════════════════════════════════════════════════════════════════════════

function parseInterfaceBody(body: AstNode): { methods: InterfaceMethod[]; embedded: EmbeddedInterface[] } {
  const methods: InterfaceMethod[] = []
  const embedded: EmbeddedInterface[] = []

  for (const child of (body?.namedChildren as AstNode[] | undefined) ?? []) {
    if (child.type === 'method_elem' || child.type === 'method_spec') {
      const nameNode = childByType(child, 'field_identifier') ?? childByType(child, 'identifier')
      if (!nameNode) continue
      methods.push({
        name: nodeText(nameNode),
        signature: nodeText(child).trim(),
        doc: extractDoc(child),
      })
    } else if (
      child.type === 'qualified_type'   ||
      child.type === 'type_identifier'  ||
      child.type === 'type_elem'        ||
      child.type === 'interface_type_name'
    ) {
      const raw = nodeText(child).trim()
      const parts = raw.split('.')
      embedded.push({ name: raw, pkg: parts.length > 1 ? parts[0] : null })
    }
  }
  return { methods, embedded }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 7 — Function / method signature builder
// ═══════════════════════════════════════════════════════════════════════════

function buildFuncSig(node: AstNode, receiver: ReceiverInfo | null, name: string, tps: TypeParam[]): string {
  let sig = 'func '
  if (receiver) {
    const ptr = receiver.isPointer ? '*' : ''
    sig += `(${receiver.name} ${ptr}${receiver.typeName}) `
  }
  sig += name + typeParamSig(tps)

  const params = childByType(node, 'parameter_list') ?? namedChildByType(node, 'parameters')
  const result = namedChildByType(node, 'result', 'return_type')

  if (params) sig += nodeText(params)
  if (result) sig += ' ' + nodeText(result)
  return sig.trim()
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 8 — Call-graph edge extraction
// ═══════════════════════════════════════════════════════════════════════════

function extractCallsInBody(body: AstNode, callerFqn: string, filePath: string): CallEdge[] {
  const edges: CallEdge[] = []
  function walk(n: AstNode): void {
    if (n.type === 'call_expression') {
      const fn = n.namedChildren?.[0]
      if (fn) edges.push({ caller: callerFqn, callee: nodeText(fn).trim(), file: filePath, line: row1(n) })
    }
    for (const child of (n.namedChildren as AstNode[] | undefined) ?? []) walk(child)
  }
  walk(body)
  return edges
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 9 — Import extraction from AST
// ═══════════════════════════════════════════════════════════════════════════

function extractGoImportsFromAst(root: AstNode, modulePrefix: string): GoImport[] {
  const imports: GoImport[] = []

  for (const node of (root.namedChildren as AstNode[])) {
    if (node.type !== 'import_declaration') continue

    const specs: AstNode[] = []
    const importSpec = namedChildByType(node, 'import_spec')
    if (importSpec) {
      specs.push(importSpec)
    } else {
      // import_spec_list
      const list = namedChildByType(node, 'import_spec_list')
      if (list) specs.push(...namedChildrenByType(list, 'import_spec'))
    }

    for (const spec of specs) {
      // path is always an interpreted_string_literal: "pkg"
      const pathNode = namedChildByType(spec, 'interpreted_string_literal')
      if (!pathNode) continue
      const rawPath = nodeText(pathNode)
      const specifier = rawPath.replace(/^"|"$/g, '').replace(/^'|'$/g, '')

      // alias is either a dot, blank identifier, or package_identifier
      const aliasNode = childByType(spec, 'package_identifier') ??
                        childByType(spec, 'identifier') ??
                        childByType(spec, '.')
      const alias = aliasNode ? nodeText(aliasNode) : null
      const localName = alias ?? specifier.split('/').pop() ?? specifier

      const firstSeg = specifier.split('/')[0]
      const isStdlib = !firstSeg.includes('.') && firstSeg !== '.'
      const isRelative = specifier.startsWith('.')
      const isInternal = !isStdlib && !isRelative &&
        modulePrefix !== '' && specifier.startsWith(modulePrefix)

      imports.push({ specifier, alias, localName, isStdlib, isRelative, isInternal })
    }
  }
  return imports
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 10 — Full AST walker
// ═══════════════════════════════════════════════════════════════════════════

interface WalkResult {
  packageName: string
  symbols: GoSymbol[]
  callEdges: CallEdge[]
  imports: GoImport[]
}

function walkAst(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: any,
  filePath: string,
  modulePrefix: string,
): WalkResult {
  const root = tree.rootNode
  let packageName = ''
  const symbols: GoSymbol[] = []
  const callEdges: CallEdge[] = []

  // ── Package name ─────────────────────────────────────────────────────
  const pkgClause = childByType(root, 'package_clause')
  if (pkgClause) {
    const pkgId = namedChildByType(pkgClause, 'package_identifier', 'identifier')
    if (pkgId) packageName = nodeText(pkgId)
  }

  // ── Imports ──────────────────────────────────────────────────────────
  const imports = extractGoImportsFromAst(root, modulePrefix)

  // ── Top-level declarations ────────────────────────────────────────────
  for (const node of (root.namedChildren as AstNode[])) {
    switch (node.type) {

      // ── Functions & methods ─────────────────────────────────────────
      case 'function_declaration':
      case 'method_declaration': {
        const isMethod = node.type === 'method_declaration'

        // Receiver list for methods
        const receiverListNode = isMethod
          ? childByType(node, 'parameter_list') ??
            namedChildByType(node, 'receiver', 'receiver_list')
          : null
        const receiver = parseReceiver(receiverListNode)

        // Function name
        const nameNode = childByType(node, 'identifier') ??
                         namedChildByType(node, 'field_identifier', 'identifier')
        if (!nameNode) continue
        const name = nodeText(nameNode)

        const tps = parseTypeParams(node)
        const sig = buildFuncSig(node, receiver, name, tps)
        const doc = extractDoc(node)

        let fqn = `${packageName}.`
        if (receiver) fqn += `(${receiver.typeName}).`
        fqn += name

        symbols.push({
          name,
          kind: isMethod ? 'method' : 'function',
          filePath,
          packageName,
          startLine: row1(node),
          endLine: endRow1(node),
          signature: sig,
          doc,
          receiver,
          typeParams: tps,
          interfaceMethods: [],
          embeddedInterfaces: [],
        })

        const body = namedChildByType(node, 'block')
        if (body) callEdges.push(...extractCallsInBody(body, fqn, filePath))
        break
      }

      // ── Type declarations ───────────────────────────────────────────
      case 'type_declaration': {
        // doc comment lives above the type_declaration, not the type_spec
        const declDoc = extractDoc(node)

        for (const spec of namedChildrenByType(node, 'type_spec')) {
          const nameNode = childByType(spec, 'type_identifier') ??
                           childByType(spec, 'identifier')
          if (!nameNode) continue
          const name = nodeText(nameNode)
          const tps = parseTypeParams(spec)

          // Body is everything except the name and type-param list
          const bodyNode = (spec.namedChildren as AstNode[]).find((c: AstNode) =>
            c !== nameNode &&
            c.type !== 'type_parameter_list' &&
            c.type !== 'type_parameters'
          ) ?? null

          let kind: GoSymbol['kind'] = 'type'
          let interfaceMethods: InterfaceMethod[] = []
          let embeddedInterfaces: EmbeddedInterface[] = []
          let sig = ''

          if (bodyNode?.type === 'struct_type') {
            kind = 'class'
            sig = `type ${name}${typeParamSig(tps)} struct { ... }`
          } else if (bodyNode?.type === 'interface_type') {
            kind = 'interface'
            const parsed = parseInterfaceBody(bodyNode)
            interfaceMethods  = parsed.methods
            embeddedInterfaces = parsed.embedded
            sig = `type ${name}${typeParamSig(tps)} interface { ... }`
          } else {
            kind = 'type'
            sig = `type ${name}${typeParamSig(tps)}` + (bodyNode ? ' ' + nodeText(bodyNode) : '')
          }

          // Prefer doc on spec itself (multiline group has it on declaration)
          const specDoc = extractDoc(spec)
          const doc = specDoc || declDoc

          symbols.push({
            name,
            kind,
            filePath,
            packageName,
            startLine: row1(spec),
            endLine: endRow1(spec),
            signature: sig,
            doc,
            receiver: null,
            typeParams: tps,
            interfaceMethods,
            embeddedInterfaces,
          })
        }
        break
      }

      // ── Variable declarations ───────────────────────────────────────
      case 'var_declaration': {
        const doc = extractDoc(node)
        for (const spec of namedChildrenByType(node, 'var_spec')) {
          for (const id of childrenByType(spec, 'identifier')) {
            const nm = nodeText(id)
            if (!nm || nm === '_') continue
            symbols.push({
              name: nm,
              kind: 'variable',
              filePath,
              packageName,
              startLine: row1(spec),
              endLine: endRow1(spec),
              signature: nodeText(spec).trim(),
              doc,
              receiver: null,
              typeParams: [],
              interfaceMethods: [],
              embeddedInterfaces: [],
            })
          }
        }
        break
      }

      // ── Constant declarations ───────────────────────────────────────
      case 'const_declaration': {
        const doc = extractDoc(node)
        for (const spec of namedChildrenByType(node, 'const_spec')) {
          for (const id of childrenByType(spec, 'identifier')) {
            const nm = nodeText(id)
            if (!nm || nm === '_') continue
            symbols.push({
              name: nm,
              kind: 'variable',   // 'variable' is the closest SymbolKind for constants
              filePath,
              packageName,
              startLine: row1(spec),
              endLine: endRow1(spec),
              signature: nodeText(spec).trim(),
              doc,
              receiver: null,
              typeParams: [],
              interfaceMethods: [],
              embeddedInterfaces: [],
            })
          }
        }
        break
      }

      default:
        break
    }
  }

  return { packageName, symbols, callEdges, imports }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 11 — AST cache for incremental parsing
// ═══════════════════════════════════════════════════════════════════════════

interface CacheEntry {
  contentHash: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tree: any
  result: WalkResult
}

const MAX_CACHE = 2000
const astCache = new Map<string, CacheEntry>()

function evictOldest(): void {
  const key = astCache.keys().next().value
  if (key !== undefined) astCache.delete(key)
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 12 — Per-file analysis (public async API)
// ═══════════════════════════════════════════════════════════════════════════

async function analyzeFile(
  content: string,
  filePath: string,
  modulePrefix = '',
): Promise<GoFileAnalysis> {
  const ok = await ensureTreeSitter()

  if (!ok) {
    // Regex fallback
    const symbols = extractSymbolsRegex(content)
    const imports = extractImportsRegex(content)
    return {
      filePath,
      packageName: '',
      symbols: symbols.map(s => ({
        ...s,
        filePath,
        packageName: '',
        signature: s.name,
        doc: '',
        receiver: null,
        typeParams: [],
        interfaceMethods: [],
        embeddedInterfaces: [],
      })),
      imports: imports.map(i => ({
        specifier: i.specifier,
        alias: i.namespaceImport,
        localName: i.namespaceImport ?? i.specifier.split('/').pop() ?? i.specifier,
        isStdlib: !i.specifier.includes('/'),
        isRelative: i.isRelative,
        isInternal: false,
      })),
      callEdges: [],
      usedAst: false,
      parseError: 'Tree-sitter unavailable',
    }
  }

  const hash = hashContent(content)
  const cached = astCache.get(filePath)
  if (cached && cached.contentHash === hash) {
    return {
      filePath,
      packageName: cached.result.packageName,
      symbols: cached.result.symbols,
      imports: cached.result.imports,
      callEdges: cached.result.callEdges,
      usedAst: true,
      parseError: null,
    }
  }

  try {
    const tree = cached
      ? parserInstance.parse(content, cached.tree)
      : parserInstance.parse(content)

    const result = walkAst(tree, filePath, modulePrefix)

    if (astCache.size >= MAX_CACHE) evictOldest()
    astCache.set(filePath, { contentHash: hash, tree, result })

    return {
      filePath,
      packageName: result.packageName,
      symbols: result.symbols,
      imports: result.imports,
      callEdges: result.callEdges,
      usedAst: true,
      parseError: null,
    }
  } catch (err) {
    console.warn(`[GoAdapter] Parse error in ${filePath}:`, (err as Error).message)
    // Fall back to regex for this file
    const symbols = extractSymbolsRegex(content)
    const imports = extractImportsRegex(content)
    return {
      filePath,
      packageName: '',
      symbols: symbols.map(s => ({
        ...s,
        filePath,
        packageName: '',
        signature: s.name,
        doc: '',
        receiver: null,
        typeParams: [],
        interfaceMethods: [],
        embeddedInterfaces: [],
      })),
      imports: imports.map(i => ({
        specifier: i.specifier,
        alias: i.namespaceImport,
        localName: i.namespaceImport ?? i.specifier.split('/').pop() ?? i.specifier,
        isStdlib: !i.specifier.includes('/'),
        isRelative: i.isRelative,
        isInternal: false,
      })),
      callEdges: [],
      usedAst: false,
      parseError: (err as Error).message,
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 13 — Repo-wide indexer
// ═══════════════════════════════════════════════════════════════════════════

export class GoRepoIndexer {
  private index: GoRepoIndex = {
    symbolsByFqn:    new Map(),
    symbolsByFile:   new Map(),
    methodToStruct:  new Map(),
    structToMethods: new Map(),
    interfaceImpls:  new Map(),
    importGraph:     new Map(),
    dependentGraph:  new Map(),
    callEdges:       [],
  }

  /**
   * Index a single file. Safe to call multiple times on the same path —
   * existing entries for that file are replaced.
   */
  async indexFile(content: string, filePath: string, modulePrefix = ''): Promise<void> {
    const analysis = await analyzeFile(content, filePath, modulePrefix)
    this.ingestFileAnalysis(analysis)
  }

  /** Remove a file from the index (e.g. on deletion). */
  removeFile(filePath: string): void {
    const existing = this.index.symbolsByFile.get(filePath) ?? []
    for (const sym of existing) {
      const fqn = this.fqn(sym)
      this.index.symbolsByFqn.delete(fqn)
    }
    this.index.symbolsByFile.delete(filePath)
    this.index.importGraph.delete(filePath)
    // Remove from dependent graph
    for (const [dep, dependents] of this.index.dependentGraph) {
      this.index.dependentGraph.set(dep, dependents.filter(d => d !== filePath))
    }
    // Remove call edges involving this file
    this.index.callEdges = this.index.callEdges.filter(e => e.file !== filePath)
  }

  /** Resolve all files a given file depends on (imports). */
  getDependencies(filePath: string): string[] {
    return this.index.importGraph.get(filePath) ?? []
  }

  /** Resolve all files that import the given file. */
  getDependents(filePath: string): string[] {
    return this.index.dependentGraph.get(filePath) ?? []
  }

  /** Find all functions/methods that call this symbol. */
  findCallers(symbolName: string): CallEdge[] {
    return this.index.callEdges.filter(e =>
      e.callee === symbolName ||
      e.callee.endsWith('.' + symbolName) ||
      e.callee.endsWith(').' + symbolName)
    )
  }

  /** Find all symbols called by this function/method. */
  findCallees(callerFqn: string): CallEdge[] {
    return this.index.callEdges.filter(e => e.caller === callerFqn)
  }

  /** Lookup a symbol by fully-qualified name. */
  getSymbol(fqn: string): GoSymbol | undefined {
    return this.index.symbolsByFqn.get(fqn)
  }

  /** All symbols in a file. */
  getFileSymbols(filePath: string): GoSymbol[] {
    return this.index.symbolsByFile.get(filePath) ?? []
  }

  /** All methods associated with a struct. */
  getStructMethods(structName: string): string[] {
    return this.index.structToMethods.get(structName) ?? []
  }

  /** The struct a method belongs to, if any. */
  getMethodStruct(methodFqn: string): string | undefined {
    return this.index.methodToStruct.get(methodFqn)
  }

  /** Read-only view of the full index (for serialisation / graph export). */
  getIndex(): Readonly<GoRepoIndex> { return this.index }

  // ── Private helpers ──────────────────────────────────────────────────────

  private fqn(sym: GoSymbol): string {
    let fqn = `${sym.packageName}.`
    if (sym.receiver) fqn += `(${sym.receiver.typeName}).`
    fqn += sym.name
    return fqn
  }

  private ingestFileAnalysis(analysis: GoFileAnalysis): void {
    // Clear old data for this file
    this.removeFile(analysis.filePath)

    const fileSym: GoSymbol[] = []

    for (const sym of analysis.symbols) {
      const fqn = this.fqn(sym)
      this.index.symbolsByFqn.set(fqn, sym)
      fileSym.push(sym)

      // Method ↔ struct linking
      if (sym.kind === 'method' && sym.receiver) {
        this.index.methodToStruct.set(fqn, sym.receiver.typeName)
        const existing = this.index.structToMethods.get(sym.receiver.typeName) ?? []
        if (!existing.includes(fqn)) existing.push(fqn)
        this.index.structToMethods.set(sym.receiver.typeName, existing)
      }

      // Interface → potential implementations (name-based heuristic)
      if (sym.kind === 'interface') {
        if (!this.index.interfaceImpls.has(sym.name)) {
          this.index.interfaceImpls.set(sym.name, [])
        }
      }
    }

    this.index.symbolsByFile.set(analysis.filePath, fileSym)

    // Build import graph entry
    const deps = analysis.imports.map(i => i.specifier)
    this.index.importGraph.set(analysis.filePath, deps)
    for (const dep of deps) {
      const dependents = this.index.dependentGraph.get(dep) ?? []
      if (!dependents.includes(analysis.filePath)) dependents.push(analysis.filePath)
      this.index.dependentGraph.set(dep, dependents)
    }

    // Merge call edges
    this.index.callEdges.push(...analysis.callEdges)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SECTION 14 — GoAdapter (implements LanguageAdapter)
// ═══════════════════════════════════════════════════════════════════════════

export class GoAdapter implements LanguageAdapter {
  readonly name = 'Go'
  readonly extensions = ['go'] as const

  // Shared repo indexer instance — consumers can access it directly for
  // richer cross-file queries (callers, callees, dependency graph, etc.)
  readonly repoIndexer = new GoRepoIndexer()

  /**
   * Synchronous symbol extraction.
   * Uses the AST cache when Tree-sitter has already parsed this content;
   * otherwise falls back to regex so the interface contract is never broken.
   *
   * For first-time files and guaranteed AST accuracy use `analyzeFile()`.
   */
  extractSymbols(content: string): Symbol[] {
    // Check AST cache first (populated by prior async analyzeFile calls)
    const hash = hashContent(content)
    for (const entry of astCache.values()) {
      if (entry.contentHash === hash) {
        return entry.result.symbols.map(s => ({
          name: s.name,
          kind: s.kind,
          startLine: s.startLine,
          endLine: s.endLine,
        }))
      }
    }
    // Synchronous regex fallback
    return extractSymbolsRegex(content)
  }

  extractImports(content: string): Import[] {
    return extractImportsRegex(content)
  }

  extractExports(content: string): Export[] {
    return extractExportsRegex(content)
  }

  extractReferences(content: string): Reference[] {
    return extractReferencesRegex(content)
  }

  // ── Extended async API ───────────────────────────────────────────────────

  /**
   * Full AST-based file analysis.
   * Returns rich GoFileAnalysis including GoDoc, receivers, generics,
   * interface methods, embedded interfaces, and call edges.
   */
  analyzeFile(content: string, filePath: string, modulePrefix = ''): Promise<GoFileAnalysis> {
    return analyzeFile(content, filePath, modulePrefix)
  }

  /**
   * Kick off Tree-sitter initialisation eagerly.
   * Call this once at application startup to avoid first-parse latency.
   */
  warmup(): Promise<boolean> {
    return ensureTreeSitter()
  }

  /** True after Tree-sitter WASM has loaded successfully. */
  get treeSitterAvailable(): boolean { return tsAvailable }

  /** Invalidate the AST cache entry for a specific file. */
  invalidateCache(filePath: string): void {
    astCache.delete(filePath)
  }

  /** Clear the entire AST cache. */
  clearCache(): void {
    astCache.clear()
  }
}
