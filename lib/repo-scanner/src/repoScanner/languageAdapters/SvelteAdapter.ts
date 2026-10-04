// lib/repoScanner/languageAdapters/SvelteAdapter.ts
//
// LanguageAdapter for Svelte component files (.svelte).
//
// Extracts from the <script> / <script context="module"> block:
//   - export const/let/function → exported props and functions
//   - const/let/var declarations → local reactive state
//   - function declarations
// Also extracts the component name from filename.

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'
import * as path from 'path'

export class SvelteAdapter implements LanguageAdapter {
  readonly name = 'Svelte'
  readonly extensions = ['svelte'] as const

  extractSymbols(content: string, filePath?: string): Symbol[] {
    const symbols: Symbol[] = []

    const compName = filePath ? path.basename(filePath, '.svelte') : null
    if (compName) {
      symbols.push({ name: compName, kind: 'component', startLine: 1, endLine: 1 })
    }

    for (const block of this.extractScriptBlocks(content)) {
      const lines = block.text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line    = lines[i].trim()
        const lineNum = block.startLine + i

        const fnDecl = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
        if (fnDecl) { symbols.push({ name: fnDecl[1], kind: 'function',  startLine: lineNum, endLine: lineNum }); continue }

        const varDecl = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
        if (varDecl) { symbols.push({ name: varDecl[1], kind: 'variable', startLine: lineNum, endLine: lineNum }); continue }

        const classDecl = line.match(/^(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/)
        if (classDecl) { symbols.push({ name: classDecl[1], kind: 'class', startLine: lineNum, endLine: lineNum }) }
      }
    }

    return symbols
  }

  extractImports(content: string): Import[] {
    const imports: Import[] = []
    for (const block of this.extractScriptBlocks(content)) {
      const re = /^import\s+(?:(\w+)|(?:\{([^}]+)\})|(?:\*\s+as\s+(\w+)))\s+from\s+['"]([^'"]+)['"]/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(block.text)) !== null) {
        const named = m[2] ? m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()) : []
        imports.push({
          specifier:       m[4],
          namedImports:    named,
          defaultImport:   m[1] ?? null,
          namespaceImport: m[3] ?? null,
          isRelative:      m[4].startsWith('.'),
        })
      }
    }
    return imports
  }

  extractExports(content: string, filePath?: string): Export[] {
    const compName = filePath ? path.basename(filePath, '.svelte') : 'Component'
    return [{ name: compName, kind: 'default' }]
  }

  extractReferences(): Reference[] { return [] }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private extractScriptBlocks(content: string): Array<{ text: string; startLine: number }> {
    const blocks: Array<{ text: string; startLine: number }> = []
    const re = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const startLine = content.substring(0, m.index).split('\n').length
      const inner = m[0].replace(/<script(?:\s[^>]*)?>/, '').replace(/<\/script>/i, '')
      blocks.push({ text: inner, startLine })
    }
    return blocks
  }
}
