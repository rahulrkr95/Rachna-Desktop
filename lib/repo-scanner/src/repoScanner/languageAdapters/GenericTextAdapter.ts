// lib/repoScanner/languageAdapters/GenericTextAdapter.ts
//
// Passthrough adapter for file types that need to be indexed (chunked for
// semantic/FTS search) but don't have meaningful symbol structures.
//
// Covers: .env, .env.*, .proto (Protocol Buffers), .xml, .svg (text form),
//         .ini, .cfg, .conf, .properties, .lock (Pipfile.lock, yarn.lock etc.)
//
// For .proto and .xml, minimal symbol extraction is attempted.
// For .env-style files, only key names are extracted (never values).

import type { LanguageAdapter, Symbol, Import, Export, Reference } from './types'

export class GenericTextAdapter implements LanguageAdapter {
  readonly name = 'Generic'
  readonly extensions = [
    // Environment files
    'env',
    // Protocol Buffers
    'proto',
    // Config formats
    'ini', 'cfg', 'conf', 'properties',
    // Lock files (content-indexed but symbol-free)
    'lock',
  ] as const

  extractSymbols(content: string, filePath?: string): Symbol[] {
    const symbols: Symbol[] = []
    const fname = filePath?.split('/').pop() ?? ''
    const lines  = content.split('\n')

    // .env: extract KEY names only (never values — they may contain secrets)
    if (fname.includes('.env') || fname.startsWith('.env')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line || line.startsWith('#')) continue
        const kv = line.match(/^([A-Z_][A-Z0-9_]*)=/)
        if (kv) symbols.push({ name: kv[1], kind: 'variable', startLine: i + 1, endLine: i + 1 })
      }
      return symbols
    }

    // .proto: extract message / service / enum names
    if (fname.endsWith('.proto')) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        const msg  = line.match(/^message\s+([A-Za-z_][A-Za-z0-9_]*)/)
        if (msg) { symbols.push({ name: msg[1], kind: 'class', startLine: i + 1, endLine: i + 1 }); continue }
        const svc  = line.match(/^service\s+([A-Za-z_][A-Za-z0-9_]*)/)
        if (svc) { symbols.push({ name: svc[1], kind: 'interface', startLine: i + 1, endLine: i + 1 }); continue }
        const en   = line.match(/^enum\s+([A-Za-z_][A-Za-z0-9_]*)/)
        if (en) { symbols.push({ name: en[1], kind: 'enum', startLine: i + 1, endLine: i + 1 }) }
      }
      return symbols
    }

    // .ini / .cfg / .conf: section headers
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      const section = line.match(/^\[([^\]]+)\]/)
      if (section) symbols.push({ name: section[1], kind: 'variable', startLine: i + 1, endLine: i + 1 })
    }

    return symbols
  }

  extractImports(): Import[]  { return [] }
  extractExports(): Export[]  { return [] }
  extractReferences(): Reference[] { return [] }
}

// ── XML adapter ───────────────────────────────────────────────────────────

export class XmlAdapter implements LanguageAdapter {
  readonly name = 'XML'
  readonly extensions = ['xml', 'plist', 'csproj', 'fsproj', 'vbproj', 'props', 'targets', 'resx'] as const

  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      // Top-level element opening tags (first occurrence of each tag name)
      const tag = line.match(/^<([A-Za-z][A-Za-z0-9_.-]*)(?:\s|>|\/)/)
      if (tag && !tag[1].startsWith('!') && !tag[1].startsWith('?')) {
        const name = tag[1]
        // Avoid spamming common wrapper tags
        if (!['xml', 'root', 'html', 'body', 'head'].includes(name.toLowerCase())) {
          // id or name attribute
          const idAttr = line.match(/\b(?:id|name)="([^"]+)"/)
          symbols.push({
            name:     idAttr ? `${name}#${idAttr[1]}` : name,
            kind:     'variable',
            startLine: i + 1,
            endLine:   i + 1,
          })
        }
      }
    }
    // Deduplicate by name
    const seen = new Set<string>()
    return symbols.filter(s => { if (seen.has(s.name)) return false; seen.add(s.name); return true })
  }

  extractImports(): Import[]  { return [] }
  extractExports(): Export[]  { return [] }
  extractReferences(): Reference[] { return [] }
}
