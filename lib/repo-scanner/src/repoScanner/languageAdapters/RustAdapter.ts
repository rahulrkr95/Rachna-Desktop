// lib/repoScanner/languageAdapters/RustAdapter.ts
//
// LanguageAdapter implementation for Rust (.rs files).
//
// Uses regex-based extraction — intentionally does NOT depend on tree-sitter
// or rust-analyzer so the adapter can run in any context (browser, worker,
// Tauri frontend). rust-analyzer is already wired via lsp.rs for diagnostics
// and hover; this adapter is the fallback/universal path used for symbol
// search and retrieval ranking.
//
// Extracts:
//  - fn / pub fn / async fn / pub async fn
//  - impl blocks           → kind: 'class'   (impl Type)
//  - struct definitions    → kind: 'class'
//  - enum definitions      → kind: 'enum'
//
// Imports: Rust `use` declarations (including nested braces unrolled one level)
// Exports: `pub` items (Rust has no explicit export keyword; pub = exported)
// References: call-sites of `use`-d names (best-effort)

import type {
  LanguageAdapter,
  Symbol,
  Import,
  Export,
  Reference,
  SymbolKind,
  ExportKind,
} from './types'
import { findSymbolEndLine } from './adapterUtils'

// ── Helpers ───────────────────────────────────────────────────────────────

// ── Rust adapter ──────────────────────────────────────────────────────────

export class RustAdapter implements LanguageAdapter {
  readonly name: string = 'Rust'
  readonly extensions: readonly string[] = ['rs'] as const

  // ── extractSymbols ──────────────────────────────────────────────────────
  extractSymbols(content: string): Symbol[] {
    const symbols: Symbol[] = []
    const lines = content.split('\n')

    const patterns: Array<{ re: RegExp; kind: SymbolKind }> = [
      // pub async fn, pub fn, async fn, fn — capture function name
      {
        re: /^(?:pub\s+(?:crate\s+)?)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'function',
      },
      // impl Trait for Type  |  impl<T> Type
      // capture the first identifier after `impl` (and optional generics)
      {
        re: /^(?:pub\s+)?impl(?:<[^>]*>)?\s+(?:[A-Za-z_][A-Za-z0-9_:]*\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'class',
      },
      // struct Foo  |  pub struct Foo
      {
        re: /^(?:pub\s+(?:crate\s+)?)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'class',
      },
      // enum Foo  |  pub enum Foo
      {
        re: /^(?:pub\s+(?:crate\s+)?)?enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'enum',
      },
      // type alias: type Foo = …  |  pub type Foo = …
      {
        re: /^(?:pub\s+(?:crate\s+)?)?type\s+([A-Za-z_][A-Za-z0-9_]*)\s*[=<]/,
        kind: 'type',
      },
      // trait Foo  |  pub trait Foo
      {
        re: /^(?:pub\s+(?:crate\s+)?)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'interface',
      },
    ]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trimStart()
      // Skip comments and attribute macros
      if (line.startsWith('//') || line.startsWith('#')) continue
      for (const { re, kind } of patterns) {
        const m = line.match(re)
        if (m) {
          symbols.push({ name: m[1], kind, startLine: i + 1, endLine: findSymbolEndLine(lines, i) })
          break
        }
      }
    }
    return symbols
  }

