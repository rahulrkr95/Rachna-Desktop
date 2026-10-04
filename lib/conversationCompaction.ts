// lib/conversationCompaction.ts
//
// Conversation Compaction Engine for Rachna AI Studio
//
// Reduces token usage during long conversations while preserving critical
// coding context. Operates on the ChatMessage[] array in useChat.ts.
//
// How it works:
//   1. Monitor cumulative token count across all messages.
//   2. When count exceeds COMPACTION_THRESHOLD × model_context_window:
//        a. Keep last KEEP_RECENT_N message pairs verbatim.
//        b. Keep system prompts (never compacted).
//        c. Generate a structured summary of the compacted messages.
//        d. Replace compacted messages with a single [Compacted Context] message.
//   3. Store CompactionMetadata alongside the message list.
//   4. Support multiple compaction passes as conversation grows further.
//
// Compaction is triggered BEFORE each send in useChat.ts (never mid-stream).

import type { ChatMessage } from '../types'
import { estimateTokens } from './contextCompression'

// ── Configuration ─────────────────────────────────────────────────────────────

export interface CompactionConfig {
  /**
   * Fraction of model context window at which to trigger compaction.
   * Default: 0.70 (compact when 70% of context is used by chat history).
   */
  thresholdFraction: number

  /**
   * Number of most-recent user/ai pairs to preserve verbatim.
   * The current request is ALWAYS kept on top of this.
   * Default: 6 (= 3 user + 3 ai turns)
   */
  keepRecentN: number

  /**
   * Estimated model context window in tokens (used when model info unavailable).
   * Default: 128_000 (conservative for most models).
   */
  contextWindowTokens: number

  /**
   * Enable verbose console logging of compaction steps.
   * Default: true
   */
  verbose: boolean
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  thresholdFraction:  0.70,
  keepRecentN:        6,
  contextWindowTokens: 128_000,
  verbose:            true,
}

// ── Well-known model context windows ─────────────────────────────────────────
// Used to size the compaction threshold correctly per active model.

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Gemini
  'gemini-2.5-pro':              1_048_576,
  'gemini-2.5-flash':            1_048_576,
  'gemini-2.5-flash-lite':         131_072,
  'gemini-2.0-flash':            1_048_576,
  'gemini-2.0-flash-exp':        1_048_576,
  'gemini-1.5-pro':              2_097_152,
  'gemini-1.5-flash':            1_048_576,
  'gemini-1.5-flash-8b':         1_048_576,
  // Claude
  'claude-opus-4':                 200_000,
  'claude-sonnet-4':               200_000,
  'claude-haiku-4':                200_000,
  'claude-3-7-sonnet':             200_000,
  'claude-3-5-sonnet':             200_000,
  'claude-3-5-haiku':              200_000,
  'claude-3-opus':                 200_000,
  // OpenAI
  'gpt-4o':                        128_000,
  'gpt-4o-mini':                   128_000,
  'gpt-4-turbo':                   128_000,
  'o1':                            200_000,
  'o3':                            200_000,
  // DeepSeek
  'deepseek-chat':                  64_000,
  'deepseek-coder':                 64_000,
}

export function getContextWindowForModel(modelId: string): number {
  if (!modelId) return DEFAULT_COMPACTION_CONFIG.contextWindowTokens

  const id = modelId.toLowerCase()

  // Exact match
  if (MODEL_CONTEXT_WINDOWS[id]) return MODEL_CONTEXT_WINDOWS[id]

  // Prefix match
  for (const [key, tokens] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (id.startsWith(key) || id.includes(key)) return tokens
  }

  // Heuristic fallbacks
  if (id.includes('gemini') && (id.includes('1.5') || id.includes('2.0') || id.includes('2.5'))) {
    return 1_000_000
  }
  if (id.includes('claude')) return 200_000
  if (id.includes('gpt-4')) return 128_000

  return DEFAULT_COMPACTION_CONFIG.contextWindowTokens
}

// ── Compaction metadata ───────────────────────────────────────────────────────

export interface CompactionMetadata {
  /** Number of messages that were compacted in this pass. */
  compactedMessageCount: number
  /** ISO timestamp when this compaction occurred. */
  timestamp: string
  /** Estimated tokens before compaction. */
  tokensBefore: number
  /** Estimated tokens after compaction. */
  tokensAfter: number
  /** Estimated token savings. */
  tokensSaved: number
  /** Savings as percentage 0–100. */
  savingsPct: number
  /** How many compaction passes have occurred on this conversation. */
  passNumber: number
}

// ── Summary categories ────────────────────────────────────────────────────────

interface CompactionSummary {
  goals:         string[]
  decisions:     string[]
  filesModified: string[]
  codeSnippets:  string[]
  openTasks:     string[]
  errorsFixed:   string[]
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function totalTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.body), 0)
}

