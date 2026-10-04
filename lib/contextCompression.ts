// lib/contextCompression.ts
//
// Context Compression Engine for Rachna AI Studio
//
// Reduces prompt token usage while preserving agent performance.
// Especially critical for Gemini free-tier models with tight context limits.
//
// Pipeline:
//   raw context (repo blocks, file content, chat history)
//     ↓  compress()
//   compressed context (symbols, signatures, summaries, deduped)
//     ↓  inject into prompt
//   LLM request
//
// Compression strategies applied (in order):
//   1. Deduplication — remove repeated file references / identical lines
//   2. File content reduction — keep signatures, imports, exports, symbol stubs
//   3. Chat history compression — summarise older turns, keep recent verbatim
//   4. Token budget enforcement — trim low-scoring context to fit budget
//   5. Repo block truncation — prefer high-scoring chunks, drop overflowed ones

import type { ChatMessage } from '../types'

// ── Token estimation ────────────────────────────────────────────────────────
// Rough heuristic: 1 token ≈ 4 chars of English text / code.
// Accurate enough for budget decisions without calling the tokeniser API.

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

// ── Token budgets ────────────────────────────────────────────────────────────

/** Configurable token budgets per context section. */
export interface TokenBudgets {
  /** Tokens reserved for the system prompt (not compressed). */
  systemPrompt: number
  /** Tokens for the active file content. */
  activeFile: number
  /** Tokens for retrieved repo context chunks. */
  repoContext: number
  /** Tokens for matching symbol results. */
  symbolContext: number
  /** Tokens for graph/related-files context. */
  graphContext: number
  /** Tokens for chat history (prior turns). */
  chatHistory: number
  /** Tokens for verification context (build/test/lint failures). */
  verificationContext: number
  /** Tokens reserved for the model's own output. */
  outputReserved: number
}

/** Preset budgets for Gemini free-tier (≤1M context but low RPM quota). */
export const GEMINI_FREE_BUDGETS: TokenBudgets = {
  systemPrompt:        2_000,
  activeFile:          3_000,
  repoContext:         4_000,
  symbolContext:       1_000,
  graphContext:          500,
  chatHistory:         3_000,
  verificationContext: 1_000,
  outputReserved:      8_192,
}

/** Preset budgets for paid / large-context models (much more relaxed). */
export const GEMINI_PRO_BUDGETS: TokenBudgets = {
  systemPrompt:         3_000,
  activeFile:          12_000,
  repoContext:         20_000,
  symbolContext:        3_000,
  graphContext:         2_000,
  chatHistory:         10_000,
  verificationContext:  2_000,
  outputReserved:       8_192,
}

/** Default — conservative but usable for most free-tier sessions. */
export const DEFAULT_BUDGETS: TokenBudgets = GEMINI_FREE_BUDGETS

// ── Model-aware budget selection ────────────────────────────────────────────

/** Free-tier Gemini model IDs (conservative budgets). */
const FREE_TIER_MODELS = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
])

export function getBudgetsForModel(modelId: string): TokenBudgets {
  const id = (modelId ?? '').toLowerCase()
  // Pro / paid models get generous budgets
  if (id.includes('pro') || id.includes('ultra') || id.includes('opus') || id.includes('gpt-4')) {
    return GEMINI_PRO_BUDGETS
  }
  // Explicit free-tier check
  if (FREE_TIER_MODELS.has(id)) return GEMINI_FREE_BUDGETS
  // Unknown flash/lite model — be conservative
  if (id.includes('flash') || id.includes('lite') || id.includes('haiku')) {
    return GEMINI_FREE_BUDGETS
  }
  return DEFAULT_BUDGETS
}

// ── Code signature extraction ───────────────────────────────────────────────
// For a file that exceeds its token budget, extract just the structural
// skeleton: imports, exports, function/class signatures, type definitions.
// Body content is stripped to a single stub line.

