// services/lsp/lspTranslate.ts
//
// Conversions between Monaco's editor coordinate system (1-based line and
// column) and LSP's (0-based line and character), plus file path <-> URI
// helpers consistent with the conventions already used by
// MonacoDiagnosticsProvider.ts (uriToFsPath) and MonacoEditor.tsx
// (the `file://` path prop construction).

import type * as Monaco from 'monaco-editor'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function fromLspRange(_monaco: typeof Monaco, range: LspRange): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn:     range.start.character + 1,
    endLineNumber:   range.end.line + 1,
    endColumn:       range.end.character + 1,
  }
}

/** Mirrors the `file://` URI construction used for Monaco's `path` prop. */
export function filePathToUri(filePath: string): string {
  if (/^file:\/\//i.test(filePath)) return filePath
  const normalized = filePath.replace(/\\/g, '/')
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`
}

/** Mirrors `uriToFsPath` in MonacoDiagnosticsProvider.ts. */
export function uriToFilePath(uri: string): string {
  let p = decodeURIComponent(uri.replace(/^file:\/\//i, ''))
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // Windows drive-letter fix
  return p
}
