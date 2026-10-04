// lib/repoScanner/languageAdapters/GoTypes.ts
//
// Extended types for the Tree-sitter Go adapter.
// These augment the base LanguageAdapter types with Go-specific metadata
// and power richer features: method↔struct linking, interface analysis,
// call graphs, dependency maps, and generics support.

import type { Symbol, SymbolKind } from './types'

// ── Receiver metadata ─────────────────────────────────────────────────────

export interface ReceiverInfo {
  /** Receiver variable name, e.g. "s" in (s *Server) */
  name: string
  /** Receiver type (without pointer sigil), e.g. "Server" */
  typeName: string
  /** True when the receiver is a pointer (*T) */
  isPointer: boolean
}

// ── Generic type parameters ───────────────────────────────────────────────

export interface TypeParam {
  /** Parameter name, e.g. "T" */
  name: string
  /** Constraint expression, e.g. "any", "comparable", "io.Reader" */
  constraint: string
}

// ── Interface method entry ────────────────────────────────────────────────

export interface InterfaceMethod {
  /** Method name */
  name: string
  /** Full signature string, e.g. "Read(p []byte) (int, error)" */
  signature: string
  /** GoDoc comment attached to this method, if any */
  doc: string
}

// ── Embedded interface reference ──────────────────────────────────────────

export interface EmbeddedInterface {
  /** Short or qualified name, e.g. "io.Reader" */
  name: string
  /** Package qualifier if present, e.g. "io" */
  pkg: string | null
}

// ── Go symbol (extends base Symbol) ──────────────────────────────────────

export interface GoSymbol extends Symbol {
  /** File path this symbol was extracted from */
  filePath: string
  /** Full Go package name from the `package` declaration */
  packageName: string
  /** Full signature string as it would appear in GoDoc */
  signature: string
  /** GoDoc comment block immediately preceding this declaration */
  doc: string

  // Method-specific
  receiver: ReceiverInfo | null

  // Generics (Go 1.18+)
  typeParams: TypeParam[]

  // Interface-specific
  interfaceMethods: InterfaceMethod[]
  embeddedInterfaces: EmbeddedInterface[]
}

// ── Import graph entry ────────────────────────────────────────────────────

export interface GoImport {
  /** Raw specifier as written, e.g. "fmt", "github.com/user/repo/pkg" */
  specifier: string
  /** Local alias (if any), e.g. "myfmt" for `import myfmt "fmt"` */
  alias: string | null
  /** Effective local name used in code */
  localName: string
  /** True for standard-library packages (no dot in first path segment) */
  isStdlib: boolean
  /** True for module-internal packages (starts with module path prefix) */
  isInternal: boolean
  /** True for paths starting with "." */
  isRelative: boolean
}

// ── Call graph edge ───────────────────────────────────────────────────────

export interface CallEdge {
  /** Caller function/method fully-qualified name: "pkg.Func" or "pkg.(T).Method" */
  caller: string
  /** Callee name as it appears at the call site */
  callee: string
  /** File where the call appears */
  file: string
  /** 1-based line of the call */
  line: number
}

// ── Parsed file result ────────────────────────────────────────────────────

export interface GoFileAnalysis {
  filePath: string
  packageName: string
  symbols: GoSymbol[]
  imports: GoImport[]
  callEdges: CallEdge[]
  /** True when Tree-sitter parsed successfully; false = regex fallback used */
  usedAst: boolean
  parseError: string | null
}

// ── Repository-wide index ─────────────────────────────────────────────────

export interface GoRepoIndex {
  /** All symbols across all files, keyed by fully-qualified name */
  symbolsByFqn:   Map<string, GoSymbol>
  /** All symbols per file */
  symbolsByFile:  Map<string, GoSymbol[]>
  /** Method → struct associations */
  methodToStruct: Map<string, string>
  /** Struct → method names */
  structToMethods:Map<string, string[]>
  /** Interface → implementing types (best-effort static analysis) */
  interfaceImpls: Map<string, string[]>
  /** Import graph: file → files it imports */
  importGraph:    Map<string, string[]>
  /** Reverse import graph: file → files that import it */
  dependentGraph: Map<string, string[]>
  /** Call edges across the whole repo */
  callEdges:      CallEdge[]
}

// ── Recognised symbol kinds in Go ─────────────────────────────────────────

export type GoSymbolKind = Extract<
  SymbolKind,
  | 'function'
  | 'method'
  | 'class'       // struct
  | 'interface'
  | 'type'        // type alias / defined type
  | 'variable'
  | 'namespace'   // package declaration
>
