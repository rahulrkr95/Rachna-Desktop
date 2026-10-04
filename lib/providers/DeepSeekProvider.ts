// lib/providers/DeepSeekProvider.ts
// DeepSeek chat completions via their OpenAI-compatible API.

import type { AIProvider } from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'

function isDeepSeekChatModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id.startsWith('deepseek-') && !id.includes('embed')
}

const deepseekImpl = createOpenAICompatibleProvider({
  id: 'deepseek',
  displayName: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
  filterModel: isDeepSeekChatModel,
  modelInfo(modelId) {
    const id = modelId.toLowerCase()
    return {
      supportsTools: id === 'deepseek-chat' || id === 'deepseek-reasoner',
      supportsVision: false,
      contextWindow: 64_000,
      inputTokenLimit: 64_000,
      outputTokenLimit: 8192,
    }
  },
})

export class DeepSeekProvider implements AIProvider {
  readonly id = deepseekImpl.id
  readonly displayName = deepseekImpl.displayName

  isAbortError = deepseekImpl.isAbortError.bind(deepseekImpl)
  isQuotaError = deepseekImpl.isQuotaError.bind(deepseekImpl)
  supportsVision = deepseekImpl.supportsVision.bind(deepseekImpl)
  listModels = deepseekImpl.listModels.bind(deepseekImpl)
  getUsage = deepseekImpl.getUsage!.bind(deepseekImpl)
  toInternalMessages = deepseekImpl.toInternalMessages.bind(deepseekImpl)
  fromInternalMessages = deepseekImpl.fromInternalMessages.bind(deepseekImpl)
  appendToolResults = deepseekImpl.appendToolResults.bind(deepseekImpl)
  stream = deepseekImpl.stream.bind(deepseekImpl)
  agentTurn = deepseekImpl.agentTurn.bind(deepseekImpl)
}
