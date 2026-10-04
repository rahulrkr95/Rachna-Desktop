// store/useApiKeyStore.ts
// Multi-provider API key management with:
//   • Multiple keys per provider
//   • Active key tracking per provider
//   • Automatic failover on quota/rate-limit errors
//   • Dynamic model discovery + caching
//   • Selected model per session

import { create } from 'zustand'
import { getProvider, getAllProviders, checkModelsHealth } from '../lib/providers/registry'
import type { ModelInfo } from '../lib/providers/types'
import type { ModelHealthResult, ModelHealthStatus } from '../lib/providers/modelHealth'
import { keychainSet, keychainDelete, keychainGetMany } from '../lib/keychain'

// ── Persisted key shape ────────────────────────────────────────────────────

export interface StoredKey {
  id: string          // stable uuid-like id
  providerId: string
  label: string       // user-facing label, e.g. "Key A"
  value: string       // the actual API key — held in memory only, NEVER persisted to localStorage
  active: boolean     // is this the active key for its provider?
  addedAt: number     // timestamp
}

const CLOUD_PROVIDER_ID = 'rachna-cloud'
const CLOUD_KEY: StoredKey = {
  id: 'rachna-cloud-session',
  providerId: CLOUD_PROVIDER_ID,
  label: 'Signed-in account',
  value: 'session',
  active: true,
  addedAt: 0,
}

/** Shape actually written to localStorage — secret `value` is stripped. */
type PersistedKey = Omit<StoredKey, 'value'>

// ── Persisted model cache ──────────────────────────────────────────────────

export interface CachedModels {
  providerId: string
  keyId: string       // which key was used to fetch these
  models: ModelInfo[]
  fetchedAt: number
}

// ── Persisted model health cache ────────────────────────────────────────────

/** One model's health-check outcome, cached per (key, model). */
export interface ModelHealthEntry {
  providerId: string
  keyId: string       // which key was used to run the check
  modelId: string
  healthy: boolean
  latencyMs: number
  lastChecked: number
  error?: string
  status: ModelHealthStatus
}

/** Don't recheck a model more than once every 24h unless manually refreshed. */
export const MODEL_HEALTH_TTL_MS = 24 * 60 * 60 * 1000

// ── Store shape ────────────────────────────────────────────────────────────

interface ApiKeyStore {
  // ── Keys ──────────────────────────────────────────────────────────────
  keys: StoredKey[]
  addKey: (providerId: string, label: string, value: string) => void
  removeKey: (keyId: string) => void
  updateKey: (keyId: string, patch: Partial<Pick<StoredKey, 'label' | 'value'>>) => void
  setActiveKey: (keyId: string) => void

  // ── Model cache ────────────────────────────────────────────────────────
  // Cached per KEY (not just per provider) so switching between categories
  // under the same provider shows that category's own model list instead
  // of clobbering a single shared provider-wide cache.
  modelCache: CachedModels[]
  setModels: (providerId: string, keyId: string, models: ModelInfo[]) => void
  /** Models for a specific key, or (if keyId omitted) the provider's active key. */
  getModels: (providerId: string, keyId?: string) => ModelInfo[]
  /**
   * Append a manually-entered model id (e.g. a Hugging Face Hub repo id not
   * returned by discovery) to a key's cached model list, and select it.
   * Generic — any provider can use this, not just Hugging Face.
   */
  addCustomModel: (providerId: string, modelId: string, keyId?: string) => void

  // ── Model health ──────────────────────────────────────────────────────
  // Cached per (key, model) with a timestamp; see MODEL_HEALTH_TTL_MS.
  // Populated asynchronously — never blocks model discovery or chat.
  modelHealth: ModelHealthEntry[]
  /** Per-key in-flight state, so the UI can show a spinner / disable "Refresh". */
  healthCheckState: Record<string, 'idle' | 'checking'>
  /** Cached health for one model, or undefined if it hasn't been checked yet. */
  getModelHealth: (providerId: string, modelId: string, keyId?: string) => ModelHealthEntry | undefined
  /**
   * The subset of a key's fetched models considered usable right now: models
   * with no health data yet (not checked, or check still in flight) are
   * included — this is the "never block on validation" fallback — while
   * models a check has explicitly marked unhealthy are excluded.
   */
  getHealthyModels: (providerId: string, keyId?: string) => ModelInfo[]
  /** All fetched models a check has explicitly marked unhealthy, most-recent first. */
  getUnhealthyModels: (providerId: string, keyId?: string) => Array<{ model: ModelInfo; health: ModelHealthEntry }>
  /**
   * Runs health checks for a key's models. By default only (re)checks models
   * that have never been checked or whose cached result is >24h old; pass
   * `force: true` (manual "Refresh Model Health") to recheck everything
   * regardless of cache age. Fully async and non-blocking — results stream
   * into `modelHealth` one at a time via setModelHealthResult as each
   * individual model's check completes, not as one big batch at the end.
   */
  refreshModelHealth: (keyId: string, opts?: { force?: boolean; modelIds?: string[] }) => Promise<void>
  /** Record one model's health result in the cache (also persists). Exposed mainly for tests/streaming updates. */
  setModelHealthResult: (providerId: string, keyId: string, result: ModelHealthResult) => void

