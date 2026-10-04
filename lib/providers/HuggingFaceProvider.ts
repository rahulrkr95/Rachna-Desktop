// lib/providers/HuggingFaceProvider.ts
// Hugging Face Inference — chat completions via Hugging Face's OpenAI-compatible
// "Inference Providers" router (https://router.huggingface.co/v1). A single HF
// access token (User Access Token, from https://huggingface.co/settings/tokens)
// authenticates requests; the `model` field accepts ANY Hugging Face Hub model
// id the token has inference access to, e.g. "bharatgenai/Param-1" or
// "meta-llama/Llama-3.1-8B-Instruct".
//
// Because the Hub hosts hundreds of thousands of repos, `/v1/models` on the
// router only ever returns a curated subset of "warm" models — it is NOT an
// exhaustive catalogue. So on top of that best-effort discovery list, the
// Settings UI lets the person type any model id directly (see
// `buildCustomModelInfo` below, used by ConfigurePanel's "Add Model" field in
// components/SettingsModal.tsx). Both paths produce ordinary `ModelInfo`
// entries — nothing downstream (agent loop, chat, tool calling) needs to know
// the difference.

import type { AIProvider, ModelInfo } from './types'
import { createOpenAICompatibleProvider } from './openaiCompatible'

export const HUGGINGFACE_ROUTER_URL = 'https://router.huggingface.co/v1'

// The router aggregates many underlying inference providers; nothing in the
// model id namespace reliably tells us it's a chat model, so accept everything
// discovery returns and let modelInfo() enrich it.
function isHuggingFaceChatModel(_modelId: string): boolean {
  return true
}

function huggingFaceModelInfo(modelId: string): Partial<ModelInfo> {
  const id = modelId.toLowerCase()
  return {
    // Tool/function calling depends on the specific model + provider backing
    // it on the router; we can't know for certain from the id alone, so default
    // to true (most modern instruct models support it) and let real errors
    // surface if a given combination genuinely doesn't.
    supportsTools: !id.includes('embed'),
    supportsVision: id.includes('vl') || id.includes('vision') || id.includes('image'),
    supportsStreaming: true,
  }
}

const huggingFaceImpl = createOpenAICompatibleProvider({
  id: 'huggingface',
  displayName: 'Hugging Face',
  baseUrl: HUGGINGFACE_ROUTER_URL,
  // No sensible static default — the whole point of this provider is that the
  // person names an exact Hub repo. Mirrors the lmstudio/ollama/zenmux pattern
  // of "no default, use whatever was discovered/entered first".
  defaultModel: '',
  filterModel: isHuggingFaceChatModel,
  modelInfo: huggingFaceModelInfo,
  supportsVision: true,
  reportUsage: true,
})

export class HuggingFaceProvider implements AIProvider {
  readonly id = huggingFaceImpl.id
  readonly displayName = huggingFaceImpl.displayName

  isAbortError = huggingFaceImpl.isAbortError.bind(huggingFaceImpl)
  isQuotaError = huggingFaceImpl.isQuotaError.bind(huggingFaceImpl)
  supportsVision = huggingFaceImpl.supportsVision.bind(huggingFaceImpl)
  listModels = huggingFaceImpl.listModels.bind(huggingFaceImpl)
  getUsage = huggingFaceImpl.getUsage!.bind(huggingFaceImpl)
  toInternalMessages = huggingFaceImpl.toInternalMessages.bind(huggingFaceImpl)
  fromInternalMessages = huggingFaceImpl.fromInternalMessages.bind(huggingFaceImpl)
  appendToolResults = huggingFaceImpl.appendToolResults.bind(huggingFaceImpl)
  stream = huggingFaceImpl.stream.bind(huggingFaceImpl)
  agentTurn = huggingFaceImpl.agentTurn.bind(huggingFaceImpl)
}

// ── Manual model entry helper ───────────────────────────────────────────────
// Used by the Settings UI to turn a free-typed Hub model id into a ModelInfo
// the rest of the app can treat exactly like a discovered one.

export function buildCustomHuggingFaceModel(modelId: string): ModelInfo {
  const trimmed = modelId.trim()
  return {
    id: trimmed,
    displayName: trimmed,
    ...huggingFaceModelInfo(trimmed),
    supportsTools: huggingFaceModelInfo(trimmed).supportsTools ?? true,
    supportsVision: huggingFaceModelInfo(trimmed).supportsVision ?? false,
    supportsStreaming: true,
  }
}

/** Basic sanity check for a Hugging Face Hub model id ("owner/repo" or a bare name). */
export function isValidHuggingFaceModelId(modelId: string): boolean {
  const trimmed = modelId.trim()
  if (!trimmed) return false
  // Allow "owner/repo", "owner/repo:provider" (router provider-pin syntax), or a bare repo name.
  return /^[\w.-]+(\/[\w.-]+)?(:[\w.-]+)?$/.test(trimmed)
}
