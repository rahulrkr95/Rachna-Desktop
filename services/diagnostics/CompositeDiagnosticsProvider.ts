// services/diagnostics/CompositeDiagnosticsProvider.ts
//
// setDiagnosticsProvider() only accepts a single DiagnosticsProvider, but we
// now have two real sources — Monaco's TS worker and the LSP bridge — and
// want both reflected in get_diagnostics. This merges N providers into one,
// querying them in parallel and concatenating results. A failure in any one
// provider degrades to an empty list for that source rather than failing
// the whole call (diagnostics are advisory, never blocking).

import type { DiagnosticsProvider, DiagnosticEntry, GetDiagnosticsArgs } from '../agent/tools/diagnosticsTool'
import type { ToolContext } from '../agent/types'

export function createCompositeDiagnosticsProvider(providers: DiagnosticsProvider[]): DiagnosticsProvider {
  return {
    getDiagnostics: async (args: GetDiagnosticsArgs, ctx: ToolContext): Promise<DiagnosticEntry[]> => {
      const results = await Promise.all(
        providers.map(p => p.getDiagnostics(args, ctx).catch(() => [] as DiagnosticEntry[]))
      )
      return results.flat()
    },
  }
}
