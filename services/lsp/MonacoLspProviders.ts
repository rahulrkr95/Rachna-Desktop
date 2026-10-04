// services/lsp/MonacoLspProviders.ts
//
// Registers Monaco hover / go-to-definition / find-references providers
// for a given LSP language, translating LSP Hover / Location[] responses
// via lsp_request. Registration is idempotent and global per language —
// Monaco's `monaco.languages.register*Provider` calls are process-wide, not
// per-editor-instance, so calling this on every file open is safe (it's
// guarded by `registeredLanguages`).
//
// Every provider degrades silently (returns null / []) on any LSP failure
// (server not started yet, request timeout, crash) — hover/definition/
// references are advisory editor affordances and must never throw in a way
// that disrupts typing or editing.

import type * as Monaco from 'monaco-editor'
import { ensureLspStarted, lspRequest } from './LspClient'
import { syncDocumentOpen } from './LspDocumentSync'
import type { LspLanguage } from './languageMap'
import { toLspPosition, fromLspRange, filePathToUri, type LspRange } from './lspTranslate'

const registeredLanguages = new Set<LspLanguage>()

interface LspHover {
  contents: string | { kind?: string; value?: string } | Array<string | { value: string }>
  range?: LspRange
}

interface LspLocation {
  uri: string
  range: LspRange
}

function hoverContentsToMarkdown(contents: LspHover['contents']): string {
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map(c => (typeof c === 'string' ? c : c.value ?? '')).join('\n\n')
  }
  return contents.value ?? ''
}

function toLocations(monaco: typeof Monaco, raw: LspLocation | LspLocation[] | null): Monaco.languages.Location[] {
  const list = !raw ? [] : Array.isArray(raw) ? raw : [raw]
  return list.map(loc => ({
    uri:   monaco.Uri.parse(loc.uri),
    range: fromLspRange(monaco, loc.range),
  }))
}

/** Best-effort: make sure the server is up and this document is open before asking it anything. */
async function prepare(language: LspLanguage, root: string, model: Monaco.editor.ITextModel): Promise<string> {
  const filePath = (model.uri as unknown as { fsPath?: string }).fsPath ?? model.uri.path
  const uri = filePathToUri(filePath)
  await ensureLspStarted(language, root)
  await syncDocumentOpen(language, root, uri, model.getValue())
  return uri
}

export function registerLspProviders(monaco: typeof Monaco, language: LspLanguage, root: string): void {
  if (registeredLanguages.has(language)) return
  registeredLanguages.add(language)

  // Monaco's built-in 'python' / 'go' language ids match LSP language ids.
  const monacoLangId = language

  monaco.languages.registerHoverProvider(monacoLangId, {
    provideHover: async (model, position) => {
      try {
        const uri = await prepare(language, root, model)
        const result = await lspRequest<LspHover | null>(language, root, 'textDocument/hover', {
          textDocument: { uri },
          position: toLspPosition(position),
        })
        if (!result) return null
        return {
          contents: [{ value: hoverContentsToMarkdown(result.contents) }],
          range: result.range ? fromLspRange(monaco, result.range) : undefined,
        }
      } catch {
        return null
      }
    },
  })

  monaco.languages.registerDefinitionProvider(monacoLangId, {
    provideDefinition: async (model, position) => {
      try {
        const uri = await prepare(language, root, model)
        const result = await lspRequest<LspLocation | LspLocation[] | null>(language, root, 'textDocument/definition', {
          textDocument: { uri },
          position: toLspPosition(position),
        })
        return toLocations(monaco, result)
      } catch {
        return null
      }
    },
  })

  monaco.languages.registerReferenceProvider(monacoLangId, {
    provideReferences: async (model, position, context) => {
      try {
        const uri = await prepare(language, root, model)
        const result = await lspRequest<LspLocation[] | null>(language, root, 'textDocument/references', {
          textDocument: { uri },
          position: toLspPosition(position),
          context: { includeDeclaration: context.includeDeclaration },
        })
        return toLocations(monaco, result)
      } catch {
        return []
      }
    },
  })
}
