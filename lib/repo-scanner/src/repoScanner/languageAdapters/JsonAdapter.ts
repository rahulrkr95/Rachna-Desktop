// lib/repoScanner/languageAdapters/JsonAdapter.ts
//
// LanguageAdapter for JSON / JSONC / JSON5 files.
//
// Symbol extraction: top-level object keys → 'variable'
// Special-cases common config files:
//   package.json  → name, version, scripts keys, dependencies → 'variable'
//   tsconfig.json → top-level compiler option keys → 'variable'
// Import extraction: none (JSON has no import semantics)
// Export extraction: top-level keys as named exports for discoverability

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'
import * as path from 'path'

export class JsonAdapter implements LanguageAdapter {
  readonly name = 'JSON'
  readonly extensions = ['json', 'jsonc', 'json5'] as const

  extractSymbols(content: string, filePath?: string): Symbol[] {
    const symbols: Symbol[] = []
    // Strip JSONC-style line comments before parsing
    const stripped = content.replace(/\/\/[^\n]*/g, '')

    let parsed: unknown
    try { parsed = JSON.parse(stripped) } catch { return [] }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []

    const obj = parsed as Record<string, unknown>
    const lines = content.split('\n')
    const fname = filePath ? path.basename(filePath) : ''

    for (const key of Object.keys(obj)) {
      const line = this.findKeyLine(lines, key)
      const kind = this.kindForKey(key, fname)
      symbols.push({ name: key, kind, startLine: line, endLine: line })

      // For package.json scripts, expose each script name too
      if (fname === 'package.json' && key === 'scripts') {
        const scripts = obj[key]
        if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
          for (const script of Object.keys(scripts as object)) {
            const sline = this.findKeyLine(lines, script)
            symbols.push({ name: `script:${script}`, kind: 'function', startLine: sline, endLine: sline })
          }
        }
      }
    }

    return symbols
  }

  extractImports(): Import[] { return [] }

  extractExports(content: string): Export[] {
    const stripped = content.replace(/\/\/[^\n]*/g, '')
    let parsed: unknown
    try { parsed = JSON.parse(stripped) } catch { return [] }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.keys(parsed as object).map(k => ({ name: k, kind: 'variable' as const }))
  }

  extractReferences(): Reference[] { return [] }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private kindForKey(key: string, fname: string): Symbol['kind'] {
    if (fname === 'package.json') {
      if (key === 'scripts') return 'variable'
      if (key === 'dependencies' || key === 'devDependencies' || key === 'peerDependencies') return 'variable'
    }
    return 'variable'
  }

  private findKeyLine(lines: string[], key: string): number {
    const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1
    }
    return 1
  }
}
