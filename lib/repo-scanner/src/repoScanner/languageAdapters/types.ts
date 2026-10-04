// lib/repoScanner/languageAdapters/types.ts
//
// Core types shared by all LanguageAdapters.
// These are language-agnostic representations extracted from source code —
// they power symbol search, retrieval ranking, and future graph features
// (symbol graph, reference graph, rename/multi-file refactoring).

// ── Extracted symbol kinds ────────────────────────────────────────────────
// This set is a superset of the legacy SymbolRecord['type'] so adapters can
// produce all the kinds the downstream retrieval ranker already understands.

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'component'   // React / UI components
  | 'variable'
  | 'default'
  | 'style-rule'  // CSS selectors etc.
  | 'method'      // class method (for future symbol graph)
  | 'field'       // class field / property (for future symbol graph)
  | 'decorator'   // Java / C# / Python decorators (for future reference graph)
  | 'namespace'   // Go packages, C# namespaces, TypeScript namespaces

export type ExportKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'default'
  | 're-export'

// ── Extracted data structures ──────────────────────────────────────────────

/** One code symbol extracted from a source file. */
export interface Symbol {
  name:      string
  kind:      SymbolKind
  /** 1-based inclusive start line */
  startLine: number
  /** 1-based inclusive end line */
  endLine:   number
}

/** One import/require declaration extracted from a source file. */
export interface Import {
  /**
   * The raw module specifier as written in source.
   * e.g. "../utils/helpers", "react", "fmt"
   */
  specifier:       string
  /** Named symbols imported: ["useState", "useEffect"] */
  namedImports:    string[]
  /** Default import name, e.g. "React" */
  defaultImport:   string | null
  /** Namespace import name, e.g. "fs" for `import * as fs` */
  namespaceImport: string | null
  /** True when the specifier looks like a relative path */
  isRelative:      boolean
}

/** One export declaration extracted from a source file. */
export interface Export {
  name: string
  kind: ExportKind
}

/** One cross-file reference extracted from a source file. */
export interface Reference {
  /**
   * Name of the referenced symbol (function call, type use, etc.)
   * e.g. "useState", "AuthService", "fmt.Println"
   */
  symbolName: string
  /** 1-based line where this reference appears */
  line: number
  /**
   * The specifier of the module this symbol was imported from, if known.
   * null for unqualified calls to locally-defined symbols.
   */
  fromSpecifier: string | null
}

// ── The adapter contract ──────────────────────────────────────────────────

/**
 * A LanguageAdapter knows how to extract structured information from a single
 * source file for one programming language.
 *
 * The extracted data powers:
 *  - Symbol Search                 (symbols)
 *  - Retrieval Ranking             (symbols + exports + imports)
 *  - Future Symbol Graph           (symbols + references)
 *  - Future Reference Graph        (references)
 *  - Future Rename Refactoring     (references + exports)
 *  - Future Multi-File Refactoring (imports + exports + references)
 *
 * Adding support for a new language means implementing this interface and
 * registering the adapter in the AdapterRegistry — no core retrieval code
 * changes are needed.
 */
export interface LanguageAdapter {
  /** Human-readable name, e.g. "TypeScript", "Python" */
  readonly name: string

  /**
   * File extensions (without leading dot) this adapter handles.
   * e.g. ["ts", "tsx"] for TypeScript, ["py"] for Python
   */
  readonly extensions: readonly string[]

  /**
   * Extract all code symbols (functions, classes, interfaces, etc.)
   * that appear in `content`.
   *
   * `filePath` is optional context — some adapters (Vue, Svelte, JSON)
   * use the filename to derive the component name or apply file-specific
   * extraction rules.  Adapters that don't need it may ignore it.
   */
  extractSymbols(content: string, filePath?: string): Symbol[]

  /**
   * Extract all import / require / use declarations from `content`.
   */
  extractImports(content: string, filePath?: string): Import[]

  /**
   * Extract all top-level exports from `content`.
   */
  extractExports(content: string, filePath?: string): Export[]

  /**
   * Extract all cross-file symbol references from `content`.
   * These are usages of imported names within the file body.
   *
   * This is used for future reference-graph and rename-refactoring features.
   * Adapters may return an empty array if reference extraction is not yet
   * implemented for the language.
   */
  extractReferences(content: string, filePath?: string): Reference[]
}
