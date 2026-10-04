// lib/repoScanner/languageAdapters/CssAdapter.ts
//
// LanguageAdapter for CSS, SCSS, Less, and PostCSS files.
//
// Extracted as symbols (visible to AI semantic search):
//   - Class selectors  .btn, .card-title  → kind: 'style-rule'
//   - Id selectors     #main-nav           → kind: 'variable'
//   - Custom props     --color-primary     → kind: 'variable'
//   - @keyframes names → kind: 'function'
//   - @mixin names     (SCSS/Less)         → kind: 'function'
//   - @function names  (SCSS)              → kind: 'function'
//   - @layer names                         → kind: 'namespace'
//
// Extracted as imports:
//   - @import "..."  /  @import url(...)
//   - @use "..."     (SCSS modules)
//   - @forward "..." (SCSS modules)
//
// References are left empty — CSS selectors don't cross-reference each
// other in a way that is useful for the current retrieval graph.

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class CssAdapter implements LanguageAdapter {
  readonly name = 'CSS'
  readonly extensions = ['css', 'scss', 'less', 'pcss', 'postcss'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')
    const seen = new Set<string>()

    // Multi-line comment stripping state
    let inBlockComment = false

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1
      let line = lines[i]

      // ── Block comment tracking ─────────────────────────────────────────
      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end === -1) continue
        line = line.substring(end + 2)
        inBlockComment = false
      }
      // Remove inline block comments
      line = line.replace(/\/\*.*?\*\//g, '')
      if (line.includes('/*')) {
        line = line.substring(0, line.indexOf('/*'))
        inBlockComment = true
      }
      // Strip line comments
      line = line.replace(/\/\/.*$/, '').trim()
      if (!line || line.startsWith('*')) continue

      let m: RegExpExecArray | null

      // ── Class selectors: .foo, .bar-baz, .foo:hover, .foo::before ──────
      // Also handle compound selectors like .btn.active, .card > .title
      const classRe = /\.([A-Za-z_-][A-Za-z0-9_-]*)(?:[:\s[{,>~+|]|$)/g
      while ((m = classRe.exec(line)) !== null) {
        const cls = m[1]
        const key = `.${cls}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: key, kind: 'style-rule', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── Id selectors: #main-nav ─────────────────────────────────────────
      const idRe = /#([A-Za-z_-][A-Za-z0-9_-]*)(?:[:\s[{,>~+|]|$)/g
      while ((m = idRe.exec(line)) !== null) {
        const id = m[1]
        const key = `#${id}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: key, kind: 'variable', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── Element selectors used in rule blocks (informational) ──────────
      // e.g. `button {`, `a:hover {`, `input[type="text"] {`
      // Only capture standalone element selectors (not inside a class/id rule)
      const elemRe = /^([a-z][a-z0-9]*)(?::[\w-]+)?(?:\[.*?\])?\s*[{,]/
      const elemM  = line.match(elemRe)
      if (elemM) {
        const tag = elemM[1]
        // Exclude at-rule keywords and common property names
        const SKIP = new Set(['from', 'to', 'url', 'not', 'is', 'has', 'where', 'import', 'use', 'forward'])
        if (!SKIP.has(tag)) {
          const key = `el:${tag}`
          if (!seen.has(key)) {
            seen.add(key)
            symbols.push({ name: tag, kind: 'style-rule', startLine: lineNum, endLine: lineNum })
          }
        }
      }

      // ── CSS custom properties: --color-primary: ... ────────────────────
      const varRe = /(--[A-Za-z_-][A-Za-z0-9_-]*)\s*:/g
      while ((m = varRe.exec(line)) !== null) {
        const prop = m[1]
        if (!seen.has(prop)) {
          seen.add(prop)
          symbols.push({ name: prop, kind: 'variable', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── @keyframes name ────────────────────────────────────────────────
      const kfM = line.match(/^@keyframes\s+([\w-]+)/)
      if (kfM) {
        const key = `@keyframes ${kfM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: kfM[1], kind: 'function', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── @mixin name (SCSS / Less) ──────────────────────────────────────
      const mixinM = line.match(/^@mixin\s+([\w-]+)/)
      if (mixinM) {
        const key = `@mixin ${mixinM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: `mixin: ${mixinM[1]}`, kind: 'function', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── @function name (SCSS) ──────────────────────────────────────────
      const fnM = line.match(/^@function\s+([\w-]+)/)
      if (fnM) {
        const key = `@function ${fnM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: `fn: ${fnM[1]}`, kind: 'function', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── @layer name ────────────────────────────────────────────────────
      const layerM = line.match(/^@layer\s+([\w.-]+)/)
      if (layerM) {
        const key = `@layer ${layerM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: `layer: ${layerM[1]}`, kind: 'namespace', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── @media description → namespace (breakpoint labelling) ──────────
      const mediaM = line.match(/^@media\s+(.{1,80})/)
      if (mediaM) {
        const query = mediaM[1].replace(/\{.*$/, '').trim()
        const key   = `@media:${query}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: `@media ${query}`, kind: 'namespace', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── @container name ────────────────────────────────────────────────
      const containerM = line.match(/^@container\s+([\w-]+)/)
      if (containerM) {
        const key = `@container:${containerM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: `container: ${containerM[1]}`, kind: 'namespace', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── SCSS/Less variables: $name: or @name: ──────────────────────────
      const scssVarM = line.match(/^([$@][A-Za-z_-][A-Za-z0-9_-]*)\s*:/)
      if (scssVarM) {
        const key = `scssvar:${scssVarM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: scssVarM[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        }
      }

      // ── Less mixins: .mixin() { ────────────────────────────────────────
      const lessMixinM = line.match(/^\.([A-Za-z_-][A-Za-z0-9_-]*)\s*\(/)
      if (lessMixinM) {
        const key = `lessmixin:${lessMixinM[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          symbols.push({ name: `mixin: ${lessMixinM[1]}`, kind: 'function', startLine: lineNum, endLine: lineNum })
        }
      }
    }

    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  extractImports(content: string): Import[] {
    const imports: Import[] = []
    const seen = new Set<string>()

    // @import "path" / @import 'path' / @import url("path")
    const importRe = /@(?:import|use|forward)\s+(?:url\()?["']([^"')]+)["']\)?/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(content)) !== null) {
      const specifier = m[1]
      if (!seen.has(specifier)) {
        seen.add(specifier)
        imports.push({
          specifier,
          namedImports: [],
          defaultImport: null,
          namespaceImport: null,
          isRelative: specifier.startsWith('.') || specifier.startsWith('/'),
        })
      }
    }

    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  // CSS files don't have exports in the traditional sense; return empty.
  extractExports(content: string): Export[] {
    return []
  }

  // ── extractReferences ───────────────────────────────────────────────────
  // var(--custom-prop) usages — useful for design-token traceability
  extractReferences(content: string): Reference[] {
    const refs: Reference[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const varUseRe = /var\((--[\w-]+)/g
      let m: RegExpExecArray | null
      while ((m = varUseRe.exec(lines[i])) !== null) {
        refs.push({ symbolName: m[1], line: i + 1, fromSpecifier: null })
      }
    }

    return refs
  }
}