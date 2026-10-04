// lib/conversationMemory.ts
//
// Typed wrappers around the Tauri conversation-memory commands.
// All heavy lifting lives in src-tauri/src/db.rs (schema) and
// src-tauri/src/commands.rs (commands). This module is the single
// import point for any TypeScript code that needs to read or write
// conversation history.

import { invoke } from '@tauri-apps/api/core'

// ── No-project scope ──────────────────────────────────────────────────────────
//
// Conversations are stored keyed by `project_root` (a NOT NULL TEXT column).
// When no project folder is open yet — the "welcome" screen — chats used to
// be thrown away entirely (see useChat.ts's old `if (!projectRoot) return`
// guards). They now persist too, scoped under this sentinel value instead of
// a real filesystem path, so every existing query/command that's already
// keyed by project_root works unchanged: no schema migration needed.
export const NO_PROJECT_KEY = '__no_project__'

// ── Types (mirror Rust structs in db.rs) ─────────────────────────────────────

export interface Conversation {
  id: string
  project_root: string
  title: string
  created_at: string
  updated_at: string
  /**
   * Id of the message at the tip of the currently-active branch (CHAT-004).
   * `null` only for a brand-new conversation with no messages yet. The
   * active transcript is reconstructed by walking `parent_id` pointers on
   * `DbMessage` back from this leaf to the root — see lib/chatGraph.ts.
   */
  current_leaf_id: string | null
}

export interface DbMessage {
  id: string
  conversation_id: string
  /**
   * Id of the message this one was created as a reply/version of. `null`
   * for the first message of a conversation (the root). Multiple messages
   * may share the same `parent_id` — that's a branch (an edited user
   * message, or a regenerated assistant reply, each get their own sibling
   * node instead of overwriting the original).
   */
  parent_id: string | null
  /** "user" | "assistant" | "tool" */
  role: string
  content: string
  tool_name: string | null
  created_at: string
  /**
   * CHAT-005: opaque JSON blob holding every non-text field of the message
   * that needs to survive a reload — generated IntentPlan, per-step
   * statuses, agent activity ("api call") chips, retrieval/compression
   * stats, attached images, pending login/toggle cards, etc. `null` for
   * plain-text turns with nothing extra to restore. Built by
   * useChat.ts's extractMessageMetadata and parsed back by
   * pathToChatMessages — never inspected on the Rust side.
   */
  metadata: string | null
}

export interface RejectedEdit {
  id: number
  message_id: string | null
  project_root: string
  file_path: string
  description: string
  created_at: string
}

export interface SaveMessageResult {
  conversationId: string
  messageId: string
}

export interface LoadConversationResult {
  conversation: Conversation | null
  /** Every message in the conversation's graph — all branches, not just the active path. */
  messages: DbMessage[]
}

// ── save_message ──────────────────────────────────────────────────────────────
//
// Saves one message as a new node in the conversation's message graph. If
// `conversationId` is omitted, a new conversation is created for
// `projectRoot` first (auto-titled from the first user message). Returns
// `{ conversationId, messageId }` so callers can track the active
// conversation without a separate round-trip.
//
// `parentId` is the id of the message this one follows on whatever branch
// it's being created on. Linear continuation: pass the current tail of the
// active path. Forking a new version (edit / regenerate): pass the
// original message's parent (edit) or the user message's id itself
// (regenerate) so the new message becomes a SIBLING rather than
// overwriting anything. Omit for the very first message of a conversation.

export async function saveMessage(params: {
  conversationId?: string | null
  projectRoot: string
  clientMessageId?: string | null
  parentId?: string | null
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string | null
  /** CHAT-005: opaque JSON string of non-text message fields to persist alongside content — see DbMessage.metadata. */
  metadata?: string | null
}): Promise<SaveMessageResult> {
  return invoke<SaveMessageResult>('save_message', {
    conversationId: params.conversationId ?? null,
    projectRoot: params.projectRoot,
    clientMessageId: params.clientMessageId ?? null,
    parentId: params.parentId ?? null,
    role: params.role,
    content: params.content,
    toolName: params.toolName ?? null,
    metadata: params.metadata ?? null,
  })
}

// ── set_current_leaf ────────────────────────────────────────────────────────
//
// Repoints a conversation's active branch at an existing message — used for
// prev/next version navigation. Never creates or deletes anything.

export async function setCurrentLeaf(conversationId: string, leafId: string): Promise<void> {
  return invoke<void>('set_current_leaf', { conversationId, leafId })
}

// ── update_message_metadata ───────────────────────────────────────────────────
//
// Overwrites an already-saved message's metadata JSON blob in place
// (CHAT-005) — for state that keeps changing on a message after its first
// save (an IntentPlanCard's approval/step-status progress, a pending
// login/toggle card's resolved flag, etc). Never creates a new message or
// moves the conversation's current leaf; see useChat.ts's
// persistMessageUpdate for the one call site that uses this.

export async function updateMessageMetadata(
  messageId: string,
  metadata: string | null
): Promise<void> {
  return invoke<void>('update_message_metadata', { messageId, metadata })
}

/** Atomically checkpoints the visible content and rich metadata of a message. */
export async function updateMessage(
  messageId: string,
  content: string,
  metadata: string | null
): Promise<void> {
  return invoke<void>('update_message', { messageId, content, metadata })
}


// ── load_conversation_by_id ───────────────────────────────────────────────────
//
// Loads a specific conversation's complete message graph by id (sidebar restore).

export async function loadConversationById(
  conversationId: string,
  limit = 50
): Promise<LoadConversationResult> {
  return invoke<LoadConversationResult>('load_conversation_by_id', { conversationId, limit })
}

// ── list_conversations ────────────────────────────────────────────────────────
//
// Returns all conversations for `projectRoot`, newest first.

export async function listConversations(projectRoot: string): Promise<Conversation[]> {
  return invoke<Conversation[]>('list_conversations', { projectRoot })
}

// ── list_all_conversations ────────────────────────────────────────────────────
//
// Returns every conversation across every project_root (including the
// NO_PROJECT_KEY scope), newest first. Powers the sidebar's combined view:
// a flat "User Chats" list plus one expandable group per project.

export async function listAllConversations(): Promise<Conversation[]> {
  return invoke<Conversation[]>('list_all_conversations')
}

// ── delete_conversation ───────────────────────────────────────────────────────

export async function deleteConversation(conversationId: string): Promise<void> {
  return invoke<void>('delete_conversation', { conversationId })
}

// ── save_rejected_edit ────────────────────────────────────────────────────────
//
// Records an edit the user rejected so the agent can avoid repeating it.
// `messageId` is the assistant message that proposed the edit (optional).

export async function saveRejectedEdit(params: {
  messageId?: string | null
  projectRoot: string
  filePath: string
  description: string
}): Promise<void> {
  return invoke<void>('save_rejected_edit', {
    messageId: params.messageId ?? null,
    projectRoot: params.projectRoot,
    filePath: params.filePath,
    description: params.description,
  })
}

// ── get_rejected_edits ────────────────────────────────────────────────────────
//
// Returns the most recent rejected edits for `projectRoot` (default 10).
// Used by buildSystemPrompt to inject a "previously rejected" memory summary.

export async function getRejectedEdits(
  projectRoot: string,
  limit = 10
): Promise<RejectedEdit[]> {
  return invoke<RejectedEdit[]>('get_rejected_edits', { projectRoot, limit })
}
