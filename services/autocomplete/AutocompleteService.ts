// services/autocomplete/AutocompleteService.ts
//
// Provider-agnostic inline autocomplete engine for Monaco Editor.
// Architecture:
//   • CompletionCache  — LRU cache keyed on (prefix + suffix + language)
//   • ContextBuilder   — extracts prefix/suffix/repo context from the editor
//   • AutocompleteService — debounces requests, cancels in-flight, calls AI
//
// The Monaco InlineCompletionsProvider is registered separately in
// useInlineAutocomplete.ts (the hook that wires this service to a Monaco instance).

import type { AIProvider } from '../../lib/providers/types'
import { loggedStream } from '../../lib/llmCallLogger'

// ── Types ──────────────────────────────────────────────────────────────────

export interface AutocompleteContext {
  /** Text before the cursor (up to CONTEXT_CHARS chars) */
  prefix: string
  /** Text after the cursor (up to CONTEXT_CHARS chars) */
  suffix: string
  /** Monaco language id, e.g. "typescript" */
  language: string
  /** Filename, e.g. "App.tsx" */
  filename: string
  /** 0-based cursor line */
  lineNumber: number
  /** 0-based cursor column */
  column: number
  /** Surrounding lines for context (±10 lines) */
  surroundingLines: string
}

export interface AutocompleteResult {
  /** The generated completion text (to insert at cursor) */
  text: string
  /** Whether this was a cache hit */
  cached: boolean
}

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_SIZE = 64
const CACHE_TTL_MS = 30_000  // 30 s

interface CacheEntry {
  text: string
  ts: number
}

function makeCacheKey(ctx: AutocompleteContext): string {
  // Key on a hash of prefix (last 200 chars) + suffix (first 80 chars) + language
  const prefixTail = ctx.prefix.slice(-200)
  const suffixHead = ctx.suffix.slice(0, 80)
  return `${ctx.language}::${prefixTail}||${suffixHead}`
}

class CompletionCache {
  private map = new Map<string, CacheEntry>()

  get(key: string): string | undefined {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this.map.delete(key)
      return undefined
    }
    // LRU: re-insert at end
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.text
  }

  set(key: string, text: string): void {
    if (this.map.size >= CACHE_SIZE) {
      // Evict oldest (first) entry
      const firstKey = this.map.keys().next().value
      if (firstKey) this.map.delete(firstKey)
    }
    this.map.set(key, { text, ts: Date.now() })
  }

  clear(): void {
    this.map.clear()
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────────

// Characters of context to send either side of the cursor
const CONTEXT_CHARS = 3000

export function buildPrompt(ctx: AutocompleteContext): string {
  return `You are an expert code completion engine. Complete the code at the cursor position.

FILE: ${ctx.filename}
LANGUAGE: ${ctx.language}

SURROUNDING CONTEXT (for reference only):
${ctx.surroundingLines}

CODE TO COMPLETE (complete what comes after <CURSOR>):
${ctx.prefix}<CURSOR>${ctx.suffix}

Rules:
- Output ONLY the completion text to insert at <CURSOR>. Nothing else.
- Do NOT repeat any text that appears before <CURSOR>.
- Match the coding style, indentation, and patterns visible in the file.
- Complete the current expression, statement, or block naturally.
- If a line is incomplete, complete it. If a block is open, close it appropriately.
- Keep completions concise (1–6 lines typical). Never output more than 20 lines.
- If the context provides no meaningful completion opportunity, output an empty string.`
}

// ── AutocompleteService ────────────────────────────────────────────────────

export class AutocompleteService {
  private cache = new CompletionCache()
  private abortController: AbortController | null = null

  constructor(
    private getProvider: () => AIProvider | undefined,
    private getApiKey: () => string,
    private getModel: () => string,
  ) {}

  /**
   * Request a completion for the given context.
   * Cancels any pending in-flight request first.
   * Returns null if the provider is unavailable or the request is cancelled.
   */
  async complete(ctx: AutocompleteContext): Promise<AutocompleteResult | null> {
    // Cancel in-flight request
    this.abortController?.abort()
    this.abortController = new AbortController()
    const { signal } = this.abortController

    // Check cache first
    const cacheKey = makeCacheKey(ctx)
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) {
      return { text: cached, cached: true }
    }

    const provider = this.getProvider()
    const apiKey = this.getApiKey()
    if (!provider || !apiKey) return null

    const prompt = buildPrompt(ctx)

    try {
      let completion = ''

      await loggedStream(
        'autocomplete',
        provider,
        apiKey,
        [{ role: 'user', content: prompt }],
        {
          onChunk: (chunk) => { completion += chunk },
          onDone: () => {},
          onError: (err) => { throw err },
        },
        {
          model: this.getModel(),
          temperature: 0.1,       // low temperature = deterministic, focused completions
          maxOutputTokens: 256,   // keep it snappy
          signal,
          systemInstruction:
            'You are a code completion engine. Respond with only the completion text.',
        }
      )

      if (signal.aborted) return null

      // Clean the output: strip any accidental markdown fences the model adds
      const text = cleanCompletion(completion, ctx)
      if (!text) return null

      this.cache.set(cacheKey, text)
      return { text, cached: false }

    } catch (err) {
      if (provider.isAbortError(err)) return null
      console.warn('[Autocomplete] Provider error:', err)
      return null
    }
  }

  /** Cancel any pending request immediately. */
  cancel(): void {
    this.abortController?.abort()
    this.abortController = null
  }

  /** Wipe the completion cache (e.g. after a large refactor). */
  invalidateCache(): void {
    this.cache.clear()
  }
}

// ── Completion post-processing ─────────────────────────────────────────────

function cleanCompletion(raw: string, ctx: AutocompleteContext): string {
  let text = raw

  // Strip markdown code fences if the model wrapped the output
  text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '')

  // If model echoed the prefix, strip it
  if (text.startsWith(ctx.prefix)) {
    text = text.slice(ctx.prefix.length)
  }

  // Remove the literal <CURSOR> marker if the model included it
  text = text.replace(/<CURSOR>/g, '')

  // Trim trailing whitespace but preserve intentional leading whitespace/indent
  text = text.trimEnd()

  return text
}

// ── Context builder helper (used by the Monaco hook) ──────────────────────

/**
 * Extracts AutocompleteContext from a Monaco editor + model at the current
 * cursor position.
 */
export function buildContext(
  model: import('monaco-editor').editor.ITextModel,
  position: import('monaco-editor').Position,
  filename: string,
): AutocompleteContext {
  const fullText = model.getValue()
  const offset = model.getOffsetAt(position)

  const prefix = fullText.slice(Math.max(0, offset - CONTEXT_CHARS), offset)
  const suffix = fullText.slice(offset, offset + CONTEXT_CHARS)

  // Surrounding lines (±10 lines) for structural context
  const lineNum   = position.lineNumber
  const startLine = Math.max(1, lineNum - 10)
  const endLine   = Math.min(model.getLineCount(), lineNum + 10)
  const surroundingLines = model
    .getLinesContent()
    .slice(startLine - 1, endLine)
    .join('\n')

  return {
    prefix,
    suffix,
    language: model.getLanguageId(),
    filename,
    lineNumber: position.lineNumber,
    column: position.column,
    surroundingLines,
  }
}
