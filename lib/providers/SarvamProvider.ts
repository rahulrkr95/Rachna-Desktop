// lib/providers/SarvamProvider.ts
// Sarvam AI — Indian multilingual LLMs via Sarvam's OpenAI-compatible Chat
// Completions API (https://api.sarvam.ai/v1). Model ids (e.g. "sarvam-105b")
// come back from `/v1/models` like any other OpenAI-compatible provider, so
// new models Sarvam ships later show up automatically without a code change —
// no special-casing needed beyond this thin config, same as Groq/DeepSeek.

import type { AIProvider } from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'

export const SARVAM_BASE_URL = 'https://api.sarvam.ai/v1'
export const SARVAM_DEFAULT_MODEL = 'sarvam-105b'

// Sarvam's catalogue is small and all conversational — accept everything
// discovery returns rather than trying to guess a naming convention that
// hasn't been fixed yet ("any future models" per product requirements).
function isSarvamChatModel(_modelId: string): boolean {
  return true
}

const sarvamImpl = createOpenAICompatibleProvider({
  id: 'sarvam',
  displayName: 'Sarvam AI',
  baseUrl: SARVAM_BASE_URL,
  defaultModel: SARVAM_DEFAULT_MODEL,
  filterModel: isSarvamChatModel,
  modelInfo(_modelId) {
    return {
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
    }
  },
  supportsVision: false,
  // Sarvam's chat completions responses include standard OpenAI-style
  // `usage` accounting — surface it through getUsage() via the shared
  // OpenAI-compatible usage tracker instead of duplicating parsing logic.
  reportUsage: true,
})

export class SarvamProvider implements AIProvider {
  readonly id = sarvamImpl.id
  readonly displayName = sarvamImpl.displayName

  isAbortError = sarvamImpl.isAbortError.bind(sarvamImpl)
  isQuotaError = sarvamImpl.isQuotaError.bind(sarvamImpl)
  supportsVision = sarvamImpl.supportsVision.bind(sarvamImpl)
  listModels = sarvamImpl.listModels.bind(sarvamImpl)
  getUsage = sarvamImpl.getUsage!.bind(sarvamImpl)
  toInternalMessages = sarvamImpl.toInternalMessages.bind(sarvamImpl)
  fromInternalMessages = sarvamImpl.fromInternalMessages.bind(sarvamImpl)
  appendToolResults = sarvamImpl.appendToolResults.bind(sarvamImpl)
  stream = sarvamImpl.stream.bind(sarvamImpl)
  agentTurn = sarvamImpl.agentTurn.bind(sarvamImpl)
}