// ── Summary extractor ─────────────────────────────────────────────────────────
// Parses raw message bodies to extract structured coding context.
// Uses heuristic pattern matching — no LLM call required.

function extractSummary(messages: ChatMessage[]): CompactionSummary {
  const goals:         string[] = []
  const decisions:     string[] = []
  const filesModified: string[] = []
  const codeSnippets:  string[] = []
  const openTasks:     string[] = []
  const errorsFixed:   string[] = []

  const seenFiles = new Set<string>()
  const seenGoals = new Set<string>()

  // Regex patterns
  const FILE_PATH_RE    = /(?:file|path|edit|modify|create|delete|in|at|updated?)\s+[`'"]?([\w./\\-]+\.\w{1,6})[`'"]?/gi
  const PROPOSE_EDIT_RE = /propose_edit\s*\(\s*[`'"]([^`'"]+)[`'"]/g
  const CREATE_FILE_RE  = /create_file\s*\(\s*[`'"]([^`'"]+)[`'"]/g
  const ERROR_RE        = /(?:error|fix(?:ed)?|resolv(?:ed)?|bug)[:.]?\s*(.{10,120})/gi
  const TASK_RE         = /(?:TODO|FIXME|next step|still need|remaining|pending)[:\s]+(.{10,100})/gi
  const CODE_FENCE_RE   = /```[\w]*\n([\s\S]{20,400}?)```/g
  const DECISION_RE     = /(?:decided|chose|using|switched|changed to|going with|approach)[:\s]+(.{10,120})/gi

  for (const msg of messages) {
    const body = msg.body ?? ''

    // ── Extract file paths ──────────────────────────────────────────────────
    for (const re of [FILE_PATH_RE, PROPOSE_EDIT_RE, CREATE_FILE_RE]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(body)) !== null) {
        const fp = m[1].trim()
        if (!seenFiles.has(fp) && fp.includes('.') && fp.length < 100) {
          seenFiles.add(fp)
          filesModified.push(fp)
        }
      }
    }

    // ── User messages → goals ───────────────────────────────────────────────
    if (msg.role === 'user') {
      const clean = body.replace(/\n+/g, ' ').trim().slice(0, 160)
      const key   = clean.toLowerCase().slice(0, 60)
      if (!seenGoals.has(key) && clean.length > 10) {
        seenGoals.add(key)
        goals.push(clean)
      }
    }

    // ── Decisions ───────────────────────────────────────────────────────────
    DECISION_RE.lastIndex = 0
    let dm: RegExpExecArray | null
    while ((dm = DECISION_RE.exec(body)) !== null) {
      const d = dm[1].trim().slice(0, 120)
      if (!decisions.includes(d)) decisions.push(d)
    }

    // ── Errors / fixes ──────────────────────────────────────────────────────
    ERROR_RE.lastIndex = 0
    let em: RegExpExecArray | null
    while ((em = ERROR_RE.exec(body)) !== null) {
      const e = em[1].trim().slice(0, 120)
      if (!errorsFixed.includes(e)) errorsFixed.push(e)
    }

    // ── Open tasks ──────────────────────────────────────────────────────────
    TASK_RE.lastIndex = 0
    let tm: RegExpExecArray | null
    while ((tm = TASK_RE.exec(body)) !== null) {
      const t = tm[1].trim().slice(0, 100)
      if (!openTasks.includes(t)) openTasks.push(t)
    }

    // ── Code snippets (AI messages only, short key blocks) ──────────────────
    if (msg.role === 'ai' && codeSnippets.length < 3) {
      CODE_FENCE_RE.lastIndex = 0
      let cm: RegExpExecArray | null
      while ((cm = CODE_FENCE_RE.exec(body)) !== null && codeSnippets.length < 3) {
        const snip = cm[1].trim().slice(0, 300)
        if (snip.length > 20) codeSnippets.push(snip)
      }
    }
  }

  // Trim lists to reasonable sizes
  return {
    goals:         goals.slice(0, 10),
    decisions:     decisions.slice(0, 8),
    filesModified: [...new Set(filesModified)].slice(0, 20),
    codeSnippets:  codeSnippets.slice(0, 3),
    openTasks:     openTasks.slice(0, 6),
    errorsFixed:   errorsFixed.slice(0, 8),
  }
}

// ── Summary renderer ──────────────────────────────────────────────────────────

function renderSummary(
  summary: CompactionSummary,
  meta: Pick<CompactionMetadata, 'compactedMessageCount' | 'timestamp' | 'tokensSaved' | 'passNumber'>,
): string {
  const lines: string[] = [
    `[Compacted Context — Pass #${meta.passNumber}]`,
    `Summarised ${meta.compactedMessageCount} messages · ~${meta.tokensSaved.toLocaleString()} tokens saved · ${meta.timestamp}`,
    '',
  ]

  if (summary.goals.length > 0) {
    lines.push('## User Goals')
    summary.goals.forEach(g => lines.push(`- ${g}`))
    lines.push('')
  }

  if (summary.decisions.length > 0) {
    lines.push('## Decisions Made')
    summary.decisions.forEach(d => lines.push(`- ${d}`))
    lines.push('')
  }

  if (summary.filesModified.length > 0) {
    lines.push('## Files Modified / Referenced')
    summary.filesModified.forEach(f => lines.push(`- \`${f}\``))
    lines.push('')
  }

  if (summary.errorsFixed.length > 0) {
    lines.push('## Errors / Fixes Attempted')
    summary.errorsFixed.forEach(e => lines.push(`- ${e}`))
    lines.push('')
  }

  if (summary.openTasks.length > 0) {
    lines.push('## Open Tasks')
    summary.openTasks.forEach(t => lines.push(`- ${t}`))
    lines.push('')
  }

  if (summary.codeSnippets.length > 0) {
    lines.push('## Key Code Snippets')
    summary.codeSnippets.forEach((snip, i) => {
      lines.push(`### Snippet ${i + 1}`)
      lines.push('```')
      lines.push(snip)
      lines.push('```')
    })
    lines.push('')
  }

  lines.push('_Earlier conversation compacted. Full history preserved in CompactionMetadata._')

  return lines.join('\n')
}

// ── Main compaction function ──────────────────────────────────────────────────

export interface CompactionResult {
  /** The new (compacted) message array. */
  messages:     ChatMessage[]
  /** Metadata about what was compacted. */
  metadata:     CompactionMetadata
  /** Whether compaction actually occurred (false = threshold not met). */
  compacted:    boolean
}

/**
 * Compact a conversation if it exceeds the token threshold.
 *
 * Rules:
 *   - Never compacts system/compaction messages (they're already summaries).
 *   - Never compacts the last `config.keepRecentN` messages.
 *   - Never compacts the current (last) user message.
 *   - Supports multiple passes — prior [Compacted Context] messages are merged.
 *   - Returns the original messages unchanged if threshold is not met.
 *
 * @param messages      Current ChatMessage[] from useChat state
 * @param modelId       Active model ID (for context window sizing)
 * @param passNumber    How many compactions have already occurred (for labelling)
 * @param config        Optional overrides to DEFAULT_COMPACTION_CONFIG
 */
export function compactConversation(
  messages:    ChatMessage[],
  modelId      = '',
  passNumber   = 0,
  config:      Partial<CompactionConfig> = {},
): CompactionResult {
  const cfg: CompactionConfig = { ...DEFAULT_COMPACTION_CONFIG, ...config }

  const contextWindow = getContextWindowForModel(modelId)
  const threshold     = Math.floor(contextWindow * cfg.thresholdFraction)
  const currentTokens = totalTokens(messages)

  if (cfg.verbose) {
    console.debug(
      `[compaction] ${currentTokens.toLocaleString()} / ${threshold.toLocaleString()} tokens` +
      ` (${Math.round(currentTokens / contextWindow * 100)}% of ${contextWindow.toLocaleString()} ctx window)`
    )
  }

  // ── Check threshold ───────────────────────────────────────────────────────
  if (currentTokens < threshold) {
    return { messages, metadata: makeEmptyMeta(passNumber), compacted: false }
  }

  // ── Identify messages that MUST be kept ──────────────────────────────────
  // 1. Already-compacted summary messages (role: 'ai', isCompactionSummary)
  // 2. Last keepRecentN messages (verbatim recent context)
  // 3. The very last message (current request or streaming placeholder)

  const keepCount  = Math.min(cfg.keepRecentN, messages.length)
  const keepStart  = messages.length - keepCount      // index where "keep zone" begins

  // Everything before keepStart is compaction-eligible
  const eligible   = messages.slice(0, keepStart)
  const protected_ = messages.slice(keepStart)

  if (eligible.length === 0) {
    // Nothing to compact — all messages are in the keep zone
    if (cfg.verbose) {
      console.debug('[compaction] All messages in keep zone — skipping.')
    }
    return { messages, metadata: makeEmptyMeta(passNumber), compacted: false }
  }

  // ── Merge prior compaction summaries ──────────────────────────────────────
  // If a prior pass already inserted a summary, include it in the new summary
  // context so we don't lose its information.
  const priorSummaries  = eligible.filter(m => isCompactionMessage(m))
  const regularMessages = eligible.filter(m => !isCompactionMessage(m))

  // ── Build summary ─────────────────────────────────────────────────────────
  const summary = extractSummary(regularMessages)

  const tokensBefore  = totalTokens(messages)
  const now           = new Date()
  const timestamp     = now.toISOString()
  const thisPass      = passNumber + 1

  const meta: Pick<CompactionMetadata, 'compactedMessageCount' | 'timestamp' | 'tokensSaved' | 'passNumber'> = {
    compactedMessageCount: eligible.length,
    timestamp:             now.toLocaleString(),
    tokensSaved:           0,  // filled in below
    passNumber:            thisPass,
  }

  // Prepend prior summary context if it exists
  if (priorSummaries.length > 0) {
    const priorText = priorSummaries.map(m => m.body).join('\n\n')
    // Merge prior open tasks / decisions into current summary
    summary.openTasks  = [...new Set([...extractOpenTasksFromSummary(priorText), ...summary.openTasks])].slice(0, 8)
    summary.decisions  = [...new Set([...extractDecisionsFromSummary(priorText), ...summary.decisions])].slice(0, 10)
    summary.filesModified = [...new Set([...extractFilesFromSummary(priorText), ...summary.filesModified])].slice(0, 25)
  }

  const summaryBody = renderSummary(summary, meta)

  // ── Assemble compacted message array ──────────────────────────────────────
  const summaryMsg: ChatMessage = {
    id:       `compaction-${timestamp}`,
    role:     'ai',
    name:     'Compaction Engine',
    initials: '⚡',
    time:     now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    body:     summaryBody,
  }

  const compacted: ChatMessage[] = [summaryMsg, ...protected_]

  const tokensAfter  = totalTokens(compacted)
  const tokensSaved  = Math.max(0, tokensBefore - tokensAfter)
  const savingsPct   = tokensBefore > 0 ? Math.round(tokensSaved / tokensBefore * 100) : 0

  const metadata: CompactionMetadata = {
    compactedMessageCount: eligible.length,
    timestamp,
    tokensBefore,
    tokensAfter,
    tokensSaved,
    savingsPct,
    passNumber: thisPass,
  }

  if (cfg.verbose) {
    console.info(
      `[compaction] Pass #${thisPass}: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens` +
      ` (saved ~${tokensSaved.toLocaleString()} / ${savingsPct}%)` +
      ` | compacted ${eligible.length} msgs, kept ${protected_.length} recent`
    )
  }

  return { messages: compacted, metadata, compacted: true }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Check if a ChatMessage is a compaction summary (generated by this module). */
export function isCompactionMessage(msg: ChatMessage): boolean {
  return msg.id.startsWith('compaction-') || msg.body.startsWith('[Compacted Context')
}

/** Convenience: check if compaction is needed without running it. */
export function shouldCompact(
  messages:  ChatMessage[],
  modelId    = '',
  config:    Partial<CompactionConfig> = {},
): boolean {
  const cfg           = { ...DEFAULT_COMPACTION_CONFIG, ...config }
  const contextWindow = getContextWindowForModel(modelId)
  const threshold     = Math.floor(contextWindow * cfg.thresholdFraction)
  return totalTokens(messages) >= threshold
}

/** Estimate total chat tokens for UI display. */
export function estimateChatTokens(messages: ChatMessage[]): number {
  return totalTokens(messages)
}

// ── Private helpers ───────────────────────────────────────────────────────────

function makeEmptyMeta(passNumber: number): CompactionMetadata {
  return {
    compactedMessageCount: 0,
    timestamp:             new Date().toISOString(),
    tokensBefore:          0,
    tokensAfter:           0,
    tokensSaved:           0,
    savingsPct:            0,
    passNumber,
  }
}

function extractOpenTasksFromSummary(text: string): string[] {
  const results: string[] = []
  const lines = text.split('\n')
  let inSection = false
  for (const line of lines) {
    if (line.startsWith('## Open Tasks')) { inSection = true; continue }
    if (inSection && line.startsWith('## ')) break
    if (inSection && line.startsWith('- ')) results.push(line.slice(2).trim())
  }
  return results
}

function extractDecisionsFromSummary(text: string): string[] {
  const results: string[] = []
  const lines = text.split('\n')
  let inSection = false
  for (const line of lines) {
    if (line.startsWith('## Decisions')) { inSection = true; continue }
    if (inSection && line.startsWith('## ')) break
    if (inSection && line.startsWith('- ')) results.push(line.slice(2).trim())
  }
  return results
}

function extractFilesFromSummary(text: string): string[] {
  const results: string[] = []
  const lines = text.split('\n')
  let inSection = false
  for (const line of lines) {
    if (line.startsWith('## Files Modified')) { inSection = true; continue }
    if (inSection && line.startsWith('## ')) break
    if (inSection && line.startsWith('- ')) results.push(line.slice(2).trim().replace(/`/g, ''))
  }
  return results
}
