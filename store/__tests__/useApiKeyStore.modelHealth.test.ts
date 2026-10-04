// store/__tests__/useApiKeyStore.modelHealth.test.ts
//
// Covers the caching/TTL/refresh contract layered on top of the
// provider-agnostic health checker (lib/providers/modelHealth.ts):
//   - results are cached with a timestamp,
//   - models aren't rechecked within 24h unless force-refreshed,
//   - the picker's "healthy models" view falls back to the full fetched
//     list for anything not yet checked (never blocks on validation),
//   - unhealthy models are reported with their failure reason,
//   - health checks never block model discovery.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import './_localStoragePolyfill'
import type { ModelHealthResult } from '../../lib/providers/modelHealth'

// Simple in-memory backing store we can clear/inspect between tests —
// installed by the side-effect import above before useApiKeyStore (which
// reads localStorage at module-load time) is imported below.
const storage = globalThis.localStorage as unknown as {
  clear: () => void
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
}

// Mock only checkModelsHealth from the registry — every other export
// (getProvider, getAllProviders, ...) keeps its real implementation so
// getProvider('openai') etc. still resolves to a real, registered provider.
const checkModelsHealthMock = vi.fn()
vi.mock('../../lib/providers/registry', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/providers/registry')>()
  return {
    ...actual,
    checkModelsHealth: (...args: unknown[]) => checkModelsHealthMock(...args),
  }
})

// Avoid real Tauri keychain calls from addKey/removeKey paths we don't use
// here — not strictly required for these tests, but keeps things hermetic.
vi.mock('../../lib/keychain', () => ({
  keychainSet: vi.fn().mockResolvedValue(undefined),
  keychainDelete: vi.fn().mockResolvedValue(undefined),
  keychainGetMany: vi.fn().mockResolvedValue({}),
}))

import { useApiKeyStore, MODEL_HEALTH_TTL_MS } from '../useApiKeyStore'
import type { ModelInfo } from '../../lib/providers/types'

const MODELS: ModelInfo[] = [
  { id: 'model-a', displayName: 'Model A', supportsTools: true, supportsVision: false, supportsStreaming: true },
  { id: 'model-b', displayName: 'Model B', supportsTools: true, supportsVision: false, supportsStreaming: true },
]

function seedKeyWithModels(keyId = 'key-1', providerId = 'openai') {
  useApiKeyStore.setState({
    keys: [{ id: keyId, providerId, label: 'Key', value: 'secret', active: true, addedAt: Date.now() }],
    modelCache: [{ providerId, keyId, models: MODELS, fetchedAt: Date.now() }],
    modelHealth: [],
    healthCheckState: {},
    selectedModels: {},
  })
}

function healthyResult(modelId: string, latencyMs = 42): ModelHealthResult {
  return { modelId, healthy: true, latencyMs, lastChecked: Date.now(), status: 'Healthy' }
}

function unhealthyResult(modelId: string, status: ModelHealthResult['status'] = 'Unauthorized'): ModelHealthResult {
  return { modelId, healthy: false, latencyMs: 5, lastChecked: Date.now(), status, error: `${status} error` }
}

beforeEach(() => {
  storage.clear()
  checkModelsHealthMock.mockReset()
  useApiKeyStore.setState({
    keys: [],
    modelCache: [],
    modelHealth: [],
    healthCheckState: {},
    selectedModels: {},
    validationState: {},
    validationError: {},
  })
})