const IMPORT_RE     = /^import\b.+/
const EXPORT_RE     = /^export\b.*/
const FUNC_SIG_RE   = /^(export\s+)?(async\s+)?function\s+\w+[^{]*/
const ARROW_SIG_RE  = /^(export\s+)?(const|let)\s+\w+\s*(?::\s*\S+)?\s*=\s*(?:async\s*)?\(/
const CLASS_SIG_RE  = /^(export\s+)?(abstract\s+)?class\s+\w+.*/
const INTERFACE_RE  = /^(export\s+)?(?:interface|type)\s+\w+.*/
const DECORATOR_RE  = /^@\w+/
const COMMENT_RE    = /^\/\/|^\/\*/
const BLANK_RE      = /^\s*$/

/**
 * Extracts the "skeleton" of a TypeScript/JavaScript source file:
 * - All import lines
 * - All export declarations
 * - Function/class/interface/type signatures (opening line only)
 * - Decorators
 * - Leading single-line comments
 *
 * Body lines between `{` and matching `}` are replaced with `  // …`.
 * This dramatically reduces token count while preserving structural context.
 */
export function extractCodeSkeleton(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let depth = 0
  let inBody = false
  let bodyStubbed = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Track brace depth for body suppression
    const opens  = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length

    if (depth > 0) {
      // Inside a body block — suppress content, emit one stub
      if (!bodyStubbed) {
        result.push('  // …')
        bodyStubbed = true
      }
      depth += opens - closes
      if (depth <= 0) {
        depth = 0
        inBody = false
        bodyStubbed = false
        result.push('}')  // closing brace
      }
      continue
    }

    // Top-level line — decide whether to keep it
    const keep =
      IMPORT_RE.test(trimmed) ||
      INTERFACE_RE.test(trimmed) ||
      DECORATOR_RE.test(trimmed) ||
      COMMENT_RE.test(trimmed) ||
      BLANK_RE.test(trimmed) ||
      EXPORT_RE.test(trimmed) ||
      FUNC_SIG_RE.test(trimmed) ||
      ARROW_SIG_RE.test(trimmed) ||
      CLASS_SIG_RE.test(trimmed)

    if (keep) {
      result.push(line)
      // If this line opens a brace, enter body suppression next iteration
      if (opens > closes) {
        depth = opens - closes
        inBody = true
        bodyStubbed = false
      }
    }
    // Non-matching top-level lines (variable initialisers, expressions, etc.)
    // are silently dropped — they're recoverable via read_file.
  }

  return result.join('\n')
}

// ── Deduplication ────────────────────────────────────────────────────────────

/**
 * Removes duplicate file references from a context block string.
 * "Duplicate" means the same `File: <path>` section appears more than once;
 * subsequent occurrences are dropped entirely.
 */
export function deduplicateContextBlock(block: string): string {
  if (!block) return block

  const seenFiles = new Set<string>()
  const FILE_LINE = /^File:\s*(.+)/

  // Split into logical sections per `[Chunk N]` or `===` delimiter
  const sections = block.split(/(?=\[Chunk \d+\]|===)/)
  const kept: string[] = []

  for (const section of sections) {
    const fileMatch = section.match(FILE_LINE)
    if (fileMatch) {
      const filePath = fileMatch[1].trim()
      if (seenFiles.has(filePath)) continue  // duplicate — drop
      seenFiles.add(filePath)
    }
    kept.push(section)
  }

  return kept.join('')
}

/**
 * Removes duplicate lines across a set of context blocks.
 * Useful when graph context repeats files already in repo context.
 */
export function deduplicateAcrossBlocks(blocks: string[]): string[] {
  const seenPaths = new Set<string>()
  return blocks.map(block => {
    if (!block) return block
    // Extract all `File:` references in this block
    const filePaths = [...block.matchAll(/^File:\s*(.+)/gm)].map(m => m[1].trim())

    // If ALL files in this block were already seen in a prior block, drop the block
    if (filePaths.length > 0 && filePaths.every(p => seenPaths.has(p))) {
      return ''
    }
    filePaths.forEach(p => seenPaths.add(p))
    return block
  })
}

// ── Chat history compression ─────────────────────────────────────────────────

export interface CompressedHistory {
  /** Compressed messages to include in the prompt (recent verbatim + older summarised). */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Total estimated token count of the compressed history. */
  estimatedTokens: number
  /** How many original messages were summarised. */
  summarisedCount: number
}

/**
 * Compresses chat history to fit within `budgetTokens`.
 *
 * Strategy:
 *   - Always keep the last `keepRecent` turns verbatim (they have the most
 *     context for the current task).
 *   - Older turns are replaced with a compact summary line:
 *     `[Earlier: <user msg truncated>…]`
 *   - If even the recent turns exceed the budget, truncate them too.
 */
export function compressChatHistory(
  messages: ChatMessage[],
  budgetTokens: number,
  keepRecent = 4,
): CompressedHistory {
  if (messages.length === 0) {
    return { messages: [], estimatedTokens: 0, summarisedCount: 0 }
  }

  // Convert to provider-message format for consistency
  const all = messages.map(m => ({
    role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
    content: m.body,
  }))

  // Split into "old" (to summarise) and "recent" (keep verbatim)
  const cutoff      = Math.max(0, all.length - keepRecent * 2)  // 2 msgs per turn
  const old         = all.slice(0, cutoff)
  const recent      = all.slice(cutoff)

  // Build summaries for old turns (one per user message)
  const summaries: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const msg of old) {
    if (msg.role === 'user') {
      const truncated = msg.content.length > 120
        ? msg.content.slice(0, 120) + '…'
        : msg.content
      summaries.push({ role: 'user', content: `[Earlier: ${truncated}]` })
    }
    // AI responses in old turns are dropped — the summary of user intent is sufficient
  }

  // Check if recent turns fit in budget; if not, truncate content
  const compressedRecent = recent.map(msg => {
    const tokens = estimateTokens(msg.content)
    // Cap each recent message at ~500 tokens to guard against monster pastes
    if (tokens > 500) {
      const limit = 500 * 4
      return { ...msg, content: msg.content.slice(0, limit) + '\n…(truncated)' }
    }
    return msg
  })

  const combined = [...summaries, ...compressedRecent]

  // Enforce total budget
  let totalTokens = combined.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  if (totalTokens > budgetTokens) {
    // Drop oldest summaries first until we fit
    while (combined.length > 0 && totalTokens > budgetTokens) {
      const dropped = combined.shift()!
      totalTokens  -= estimateTokens(dropped.content)
    }
  }

  return {
    messages:       combined,
    estimatedTokens: totalTokens,
    summarisedCount: old.length,
  }
}