  // ── Selected model per key ───────────────────────────────────────────
  selectedModels: Record<string, string>  // keyId → modelId
  setSelectedModel: (providerId: string, modelId: string, keyId?: string) => void
  /** Selected model for a specific key, or (if keyId omitted) the provider's active key. */
  getSelectedModel: (providerId: string, keyId?: string) => string | undefined

  // ── Active provider (the one the chat UI uses) ─────────────────────
  activeProviderId: string
  setActiveProviderId: (id: string) => void

  // ── Derived helpers ────────────────────────────────────────────────────
  getActiveKey: (providerId: string) => StoredKey | undefined
  getKeysForProvider: (providerId: string) => StoredKey[]

  // ── Key validation + model discovery ──────────────────────────────────
  validateAndFetchModels: (keyId: string) => Promise<{ ok: boolean; error?: string }>

  // ── Failover: pick next usable key for a provider ──────────────────────
  failoverKey: (providerId: string, exhaustedKeyId: string) => StoredKey | undefined

  // ── Notify store of which key is now active (after failover) ──────────
  notifyActiveKey: (keyId: string) => void

  // ── Validation state ───────────────────────────────────────────────────
  validationState: Record<string, 'idle' | 'validating' | 'ok' | 'error'>
  validationError: Record<string, string>
}

// ── Persistence helpers ────────────────────────────────────────────────────

const KEYS_KEY    = 'rachna_ide_api_keys'
const MODELS_KEY  = 'rachna_ide_models'
const SELMOD_KEY  = 'rachna_ide_selected_models'
const PROVIDER_KEY = 'rachna_ide_active_provider'
const HEALTH_KEY  = 'rachna_ide_model_health'

function loadKeys(): StoredKey[] {
  try {
    const persisted: PersistedKey[] = JSON.parse(localStorage.getItem(KEYS_KEY) ?? '[]')
    // `value` is rehydrated asynchronously from the OS keychain by
    // hydrateKeyValuesFromKeychain() shortly after the store is created —
    // it starts empty here so nothing sensitive ever sits in this JSON blob.
    return persisted.map(k => ({ ...k, value: '' }))
  } catch {
    return []
  }
}

function saveKeys(keys: StoredKey[]): void {
  // Never persist the raw key value in localStorage — secrets live in the
  // OS keychain (see lib/keychain.ts / src-tauri/src/keychain.rs). Only
  // non-sensitive metadata is written here.
  const persisted: PersistedKey[] = keys.map(({ value: _value, ...rest }) => rest)
  localStorage.setItem(KEYS_KEY, JSON.stringify(persisted))
}

function loadModelCache(): CachedModels[] {
  try {
    return JSON.parse(localStorage.getItem(MODELS_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveModelCache(cache: CachedModels[]): void {
  localStorage.setItem(MODELS_KEY, JSON.stringify(cache))
}

function loadModelHealth(): ModelHealthEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HEALTH_KEY) ?? '[]')
  } catch {
    return []
  }
}

function saveModelHealth(entries: ModelHealthEntry[]): void {
  localStorage.setItem(HEALTH_KEY, JSON.stringify(entries))
}