describe('refreshModelHealth — caching, TTL, and non-blocking behavior', () => {
  it('checks all models with no cached health yet, and caches results with a timestamp', async () => {
    seedKeyWithModels()
    checkModelsHealthMock.mockImplementation(async (_providerId, _apiKey, modelIds, opts) => {
      const results = (modelIds as string[]).map(id => healthyResult(id))
      results.forEach(r => opts?.onResult?.(r))
      return results
    })

    await useApiKeyStore.getState().refreshModelHealth('key-1')

    expect(checkModelsHealthMock).toHaveBeenCalledTimes(1)
    const [, , checkedIds] = checkModelsHealthMock.mock.calls[0]
    expect(checkedIds.sort()).toEqual(['model-a', 'model-b'])

    const healthA = useApiKeyStore.getState().getModelHealth('openai', 'model-a', 'key-1')
    expect(healthA?.healthy).toBe(true)
    expect(healthA?.status).toBe('Healthy')
    expect(healthA?.lastChecked).toBeGreaterThan(0)

    // Persisted, not just in-memory.
    expect(JSON.parse(storage.getItem('rachna_ide_model_health') ?? '[]')).toHaveLength(2)
  })

  it('does not recheck a model whose cached result is under 24h old', async () => {
    seedKeyWithModels()
    useApiKeyStore.setState({
      modelHealth: [
        { providerId: 'openai', keyId: 'key-1', modelId: 'model-a', healthy: true, latencyMs: 10, lastChecked: Date.now(), status: 'Healthy' },
        { providerId: 'openai', keyId: 'key-1', modelId: 'model-b', healthy: true, latencyMs: 10, lastChecked: Date.now(), status: 'Healthy' },
      ],
    })

    await useApiKeyStore.getState().refreshModelHealth('key-1')

    expect(checkModelsHealthMock).not.toHaveBeenCalled()
  })

  it('rechecks a model whose cached result is older than the 24h TTL', async () => {
    seedKeyWithModels()
    const stale = Date.now() - (MODEL_HEALTH_TTL_MS + 1_000)
    useApiKeyStore.setState({
      modelHealth: [
        { providerId: 'openai', keyId: 'key-1', modelId: 'model-a', healthy: true, latencyMs: 10, lastChecked: stale, status: 'Healthy' },
        { providerId: 'openai', keyId: 'key-1', modelId: 'model-b', healthy: true, latencyMs: 10, lastChecked: Date.now(), status: 'Healthy' },
      ],
    })
    checkModelsHealthMock.mockResolvedValue([healthyResult('model-a', 99)])

    await useApiKeyStore.getState().refreshModelHealth('key-1')

    expect(checkModelsHealthMock).toHaveBeenCalledTimes(1)
    const [, , checkedIds] = checkModelsHealthMock.mock.calls[0]
    expect(checkedIds).toEqual(['model-a'])  // model-b is still fresh, skipped
  })

  it('force refresh rechecks every model regardless of cache age', async () => {
    seedKeyWithModels()
    useApiKeyStore.setState({
      modelHealth: [
        { providerId: 'openai', keyId: 'key-1', modelId: 'model-a', healthy: true, latencyMs: 10, lastChecked: Date.now(), status: 'Healthy' },
        { providerId: 'openai', keyId: 'key-1', modelId: 'model-b', healthy: true, latencyMs: 10, lastChecked: Date.now(), status: 'Healthy' },
      ],
    })
    checkModelsHealthMock.mockResolvedValue(MODELS.map(m => healthyResult(m.id)))

    await useApiKeyStore.getState().refreshModelHealth('key-1', { force: true })

    expect(checkModelsHealthMock).toHaveBeenCalledTimes(1)
    const [, , checkedIds] = checkModelsHealthMock.mock.calls[0]
    expect(checkedIds.sort()).toEqual(['model-a', 'model-b'])
  })

  it('marks unhealthy models with their failure reason and excludes them from getHealthyModels', async () => {
    seedKeyWithModels()
    checkModelsHealthMock.mockImplementation(async (_providerId, _apiKey, modelIds, opts) => {
      const results = (modelIds as string[]).map(id =>
        id === 'model-b' ? unhealthyResult(id, 'Unauthorized') : healthyResult(id)
      )
      results.forEach(r => opts?.onResult?.(r))
      return results
    })

    await useApiKeyStore.getState().refreshModelHealth('key-1')

    const state = useApiKeyStore.getState()
    const healthy = state.getHealthyModels('openai', 'key-1').map(m => m.id)
    expect(healthy).toEqual(['model-a'])

    const unhealthy = state.getUnhealthyModels('openai', 'key-1')
    expect(unhealthy).toHaveLength(1)
    expect(unhealthy[0].model.id).toBe('model-b')
    expect(unhealthy[0].health.status).toBe('Unauthorized')
    expect(unhealthy[0].health.error).toBeTruthy()
  })

  it('getHealthyModels falls back to the full fetched list when nothing has been checked yet (never blocks)', () => {
    seedKeyWithModels()
    // No refreshModelHealth call at all — health cache is empty.
    const healthy = useApiKeyStore.getState().getHealthyModels('openai', 'key-1')
    expect(healthy.map(m => m.id).sort()).toEqual(['model-a', 'model-b'])
  })

  it('toggles healthCheckState to "checking" during the refresh and back to "idle" after', async () => {
    seedKeyWithModels()
    let resolveCheck!: (v: ModelHealthResult[]) => void
    checkModelsHealthMock.mockImplementation(
      () => new Promise<ModelHealthResult[]>(resolve => { resolveCheck = resolve })
    )

    const refreshPromise = useApiKeyStore.getState().refreshModelHealth('key-1')
    // Microtask needed for the initial `set(... 'checking')` to land.
    await Promise.resolve()
    expect(useApiKeyStore.getState().healthCheckState['key-1']).toBe('checking')

    resolveCheck(MODELS.map(m => healthyResult(m.id)))
    await refreshPromise

    expect(useApiKeyStore.getState().healthCheckState['key-1']).toBe('idle')
  })

  it('is a no-op when there are no fetched models yet for the key', async () => {
    useApiKeyStore.setState({
      keys: [{ id: 'key-1', providerId: 'openai', label: 'Key', value: 'secret', active: true, addedAt: Date.now() }],
      modelCache: [],
    })

    await useApiKeyStore.getState().refreshModelHealth('key-1')
    expect(checkModelsHealthMock).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown key id (never throws)', async () => {
    await expect(useApiKeyStore.getState().refreshModelHealth('missing-key')).resolves.toBeUndefined()
    expect(checkModelsHealthMock).not.toHaveBeenCalled()
  })

  it('swallows a rejection from checkModelsHealth and still resets state to idle', async () => {
    seedKeyWithModels()
    checkModelsHealthMock.mockRejectedValue(new Error('unexpected batch failure'))

    await expect(useApiKeyStore.getState().refreshModelHealth('key-1')).resolves.toBeUndefined()
    expect(useApiKeyStore.getState().healthCheckState['key-1']).toBe('idle')
  })
})
