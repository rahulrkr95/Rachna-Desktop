// lib/providers/lmStudioNative.ts
//
// Native LM Studio REST API client — implements LM Studio's own
// `/api/v1/models` and `/api/v1/chat` endpoints directly, per:
//   https://lmstudio.ai/docs/developer/rest/list
//   https://lmstudio.ai/docs/developer/rest/chat
//   https://lmstudio.ai/docs/developer/rest/streaming-events
//
// This is intentionally NOT the OpenAI-compatible surface
// (`/v1/models`, `/v1/chat/completions`). It speaks LM Studio's
// own request/response shapes so it works with any model LM Studio
// can load, without any OpenAI-specific assumptions.
//
// ── Tool calling note ───────────────────────────────────────────────────────
// LM Studio's native `/api/v1/chat` endpoint only accepts *server-side*
// tool sources (`integrations`: plugins / ephemeral MCP servers) — it has
// no field for passing arbitrary client-defined function schemas the way
// OpenAI's `tools` parameter does. To keep this IDE's existing agentic
// tool-calling loop (file edits, search, terminal, etc.) working against
// the native API, we describe the available tools in the system prompt and
// ask the model to reply with a single fenced ```tool_call``` JSON block
// when it wants to invoke one. This is parsed client-side. When the model
// has no tool call to make, it just replies normally and we treat the
// turn as final.

import type {
  AIProvider,
  ModelInfo,
  ProviderMessage,
  ProviderFunctionDeclaration,
  ProviderAgentTurn,
  StreamCallbacks,
  ChatOptions,
  ProviderUsage,
} from './types'
import { openAISchemaConverter } from './schemaConverters/OpenAISchemaConverter'

// ── Internal message format ─────────────────────────────────────────────────

export interface LMMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** Set on assistant turns that contained a parsed tool call. */
  toolCall?: { name: string; args: Record<string, unknown> }
  /** Set on tool-result messages so we can label them in the transcript. */
  toolName?: string
}

export interface LMStudioNativeConfig {
  getBaseUrl: () => string
  getApiKey: () => string
  displayName?: string
}

// ── /api/v1/models response shapes ──────────────────────────────────────────

interface LMStudioModelCapabilities {
  vision?: boolean
  trained_for_tool_use?: boolean
}

interface LMStudioModelEntry {
  type: 'llm' | 'embedding'
  key: string
  display_name?: string
  max_context_length?: number
  format?: 'gguf' | 'mlx' | null
  capabilities?: LMStudioModelCapabilities
}

interface LMStudioModelsResponse {
  models?: LMStudioModelEntry[]
}

// ── /api/v1/chat request/response shapes ────────────────────────────────────

type LMChatInputItem =
  | { type: 'message'; content: string }

interface LMChatRequestBody {
  model: string
  input: string | LMChatInputItem[]
  system_prompt?: string
  stream?: boolean
  temperature?: number
  max_output_tokens?: number
  store?: boolean
}

type LMChatOutputItem =
  | { type: 'message'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; tool: string; arguments: Record<string, unknown>; output?: string }
  | { type: 'invalid_tool_call'; reason: string }

interface LMChatResponse {
  model_instance_id?: string
  output?: LMChatOutputItem[]
  response_id?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/models`
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/chat`
}

function isLMStudioChatModel(entry: LMStudioModelEntry): boolean {
  return entry.type === 'llm'
}

function toModelInfo(entry: LMStudioModelEntry): ModelInfo {
  const caps = entry.capabilities
  return {
    id: entry.key,
    displayName: entry.display_name || entry.key,
    contextWindow: entry.max_context_length,
    inputTokenLimit: entry.max_context_length,
    outputTokenLimit: undefined,
    supportsTools: caps?.trained_for_tool_use ?? false,
    supportsVision: caps?.vision ?? false,
    supportsStreaming: true,
  }
}

// ── Tool-call protocol embedded via system prompt ───────────────────────────

export function buildToolProtocolInstructions(tools: ProviderFunctionDeclaration[]): string {
  if (tools.length === 0) return ''
  // LM Studio has no structured `tools` request field (see the module
  // header note above) — tool schemas are embedded as JSON text in the
  // prompt instead. They still go through OpenAISchemaConverter first so
  // the model sees the same sanitized schema (no $schema/$defs/deprecated/
  // etc. noise) it would if this were a real `tools` field, and so this
  // stays consistent with every other OpenAI-compatible provider.
  const toolDocs = tools
    .map(t => {
      const fn = openAISchemaConverter.convert({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })
      return `- ${fn.name}: ${fn.description}\n  parameters (JSON Schema): ${JSON.stringify(fn.parameters)}`
    })
    .join('\n')

  return [
    'You have access to the following tools. To call one, reply with ONLY a single',
    'fenced code block of the exact form below, and nothing else in that turn:',
    '',
    '```tool_call',
    '{"name": "<tool name>", "arguments": { ... }}',
    '```',
    '',
    'Available tools:',
    toolDocs,
    '',
    'If no tool call is needed, just answer normally in plain text without the',
    'tool_call code block.',
  ].join('\n')
}

