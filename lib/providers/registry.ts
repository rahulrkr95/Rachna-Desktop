// lib/providers/registry.ts
// Central registry of all supported AI providers.
// Add new providers here — the rest of the app finds them through getProvider().

import type { AIProvider } from './types'
import { GeminiProvider } from './GeminiProvider'
import { OpenAIProvider } from './OpenAIProvider'
import { ClaudeProvider } from './ClaudeProvider'
import { DeepSeekProvider } from './DeepSeekProvider'
import { LMStudioProvider } from './LMStudioProvider'
import { OpenRouterProvider } from './OpenRouterProvider'
import { OllamaProvider } from './OllamaProvider'
import { ZenmuxProvider } from './ZenmuxProvider'
import { GroqProvider } from './GroqProvider'
import { HuggingFaceProvider } from './HuggingFaceProvider'
import { SarvamProvider } from './SarvamProvider'
import { RachnaCloudProvider } from './RachnaCloudProvider'
import {
  checkModelHealth as checkModelHealthImpl,
  checkModelsHealth as checkModelsHealthImpl,
} from './modelHealth'
import type {
  ModelHealthResult,
  ModelHealthCheckOptions,
  ModelHealthBatchOptions,
} from './modelHealth'

const PROVIDERS: AIProvider[] = [
  new RachnaCloudProvider(),
  new GeminiProvider(),
  new OpenAIProvider(),
  new ClaudeProvider(),
  new DeepSeekProvider(),
  new OpenRouterProvider(),
  new GroqProvider(),
  new ZenmuxProvider(),
  new HuggingFaceProvider(),
  new SarvamProvider(),
  new LMStudioProvider(),
  new OllamaProvider(),
]

/** All registered providers. */
export function getAllProviders(): AIProvider[] {
  return PROVIDERS
}

/** Look up a provider by id (e.g. "gemini", "openai"). */
export function getProvider(id: string): AIProvider | undefined {
  return PROVIDERS.find(p => p.id === id)
}

/** Convenience: get provider or throw. */
export function requireProvider(id: string): AIProvider {
  const p = getProvider(id)
  if (!p) throw new Error(`No provider registered with id "${id}"`)
  return p
}

// ── Model health checks ──────────────────────────────────────────────────
// Thin pass-throughs so callers only ever need to import from the registry
// module, never from individual provider files or the health-check
// internals directly. The actual logic is fully provider-agnostic (see
// ./modelHealth) — it drives every provider through the same AIProvider
// interface (agentTurn/toInternalMessages/isQuotaError/isAbortError), so
// no provider-specific branching is added here or anywhere else.

/** Validate a single model for a provider by id. Throws if the provider id is unknown. */
export function checkModelHealth(
  providerId: string,
  apiKey: string,
  modelId: string,
  opts?: ModelHealthCheckOptions
): Promise<ModelHealthResult> {
  return checkModelHealthImpl(requireProvider(providerId), apiKey, modelId, opts)
}

/** Validate many models for a provider by id, with bounded concurrency. */
export function checkModelsHealth(
  providerId: string,
  apiKey: string,
  modelIds: string[],
  opts?: ModelHealthBatchOptions
): Promise<ModelHealthResult[]> {
  return checkModelsHealthImpl(requireProvider(providerId), apiKey, modelIds, opts)
}

export type { ModelHealthResult, ModelHealthStatus, ModelHealthCheckOptions, ModelHealthBatchOptions } from './modelHealth'
