// lib/repoScanner/fileParser.ts
//
// Parses a single source file using ts-morph and extracts structured
// import / export information.  Called once per file by the scanner service.
//
// Design note: we create one ts-morph Project per scan (passed in as a
// parameter) so we benefit from the shared compiler host and type-checker
// caching across all files.

import {
  Project,
  SourceFile,
  SyntaxKind,
  ExportedDeclarations,
  Node,
} from 'ts-morph'

import type { ImportRecord, ExportRecord, SymbolRecord } from './types'
import {
  resolveRelativeImport,
  isRelativeSpecifier,
  classifyExportKind,
  resolveImport,
} from './utils'

// ── Public API ────────────────────────────────────────────────────────────

export interface ParsedFile {
  imports: ImportRecord[]
  exports: ExportRecord[]
  symbols: SymbolRecord[]
}

/**
 * Parses `sourceFile` and returns structured import/export records.
 *
 * @param sourceFile    A ts-morph SourceFile already added to a Project
 * @param extensions    The set of file extensions used to resolve bare paths
 * @param projectRoot   Absolute path to the project root (used for alias resolution)
 */
export function parseFile(
  sourceFile: SourceFile,
  extensions: Set<string>,
  projectRoot?: string,
): ParsedFile {
  return {
    imports: extractImports(sourceFile, extensions, projectRoot),
    exports: extractExports(sourceFile),
    symbols: extractSymbols(sourceFile),
  }
}

// ── Import extraction ─────────────────────────────────────────────────────

function extractImports(
  sourceFile: SourceFile,
  extensions: Set<string>,
  projectRoot?: string,
): ImportRecord[] {
  const records: ImportRecord[] = []
  const filePath = sourceFile.getFilePath()

  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue()

    // Use alias-aware resolver when projectRoot is available;
    // fall back to legacy relative-only resolver for backward compat.
    const resolvedPath = projectRoot
      ? resolveImport(specifier, filePath, projectRoot, extensions)
      : isRelativeSpecifier(specifier)
        ? resolveRelativeImport(specifier, filePath, extensions)
        : null

    // Named imports: { useState, useEffect }
    const namedImports = decl
      .getNamedImports()
      .map(n => n.getAliasNode()?.getText() ?? n.getName())

    // Default import: import React from 'react'
    const defaultImportNode = decl.getDefaultImport()
    const defaultImport     = defaultImportNode?.getText() ?? null

    // Namespace import: import * as path from 'path'
    const namespaceImportNode = decl.getNamespaceImport()
    const namespaceImport     = namespaceImportNode?.getText() ?? null

    records.push({
      specifier,
      resolvedPath,
      namedImports,
      defaultImport,
      namespaceImport,
    })
  }

  // Also capture dynamic import() calls (non-static — just the specifier)
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue
    const args = call.getArguments()
    if (args.length === 0) continue

    // Only capture string-literal dynamic imports (not computed)
    const firstArg = args[0]
    if (firstArg.getKind() !== SyntaxKind.StringLiteral) continue

    const specifier = firstArg.getText().slice(1, -1) // strip surrounding quotes

    const resolvedPath = projectRoot
      ? resolveImport(specifier, filePath, projectRoot, extensions)
      : isRelativeSpecifier(specifier)
        ? resolveRelativeImport(specifier, filePath, extensions)
        : null

    records.push({
      specifier,
      resolvedPath,
      namedImports:   [],
      defaultImport:  null,
      namespaceImport: null,
    })
  }

  return records
}

// ── Export extraction ─────────────────────────────────────────────────────

function extractExports(sourceFile: SourceFile): ExportRecord[] {
  const records: ExportRecord[] = []

  // ── 1. Named / typed exports via getExportedDeclarations() ───────────
  //    This covers: export function, export class, export interface,
  //    export type, export enum, export const, export let, export var,
  //    export default, and re-exported symbols.
  const exportedDecls: ReadonlyMap<string, ExportedDeclarations[]> =
    sourceFile.getExportedDeclarations()

  for (const [name, declArray] of exportedDecls) {
    if (declArray.length === 0) continue
    const firstDecl = declArray[0]

    // Determine kind from the node's SyntaxKind
    const kindName = SyntaxKind[firstDecl.getKind()]
    const kind     = classifyExportKind(kindName)

    records.push({ name, kind })
  }

  // ── 2. Re-export declarations: export { X } from './module' ──────────
  //    These may not appear in getExportedDeclarations() if the symbol
  //    is only re-exported (not defined here).
  for (const decl of sourceFile.getExportDeclarations()) {
    const moduleSpecifier = decl.getModuleSpecifierValue()
    if (!moduleSpecifier) continue // not a re-export

    for (const namedExport of decl.getNamedExports()) {
      const name = namedExport.getAliasNode()?.getText()
                ?? namedExport.getName()

      // Avoid duplicating symbols already captured above
      if (records.some(r => r.name === name)) continue

      records.push({ name, kind: 're-export' })
    }

    // Barrel re-export: export * from './module'
    if (decl.isNamespaceExport() || decl.getNamedExports().length === 0) {
      const barrelName = `* from '${moduleSpecifier}'`
      if (!records.some(r => r.name === barrelName)) {
        records.push({ name: barrelName, kind: 're-export' })
      }
    }
  }

  return records
}

