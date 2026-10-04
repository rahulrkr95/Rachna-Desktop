// lib/providers/OpenAIProvider.ts
// OpenAI chat completions via the OpenAI-compatible API.

import type { AIProvider } from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'

const CHAT_MODEL_PREFIXES = [
  'gpt-4',
  'gpt-3.5',
  'gpt-5',
  'o1',
  'o3',
  'o4',
  'chatgpt',
]

const EXCLUDED_PATTERNS = [
  'embed',
  'whisper',
  'tts',
  'dall-e',
  'davinci',
  'babbage',
  'curie',
  'ada',
  'moderation',
  'realtime',
  'transcribe',
  'sora',
]

function isChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (EXCLUDED_PATTERNS.some(p => id.includes(p))) return false
  return CHAT_MODEL_PREFIXES.some(p => id.startsWith(p))
}

const openaiImpl = createOpenAICompatibleProvider({
  id: 'openai',
  displayName: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  filterModel: isChatModel,
  supportsVision: true,
})

export class OpenAIProvider implements AIProvider {
  readonly id = openaiImpl.id
  readonly displayName = openaiImpl.displayName

  isAbortError = openaiImpl.isAbortError.bind(openaiImpl)
  isQuotaError = openaiImpl.isQuotaError.bind(openaiImpl)
  supportsVision = openaiImpl.supportsVision.bind(openaiImpl)
  listModels = openaiImpl.listModels.bind(openaiImpl)
  getUsage = openaiImpl.getUsage!.bind(openaiImpl)
  toInternalMessages = openaiImpl.toInternalMessages.bind(openaiImpl)
  fromInternalMessages = openaiImpl.fromInternalMessages.bind(openaiImpl)
  appendToolResults = openaiImpl.appendToolResults.bind(openaiImpl)
  stream = openaiImpl.stream.bind(openaiImpl)
  agentTurn = openaiImpl.agentTurn.bind(openaiImpl)
}
