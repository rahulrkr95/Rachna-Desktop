// lib/repoScanner/languageAdapters/VueAdapter.ts
//
// LanguageAdapter for Vue Single File Components (.vue).
//
// Strategy: extract the <script> / <script setup> block and delegate to
// simple TS/JS regex extraction.  Does NOT depend on @vue/compiler-sfc
// to keep the adapter lightweight and browser-safe.
//
// Extracts:
//   - Component name from `name:` option or filename (via filePath)
//   - defineProps / defineEmits / defineExpose calls → 'variable'
//   - <script setup>: const/function/class declarations → their native kinds
//   - <script> Options API: `methods`, `computed`, `data` keys → 'function'/'variable'
// Imports: proxied from the script block

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'
import * as path from 'path'

export class VueAdapter implements LanguageAdapter {
  readonly name = 'Vue'
  readonly extensions = ['vue'] as const

  extractSymbols(content: string, filePath?: string): Symbol[] {
    const symbols: Symbol[] = []

    // Component name from `name: 'MyComp'` or filename
    const nameMatch = content.match(/\bname\s*:\s*['"]([A-Za-z0-9_$-]+)['"]/)
    const compName  = nameMatch
      ? nameMatch[1]
      : filePath ? path.basename(filePath, '.vue') : null
    if (compName) {
      symbols.push({ name: compName, kind: 'component', startLine: 1, endLine: 1 })
    }

    const scriptContent = this.extractScriptBlock(content)
    if (!scriptContent.text) return symbols

    const offset = scriptContent.startLine

    const lines = scriptContent.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line    = lines[i].trim()
      const lineNum = offset + i

      // defineProps / defineEmits / defineExpose (Composition API macros)
      const macro = line.match(/\b(defineProps|defineEmits|defineExpose|defineOptions)\b/)
      if (macro) {
        symbols.push({ name: macro[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
      }

      // const/let/var declarations (setup)
      const varDecl = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (varDecl) {
        symbols.push({ name: varDecl[1], kind: 'variable', startLine: lineNum, endLine: lineNum })
        continue
      }

      // function declarations
      const fnDecl = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
      if (fnDecl) {
        symbols.push({ name: fnDecl[1], kind: 'function', startLine: lineNum, endLine: lineNum })
        continue
      }

      // Options API method/computed keys: `  methodName(` or `  methodName:`
      const optKey = lines[i].match(/^    ([A-Za-z_$][A-Za-z0-9_$]*)\s*[:(]/)
      if (optKey) {
        symbols.push({ name: optKey[1], kind: 'function', startLine: lineNum, endLine: lineNum })
      }
    }

    return symbols
  }

  extractImports(content: string): Import[] {
    const { text } = this.extractScriptBlock(content)
    if (!text) return []
    const imports: Import[] = []
    const re = /^import\s+(?:(\w+)|(?:\{([^}]+)\})|(?:\*\s+as\s+(\w+)))\s+from\s+['"]([^'"]+)['"]/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
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

  extractExports(content: string, filePath?: string): Export[] {
    const compName = filePath ? path.basename(filePath, '.vue') : 'Component'
    return [{ name: compName, kind: 'default' }]
  }

  extractReferences(): Reference[] { return [] }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private extractScriptBlock(content: string): { text: string; startLine: number } {
    // Match <script setup> or <script> block
    const scriptRe = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/i
    const m = content.match(scriptRe)
    if (!m) return { text: '', startLine: 1 }

    const startLine = content.substring(0, m.index ?? 0).split('\n').length
    // Strip the opening/closing tags
    const inner = m[0]
      .replace(/<script(?:\s[^>]*)?>/, '')
      .replace(/<\/script>/, '')
    return { text: inner, startLine }
  }
}
