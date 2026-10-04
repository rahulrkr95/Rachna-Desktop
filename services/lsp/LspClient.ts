// services/lsp/LspClient.ts
//
// Thin wrapper around the Rust lsp_start/lsp_request/lsp_notify/lsp_stop
// Tauri commands (src-tauri/src/lsp.rs), plus subscriptions to the
// lsp-diagnostics-{language} / lsp-crashed-{language} events they emit.
//
// `ensureLspStarted` is the only "lifecycle" entry point the rest of the
// frontend needs to call — it's idempotent and de-dupes concurrent callers
// (e.g. hover + definition firing in the same tick on first file open) into
// a single lsp_start invocation.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { LspLanguage } from './languageMap'

function sessionKey(language: LspLanguage, root: string): string {
  return `${language}|${root}`
}

const startedSessions = new Set<string>()
const startingPromises = new Map<string, Promise<void>>()
const crashListenersAttached = new Set<LspLanguage>()

/**
 * Lazily starts (or reuses) an LSP server for (language, root). Safe to
 * call on every hover/definition/reference request — it's a no-op once a
 * session is already up, and concurrent first-callers share one in-flight
 * lsp_start call rather than racing to spawn duplicate processes.
 */
export async function ensureLspStarted(language: LspLanguage, root: string): Promise<void> {
  ensureCrashListener(language)

  const key = sessionKey(language, root)
  if (startedSessions.has(key)) return

  let promise = startingPromises.get(key)
  if (!promise) {
    promise = invoke<void>('lsp_start', { language, root })
      .then(() => {
        startedSessions.add(key)
      })
      .finally(() => {
        startingPromises.delete(key)
      })
    startingPromises.set(key, promise)
  }
  return promise
}

export async function lspRequest<T = unknown>(
  language: LspLanguage,
  root: string,
  method: string,
  params: unknown
): Promise<T> {
  return invoke<T>('lsp_request', { language, root, method, params })
}

export async function lspNotify(
  language: LspLanguage,
  root: string,
  method: string,
  params: unknown
): Promise<void> {
  return invoke<void>('lsp_notify', { language, root, method, params })
}


// ── Diagnostics event payload (mirrors the Rust emit shape) ────────────────

export interface LspDiagnosticItem {
  range: {
    start: { line: number; character: number }
    end:   { line: number; character: number }
  }
  severity?: number // 1=error, 2=warning, 3=info, 4=hint (LSP DiagnosticSeverity)
  code?: string | number
  message: string
  source?: string
}

export interface LspDiagnosticsEventPayload {
  language: LspLanguage
  root: string
  params: {
    uri: string
    diagnostics: LspDiagnosticItem[]
  }
}

export function onLspDiagnostics(
  language: LspLanguage,
  handler: (payload: LspDiagnosticsEventPayload) => void
): Promise<UnlistenFn> {
  return listen<LspDiagnosticsEventPayload>(`lsp-diagnostics-${language}`, ({ payload }) => handler(payload))
}

export function onLspCrashed(language: LspLanguage, handler: (root: string) => void): Promise<UnlistenFn> {
  return listen<string>(`lsp-crashed-${language}`, ({ payload }) => handler(payload))
}

/**
 * On crash, the Rust side already tore the session down — drop our local
 * "started" flag too so the next `ensureLspStarted` call for that
 * (language, root) actually respawns it instead of assuming it's alive.
 * Attached lazily, once per language, the first time it's needed.
 */
function ensureCrashListener(language: LspLanguage): void {
  if (crashListenersAttached.has(language)) return
  crashListenersAttached.add(language)
  onLspCrashed(language, (root) => {
    startedSessions.delete(sessionKey(language, root))
  })
}
