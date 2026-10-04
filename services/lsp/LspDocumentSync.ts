// services/lsp/LspDocumentSync.ts
//
// Tracks which documents are "open" from each LSP server's point of view
// and sends textDocument/didOpen, didChange, and didClose accordingly.
//
// Sync strategy: full-document sync on every change (re-send the entire
// text, incrementing `version`). This is always spec-valid regardless of
// what TextDocumentSyncKind the server prefers — we just never declared
// incremental-sync support in our `initialize` capabilities, so servers
// must accept full-text didChange notifications.

import { ensureLspStarted, lspNotify } from './LspClient'
import type { LspLanguage } from './languageMap'

interface TrackedDoc {
  version: number
  root: string
}

const tracked = new Map<string, TrackedDoc>() // key: `${language}|${uri}`

function docKey(language: LspLanguage, uri: string): string {
  return `${language}|${uri}`
}

/** Opens the document with the server if it isn't already tracked. No-op otherwise. */
export async function syncDocumentOpen(
  language: LspLanguage,
  root: string,
  uri: string,
  text: string
): Promise<void> {
  await ensureLspStarted(language, root)

  const key = docKey(language, uri)
  if (tracked.has(key)) return

  tracked.set(key, { version: 1, root })
  await lspNotify(language, root, 'textDocument/didOpen', {
    textDocument: { uri, languageId: language, version: 1, text },
  })
}

/** Sends a full-text didChange for an already-open document. No-op if not open. */
export async function syncDocumentChange(language: LspLanguage, uri: string, text: string): Promise<void> {
  const key = docKey(language, uri)
  const doc = tracked.get(key)
  if (!doc) return

  doc.version += 1
  await lspNotify(language, doc.root, 'textDocument/didChange', {
    textDocument: { uri, version: doc.version },
    contentChanges: [{ text }],
  })
}

/** Sends didClose and stops tracking the document. No-op if not open. */
export async function syncDocumentClose(language: LspLanguage, uri: string): Promise<void> {
  const key = docKey(language, uri)
  const doc = tracked.get(key)
  if (!doc) return

  tracked.delete(key)
  await lspNotify(language, doc.root, 'textDocument/didClose', {
    textDocument: { uri },
  })
}
