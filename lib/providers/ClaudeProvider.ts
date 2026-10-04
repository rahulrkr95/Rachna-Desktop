// lib/providers/ClaudeProvider.ts
// Anthropic Claude Messages API integration.

import type {
  AIProvider,
  ModelInfo,
  ProviderMessage,
  ProviderFunctionDeclaration,
  ProviderAgentTurn,
  StreamCallbacks,
  ChatOptions,
  ProviderUsage,
  PendingFileAttachment,
} from './types'
import { claudeSchemaConverter } from './schemaConverters/ClaudeSchemaConverter'
import type { ClaudeToolDefinition } from './schemaConverters/ClaudeSchemaConverter'

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

// ── Internal message types ─────────────────────────────────────────────────

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

// This is the single point where generic ProviderFunctionDeclarations (as
// assembled by AgentLoop from built-in tools, MCP tools, and connector
// tools) become Claude's `tools` request field. Each declaration's
// `parameters` schema is re-sanitized here via ClaudeSchemaConverter for
// Claude's own unsupported-keyword list — independent of whatever
// sanitization (if any) was already applied for a different provider.
function buildTools(tools: ProviderFunctionDeclaration[]): ClaudeToolDefinition[] {
  return tools.map(t => claudeSchemaConverter.convert({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }))
}

function buildBody(
  messages: ClaudeMessage[],
  tools: ProviderFunctionDeclaration[],
  opts: ChatOptions,
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxOutputTokens ?? 8192,
    messages,
    stream,
  }
  if (opts.systemInstruction) {
    body.system = opts.systemInstruction
  }
  if (opts.temperature !== undefined) {
    body.temperature = opts.temperature
  } else {
    body.temperature = 0.7
  }
  if (tools.length > 0) {
    body.tools = buildTools(tools)
  }
  return body
}

function inferModelInfo(modelId: string): ModelInfo {
  const id = modelId.toLowerCase()
  const isHaiku = id.includes('haiku')
  const ctx = id.includes('3-5') || id.includes('3-7') || id.includes('4') || id.includes('sonnet')
    ? 200_000
    : 100_000

  return {
    id: modelId,
    displayName: modelId,
    contextWindow: ctx,
    inputTokenLimit: ctx,
    outputTokenLimit: isHaiku ? 4096 : 8192,
    supportsTools: true,
    supportsVision: !id.includes('instant'),
    supportsStreaming: true,
  }
}

