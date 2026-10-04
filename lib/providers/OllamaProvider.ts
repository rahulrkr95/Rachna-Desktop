// lib/providers/OllamaProvider.ts
// Ollama provider — uses Ollama's OpenAI-compatible local API server.
//
// Ollama ships with a built-in OpenAI-compatible endpoint at
//   http://localhost:11434/v1
// This provider reads the configured base URL at call-time from
// localStorage so users can change it in Settings without restarting.
//
// Key differences from cloud providers (mirrors LMStudioProvider):
//  • No API key required
//  • baseUrl is user-configurable (default: http://localhost:11434/v1)
//  • Model list comes from whatever the user has pulled locally (`ollama pull ...`)
//  • Tools/streaming supported if the loaded model supports it

import type { AIProvider, ModelInfo, ProviderMessage, ProviderFunctionDeclaration, ProviderAgentTurn, StreamCallbacks, ChatOptions, ProviderUsage } from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'

// ── Config persistence ─────────────────────────────────────────────────────

export const OLLAMA_URL_KEY = 'rachna_ide_ollama_url'

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434/v1'

export function getOllamaBaseUrl(): string {
  try {
    return localStorage.getItem(OLLAMA_URL_KEY) || OLLAMA_DEFAULT_URL
  } catch {
    return OLLAMA_DEFAULT_URL
  }
}

export function setOllamaBaseUrl(url: string): void {
  try {
    localStorage.setItem(OLLAMA_URL_KEY, url.trim() || OLLAMA_DEFAULT_URL)
  } catch { /* ignore */ }
}

// ── Ollama filter ───────────────────────────────────────────────────────
// Ollama exposes whatever models the user has pulled locally; accept
// everything except obviously non-chat embedding models.

function isOllamaChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (id.includes('embed') || id.includes('nomic') || id.includes('bge-') || id.includes('minilm')) {
    return false
  }
  return true
}

// ── Model-info heuristics for locally pulled models ────────────────────────

function ollamaModelInfo(modelId: string): Partial<ModelInfo> {
  const id = modelId.toLowerCase()

  let contextWindow: number | undefined
  if (id.includes('128k'))                                contextWindow = 128_000
  else if (id.includes('llama3') || id.includes('llama-3')) contextWindow = 128_000
  else if (id.includes('mistral') || id.includes('mixtral')) contextWindow = 32_000
  else if (id.includes('qwen'))                            contextWindow = 32_000
  else if (id.includes('phi3') || id.includes('phi-3'))    contextWindow = 128_000
  else if (id.includes('gemma'))                           contextWindow = 8_192

  const supportsTools =
    id.includes('llama3') || id.includes('llama-3') ||
    id.includes('qwen') || id.includes('mistral') ||
    id.includes('mixtral') || id.includes('hermes') ||
    id.includes('functionary') || id.includes('command-r')

  const supportsVision =
    id.includes('vision') || id.includes('llava') ||
    id.includes('bakllava') || id.includes('moondream') ||
    id.includes('minicpm-v')

  return {
    contextWindow,
    inputTokenLimit: contextWindow,
    outputTokenLimit: 8192,
    supportsTools,
    supportsVision,
    supportsStreaming: true,
  }
}

// ── Dynamic-URL wrapper ────────────────────────────────────────────────────
// Mirrors LMStudioProvider: we can't bake a static baseUrl into the impl
// since the user may change it in Settings, so build a fresh impl per call.

function getImpl() {
  return createOpenAICompatibleProvider({
    id: 'ollama',
    displayName: 'Ollama',
    baseUrl: getOllamaBaseUrl(),
    defaultModel: '', // no single default; first discovered/pulled model is used
    filterModel: isOllamaChatModel,
    modelInfo: ollamaModelInfo,
    // Ollama errors on a bad URL with network errors, not 429s
    isQuotaError: (err: unknown) => {
      if (!(err instanceof Error)) return false
      const msg = err.message.toLowerCase()
      return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    },
  })
}

// ── OllamaProvider ───────────────────────────────────────────────────────

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama'
  readonly displayName = 'Ollama'

  isAbortError(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.name === 'AbortError' || err.message.includes('aborted'))
    )
  }

  isQuotaError(err: unknown): boolean {
    return getImpl().isQuotaError(err)
  }

  supportsVision(): boolean {
    return false
  }

  async listModels(_apiKey: string): Promise<ModelInfo[]> {
    try {
      // Ollama doesn't require a key; pass an empty string through.
      return await getImpl().listModels('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        msg.includes('fetch') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('NetworkError') ||
        msg.includes('Failed to fetch')
      ) {
        throw new Error(
          `Could not connect to Ollama at ${getOllamaBaseUrl()}. ` +
          `Make sure Ollama is running (\`ollama serve\`) and you've pulled at least one model (\`ollama pull llama3.1\`).`
        )
      }
      throw err
    }
  }

  async getUsage(_apiKey: string): Promise<ProviderUsage> {
    return { status: 'Local model — no usage limits' }
  }

  toInternalMessages(messages: ProviderMessage[]): unknown[] {
    return getImpl().toInternalMessages(messages)
  }

  fromInternalMessages(history: unknown[]): ProviderMessage[] {
    return getImpl().fromInternalMessages(history)
  }

  appendToolResults(
    history: unknown[],
    modelTurn: unknown,
    results: Array<{ name: string; result: Record<string, unknown> }>
  ): unknown[] {
    return getImpl().appendToolResults(history, modelTurn, results)
  }

  async stream(
    _apiKey: string,
    messages: ProviderMessage[],
    callbacks: StreamCallbacks,
    opts?: ChatOptions
  ): Promise<void> {
    return getImpl().stream('', messages, callbacks, opts)
  }

  async agentTurn(
    _apiKey: string,
    messages: unknown[],
    tools: ProviderFunctionDeclaration[],
    opts?: ChatOptions
  ): Promise<ProviderAgentTurn> {
    return getImpl().agentTurn('', messages, tools, opts)
  }
}
