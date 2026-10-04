// lib/conversationContext.ts
//
// Per-turn conversation-context builder for Rachna AI Studio.
//
// Distinct from lib/conversationCompaction.ts (which only kicks in once the
// conversation is close to blowing the model's context window, and reduces
// older turns to a real summary based on actual token counts). This module
// runs on every send and simply reconstructs the full prior conversation —
// every past user prompt and every past assistant reply, verbatim and in
// full — so the model always has the complete session history to work
// from. The current user message is appended after this context by the
// caller.

import type { ChatMessage } from '../types'

interface ConversationContextConfig {
  /** How many most-recent user/assistant turns to include as history. Default: 8. */
  maxTurns: number
  /**
   * How many of the most-recent turns (counting from the end) keep the
   * assistant's *full* response body instead of a summary. Default: 1
   * (only the immediately preceding turn is kept verbatim).
   */
  keepFullResponsesN: number
  /** Hard cap (characters) on any single summary. Default: 400. */
  maxSummaryChars: number
}

/** One user message paired with the assistant message(s) that followed it. */
interface Turn {
  user: ChatMessage
  ai:   ChatMessage[]
}

// ── Turn grouping ─────────────────────────────────────────────────────────────

/**
 * Groups a flat ChatMessage[] into {user, ai[]} turns. Any leading assistant
 * messages (no preceding user message — shouldn't normally happen, but the
 * compaction summary message is 'ai'-authored and could theoretically lead)
 * are attached to a synthetic empty-user turn so nothing is silently dropped.
 */
function groupIntoTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const msg of messages) {
    if (msg.role === 'user') {
      current = { user: msg, ai: [] }
      turns.push(current)
    } else {
      if (!current) {
        current = { user: { ...msg, role: 'user', body: '' }, ai: [] }
        turns.push(current)
      }
      current.ai.push(msg)
    }
  }

  return turns
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the conversation-history slice to send with the next request.
 *
 * - Takes the last `config.maxTurns` user/assistant turns from `priorMessages`.
 * - Every user prompt in that window is kept verbatim.
 * - Every assistant reply is replaced with a concise summary, EXCEPT the last
 *   `config.keepFullResponsesN` turns, whose assistant replies are kept in
 *   full (the model may need their exact wording/content going forward).
 * - Returns a flat ChatMessage[] ready to be handed to
 *   `provider.toInternalMessages(...)`, with the caller responsible for
 *   appending the new current-turn user message after it.
 * // Every prior user prompt and every prior assistant reply is sent back to
  // the model verbatim and in full — no windowing to the last `maxTurns`
  // turns, and no heuristic summarization of older assistant replies. This
  // is what keeps a session coherent across many messages instead of the
  // model "losing" context a couple of turns back.
  //
  // `config` is accepted for backwards compatibility with callers but is no
  // longer used to truncate/summarize; actual context-window overflow is
  // still handled separately (and more accurately, via real token counts)
  // by lib/conversationCompaction.ts before each send.
 */
export function buildConversationHistory(
  priorMessages: ChatMessage[],
  config: Partial<ConversationContextConfig> = {},
): ChatMessage[] {  
  void config

  const turns = groupIntoTurns(priorMessages)
  const result: ChatMessage[] = []

  for (const turn of turns) {
    if (turn.user.body || turn.user.images?.length) {
      result.push(turn.user)
    }
    if (turn.ai.length > 0) {
      result.push(...turn.ai)
    }
  }

  return result
}

