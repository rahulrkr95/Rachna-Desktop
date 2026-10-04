// lib/providers/OpenRouterProvider.ts
// OpenRouter — a single API key that proxies to dozens of providers/models
// (including a number of free-tier models), via an OpenAI-compatible API.
// This widens the "free tier" options for users beyond just Gemini.

import type {
  AIProvider,
  ModelInfo,
  ProviderMessage,
  ProviderFunctionDeclaration,
  ProviderAgentTurn,
  StreamCallbacks,
  ChatOptions,
} from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'
import { respectOpenRouterFreeRateLimit } from './openRouterRateLimiter'

// OpenRouter model ids look like "openrouter-org/model-name[:free]" — there's
// no consistent prefix to filter on (unlike OpenAI/DeepSeek), so we accept
// everything the API returns and instead enrich with metadata below.
function isChatModel(_modelId: string): boolean {
  return true
}

function openRouterModelInfo(modelId: string): Partial<ModelInfo> {
  const id = modelId.toLowerCase()
  return {
    // OpenRouter model ids ending in ":free" are free-tier models — surface
    // that distinction by treating them as vision-incapable-by-default. Real
    // capability data comes back from the /models endpoint's `architecture`
    // and `top_provider` fields when available; this is a conservative
    // fallback for entries the registry doesn't enrich further.
    supportsTools: !id.includes('instruct-only'),
    supportsVision: id.includes('vision') || id.includes('vl') || id.includes('4o'),
    supportsStreaming: true,
  }
}

const OPENROUTER_DEFAULT_MODEL = 'meta-llama/llama-3.1-8b-instruct:free'

const openRouterImpl = createOpenAICompatibleProvider({
  id: 'openrouter',
  displayName: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: OPENROUTER_DEFAULT_MODEL,
  filterModel: isChatModel,
  modelInfo: openRouterModelInfo,
  supportsVision: true,
})

function logWait(wait: { reason: string; waitMs: number }): void {
  console.info(`[OpenRouter rate limit] ${wait.reason} — waiting ~${Math.round(wait.waitMs / 1000)}s`)
}

export class OpenRouterProvider implements AIProvider {
  readonly id = openRouterImpl.id
  readonly displayName = openRouterImpl.displayName

  isAbortError = openRouterImpl.isAbortError.bind(openRouterImpl)
  isQuotaError = openRouterImpl.isQuotaError.bind(openRouterImpl)
  supportsVision = openRouterImpl.supportsVision.bind(openRouterImpl)
  listModels = openRouterImpl.listModels.bind(openRouterImpl)
  getUsage = openRouterImpl.getUsage!.bind(openRouterImpl)
  toInternalMessages = openRouterImpl.toInternalMessages.bind(openRouterImpl)
  fromInternalMessages = openRouterImpl.fromInternalMessages.bind(openRouterImpl)
  appendToolResults = openRouterImpl.appendToolResults.bind(openRouterImpl)

  // Free-tier (":free" model) requests are rate-limited client-side before
  // being handed off to the shared OpenAI-compatible implementation — see
  // lib/providers/openRouterRateLimiter.ts. Paid models pass straight
  // through untouched.
  async stream(
    apiKey: string,
    messages: ProviderMessage[],
    callbacks: StreamCallbacks,
    opts: ChatOptions = {}
  ): Promise<void> {
    const model = opts.model ?? OPENROUTER_DEFAULT_MODEL
    try {
      await respectOpenRouterFreeRateLimit(apiKey, model, opts.signal, logWait)
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
      return
    }
    if (opts.signal?.aborted) return
    return openRouterImpl.stream(apiKey, messages, callbacks, opts)
  }

  async agentTurn(
    apiKey: string,
    messages: unknown[],
    tools: ProviderFunctionDeclaration[],
    opts: ChatOptions = {}
  ): Promise<ProviderAgentTurn> {
    const model = opts.model ?? OPENROUTER_DEFAULT_MODEL
    await respectOpenRouterFreeRateLimit(apiKey, model, opts.signal, logWait)
    return openRouterImpl.agentTurn(apiKey, messages, tools, opts)
  }
}
