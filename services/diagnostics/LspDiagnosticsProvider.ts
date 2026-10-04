// services/diagnostics/LspDiagnosticsProvider.ts
//
// Implements the existing DiagnosticsProvider interface (diagnosticsTool.ts)
// backed by real LSP `textDocument/publishDiagnostics` notifications instead
// of Monaco's TS worker, so `get_diagnostics` returns real errors/warnings
// for Python, Go, TypeScript/JavaScript, Rust, and C/C++ too. Emits the same
// DiagnosticEntry shape the agent tool already maps into
// AgentDiagnosticEntry — diagnosticsTool.ts is unmodified.
//
// Diagnostics arrive asynchronously and are cached per-file (keyed by URI),
// refreshed in place every time the server republishes for that file.

import type { DiagnosticsProvider, DiagnosticEntry, GetDiagnosticsArgs } from '../agent/tools/diagnosticsTool'
import type { ToolContext } from '../agent/types'
import { onLspDiagnostics, type LspDiagnosticsEventPayload, type LspDiagnosticItem } from '../lsp/LspClient'
import { uriToFilePath } from '../lsp/lspTranslate'
import type { LspLanguage } from '../lsp/languageMap'

const LSP_LANGUAGES: LspLanguage[] = ['python', 'go', 'typescript', 'javascript', 'rust', 'c', 'cpp']

function mapSeverity(severity: LspDiagnosticItem['severity']): DiagnosticEntry['severity'] {
  switch (severity) {
    case 1:  return 'error'
    case 2:  return 'warning'
    case 3:  return 'info'
    case 4:  return 'hint'
    default: return 'info'
  }
}

// uri -> latest diagnostics for that file, replaced wholesale on each publish
const diagnosticsByUri = new Map<string, DiagnosticEntry[]>()
let listenersAttached = false

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true

  for (const language of LSP_LANGUAGES) {
    onLspDiagnostics(language, (payload: LspDiagnosticsEventPayload) => {
      const { uri, diagnostics } = payload.params
      const filePath = uriToFilePath(uri)
      diagnosticsByUri.set(
        uri,
        diagnostics.map((d): DiagnosticEntry => ({
          filePath,
          line:     d.range.start.line + 1,
          column:   d.range.start.character + 1,
          severity: mapSeverity(d.severity),
          message:  d.message,
          code:     d.code,
        }))
      )
    })
  }
}

export function createLspDiagnosticsProvider(): DiagnosticsProvider {
  attachListeners()

  return {
    getDiagnostics: async (args: GetDiagnosticsArgs, ctx: ToolContext): Promise<DiagnosticEntry[]> => {
      const all = [...diagnosticsByUri.values()].flat()
      if (!args.path) return all

      const isAbsolute = args.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(args.path)
      const target = isAbsolute || !ctx.projectRoot
        ? args.path
        : `${ctx.projectRoot.replace(/\/$/, '')}/${args.path}`

      return all.filter(d => d.filePath === target || d.filePath.endsWith(args.path as string))
    },
  }
}