  // ── extractImports ──────────────────────────────────────────────────────
  // Handles:
  //   use std::io;
  //   use std::io::Write;
  //   use std::collections::{HashMap, HashSet};
  //   use crate::utils::helper;
  extractImports(content: string): Import[] {
    const imports: Import[] = []

    // Multiline use statements can span braces; strip comments first
    const stripped = content.replace(/\/\/[^\n]*/g, '')

    // Single-path use: `use a::b::c;` (no braces)
    const singleRe = /\buse\s+([\w:]+(?:::\w+)*)\s*;/g
    let m: RegExpExecArray | null
    while ((m = singleRe.exec(stripped)) !== null) {
      const full = m[1]
      const parts = full.split('::')
      const name = parts[parts.length - 1]
      // Detect if it ends with a segment that looks like a trait/type (PascalCase) or fn
      imports.push({
        specifier: full,
        namedImports: [name],
        defaultImport: null,
        namespaceImport: null,
        isRelative: full.startsWith('crate') || full.startsWith('super') || full.startsWith('self'),
      })
    }

    // Grouped use: `use a::b::{Foo, Bar, baz};`
    const groupedRe = /\buse\s+([\w:]+)::\{([^}]+)\}\s*;/g
    while ((m = groupedRe.exec(stripped)) !== null) {
      const prefix = m[1]
      const names = m[2]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      imports.push({
        specifier: prefix,
        namedImports: names,
        defaultImport: null,
        namespaceImport: null,
        isRelative:
          prefix.startsWith('crate') ||
          prefix.startsWith('super') ||
          prefix.startsWith('self'),
      })
    }

    // Wildcard use: `use a::b::*;`
    const wildcardRe = /\buse\s+([\w:]+)::\*\s*;/g
    while ((m = wildcardRe.exec(stripped)) !== null) {
      imports.push({
        specifier: m[1],
        namedImports: [],
        defaultImport: null,
        namespaceImport: '*',
        isRelative:
          m[1].startsWith('crate') ||
          m[1].startsWith('super') ||
          m[1].startsWith('self'),
      })
    }

    return imports
  }

  // ── extractExports ──────────────────────────────────────────────────────
  // In Rust, `pub` (and `pub(crate)`) items are the equivalent of exports.
  extractExports(content: string): Export[] {
    const exports: Export[] = []
    const seen = new Set<string>()

    const add = (name: string, kind: ExportKind) => {
      if (!seen.has(name)) {
        seen.add(name)
        exports.push({ name, kind })
      }
    }

    const lines = content.split('\n')
    const pubPatterns: Array<{ re: RegExp; kind: ExportKind }> = [
      {
        re: /^pub(?:\s*\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'function',
      },
      {
        re: /^pub(?:\s*\([^)]*\))?\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'class',
      },
      {
        re: /^pub(?:\s*\([^)]*\))?\s+enum\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'enum',
      },
      {
        re: /^pub(?:\s*\([^)]*\))?\s+trait\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'interface',
      },
      {
        re: /^pub(?:\s*\([^)]*\))?\s+type\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'type',
      },
      {
        re: /^pub(?:\s*\([^)]*\))?\s+(?:static|const)\s+([A-Za-z_][A-Za-z0-9_]*)/,
        kind: 'variable',
      },
    ]

    for (const line of lines) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue
      for (const { re, kind } of pubPatterns) {
        const m = trimmed.match(re)
        if (m) {
          add(m[1], kind)
          break
        }
      }
    }

    return exports
  }

  // ── extractReferences ────────────────────────────────────────────────────
  // Best-effort: finds call-sites and type references for imported names.
  extractReferences(content: string): Reference[] {
    const importedFrom = new Map<string, string>()
    for (const imp of this.extractImports(content)) {
      for (const n of imp.namedImports) {
        importedFrom.set(n, imp.specifier)
      }
    }

    const refs: Reference[] = []
    const seen = new Set<string>()
    const lines = content.split('\n')

    const useRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*[(::<]/g
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip use declarations and comments
      if (/^\s*use\s/.test(line) || /^\s*\/\//.test(line)) continue
      let m: RegExpExecArray | null
      useRe.lastIndex = 0
      while ((m = useRe.exec(line)) !== null) {
        const name = m[1]
        if (!importedFrom.has(name)) continue
        const key = `${name}:${i + 1}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({
            symbolName: name,
            line: i + 1,
            fromSpecifier: importedFrom.get(name) ?? null,
          })
        }
      }
    }
    return refs
  }
}
