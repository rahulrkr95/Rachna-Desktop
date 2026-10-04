// services/diagnostics/MonacoDiagnosticsProvider.ts
//
// Real implementation of DiagnosticsProvider that queries the Monaco
// TypeScript language worker for semantic and syntactic diagnostics.
//
// Architecture:
//   Monaco's TS worker maintains a full TypeScript Language Service in a
//   Web Worker. We call:
//     monaco.languages.typescript.getTypeScriptWorker()
//       → worker client proxy
//       → worker.getSemanticDiagnostics(uri)
//       → worker.getSyntacticDiagnostics(uri)
//       → worker.getSuggestionDiagnostics(uri)
//
//   The worker only knows about models that Monaco has loaded.  When no
//   model exists for a requested file we fall back to marker-only results
//   (creating throw-away models is unreliable without the file content).
//
//   The Monaco marker system (editor.getModelMarkers) catches ALL marker
//   types (TS worker + any other language service), so we always use it as
//   the primary broad-sweep source and supplement with worker diagnostics
//   for the specific file requested.
//
// Reactive updates:
//   MonacoEditor.tsx subscribes to monaco.editor.onDidChangeMarkers and
//   calls notifyDiagnosticsChanged() on every change.  Consumers (e.g. a
//   future auto-fix loop) can subscribe via onDiagnosticsChanged().

import type * as Monaco from 'monaco-editor'
import type {
  DiagnosticsProvider,
  DiagnosticEntry,
  GetDiagnosticsArgs,
} from '../agent/tools/diagnosticsTool'
import type { ToolContext } from '../agent/types'

// ── Reactive change notifications ────────────────────────────────────────────

type DiagnosticsChangedListener = () => void
const changeListeners = new Set<DiagnosticsChangedListener>()

/**
 * Called by MonacoEditor.tsx whenever Monaco fires onDidChangeMarkers.
 * Notifies all registered listeners that diagnostics may have changed.
 */
export function notifyDiagnosticsChanged(): void {
  for (const fn of changeListeners) {
    try { fn() } catch { /* ignore listener errors */ }
  }
}

/**
 * Subscribe to diagnostic change notifications.
 * Returns an unsubscribe function.
 */