// ── Active file compression ──────────────────────────────────────────────────

/**
 * Compresses active file content to fit `budgetTokens`.
 *
 * - If the file fits: return as-is.
 * - If over budget: extract skeleton (imports + signatures) first.
 * - If skeleton still over budget: truncate skeleton to budget.
 */
export function compressActiveFile(
  content: string,
  language: string | undefined,
  budgetTokens: number,
): { content: string; wasCompressed: boolean; originalTokens: number; compressedTokens: number } {
  const originalTokens = estimateTokens(content)

  if (originalTokens <= budgetTokens) {
    return { content, wasCompressed: false, originalTokens, compressedTokens: originalTokens }
  }

  // TypeScript/JavaScript/TSX/JSX: extract skeleton
  const isCode = !language || ['typescript', 'javascript', 'tsx', 'jsx', 'ts', 'js'].includes(language)
  let compressed = isCode ? extractCodeSkeleton(content) : content

  const skeletonTokens = estimateTokens(compressed)
  if (skeletonTokens <= budgetTokens) {
    return { content: compressed, wasCompressed: true, originalTokens, compressedTokens: skeletonTokens }
  }

  // Still too big — hard truncate skeleton
  const limit = budgetTokens * 4
  compressed = compressed.slice(0, limit) + '\n// …(compressed — use read_file for full content)'

  return {
    content:         compressed,
    wasCompressed:   true,
    originalTokens,
    compressedTokens: estimateTokens(compressed),
  }
}

// ── Context block compression ────────────────────────────────────────────────

/**
 * Trims a context block string (repo/symbol/graph) to fit within `budgetTokens`.
 *
 * For repo context blocks with multiple `[Chunk N]` sections:
 *   - Earlier chunks are assumed higher-ranked (better scores).
 *   - Drops trailing chunks first when over budget.
 *
 * For other blocks: simple character truncation with ellipsis.
 */