const TOOL_CALL_BLOCK_RE = /```tool_call\s*([\s\S]*?)```/

function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  const match = TOOL_CALL_BLOCK_RE.exec(text)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1].trim()) as { name?: string; arguments?: unknown }
    if (!parsed.name) return null
    // Guard against a model emitting `arguments` as a bare string/array/number
    // instead of an object — passing that straight through breaks downstream
    // tool schema validation ("Expected object, received string").
    const args =
      parsed.arguments !== null && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? (parsed.arguments as Record<string, unknown>)
        : {}
    return { name: parsed.name, args }
  } catch {
    return null
  }
}

function stripToolCallBlock(text: string): string {
  return text.replace(TOOL_CALL_BLOCK_RE, '').trim()
}

// ── Transcript building ──────────────────────────────────────────────────
// The native /api/v1/chat endpoint takes a single `input` (string or array
// of role-less "message" items) plus a separate `system_prompt`. There is no
// per-item role field, so multi-turn history is rendered as a labelled
// transcript and sent as one input string — this keeps every turn (user,
// assistant, tool result) visible to the model without inventing an
// OpenAI-style messages array.

function renderTranscript(history: LMMessage[]): string {
  const lines: string[] = []
  for (const m of history) {
    if (m.role === 'user') {
      lines.push(`User: ${m.content}`)
    } else if (m.role === 'assistant') {
      if (m.toolCall) {
        lines.push(`Assistant: [called tool ${m.toolCall.name} with ${JSON.stringify(m.toolCall.args)}]`)
      } else {
        lines.push(`Assistant: ${m.content}`)
      }
    } else {
      lines.push(`Tool result (${m.toolName ?? 'unknown'}): ${m.content}`)
    }
  }
  return lines.join('\n\n')
}

function outputText(output: LMChatOutputItem[] | undefined): string {
  if (!output) return ''
  return output
    .filter((o): o is { type: 'message'; content: string } => o.type === 'message')
    .map(o => o.content)
    .join('')
}

// ── Provider factory ─────────────────────────────────────────────────────

