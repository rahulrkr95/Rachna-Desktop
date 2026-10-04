// lib/providers/GroqProvider.ts
// Groq — ultra-fast LPU-hosted inference (Llama, Mixtral, Gemma, Whisper,
// etc.) via an OpenAI-compatible chat completions API. Groq has a generous
// free tier for personal API keys, gated by their own per-model RPM/RPD/TPM
// limits (see https://console.groq.com/docs/rate-limits) — surfaced to the
// user in Settings rather than hard-enforced client-side, since limits vary
// a lot by model and change over time.

import type { AIProvider } from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'

function isGroqChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  // Exclude audio (whisper) and moderation (guard) models — text chat only.
  return !id.includes('whisper') && !id.includes('guard') && !id.includes('tts')
}

// Groq's /models endpoint doesn't return context window sizes, so we keep a
// small known-model table (mirrors DeepSeekProvider's approach) and fall back
// to a conservative default for anything not listed.
const GROQ_CONTEXT_WINDOWS: Record<string, number> = {
  'llama-3.3-70b-versatile': 128_000,
  'llama-3.1-8b-instant': 128_000,
  'llama3-70b-8192': 8_192,
  'llama3-8b-8192': 8_192,
  'mixtral-8x7b-32768': 32_768,
  'gemma2-9b-it': 8_192,
  'deepseek-r1-distill-llama-70b': 128_000,
  'qwen-2.5-32b': 128_000,
}

function inferGroqContextWindow(modelId: string): number | undefined {
  if (GROQ_CONTEXT_WINDOWS[modelId]) return GROQ_CONTEXT_WINDOWS[modelId]
  const prefix = Object.keys(GROQ_CONTEXT_WINDOWS).find(k => modelId.startsWith(k))
  return prefix ? GROQ_CONTEXT_WINDOWS[prefix] : 32_768
}

const groqImpl = createOpenAICompatibleProvider({
  id: 'groq',
  displayName: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  filterModel: isGroqChatModel,
  modelInfo(modelId) {
    const id = modelId.toLowerCase()
    const ctx = inferGroqContextWindow(id)
    return {
      supportsTools: !id.includes('vision'),
      supportsVision: id.includes('vision') || id.includes('scout') || id.includes('maverick'),
      contextWindow: ctx,
      inputTokenLimit: ctx,
      outputTokenLimit: 8_192,
    }
  },
})

export class GroqProvider implements AIProvider {
  readonly id = groqImpl.id
  readonly displayName = groqImpl.displayName

  isAbortError = groqImpl.isAbortError.bind(groqImpl)
  isQuotaError = groqImpl.isQuotaError.bind(groqImpl)
  supportsVision = groqImpl.supportsVision.bind(groqImpl)
  listModels = groqImpl.listModels.bind(groqImpl)
  getUsage = groqImpl.getUsage!.bind(groqImpl)
  toInternalMessages = groqImpl.toInternalMessages.bind(groqImpl)
  fromInternalMessages = groqImpl.fromInternalMessages.bind(groqImpl)
  appendToolResults = groqImpl.appendToolResults.bind(groqImpl)
  stream = groqImpl.stream.bind(groqImpl)
  agentTurn = groqImpl.agentTurn.bind(groqImpl)
}
