import type { AIProvider, ChatOptions, ModelInfo, ProviderAgentTurn, ProviderFunctionDeclaration, ProviderMessage, StreamCallbacks } from './types'
import { useAuthStore } from '../../store/useAuthStore'
import { invoke } from '@tauri-apps/api/core'

type CloudMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Rachna Cloud is the ONLY feature that needs a Rachna account. When there's
 * no session, pop the sign-in dialog (store/useAuthStore.ts → components/
 * LoginScreen.tsx) and fail this request with a clear message; once the person
 * signs in they just resend.
 */
function sessionToken(): string {
  const token = useAuthStore.getState().sessionToken
  if (!token) {
    useAuthStore.getState().openLoginDialog()
    throw new Error('Sign in to use Rachna Cloud AI, or pick another provider (your own API key or a local model) in the model menu.')
  }
  return token
}

function responseText(body: unknown): string {
  if (typeof body === 'string') return body
  // POST /api/ai/cloud-provider (handlers.AIHandler.CloudProvider) always
  // returns `{ reply: string, response: {...}, ... }` — `reply` is the
  // plain-text answer; the other shapes below are kept only as a
  // defensive fallback in case the contract ever changes.
  const value = body as { reply?: unknown; content?: unknown; text?: unknown; response?: { text?: unknown }; result?: unknown; message?: { content?: unknown }; data?: { content?: unknown; text?: unknown; response?: unknown }; choices?: Array<{ message?: { content?: unknown }; text?: unknown }> }
  const found = [value?.reply, value?.content, value?.text, value?.response?.text, value?.result, value?.message?.content, value?.data?.content, value?.data?.text, value?.data?.response, value?.choices?.[0]?.message?.content, value?.choices?.[0]?.text]
    .find(candidate => typeof candidate === 'string')
  if (typeof found !== 'string') throw new Error('Rachna Cloud AI returned an unsupported response.')
  return found
}

/** The Cloud endpoint accepts one prompt and owns provider/model selection. */
export function buildCloudPrompt(messages: CloudMessage[], systemInstruction?: string, tools: ProviderFunctionDeclaration[] = []): string {
  const sections: string[] = []
  const system = systemInstruction?.trim()
  if (system) sections.push(`SYSTEM INSTRUCTIONS\n${system}`)
  sections.push(`CONVERSATION\n${messages.map(message => `[${message.role.toUpperCase()}]\n${message.content}`).join('\n\n')}`)
  if (tools.length) {
    sections.push(
      'AVAILABLE TOOLS\n' + JSON.stringify(tools) +
      '\n\nTo call tools, respond only with JSON in this exact shape: ' +
      '{"tool_calls":[{"name":"tool_name","args":{}}],"text":""}. ' +
      'Use only tools listed above and arguments matching their JSON schemas. When no tool is needed, respond normally.',
    )
  }
  return sections.join('\n\n')
}

async function generate(prompt: string, opts: ChatOptions = {}): Promise<string> {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  // Resolved outside the try/catch below so the "sign in" error reaches the
  // person as-is instead of being rewritten by cloudError().
  const token = sessionToken()
  let body: unknown
  try {
    body = await invoke<unknown>('cloud_ai_generate', { token, request: { prompt } })
  } catch (error) {
    throw cloudError(error)
  }
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const text = responseText(body)
  // Balance is display-only; the backend has already performed any deduction.
  void useAuthStore.getState().refreshUserInfo()
  return text
}

function cloudError(error: unknown): Error {
  const code = String(error)
  if (code.includes('CLOUD_AI_AUTHENTICATION')) {
    // The backend rejected the token (expired/revoked elsewhere): drop the dead session and ask again.
    void useAuthStore.getState().logout().then(() => useAuthStore.getState().openLoginDialog())
    return new Error('Your Rachna session is no longer authorized. Please sign in again.')
  }
  if (code.includes('CLOUD_AI_PERMISSION')) return new Error('Your Rachna account does not have permission for this AI request.')
  if (code.includes('CLOUD_AI_INSUFFICIENT_COINS')) return new Error('Insufficient coins. Check your Rachna Cloud balance and try again.')
  if (code.includes('CLOUD_AI_RATE_LIMITED')) return new Error('Rachna Cloud AI is temporarily rate limited. Please try again shortly.')
  if (code.includes('CLOUD_AI_SERVER')) return new Error('Rachna Cloud AI is temporarily unavailable. Please try again later.')
  if (code.includes('CLOUD_AI_NETWORK')) return new Error('Could not reach Rachna Cloud AI. Check your connection and try again.')
  if (code.includes('CLOUD_AI_RESPONSE')) return new Error('Rachna Cloud AI returned an unsupported response.')
  return new Error('Rachna Cloud AI could not process this request.')
}

function toMessages(messages: ProviderMessage[]): CloudMessage[] {
  if (messages.some(message => message.images?.length)) {
    throw new Error('Rachna Cloud AI does not currently support image input. Select a vision-capable direct provider to send images.')
  }
  return messages.map(message => ({ role: message.role, content: message.content }))
}

function parseToolCalls(text: string): ProviderAgentTurn['functionCalls'] {
  try {
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { tool_calls?: Array<{ name?: unknown; args?: unknown }> }
    return (parsed.tool_calls ?? []).flatMap(call =>
      typeof call.name === 'string' && call.args && typeof call.args === 'object' && !Array.isArray(call.args)
        ? [{ name: call.name, args: call.args as Record<string, unknown> }]
        : [],
    )
  } catch {
    return []
  }
}

export class RachnaCloudProvider implements AIProvider {
  readonly id = 'rachna-cloud'
  readonly displayName = 'Rachna Cloud AI (Default)'

  async listModels(_apiKey: string): Promise<ModelInfo[]> { return [] }
  toInternalMessages(messages: ProviderMessage[]): CloudMessage[] { return toMessages(messages) }
  fromInternalMessages(history: unknown[]): ProviderMessage[] {
    return (history as CloudMessage[]).filter(message => message.role !== 'system').map(message => ({ role: message.role as 'user' | 'assistant', content: message.content }))
  }
  appendToolResults(history: unknown[], _modelTurn: unknown, results: Array<{ name: string; result: Record<string, unknown> }>): unknown[] {
    return [...(history as CloudMessage[]), { role: 'user', content: `Tool results:\n${JSON.stringify(results)}` } satisfies CloudMessage]
  }

  async stream(_apiKey: string, messages: ProviderMessage[], callbacks: StreamCallbacks, opts: ChatOptions = {}): Promise<void> {
    try {
      const text = await generate(buildCloudPrompt(toMessages(messages), opts.systemInstruction), opts)
      if (opts.signal?.aborted) return
      callbacks.onChunk(text)
      callbacks.onDone(text)
    } catch (error) {
      if (!this.isAbortError(error)) callbacks.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async agentTurn(_apiKey: string, messages: unknown[], tools: ProviderFunctionDeclaration[], opts: ChatOptions = {}): Promise<ProviderAgentTurn> {
    const history = messages as CloudMessage[]
    const text = await generate(buildCloudPrompt(history, opts.systemInstruction, tools), opts)
    return { text, functionCalls: parseToolCalls(text), modelTurn: { role: 'assistant', content: text } satisfies CloudMessage }
  }

  isQuotaError(error: unknown): boolean { return error instanceof Error && /429|quota|coin|balance|rate limit/i.test(error.message) }
  isAbortError(error: unknown): boolean { return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message)) }
  supportsVision(): boolean { return false }
  supportsToolCalling(): boolean { return true }
}
