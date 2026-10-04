// lib/repoScanner/languageAdapters/MarkdownAdapter.ts
//
// LanguageAdapter for Markdown and MDX files.
//
// Extracts:
//   - ATX headings (#, ##, ###) → 'variable' (heading text as name)
//   - MDX: named exports (export const/function) → 'function'/'variable'
//   - MDX: import statements → Import records
//   - Code block fences with language tag noted (for context ranking)

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class MarkdownAdapter implements LanguageAdapter {
  readonly name = 'Markdown'
  readonly extensions = ['md', 'mdx', 'markdown'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      // ATX heading: # Title, ## Section, ### Sub
      const heading = line.match(/^(#{1,6})\s+(.+)/)
      if (heading) {
        const depth = heading[1].length
        const name  = heading[2].trim().replace(/\s+#*\s*$/, '') // strip trailing hashes
        const kind  = depth === 1 ? 'class' : depth === 2 ? 'function' : 'variable'
        symbols.push({ name, kind, startLine: lineNum, endLine: lineNum })
        continue
      }

      // MDX: export const/function/class
      const mdxExport = line.match(/^export\s+(?:default\s+)?(?:const|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (mdxExport) {
        symbols.push({ name: mdxExport[1], kind: 'function', startLine: lineNum, endLine: lineNum })
      }
    }

    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    // MDX supports ES6 imports
    const re = /^import\s+(?:(\w+)|(?:\{([^}]+)\})|(?:\*\s+as\s+(\w+)))\s+from\s+['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const named = m[2] ? m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()) : []
      imports.push({
        specifier:       m[4],
        namedImports:    named,
        defaultImport:   m[1] ?? null,
        namespaceImport: m[3] ?? null,
        isRelative:      m[4].startsWith('.'),
      })
    }
    return imports
  }

  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const re = /^export\s+(?:default\s+)?(?:const|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      exports.push({ name: m[1], kind: 'function' })
    }
    return exports
  }

  extractReferences(): Reference[] { return [] }
}
