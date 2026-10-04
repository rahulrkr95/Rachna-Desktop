// lib/pendingAttachments.ts
//
// pendingAttachmentsStore — the "pending request state" for the
// `add_file_to_request` tool (services/agent/tools/addFileToRequestTool.ts).
//
// Mirrors the shape of lib/llmCallLogger.ts's module-level singleton: a
// single in-memory store, independent of any mounted UI, that queues
// PendingFileAttachment entries between the moment the agent calls
// `add_file_to_request` and the moment AgentLoop.ts makes the *next* LLM API
// request. AgentLoop reads getAll() immediately before calling
// loggedAgentTurn()/loggedStream(), attaches them to that one request via
// ChatOptions.attachments, then calls clear() right after — so attachments
// are always single-use and never silently resent on a later turn.
//
// Kept as its own module (rather than living on ToolContext) because it
// needs to survive across the tool-call boundary and back into AgentLoop's
// own scope, the same cross-cutting reason llmCallLogger is a module
// singleton rather than something threaded through props.

import type { PendingFileAttachment } from './providers/types'

type Listener = (attachments: PendingFileAttachment[]) => void

class PendingAttachmentsStoreImpl {
  private attachments: PendingFileAttachment[] = []
  private listeners = new Set<Listener>()

  /** Queue a file to be attached to the next LLM API request. */
  add(attachment: PendingFileAttachment): void {
    this.attachments.push(attachment)
    this.notify()
  }

  /** All attachments currently queued, in the order they were added. */
  getAll(): PendingFileAttachment[] {
    return this.attachments
  }

  hasPending(): boolean {
    return this.attachments.length > 0
  }

  /** Consume-and-clear — called by AgentLoop right after the request that used them completes (success or failure). */
  clear(): void {
    if (this.attachments.length === 0) return
    this.attachments = []
    this.notify()
  }

  /** Optional UI hook (e.g. a chat composer indicator showing "2 files attached"). */
  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(fn => {
      try { fn(this.attachments) } catch { /* never let a UI listener crash a tool call */ }
    })
  }
}

export const pendingAttachmentsStore = new PendingAttachmentsStoreImpl()
