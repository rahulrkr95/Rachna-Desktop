// services/agent/tools/diagnosticsTool.ts
//
// Tool: get_diagnostics
//
// Returns current TypeScript / editor diagnostics for the workspace by
// reading live data directly from Monaco Editor models.
//
// Implementation:
//   - Primary:   monaco.editor.getModelMarkers({}) — fast, covers every open
//                model, includes markers set by any language service.
//   - Secondary: monaco.languages.typescript.getTypeScriptWorker() — deeper
//                semantic analysis for the specific file requested.
//
// The provider is registered once at Monaco mount time (MonacoEditor.tsx →
// setDiagnosticsProvider) and remains available for the lifetime of the IDE.
//
// Reactive updates:
//   MonacoEditor.tsx subscribes to onDidChangeMarkers and calls
//   notifyDiagnosticsChanged() so listeners (e.g. a future auto-fix loop)
//   can react to edit-induced marker changes in real time.

import { toolOk, toolErr, type AgentTool, type ToolContext } from '../types'
import { validateFileExists } from '../fileValidation'

// ── Shared types ──────────────────────────────────────────────────────────────

/** Internal representation used between the provider and the tool. */
export interface DiagnosticEntry {
  filePath: string
  /** 1-based line number */
  line: number
  /** 1-based column number */
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  /** TS error code (e.g. 2304) or a linter rule id */
  code?: string | number
}

/** Agent-facing diagnostic shape — matches the spec example. */
export interface AgentDiagnosticEntry {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  source?: string | number
}

export interface GetDiagnosticsArgs {
  /** Optional: limit to a single file (absolute or relative path) */
  path?: string
}

export interface GetDiagnosticsResult {
  diagnostics: AgentDiagnosticEntry[]
  /**
   * true  → diagnostics come from real Monaco data.
   * false → Monaco provider not yet mounted (editor hasn't loaded).
   */
  available: boolean
}

// ── Provider interface ────────────────────────────────────────────────────────

/**
 * Pluggable diagnostics source.
 * Implementations are registered via `setDiagnosticsProvider`.
 */
export interface DiagnosticsProvider {
  getDiagnostics: (args: GetDiagnosticsArgs, ctx: ToolContext) => Promise<DiagnosticEntry[]>
}

let activeProvider: DiagnosticsProvider | null = null

/** Registers the live Monaco-backed provider (called once at editor mount). */
export function setDiagnosticsProvider(provider: DiagnosticsProvider | null): void {
  activeProvider = provider
}

// ── Tool definition ───────────────────────────────────────────────────────────

export const diagnosticsTool: AgentTool<GetDiagnosticsArgs, GetDiagnosticsResult> = {
  declaration: {
    name: 'get_diagnostics',
    description:
      'Get current TypeScript/editor diagnostics (errors, warnings, hints) for ' +
      'the workspace, read live from Monaco Editor models. Optionally filter to a ' +
      'single file. Returns all diagnostics the editor currently knows about; ' +
      'call after making edits to see updated errors. Returns available: false ' +
      'only if the editor has not yet mounted.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional file path (absolute or relative to project root) to limit ' +
            'results to a single file. Omit to get workspace-wide diagnostics.',
        },
      },
      required: [],
    },
  },

  describeCall: (args) =>
    args.path ? `Checking diagnostics for ${args.path}…` : 'Checking workspace diagnostics…',

  execute: async (args, ctx: ToolContext) => {
    // Validate the path if provided (so the agent gets a clear error on typos)
    if (args.path) {
      const validated = await validateFileExists(args.path, ctx.projectRoot)
      if (!validated.ok) return toolErr(validated.error)
    }

    if (!activeProvider) {
      // Editor hasn't mounted yet — honest signal rather than silent empty list
      return toolOk<GetDiagnosticsResult>({ diagnostics: [], available: false })
    }

    try {
      const raw = await activeProvider.getDiagnostics(args, ctx)

      // Map internal DiagnosticEntry → AgentDiagnosticEntry
      const diagnostics: AgentDiagnosticEntry[] = raw.map(e => ({
        file:     e.filePath,
        line:     e.line,
        column:   e.column,
        severity: e.severity,
        message:  e.message,
        ...(e.code !== undefined ? { source: e.code } : {}),
      }))

      return toolOk<GetDiagnosticsResult>({ diagnostics, available: true })
    } catch {
      // Provider failures degrade to unavailable rather than a hard tool error —
      // diagnostics are advisory, not critical to the agent loop.
      return toolOk<GetDiagnosticsResult>({ diagnostics: [], available: false })
    }
  },
}