export function onDiagnosticsChanged(fn: DiagnosticsChangedListener): () => void {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

// ── Severity mapping ─────────────────────────────────────────────────────────

function mapMarkerSeverity(
  monacoSeverity: number,
  monaco: typeof Monaco
): DiagnosticEntry['severity'] {
  switch (monacoSeverity) {
    case monaco.MarkerSeverity.Error:   return 'error'
    case monaco.MarkerSeverity.Warning: return 'warning'
    case monaco.MarkerSeverity.Info:    return 'info'
    case monaco.MarkerSeverity.Hint:    return 'hint'
    default:                             return 'info'
  }
}

// ── URI → file path ──────────────────────────────────────────────────────────
//
// Monaco model URIs are created as file:// URIs.
// - On Unix:   file:///home/user/project/src/App.tsx → /home/user/project/src/App.tsx
// - On Windows: file:///C:/Users/project/src/App.tsx → C:/Users/project/src/App.tsx
//
// We prefer `uri.fsPath` (which the Monaco types expose), but fall back to
// manual parsing because the `@monaco-editor/react` typings don't always
// include it.

function uriToFsPath(uri: Monaco.Uri): string {
  // Use fsPath when available (it handles Windows drive letters correctly)
  const fsPath = (uri as { fsPath?: string }).fsPath
  if (fsPath) return fsPath

  // Manual fallback: strip scheme + authority, decode percent-encoding
  let p = decodeURIComponent(uri.path)
  // Windows: /C:/... → C:/...
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p
}

// ── Worker diagnostic → DiagnosticEntry ─────────────────────────────────────

function workerDiagToEntry(
  diag: {
    start?: number
    messageText: string | { messageText: string }
    code: number
    category: number  // 0=warning, 1=error, 2=message, 3=suggestion
  },
  model: Monaco.editor.ITextModel,
  filePath: string
): DiagnosticEntry {
  const pos = diag.start !== undefined
    ? model.getPositionAt(diag.start)
    : { lineNumber: 1, column: 1 }

  const rawMsg = diag.messageText
  const message = typeof rawMsg === 'string' ? rawMsg : rawMsg.messageText

  let severity: DiagnosticEntry['severity']
  switch (diag.category) {
    case 1:  severity = 'error';   break
    case 0:  severity = 'warning'; break
    case 3:  severity = 'hint';    break
    default: severity = 'info';    break
  }

  return { filePath, line: pos.lineNumber, column: pos.column, severity, message, code: diag.code }
}

// ── Provider factory ─────────────────────────────────────────────────────────

/**
 * Creates and returns a MonacoDiagnosticsProvider.
 *
 * Call `setDiagnosticsProvider(createMonacoDiagnosticsProvider(monacoApi))`
 * once Monaco has mounted (inside the `onMount` handler in MonacoEditor.tsx).
 */
export function createMonacoDiagnosticsProvider(
  monacoApi: typeof Monaco
): DiagnosticsProvider {
  return {
    getDiagnostics: async (
      args: GetDiagnosticsArgs,
      ctx: ToolContext
    ): Promise<DiagnosticEntry[]> => {
      const monaco = monacoApi

      // ── Strategy 1: Monaco marker API — covers ALL open models ───────────
      // getModelMarkers({}) returns markers for every loaded model, giving an
      // immediate workspace-wide picture across all language services.
      const allMarkers = monaco.editor.getModelMarkers({})
      const markerEntries: DiagnosticEntry[] = allMarkers.map(m => ({
        filePath: uriToFsPath(m.resource),
        line:     m.startLineNumber,
        column:   m.startColumn,
        severity: mapMarkerSeverity(m.severity, monaco),
        message:  m.message,
        code:     typeof m.code === 'object' ? String((m.code as { value: unknown }).value) : m.code,
      }))

      // ── Strategy 2: TS worker deep diagnostics for a specific file ────────
      // When a file path is requested AND a Monaco model exists for it, we
      // also query the TypeScript language worker for semantic + syntactic
      // diagnostics.  This is richer than markers because the worker runs the
      // full language service including cross-file type checking.
      const workerEntries: DiagnosticEntry[] = []

      if (args.path) {
        const targetPath = resolveTargetPath(args.path, ctx.projectRoot)

        try {
          const getTsWorker = monaco.languages.typescript.getTypeScriptWorker

          // Prefer an already-loaded model (avoids creating a temporary one)
          const model = findModel(monaco, targetPath)

          if (model) {
            const workerFactory = await getTsWorker()
            const client = await workerFactory(model.uri)

            const [semantic, syntactic, suggestion] = await Promise.all([
              (client as {
                getSemanticDiagnostics(uri: string): Promise<unknown[]>
                getSyntacticDiagnostics(uri: string): Promise<unknown[]>
                getSuggestionDiagnostics(uri: string): Promise<unknown[]>
              }).getSemanticDiagnostics(model.uri.toString()),
              (client as {
                getSyntacticDiagnostics(uri: string): Promise<unknown[]>
              }).getSyntacticDiagnostics(model.uri.toString()),
              (client as {
                getSuggestionDiagnostics(uri: string): Promise<unknown[]>
              }).getSuggestionDiagnostics(model.uri.toString()),
            ])

            for (const d of [...semantic, ...syntactic, ...suggestion]) {
              workerEntries.push(
                workerDiagToEntry(
                  d as Parameters<typeof workerDiagToEntry>[0],
                  model,
                  targetPath
                )
              )
            }
          }
        } catch {
          // TS worker unavailable or file is not TypeScript/JavaScript.
          // Fall through — marker-only result is still valid.
        }
      }

      // ── Merge and deduplicate ─────────────────────────────────────────────
      // Worker entries take precedence (richer detail); markers fill the gaps.
      const merged = deduplicateEntries([...workerEntries, ...markerEntries])

      // ── Filter to requested path if specified ─────────────────────────────
      if (!args.path) return merged

      const targetPath = resolveTargetPath(args.path, ctx.projectRoot)
      const norm = normalizePath(targetPath)

      return merged.filter(e => {
        const ep = normalizePath(e.filePath)
        return ep === norm || ep.endsWith(normalizePath(args.path!))
      })
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize a path for case-insensitive, cross-platform comparison. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Find an existing Monaco model by absolute file path.
 * Compares against both fsPath and URI path in a platform-tolerant way.
 */
function findModel(
  monaco: typeof Monaco,
  targetPath: string
): Monaco.editor.ITextModel | null {
  const norm = normalizePath(targetPath)
  return (
    monaco.editor.getModels().find(m => {
      const fp = normalizePath(uriToFsPath(m.uri))
      const up = normalizePath(m.uri.path)
      return fp === norm || up === norm ||
        // Tolerate the leading slash difference on Windows paths
        fp === norm.replace(/^\//, '') ||
        up === norm.replace(/^\//, '')
    }) ?? null
  )
}

function resolveTargetPath(inputPath: string, projectRoot: string | null): string {
  const trimmed = inputPath.trim()
  if (/^[/\\]/.test(trimmed) || /^[A-Za-z]:/.test(trimmed)) return trimmed
  if (projectRoot) {
    const sep = projectRoot.includes('\\') ? '\\' : '/'
    return `${projectRoot}${sep}${trimmed.replace(/[/\\]/g, sep)}`
  }
  return trimmed
}

function deduplicateEntries(entries: DiagnosticEntry[]): DiagnosticEntry[] {
  const seen = new Set<string>()
  return entries.filter(e => {
    const key = `${normalizePath(e.filePath)}:${e.line}:${e.column}:${e.message.slice(0, 80)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