export function compressContextBlock(block: string, budgetTokens: number): string {
  if (!block) return block

  const currentTokens = estimateTokens(block)
  if (currentTokens <= budgetTokens) return block

  // Try chunk-aware trimming for repo context blocks
  if (block.includes('[Chunk ')) {
    const header    = '=== Repository Context ===\n'
    const footer    = '\n=== End Repository Context ==='
    const inner     = block.replace(header, '').replace(footer, '')
    const chunks    = inner.split(/\n(?=\[Chunk )/).filter(Boolean)
    let kept: string[] = []
    let tokenCount  = estimateTokens(header + footer)

    for (const chunk of chunks) {
      const ct = estimateTokens(chunk)
      if (tokenCount + ct > budgetTokens) break
      kept.push(chunk)
      tokenCount += ct
    }

    if (kept.length === 0) {
      // Even first chunk doesn't fit — truncate it
      const limit = (budgetTokens - estimateTokens(header + footer)) * 4
      kept = [chunks[0].slice(0, limit) + '\n…']
    }

    return header + kept.join('\n\n') + footer
  }

  // Simple truncation for symbol / graph blocks
  const limit = budgetTokens * 4
  const truncated = block.slice(0, limit)
  // Find last complete line within limit to avoid mid-line cuts
  const lastNewline = truncated.lastIndexOf('\n')
  return (lastNewline > limit * 0.8 ? truncated.slice(0, lastNewline) : truncated) + '\n…'
}

// ── Main compression pipeline ────────────────────────────────────────────────

export interface CompressionInput {
  /** Active file content (may be undefined if no file open). */
  activeFileContent?: string
  /** Active file language identifier. */
  activeFileLanguage?: string
  /** Retrieved repo context block (from buildRepoContextBlock). */
  repoContextBlock: string
  /** Symbol context block (from buildSymbolContextBlock). */
  symbolContextBlock: string
  /** Graph/related-files context block (from buildRelatedFilesContextBlock). */
  graphContextBlock: string
  /** Semantic (vector) search results block. */
  semanticContextBlock?: string
  /** Chat history prior messages. */
  chatHistory: ChatMessage[]
  /** Verification context string (build/test/lint failures). */
  verificationContext?: string
  /** Token budgets to enforce. Defaults to GEMINI_FREE_BUDGETS. */
  budgets?: TokenBudgets
}

export interface CompressionOutput {
  /** Compressed active file content (may be same as input if it fit). */
  activeFileContent: string
  /** Compressed + deduped repo context block. */
  repoContextBlock: string
  /** Compressed symbol context block. */
  symbolContextBlock: string
  /** Compressed graph context block. */
  graphContextBlock: string
  /** Semantic context block (passed through, lightly trimmed if over budget). */
  semanticContextBlock: string
  /** Compressed chat history ready for provider.toInternalMessages(). */
  chatHistory: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Compressed verification context. */
  verificationContext: string
  /** Compression metrics for logging / display. */
  metrics: CompressionMetrics
}

export interface CompressionMetrics {
  /** Original total estimated tokens (all sections combined). */
  originalTokens: number
  /** Compressed total estimated tokens. */
  compressedTokens: number
  /** Reduction percentage (0–100). */
  reductionPct: number
  /** Per-section breakdown. */
  sections: {
    activeFile:          { original: number; compressed: number }
    repoContext:         { original: number; compressed: number }
    symbolContext:       { original: number; compressed: number }
    graphContext:        { original: number; compressed: number }
    chatHistory:         { original: number; compressed: number }
    verificationContext: { original: number; compressed: number }
  }
  /** Number of duplicate context blocks eliminated. */
  duplicatesRemoved: number
  /** Number of old chat turns summarised. */
  chatTurnsSummarised: number
}

/**
 * Main entry-point: runs the full compression pipeline.
 *
 * Call this BEFORE assembling the final prompt string, passing the raw
 * retrieved context and chat history. Use the returned values in place of
 * the originals.
 */
export function compressContext(input: CompressionInput): CompressionOutput {
  const budgets = input.budgets ?? DEFAULT_BUDGETS

  // ── 1. Deduplication across blocks ────────────────────────────────────────
  const [deduped_repo, deduped_symbol, deduped_graph] = deduplicateAcrossBlocks([
    input.repoContextBlock,
    input.symbolContextBlock,
    input.graphContextBlock,
  ])

  const duplicatesRemoved =
    (input.repoContextBlock.length   - (deduped_repo    ?? '').length  > 50 ? 1 : 0) +
    (input.symbolContextBlock.length - (deduped_symbol  ?? '').length  > 50 ? 1 : 0) +
    (input.graphContextBlock.length  - (deduped_graph   ?? '').length  > 50 ? 1 : 0)

  // ── 2. Per-section block deduplication ────────────────────────────────────
  const deduped_repo2   = deduplicateContextBlock(deduped_repo    ?? '')
  const deduped_symbol2 = deduplicateContextBlock(deduped_symbol  ?? '')
  const deduped_graph2  = deduplicateContextBlock(deduped_graph   ?? '')

  // ── 3. Token-budget enforcement on each block ──────────────────────────────
  const origRepo          = estimateTokens(deduped_repo2)
  const origSymbol        = estimateTokens(deduped_symbol2)
  const origGraph         = estimateTokens(deduped_graph2)
  const origVerification  = estimateTokens(input.verificationContext ?? '')
  const origHistory       = input.chatHistory.reduce((s, m) => s + estimateTokens(m.body), 0)
  const origActiveFile    = estimateTokens(input.activeFileContent ?? '')

  const compressedRepo         = compressContextBlock(deduped_repo2,   budgets.repoContext)
  const compressedSymbol       = compressContextBlock(deduped_symbol2, budgets.symbolContext)
  const compressedGraph        = compressContextBlock(deduped_graph2,  budgets.graphContext)

  // ── 4. Verification context truncation ────────────────────────────────────
  let compressedVerification = input.verificationContext ?? ''
  if (estimateTokens(compressedVerification) > budgets.verificationContext) {
    const limit = budgets.verificationContext * 4
    compressedVerification = compressedVerification.slice(0, limit) + '\n…(truncated)'
  }

  // ── 5. Active file compression ────────────────────────────────────────────
  const { content: compressedFileContent } = input.activeFileContent
    ? compressActiveFile(input.activeFileContent, input.activeFileLanguage, budgets.activeFile)
    : { content: '' }

  // ── 6. Chat history compression ───────────────────────────────────────────
  const { messages: compressedHistory, estimatedTokens: histTokens, summarisedCount } =
    compressChatHistory(input.chatHistory, budgets.chatHistory)

  // ── Metrics ────────────────────────────────────────────────────────────────
  const compressedRepo_t        = estimateTokens(compressedRepo)
  const compressedSymbol_t      = estimateTokens(compressedSymbol)
  const compressedGraph_t       = estimateTokens(compressedGraph)
  const compressedVerification_t = estimateTokens(compressedVerification)
  const compressedFile_t        = estimateTokens(compressedFileContent)

  const originalTokens = origActiveFile + origRepo + origSymbol + origGraph + origHistory + origVerification
  const compressedTokens =
    compressedFile_t + compressedRepo_t + compressedSymbol_t +
    compressedGraph_t + histTokens + compressedVerification_t

  const reductionPct = originalTokens > 0
    ? Math.round((1 - compressedTokens / originalTokens) * 100)
    : 0

  const metrics: CompressionMetrics = {
    originalTokens,
    compressedTokens,
    reductionPct,
    sections: {
      activeFile:          { original: origActiveFile,   compressed: compressedFile_t },
      repoContext:         { original: origRepo,         compressed: compressedRepo_t },
      symbolContext:       { original: origSymbol,       compressed: compressedSymbol_t },
      graphContext:        { original: origGraph,        compressed: compressedGraph_t },
      chatHistory:         { original: origHistory,      compressed: histTokens },
      verificationContext: { original: origVerification, compressed: compressedVerification_t },
    },
    duplicatesRemoved,
    chatTurnsSummarised: summarisedCount,
  }

  if (reductionPct > 0) {
    console.debug(
      `[compression] ${originalTokens} → ${compressedTokens} tokens` +
      ` (${reductionPct}% reduction, ${summarisedCount} turns summarised,` +
      ` ${duplicatesRemoved} duplicate blocks removed)`
    )
  }

  return {
    activeFileContent:    compressedFileContent,
    repoContextBlock:     compressedRepo,
    symbolContextBlock:   compressedSymbol,
    graphContextBlock:    compressedGraph,
    semanticContextBlock: input.semanticContextBlock ?? '',
    chatHistory:          compressedHistory,
    verificationContext:  compressedVerification,
    metrics,
  }
}