function loadSelectedModels(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SELMOD_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function saveSelectedModels(sel: Record<string, string>): void {
  localStorage.setItem(SELMOD_KEY, JSON.stringify(sel))
}

function loadActiveProvider(): string {
  return localStorage.getItem(PROVIDER_KEY) ?? CLOUD_PROVIDER_ID
}

function saveActiveProvider(id: string): void {
  localStorage.setItem(PROVIDER_KEY, id)
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useApiKeyStore = create<ApiKeyStore>((set, get) => ({
  keys: loadKeys(),
  modelCache: loadModelCache(),
  modelHealth: loadModelHealth(),
  healthCheckState: {},
  selectedModels: loadSelectedModels(),
  activeProviderId: loadActiveProvider(),
  validationState: {},
  validationError: {},

  // ── Key management ─────────────────────────────────────────────────────

  addKey(providerId, label, value) {
    const currentKeys = get().keys
    const providerKeys = currentKeys.filter(k => k.providerId === providerId)
    const isFirst = providerKeys.length === 0

    const newKey: StoredKey = {
      id: makeId(),
      providerId,
      label: label || `Key ${providerKeys.length + 1}`,
      value,
      active: isFirst,
      addedAt: Date.now(),
    }

    const updated = [...currentKeys, newKey]
    saveKeys(updated)
    set({ keys: updated })

    // Persist the secret to the OS keychain (fire-and-forget — the key is
    // already usable from in-memory state immediately).
    keychainSet(newKey.id, value).catch(err =>
      console.error('Failed to store API key in OS keychain:', err)
    )

    // Kick off validation + model fetch in background
    get().validateAndFetchModels(newKey.id)
  },

  removeKey(keyId) {
    const { keys } = get()
    const removing = keys.find(k => k.id === keyId)
    let updated = keys.filter(k => k.id !== keyId)

    // If we removed the active key, promote the next available one
    if (removing?.active) {
      const siblings = updated.filter(k => k.providerId === removing.providerId)
      if (siblings.length > 0) {
        updated = updated.map(k =>
          k.id === siblings[0].id ? { ...k, active: true } : k
        )
      }
    }

    saveKeys(updated)
    set({ keys: updated })
    keychainDelete(keyId).catch(err =>
      console.error('Failed to delete API key from OS keychain:', err)
    )
  },

  updateKey(keyId, patch) {
    const updated = get().keys.map(k =>
      k.id === keyId ? { ...k, ...patch } : k
    )
    saveKeys(updated)
    set({ keys: updated })

    // Re-validate if value changed
    if (patch.value) {
      keychainSet(keyId, patch.value).catch(err =>
        console.error('Failed to update API key in OS keychain:', err)
      )
      get().validateAndFetchModels(keyId)
    }
  },

  setActiveKey(keyId) {
    const key = get().keys.find(k => k.id === keyId)
    if (!key) return
    const updated = get().keys.map(k =>
      k.providerId === key.providerId
        ? { ...k, active: k.id === keyId }
        : k
    )
    saveKeys(updated)
    set({ keys: updated })
  },

  // ── Model cache ────────────────────────────────────────────────────────

  setModels(providerId, keyId, models) {
    // Only replace THIS key's cache entry — other keys/categories under the
    // same provider keep their own independently-fetched model lists.
    const cache = get().modelCache.filter(c => c.keyId !== keyId)
    const updated: CachedModels[] = [...cache, { providerId, keyId, models, fetchedAt: Date.now() }]
    saveModelCache(updated)
    set({ modelCache: updated })
  },

  getModels(providerId, keyId) {
    if (providerId === CLOUD_PROVIDER_ID) return []
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    if (targetKeyId) {
      const exact = get().modelCache.find(c => c.keyId === targetKeyId)
      if (exact) return exact.models
    }
    // Fallback for legacy cache entries or a provider with no active key yet
    return get().modelCache.find(c => c.providerId === providerId)?.models ?? []
  },

  addCustomModel(providerId, modelId, keyId) {
    const trimmed = modelId.trim()
    if (!trimmed) return
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    if (!targetKeyId) return

    const existing = get().getModels(providerId, targetKeyId)
    if (existing.some(m => m.id === trimmed)) {
      get().setSelectedModel(providerId, trimmed, targetKeyId)
      return
    }

    const newModel: ModelInfo = {
      id: trimmed,
      displayName: trimmed,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
    }
    get().setModels(providerId, targetKeyId, [...existing, newModel])
    get().setSelectedModel(providerId, trimmed, targetKeyId)
  },

  // ── Model health ──────────────────────────────────────────────────────

  setModelHealthResult(providerId, keyId, result) {
    const entries = get().modelHealth.filter(
      e => !(e.keyId === keyId && e.modelId === result.modelId)
    )
    const entry: ModelHealthEntry = {
      providerId,
      keyId,
      modelId: result.modelId,
      healthy: result.healthy,
      latencyMs: result.latencyMs,
      lastChecked: result.lastChecked,
      error: result.error,
      status: result.status,
    }
    const updated = [...entries, entry]
    saveModelHealth(updated)
    set({ modelHealth: updated })
  },

  getModelHealth(providerId, modelId, keyId) {
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    if (!targetKeyId) return undefined
    return get().modelHealth.find(e => e.keyId === targetKeyId && e.modelId === modelId)
  },

  getHealthyModels(providerId, keyId) {
    const models = get().getModels(providerId, keyId)
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    if (!targetKeyId) return models
    // Models with no cached health yet fall back into the list — a check
    // that hasn't run (or hasn't finished) must never hide a model the
    // provider actually returned.
    return models.filter(m => {
      const health = get().modelHealth.find(e => e.keyId === targetKeyId && e.modelId === m.id)
      return !health || health.healthy
    })
  },

  getUnhealthyModels(providerId, keyId) {
    const models = get().getModels(providerId, keyId)
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    if (!targetKeyId) return []
    const out: Array<{ model: ModelInfo; health: ModelHealthEntry }> = []
    for (const m of models) {
      const health = get().modelHealth.find(e => e.keyId === targetKeyId && e.modelId === m.id)
      if (health && !health.healthy) out.push({ model: m, health })
    }
    return out.sort((a, b) => b.health.lastChecked - a.health.lastChecked)
  },

  async refreshModelHealth(keyId, opts = {}) {
    const key = get().keys.find(k => k.id === keyId)
    if (keyId === CLOUD_KEY.id) return
    if (!key) return
    const provider = getProvider(key.providerId)
    if (!provider) return

    const models = get().getModels(key.providerId, keyId)
    if (models.length === 0) return

    const now = Date.now()
    const candidateIds = opts.modelIds ?? models.map(m => m.id)
    const targets = candidateIds.filter(id => {
      if (opts.force) return true
      const existing = get().modelHealth.find(e => e.keyId === keyId && e.modelId === id)
      return !existing || now - existing.lastChecked > MODEL_HEALTH_TTL_MS
    })
    if (targets.length === 0) return

    // Never block: this runs fully in the background. Callers (bootstrap,
    // validateAndFetchModels, the "Refresh Model Health" button) fire this
    // without awaiting it, and the UI keeps using getHealthyModels()'s
    // fallback-to-fetched-list behavior while results stream in.
    set(s => ({ healthCheckState: { ...s.healthCheckState, [keyId]: 'checking' } }))

    try {
      await checkModelsHealth(key.providerId, key.value, targets, {
        concurrency: 6,
        onResult: (result: ModelHealthResult) => {
          get().setModelHealthResult(key.providerId, keyId, result)
        },
      })
    } catch {
      // checkModelsHealth itself never rejects (each model's failure is
      // captured in its own result), but guard anyway so a refresh can
      // never surface as an unhandled rejection.
    } finally {
      set(s => ({ healthCheckState: { ...s.healthCheckState, [keyId]: 'idle' } }))
    }
  },

  // ── Selected model ─────────────────────────────────────────────────────

  setSelectedModel(providerId, modelId, keyId) {
    if (providerId === CLOUD_PROVIDER_ID) return
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    if (!targetKeyId) return
    const sel = { ...get().selectedModels, [targetKeyId]: modelId }
    saveSelectedModels(sel)
    set({ selectedModels: sel })
  },

  getSelectedModel(providerId, keyId) {
    if (providerId === CLOUD_PROVIDER_ID) return undefined
    const targetKeyId = keyId ?? get().getActiveKey(providerId)?.id
    return targetKeyId ? get().selectedModels[targetKeyId] : undefined
  },

  // ── Active provider ────────────────────────────────────────────────────

  setActiveProviderId(id) {
    saveActiveProvider(id)
    set({ activeProviderId: id })
  },

  // ── Derived ───────────────────────────────────────────────────────────

  getActiveKey(providerId) {
    if (providerId === CLOUD_PROVIDER_ID) return CLOUD_KEY
    return get().keys.find(k => k.providerId === providerId && k.active)
  },

  getKeysForProvider(providerId) {
    if (providerId === CLOUD_PROVIDER_ID) return [CLOUD_KEY]
    return get().keys.filter(k => k.providerId === providerId)
  },

  // ── Validation + model discovery ───────────────────────────────────────

  async validateAndFetchModels(keyId) {
    const key = get().keys.find(k => k.id === keyId)
    if (!key) return { ok: false, error: 'Key not found' }

    const provider = getProvider(key.providerId)
    if (!provider) return { ok: false, error: `Unknown provider: ${key.providerId}` }

    set(s => ({
      validationState: { ...s.validationState, [keyId]: 'validating' },
      validationError: { ...s.validationError, [keyId]: '' },
    }))

    try {
      const models = await provider.listModels(key.value)
      get().setModels(key.providerId, keyId, models)

      // Auto-select first model if nothing selected yet for this key
      if (!get().selectedModels[keyId] && models.length > 0) {
        get().setSelectedModel(key.providerId, models[0].id, keyId)
      }

      set(s => ({
        validationState: { ...s.validationState, [keyId]: 'ok' },
      }))

      // Kick off health checks in the background — deliberately not
      // awaited. Model discovery (and everything depending on it, like the
      // Model Picker opening) must complete immediately; health results
      // stream in afterwards via setModelHealthResult.
      void get().refreshModelHealth(keyId)

      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set(s => ({
        validationState: { ...s.validationState, [keyId]: 'error' },
        validationError: { ...s.validationError, [keyId]: msg },
      }))
      return { ok: false, error: msg }
    }
  },

  // ── Failover ───────────────────────────────────────────────────────────

  failoverKey(providerId, exhaustedKeyId) {
    const providerKeys = get().keys.filter(k => k.providerId === providerId)
    const exhaustedIdx = providerKeys.findIndex(k => k.id === exhaustedKeyId)

    // Try keys after the exhausted one, then wrap around
    for (let i = 1; i < providerKeys.length; i++) {
      const candidate = providerKeys[(exhaustedIdx + i) % providerKeys.length]
      if (candidate.id !== exhaustedKeyId) {
        return candidate
      }
    }
    return undefined  // no alternative key available
  },

  notifyActiveKey(keyId) {
    get().setActiveKey(keyId)
  },
}))

// ── Convenience selectors ──────────────────────────────────────────────────

/** Get the active API key value for the currently selected provider. */
export function useActiveApiKey(): string {
  const { activeProviderId, getActiveKey } = useApiKeyStore()
  return getActiveKey(activeProviderId)?.value ?? ''
}

const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  claude: 'claude-sonnet-4-20250514',
  deepseek: 'deepseek-chat',
  openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
  groq: 'llama-3.3-70b-versatile',
  zenmux: '',       // no static default; use first discovered model
  huggingface: '',  // no static default; the person types an exact Hub model id
  sarvam: 'sarvam-105b',
  lmstudio: '',  // no static default; use first discovered model
  ollama: '',    // no static default; use first discovered model
}

/** Get the selected model id for the active provider. */
export function useSelectedModel(): string {
  const { activeProviderId, getSelectedModel, getModels } = useApiKeyStore()
  if (activeProviderId === CLOUD_PROVIDER_ID) return ''
  const selected = getSelectedModel(activeProviderId)
  if (selected) return selected
  // Fall back to the first available model, then provider default
  const models = getModels(activeProviderId)
  return models[0]?.id ?? DEFAULT_MODELS[activeProviderId] ?? 'gemini-2.5-flash'
}

/**
 * On startup, pull every key's secret value out of the OS keychain and
 * merge it into in-memory state. localStorage only ever holds metadata
 * (id, label, providerId, active flag) — this is what makes the value
 * usable for the in-app session without ever touching disk in plaintext.
 * Call this once, before bootstrapKeyValidation().
 */
export async function hydrateKeyValuesFromKeychain(): Promise<void> {
  const store = useApiKeyStore.getState()
  const ids = store.keys.map(k => k.id)
  if (ids.length === 0) return

  const values = await keychainGetMany(ids)
  const hydrated = store.keys.map(k =>
    values[k.id] !== undefined ? { ...k, value: values[k.id] } : k
  )
  useApiKeyStore.setState({ keys: hydrated })
}

/** On startup, validate any existing keys that have no cached models yet. */
export function bootstrapKeyValidation(): void {
  const store = useApiKeyStore.getState()
  const allProviders = getAllProviders()

  for (const provider of allProviders) {
    const activeKey = store.getActiveKey(provider.id)
    const cached = store.getModels(provider.id)

    if (cached.length === 0) {
      // No models yet — validate the key, which also kicks off health
      // checks once models come back (see validateAndFetchModels).
      if (activeKey) store.validateAndFetchModels(activeKey.id)
      continue
    }

    // Models already cached from a previous session — still refresh health
    // in the background so stale (>24h) or never-checked entries get
    // rechecked without blocking startup. refreshModelHealth no-ops
    // internally if everything is already fresh.
    if (activeKey) void store.refreshModelHealth(activeKey.id)
  }
}