function contentToText(content: string | ClaudeContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'document') return '[Attached file]'
      if (block.type === 'tool_use') {
        return `[Called ${block.name}(${JSON.stringify(block.input)})]`
      }
      if (block.type === 'tool_result') {
        return `[Tool result: ${block.content}]`
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Appends any queued file attachments (opts.attachments — see
 * lib/pendingAttachments.ts) as extra `document` content blocks on the last
 * message, so they go out with this one request. Returns the same array
 * unchanged when there's nothing to attach.
 */
function withAttachments(messages: ClaudeMessage[], attachments?: PendingFileAttachment[]): ClaudeMessage[] {
  if (!attachments || attachments.length === 0) return messages
  if (messages.length === 0) return messages
  const attachmentBlocks: ClaudeContentBlock[] = attachments.map(a => ({
    type: 'document',
    source: { type: 'base64', media_type: a.mimeType, data: a.base64 },
  }))
  const last = messages[messages.length - 1]
  const lastBlocks: ClaudeContentBlock[] =
    typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content
  const updatedLast: ClaudeMessage = { ...last, content: [...lastBlocks, ...attachmentBlocks] }
  return [...messages.slice(0, -1), updatedLast]
}

// ── ClaudeProvider ─────────────────────────────────────────────────────────

export class ClaudeProvider implements AIProvider {
  readonly id = 'claude'
  readonly displayName = 'Anthropic Claude'

  isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'))
    )
  }

  supportsVision(): boolean {
    return true
  }

  supportsFileAttachments(): boolean {
    return true
  }

  mapFileAttachment(attachment: PendingFileAttachment): ClaudeContentBlock {
    return {
      type: 'document',
      source: { type: 'base64', media_type: attachment.mimeType, data: attachment.base64 },
    }
  }

  isQuotaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    const msg = err.message.toLowerCase()
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('overloaded') ||
      msg.includes('quota')
    )
  }

  async listModels(apiKey: string): Promise<ModelInfo[]> {
    const url = `${ANTHROPIC_BASE}/models`
    const res = await fetch(url, { headers: anthropicHeaders(apiKey) })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Claude API error ${res.status}: ${detail}`)
    }

    const json = await res.json() as {
      data?: { id: string; display_name?: string }[]
    }

    const models: ModelInfo[] = []
    for (const m of json.data ?? []) {
      const info = inferModelInfo(m.id)
      models.push({
        ...info,
        displayName: m.display_name || info.displayName,
      })
    }

    models.sort((a, b) => {
      const score = (id: string) => {
        if (id.includes('haiku')) return 0
        if (id.includes('sonnet')) return 1
        if (id.includes('opus')) return 2
        return 3
      }
      return score(a.id) - score(b.id) || a.id.localeCompare(b.id)
    })

    return models
  }

  async getUsage(_apiKey: string): Promise<ProviderUsage> {
    return { status: 'Usage data unavailable for Claude' }
  }

  toInternalMessages(messages: ProviderMessage[]): ClaudeMessage[] {
    return messages.map(m => {
      if (m.images?.length) {
        const blocks: ClaudeContentBlock[] = [
          ...m.images.map((img): ClaudeContentBlock => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
          })),
          { type: 'text', text: m.content },
        ]
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: blocks }
      }
      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }
    })
  }

  fromInternalMessages(history: unknown[]): ProviderMessage[] {
    return (history as ClaudeMessage[]).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: contentToText(m.content),
    }))
  }

  appendToolResults(
    history: unknown[],
    modelTurn: unknown,
    results: Array<{ name: string; result: Record<string, unknown> }>
  ): unknown[] {
    const msgs = [...(history as ClaudeMessage[])]
    const turn = modelTurn as ClaudeMessage
    const blocks = typeof turn.content === 'string' ? [] : turn.content
    const toolUses = blocks.filter(
      (b): b is Extract<ClaudeContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
    )

    const toolResultBlocks: ClaudeContentBlock[] = results.map((r, i) => {
      const matched =
        toolUses.find(tu => tu.name === r.name && !msgs.some(m => {
          if (typeof m.content === 'string') return false
          return m.content.some(
            b => b.type === 'tool_result' && b.tool_use_id === tu.id
          )
        })) ?? toolUses[i]

      return {
        type: 'tool_result',
        tool_use_id: matched?.id ?? `toolu_${r.name}_${i}`,
        content: JSON.stringify(r.result),
      }
    })

    msgs.push({ role: 'user', content: toolResultBlocks })
    return msgs
  }

  async stream(
    apiKey: string,
    messages: ProviderMessage[],
    callbacks: StreamCallbacks,
    opts: ChatOptions = {}
  ): Promise<void> {
    const url = `${ANTHROPIC_BASE}/messages`
    const claudeMessages = this.toInternalMessages(messages) as ClaudeMessage[]

    if (opts.signal?.aborted) return

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify(buildBody(withAttachments(claudeMessages, opts.attachments), [], opts, true)),
        signal: opts.signal,
      })
    } catch (err) {
      if (this.isAbortError(err)) return
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
      return
    }

    if (!response.ok) {
      let detail = ''
      try { detail = await response.text() } catch { /* ignore */ }
      callbacks.onError(new Error(`Claude API error ${response.status}: ${detail}`))
      return
    }

    const reader = response.body?.getReader()
    if (!reader) {
      callbacks.onError(new Error('Response body is not readable'))
      return
    }

    const decoder = new TextDecoder()
    let accumulated = ''
    let buffer = ''
    let currentEvent = ''

    const abortHandler = () => { reader.cancel().catch(() => {}) }
    opts.signal?.addEventListener('abort', abortHandler)

    try {
      while (true) {
        if (opts.signal?.aborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.slice(6).trim()
            continue
          }

          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data) as {
              type?: string
              delta?: { type?: string; text?: string }
            }

            const isTextDelta =
              (currentEvent === 'content_block_delta' || parsed.type === 'content_block_delta') &&
              parsed.delta?.type === 'text_delta' &&
              parsed.delta.text

            if (isTextDelta) {
              accumulated += parsed.delta!.text!
              callbacks.onChunk(parsed.delta!.text!)
            }
          } catch { /* malformed chunk */ }
        }
      }

      if (opts.signal?.aborted) return
      callbacks.onDone(accumulated)
    } catch (err) {
      if (this.isAbortError(err)) return
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      opts.signal?.removeEventListener('abort', abortHandler)
      reader.releaseLock()
    }
  }

  async agentTurn(
    apiKey: string,
    messages: unknown[],
    tools: ProviderFunctionDeclaration[],
    opts: ChatOptions = {}
  ): Promise<ProviderAgentTurn> {
    const url = `${ANTHROPIC_BASE}/messages`
    const claudeMessages = messages as ClaudeMessage[]

    const res = await fetch(url, {
      method: 'POST',
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify(buildBody(withAttachments(claudeMessages, opts.attachments), tools, opts, false)),
      signal: opts.signal,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Claude API error ${res.status}: ${detail}`)
    }

    const json = await res.json() as {
      content?: ClaudeContentBlock[]
      stop_reason?: string
    }

    const blocks = json.content ?? []
    let text = ''
    const functionCalls: ProviderAgentTurn['functionCalls'] = []

    for (const block of blocks) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'tool_use') {
        functionCalls.push({
          name: block.name,
          args: block.input ?? {},
        })
      }
    }

    const modelTurn: ClaudeMessage = {
      role: 'assistant',
      content: blocks.length > 0 ? blocks : [{ type: 'text', text }],
    }

    return { text, functionCalls, modelTurn }
  }
}