export function createLMStudioNativeProvider(config: LMStudioNativeConfig): AIProvider {
  const displayName = config.displayName ?? 'LM Studio'

  function describeConnectionError(err: unknown, baseUrl: string): Error {
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes('fetch') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('NetworkError') ||
      msg.includes('Failed to fetch')
    ) {
      const port = baseUrl.match(/:(\d+)/)?.[1] ?? '1234'
      return new Error(
        `Could not connect to LM Studio at ${baseUrl}. ` +
        `Make sure LM Studio is running and the local server is enabled (port ${port}).`
      )
    }
    return err instanceof Error ? err : new Error(msg)
  }

  return {
    id: 'lmstudio',
    displayName,

    isAbortError(err: unknown): boolean {
      return err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))
    },

    isQuotaError(err: unknown): boolean {
      if (!(err instanceof Error)) return false
      const msg = err.message.toLowerCase()
      return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    },

    supportsVision(): boolean {
      return false
    },

    async listModels(_apiKey: string): Promise<ModelInfo[]> {
      const baseUrl = config.getBaseUrl()
      const apiKey = config.getApiKey()
      const url = modelsUrl(baseUrl)
      console.info(`[LM Studio] listModels → GET ${url}`)
      let res: Response
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: authHeaders(apiKey),
        })
      } catch (err) {
        throw describeConnectionError(err, baseUrl)
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`${displayName} API error ${res.status}: ${detail}`)
      }

      const json = (await res.json()) as LMStudioModelsResponse
      const models = (json.models ?? [])
        .filter(isLMStudioChatModel)
        .map(toModelInfo)

      models.sort((a, b) => a.displayName.localeCompare(b.displayName))
      return models
    },

    async getUsage(_apiKey: string): Promise<ProviderUsage> {
      return { status: 'Local model — no usage limits' }
    },

    toInternalMessages(messages: ProviderMessage[]): LMMessage[] {
      return messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }))
    },

    fromInternalMessages(history: unknown[]): ProviderMessage[] {
      return (history as LMMessage[]).map(m => {
        if (m.role === 'tool') {
          return { role: 'user', content: `[Tool result (${m.toolName ?? 'unknown'}): ${m.content}]` }
        }
        if (m.role === 'assistant' && m.toolCall) {
          return {
            role: 'assistant',
            content: `[Called ${m.toolCall.name}(${JSON.stringify(m.toolCall.args)})]`,
          }
        }
        return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }
      })
    },

    appendToolResults(
      history: unknown[],
      _modelTurn: unknown,
      results: Array<{ name: string; result: Record<string, unknown> }>
    ): unknown[] {
      const msgs = [...(history as LMMessage[])]
      for (const r of results) {
        msgs.push({
          role: 'tool',
          toolName: r.name,
          content: JSON.stringify(r.result),
        })
      }
      return msgs
    },

    async stream(
      _apiKey: string,
      messages: ProviderMessage[],
      callbacks: StreamCallbacks,
      opts: ChatOptions = {}
    ): Promise<void> {
      const baseUrl = config.getBaseUrl()
      const apiKey = config.getApiKey()
      const model = opts.model ?? ''
      const history = this.toInternalMessages(messages) as LMMessage[]
      const input = renderTranscript(history)

      const body: LMChatRequestBody = {
        model,
        input,
        system_prompt: opts.systemInstruction,
        stream: true,
        temperature: opts.temperature ?? 0.7,
        max_output_tokens: opts.maxOutputTokens ?? 4096,
        store: false,
      }

      let response: Response
      const streamUrl = chatUrl(baseUrl)
      console.info(`[LM Studio] stream → POST ${streamUrl} (model: ${model})`)
      try {
        response = await fetch(streamUrl, {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify(body),
          signal: opts.signal,
        })
      } catch (err) {
        if (this.isAbortError(err)) return
        callbacks.onError(describeConnectionError(err, baseUrl))
        return
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        callbacks.onError(new Error(`${displayName} API error ${response.status}: ${detail}`))
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
            if (!trimmed) { currentEvent = ''; continue }
            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.slice(6).trim()
              continue
            }
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data) continue
            try {
              const parsed = JSON.parse(data) as { type?: string; content?: string }
              const evType = parsed.type ?? currentEvent
              if (evType === 'message.delta' && parsed.content) {
                accumulated += parsed.content
                callbacks.onChunk(parsed.content)
              } else if (evType === 'error') {
                const errObj = (parsed as unknown as { error?: { message?: string } }).error
                callbacks.onError(new Error(errObj?.message ?? 'LM Studio stream error'))
                return
              }
            } catch { /* malformed event */ }
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
    },

    async agentTurn(
      _apiKey: string,
      messages: unknown[],
      tools: ProviderFunctionDeclaration[],
      opts: ChatOptions = {}
    ): Promise<ProviderAgentTurn> {
      const baseUrl = config.getBaseUrl()
      const apiKey = config.getApiKey()
      const model = opts.model ?? ''
      const history = messages as LMMessage[]
      const input = renderTranscript(history)

      const toolInstructions = buildToolProtocolInstructions(tools)
      const systemPrompt = [opts.systemInstruction, toolInstructions].filter(Boolean).join('\n\n')

      const body: LMChatRequestBody = {
        model,
        input,
        system_prompt: systemPrompt || undefined,
        stream: false,
        temperature: opts.temperature ?? 0.7,
        max_output_tokens: opts.maxOutputTokens ?? 4096,
        store: false,
      }

      let res: Response
      const agentUrl = chatUrl(baseUrl)
      console.info(`[LM Studio] agentTurn → POST ${agentUrl} (model: ${model})`)
      try {
        res = await fetch(agentUrl, {
          method: 'POST',
          headers: authHeaders(apiKey),
          body: JSON.stringify(body),
          signal: opts.signal,
        })
      } catch (err) {
        throw describeConnectionError(err, baseUrl)
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`${displayName} API error ${res.status}: ${detail}`)
      }

      const json = (await res.json()) as LMChatResponse
      const rawText = outputText(json.output)
      const toolCall = parseToolCall(rawText)

      if (toolCall) {
        const modelTurn: LMMessage = { role: 'assistant', content: rawText, toolCall }
        return {
          text: stripToolCallBlock(rawText),
          functionCalls: [toolCall],
          modelTurn,
        }
      }

      const modelTurn: LMMessage = { role: 'assistant', content: rawText }
      return { text: rawText, functionCalls: [], modelTurn }
    },
  }
}
