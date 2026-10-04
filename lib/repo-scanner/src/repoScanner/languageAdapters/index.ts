// lib/repoScanner/languageAdapters/index.ts
//
// Public API for the language adapter subsystem.

export type {
  LanguageAdapter,
  Symbol,
  Import,
  Export,
  Reference,
  SymbolKind,
  ExportKind,
} from './types'

export { AdapterRegistry, defaultRegistry } from './AdapterRegistry'

// ── Language adapters ─────────────────────────────────────────────────────
export { TypeScriptAdapter, JavaScriptAdapter } from './TypeScriptAdapter'
export { HtmlAdapter }         from './HtmlAdapter'
export { CssAdapter }          from './CssAdapter'
export { PythonAdapter }       from './PythonAdapter'
export { JavaAdapter }         from './JavaAdapter'
export { CSharpAdapter }       from './CSharpAdapter'
export { GoAdapter }           from './GoAdapter'
export { RustAdapter }         from './RustAdapter'
export { PhpAdapter }          from './PhpAdapter'
export { RubyAdapter }         from './RubyAdapter'
export { KotlinAdapter }       from './KotlinAdapter'
export { SwiftAdapter }        from './SwiftAdapter'
export { DartAdapter }         from './DartAdapter'
export { LuaAdapter }          from './LuaAdapter'
export { ShellAdapter }        from './ShellAdapter'

// ── New adapters ──────────────────────────────────────────────────────────
export { JsonAdapter }         from './JsonAdapter'
export { YamlAdapter }         from './YamlAdapter'
export { TomlAdapter }         from './TomlAdapter'
export { MarkdownAdapter }     from './MarkdownAdapter'
export { GraphQLAdapter }      from './GraphQLAdapter'
export { SqlAdapter }          from './SqlAdapter'
export { VueAdapter }          from './VueAdapter'
export { SvelteAdapter }       from './SvelteAdapter'
export { PrismaAdapter }       from './PrismaAdapter'
export { GenericTextAdapter, XmlAdapter } from './GenericTextAdapter'
export { CppAdapter }          from './CppAdapter'
export { DockerfileAdapter }   from './DockerfileAdapter'
export { ElixirAdapter }       from './ElixirAdapter'
export { ScalaAdapter }        from './ScalaAdapter'
export { HaskellAdapter }      from './HaskellAdapter'
export { ObjectiveCAdapter }   from './ObjectiveCAdapter'