// ── Symbol extraction ──────────────────────────────────────────────────────
//
// Walks top-level declarations (and exported declarations specifically) to
// build a flat list of named symbols with their line ranges. Powers:
//   - the `symbols` SQLite table
//   - "Where is login implemented?" / "Find AuthProvider" style lookups
//
// Heuristics:
//   - A function/const/class whose name starts with an uppercase letter and
//     whose body returns JSX is classified as a React Component.
//   - Arrow-function consts (`const useAuth = () => {}`) are functions.
//   - Only declarations with a resolvable name are indexed (anonymous
//     default exports like `export default function() {}` are skipped).

const JSX_KINDS = new Set<SyntaxKind>([
  SyntaxKind.JsxElement,
  SyntaxKind.JsxSelfClosingElement,
  SyntaxKind.JsxFragment,
])

/** Returns true if `node`'s subtree contains any JSX node. */
function containsJsx(node: Node): boolean {
  if (JSX_KINDS.has(node.getKind())) return true
  for (const child of node.getDescendants()) {
    if (JSX_KINDS.has(child.getKind())) return true
  }
  return false
}

/** True if `name` looks like a React component (PascalCase). */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name)
}

function pushSymbol(
  out: SymbolRecord[],
  seen: Set<string>,
  name: string,
  type: SymbolRecord['type'],
  node: Node,
) {
  const start = node.getStartLineNumber()
  const end = node.getEndLineNumber()
  const key = `${name}:${type}:${start}:${end}`
  if (seen.has(key)) return
  seen.add(key)
  out.push({ name, type, startLine: start, endLine: end })
}

function extractSymbols(sourceFile: SourceFile): SymbolRecord[] {
  const out: SymbolRecord[] = []
  const seen = new Set<string>()

  // ── Function declarations ────────────────────────────────────────────
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    const type: SymbolRecord['type'] =
      isComponentName(name) && containsJsx(fn) ? 'component' : 'function'
    pushSymbol(out, seen, name, type, fn)
  }

  // ── Class declarations ────────────────────────────────────────────────
  for (const cls of sourceFile.getClasses()) {
    const name = cls.getName()
    if (!name) continue
    const type: SymbolRecord['type'] =
      isComponentName(name) && containsJsx(cls) ? 'component' : 'class'
    pushSymbol(out, seen, name, type, cls)
  }

  // ── Interfaces ───────────────────────────────────────────────────────
  for (const iface of sourceFile.getInterfaces()) {
    pushSymbol(out, seen, iface.getName(), 'interface', iface)
  }

  // ── Type aliases ─────────────────────────────────────────────────────
  for (const alias of sourceFile.getTypeAliases()) {
    pushSymbol(out, seen, alias.getName(), 'type', alias)
  }

  // ── Enums ────────────────────────────────────────────────────────────
  for (const en of sourceFile.getEnums()) {
    pushSymbol(out, seen, en.getName(), 'enum', en)
  }

  // ── Top-level variable declarations ─────────────────────────────────
  // Covers: const AuthProvider = () => {...}, const useAuth = () => {...},
  //         export const UserService = { ... }
  for (const varStmt of sourceFile.getVariableStatements()) {
    for (const decl of varStmt.getDeclarations()) {
      const name = decl.getName()
      if (!name) continue

      const initializer = decl.getInitializer()
      const isFunctionLike =
        initializer !== undefined &&
        (initializer.getKind() === SyntaxKind.ArrowFunction ||
          initializer.getKind() === SyntaxKind.FunctionExpression)

      let type: SymbolRecord['type'] = 'variable'
      if (isFunctionLike) {
        type =
          isComponentName(name) && initializer && containsJsx(initializer)
            ? 'component'
            : 'function'
      }

      // Only index function-like or PascalCase (likely component/config)
      // top-level consts to avoid noise from every local constant.
      if (!isFunctionLike && !isComponentName(name)) continue

      pushSymbol(out, seen, name, type, varStmt)
    }
  }

  // ── Default export: classify via exported declarations ────────────────
  for (const [name, declArray] of sourceFile.getExportedDeclarations()) {
    if (name !== 'default' || declArray.length === 0) continue
    const decl = declArray[0]

    // Try to recover a usable display name from the declaration itself
    let displayName = 'default'
    if (Node.isFunctionDeclaration(decl) || Node.isClassDeclaration(decl)) {
      displayName = decl.getName() ?? 'default'
    }

    const type: SymbolRecord['type'] =
      isComponentName(displayName) && containsJsx(decl) ? 'component' : 'default'

    pushSymbol(out, seen, displayName, type, decl)
  }

  return out
}
