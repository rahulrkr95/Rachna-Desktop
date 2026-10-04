// lib/repoScanner/languageAdapters/AdapterRegistry.ts
//
// Central registry that maps file extensions to LanguageAdapters.

import type { LanguageAdapter } from './types'
import { TypeScriptAdapter }   from './TypeScriptAdapter'
import { HtmlAdapter }         from './HtmlAdapter'
import { CssAdapter }          from './CssAdapter'
import { PythonAdapter }       from './PythonAdapter'
import { JavaAdapter }         from './JavaAdapter'
import { CSharpAdapter }       from './CSharpAdapter'
import { GoAdapter }           from './GoAdapter'
import { RustAdapter }         from './RustAdapter'
import { PhpAdapter }          from './PhpAdapter'
import { RubyAdapter }         from './RubyAdapter'
import { KotlinAdapter }       from './KotlinAdapter'
import { SwiftAdapter }        from './SwiftAdapter'
import { DartAdapter }         from './DartAdapter'
import { LuaAdapter }          from './LuaAdapter'
import { ShellAdapter }        from './ShellAdapter'
import { JsonAdapter }         from './JsonAdapter'
import { YamlAdapter }         from './YamlAdapter'
import { TomlAdapter }         from './TomlAdapter'
import { MarkdownAdapter }     from './MarkdownAdapter'
import { GraphQLAdapter }      from './GraphQLAdapter'
import { SqlAdapter }          from './SqlAdapter'
import { VueAdapter }          from './VueAdapter'
import { SvelteAdapter }       from './SvelteAdapter'
import { PrismaAdapter }       from './PrismaAdapter'
import { GenericTextAdapter, XmlAdapter } from './GenericTextAdapter'
import { CppAdapter }          from './CppAdapter'
import { DockerfileAdapter }   from './DockerfileAdapter'
import { ElixirAdapter }       from './ElixirAdapter'
import { ScalaAdapter }        from './ScalaAdapter'
import { HaskellAdapter }      from './HaskellAdapter'
import { ObjectiveCAdapter }   from './ObjectiveCAdapter'

class NullAdapter implements LanguageAdapter {
  readonly name = 'Unknown'
  readonly extensions = [] as const
  extractSymbols()    { return [] }
  extractImports()    { return [] }
  extractExports()    { return [] }
  extractReferences() { return [] }
}

const NULL_ADAPTER = new NullAdapter()

export class AdapterRegistry {
  private readonly byExtension = new Map<string, LanguageAdapter>()

  register(adapter: LanguageAdapter): this {
    for (const ext of adapter.extensions) {
      this.byExtension.set(ext.toLowerCase(), adapter)
    }
    return this
  }

  get(extension: string): LanguageAdapter {
    return this.byExtension.get(extension.toLowerCase()) ?? NULL_ADAPTER
  }

  getForPath(filePath: string): LanguageAdapter {
    const ext = filePath.split('.').pop() ?? ''
    return this.get(ext)
  }

  supports(extension: string): boolean {
    return this.byExtension.has(extension.toLowerCase())
  }

  allAdapters(): LanguageAdapter[] {
    return [...new Set(this.byExtension.values())]
  }

  /** All extensions covered by registered adapters */
  allExtensions(): Set<string> {
    return new Set(this.byExtension.keys())
  }
}

export const defaultRegistry = new AdapterRegistry()
  // ── TypeScript / JavaScript (ts-morph handles .ts/.tsx/.js/.jsx;
  //    adapter covers .mts/.mjs/.cts/.cjs and acts as fallback)
  .register(new TypeScriptAdapter())
  // ── Markup / Styles
  .register(new HtmlAdapter())
  .register(new CssAdapter())
  // ── Frontend frameworks
  .register(new VueAdapter())
  .register(new SvelteAdapter())
  // ── Backend languages
  .register(new PythonAdapter())
  .register(new JavaAdapter())
  .register(new CSharpAdapter())
  .register(new GoAdapter())
  .register(new RustAdapter())
  .register(new PhpAdapter())
  .register(new RubyAdapter())
  .register(new KotlinAdapter())
  .register(new SwiftAdapter())
  .register(new DartAdapter())
  // ── C / C++
  .register(new CppAdapter())
  // ── Elixir (Phoenix)
  .register(new ElixirAdapter())
  // ── Scala (JVM + Spark)
  .register(new ScalaAdapter())
  // ── Haskell (fintech / academic)
  .register(new HaskellAdapter())
  // ── Objective-C (iOS legacy)
  .register(new ObjectiveCAdapter())
  // ── Infrastructure / Containers
  .register(new DockerfileAdapter())
  // ── Config / Data formats
  .register(new JsonAdapter())
  .register(new YamlAdapter())
  .register(new TomlAdapter())
  .register(new MarkdownAdapter())
  .register(new GraphQLAdapter())
  .register(new SqlAdapter())
  .register(new PrismaAdapter())
  .register(new XmlAdapter())
  .register(new GenericTextAdapter())
  // ── Scripting
  .register(new LuaAdapter())
  .register(new ShellAdapter())
