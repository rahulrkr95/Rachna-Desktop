// components/ModelPicker.tsx
// Inline dropdown for selecting provider and model in the chat input area.
// Shows a square provider icon (with company brand color), active model name,
// and a dropdown for switching provider / model.
// All state comes from useApiKeyStore — no provider-specific code here.

import React, { useState, useRef, useEffect } from 'react'
import { useAuthStore } from '../store/useAuthStore'
import { useApiKeyStore } from '../store/useApiKeyStore'
import { getAllProviders } from '../lib/providers/registry'
import styles from './ModelPicker.module.css'

// ── Brand colours & abbreviations per provider ─────────────────────────────

const PROVIDER_BRAND: Record<string, { bg: string; label: string }> = {
  'rachna-cloud': { bg: 'var(--accent)', label: 'R' },
  gemini:      { bg: '#4285F4', label: 'G'  },
  openai:      { bg: '#10a37f', label: 'Oi' },
  claude:      { bg: '#c77cff', label: 'C'  },
  deepseek:    { bg: '#ff6b35', label: 'DS' },
  openrouter:  { bg: 'var(--accent)', label: 'OR' },
  zenmux:      { bg: '#f59e0b', label: 'Z'  },
  huggingface: { bg: '#FFD21E', label: 'HF' },
  sarvam:      { bg: '#0EA25B', label: 'Sv' },
  lmstudio:    { bg: 'var(--accent)', label: 'LM' },
  ollama:      { bg: 'var(--text-muted)', label: 'Ol' },
}

function ProviderIconSquare({
  providerId,
  size = 16,
}: {
  providerId: string
  size?: number
}) {
  const brand = PROVIDER_BRAND[providerId] ?? { bg: 'var(--text-muted)', label: providerId.slice(0, 2).toUpperCase() }
  return (
    <span
      className={styles.providerIconSquare}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: brand.bg,
        fontSize: size * 0.52,
        lineHeight: 1,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        flexShrink: 0,
        fontFamily: 'var(--font-ui)',
      }}
      title={providerId}
    >
      {brand.label}
    </span>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

type Props = {
  /** Open dropdown above the trigger (for bottom-of-panel placement). */
  dropUp?: boolean
}

export default function ModelPicker({ dropUp = false }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Persisted-per-session-only; whether to reveal unhealthy models (with
  // their failure reason) in each provider's model list. Off by default —
  // the picker shows only healthy models unless the person opts in.
  const [showUnavailable, setShowUnavailable] = useState(false)

  const {
    activeProviderId,
    setActiveProviderId,
    getActiveKey,
    getKeysForProvider,
    setActiveKey,
    getModels,
    getHealthyModels,
    getUnhealthyModels,
    getModelHealth,
    refreshModelHealth,
    healthCheckState,
    getSelectedModel,
    setSelectedModel,
    validationState,
  } = useApiKeyStore()

  // Only show providers that actually have at least one key configured —
  // an unconfigured provider isn't a usable choice in the chat window, so
  // it's dropped entirely here rather than shown greyed-out with "no key".
  const allProviders = getAllProviders().filter(p => getKeysForProvider(p.id).length > 0)
  const isSignedIn = useAuthStore(s => s.isAuthenticated)

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const activeKey    = getActiveKey(activeProviderId)
  const models       = getModels(activeProviderId)
  const selectedId   = getSelectedModel(activeProviderId) ?? models[0]?.id
  const selectedModel = models.find(m => m.id === selectedId)

  return (
    <div className={styles.root} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => setOpen(o => !o)}
        title={activeProviderId === 'rachna-cloud' ? 'Change AI provider' : 'Change model'}
      >
        <ProviderIconSquare providerId={activeProviderId} size={16} />
        <span className={styles.modelName}>
          {activeProviderId === 'rachna-cloud' ? 'Rachna Cloud AI' : (selectedModel?.displayName ?? selectedId ?? 'No model')}
        </span>
        <span className={styles.chevron}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className={`${styles.dropdown} ${dropUp ? styles.dropdownUp : ''}`}>
          {allProviders.map(p => {
            const pKey     = getActiveKey(p.id)
            const pKeys    = getKeysForProvider(p.id)
            const pModels  = getModels(p.id, pKey?.id)
            const isActive = p.id === activeProviderId
            // Healthy (or not-yet-checked, which falls back into this list —
            // a health check must never hide a model before it has run).
            const pHealthyModels   = getHealthyModels(p.id, pKey?.id)
            const pUnhealthyModels = isActive && showUnavailable
              ? getUnhealthyModels(p.id, pKey?.id)
              : []
            const pSel     = getSelectedModel(p.id, pKey?.id) ?? pHealthyModels[0]?.id ?? pModels[0]?.id
            const hasKey   = !!pKey
            const vState   = pKey ? (validationState[pKey.id] ?? 'idle') : 'idle'
            const healthState = pKey ? (healthCheckState[pKey.id] ?? 'idle') : 'idle'
            // Multiple categories/keys under this provider — show them as
            // their own divider so the person can see and pick between e.g.
            // "Personal" vs "Work" without leaving the chat window.
            const hasMultipleCategories = pKeys.length > 1

            return (
              <div key={p.id} className={`${styles.providerGroup} ${isActive ? styles.activeGroup : ''}`}>
                <div
                  className={styles.providerRow}
                  onClick={() => {
                    setActiveProviderId(p.id)
                    // Rachna Cloud is the only provider that needs an account.
                    if (p.id === 'rachna-cloud' && !useAuthStore.getState().isAuthenticated) {
                      useAuthStore.getState().openLoginDialog()
                    }
                  }}
                  title={p.id === 'rachna-cloud' && !isSignedIn ? 'Sign in to use Rachna Cloud AI' : `Switch to ${p.displayName}`}
                >
                  <ProviderIconSquare providerId={p.id} size={20} />
                  <span className={styles.providerLabel}>{p.displayName}</span>
                  {p.id === 'rachna-cloud' && !isSignedIn && (
                    <span className={styles.noModels} style={{ padding: 0, marginLeft: 'auto' }}>Sign in</span>
                  )}
                  {vState === 'validating' && <span className={styles.validating}>⟳</span>}
                  {vState === 'ok'         && <span className={styles.valid}>✓</span>}
                  {vState === 'error'      && <span className={styles.invalid}>⚠</span>}
                </div>

                {isActive && hasMultipleCategories && (
                  <div className={styles.categoryList}>
                    {pKeys.map(k => (
                      <button
                        key={k.id}
                        className={`${styles.categoryRow} ${k.active ? styles.selectedCategory : ''}`}
                        onClick={() => setActiveKey(k.id)}
                        title={`Use the "${k.label}" key`}
                      >
                        <span className={styles.modelPrefix}>{k.active ? '▶' : '·'}</span>
                        <span className={styles.categoryLabel}>{k.label}</span>
                      </button>
                    ))}
                  </div>
                )}

                {isActive && p.id !== 'rachna-cloud' && pHealthyModels.length > 0 && (
                  <div className={styles.modelList}>
                    {pHealthyModels.map(m => {
                      const isSelected = m.id === pSel
                      const health = getModelHealth(p.id, m.id, pKey?.id)
                      const isChecking = healthState === 'checking' && !health
                      return (
                        <button
                          key={m.id}
                          className={`${styles.modelRow} ${isSelected ? styles.selectedModel : ''}`}
                          onClick={() => {
                            setSelectedModel(p.id, m.id, pKey?.id)
                            setOpen(false)
                          }}
                          title={[
                            m.displayName,
                            m.contextWindow ? `Context: ${(m.contextWindow / 1000).toFixed(0)}k tokens` : '',
                            m.supportsTools ? 'Tools ✓' : '',
                            m.supportsVision ? 'Vision ✓' : '',
                            health ? `Healthy · ${health.latencyMs}ms` : (isChecking ? 'Checking health…' : ''),
                          ].filter(Boolean).join(' · ')}
                        >
                          <span className={styles.modelPrefix}>
                            {isSelected ? '▶' : '·'}
                          </span>
                          <span className={styles.modelId}>{m.displayName}</span>
                          <span className={styles.modelMeta}>
                            {isChecking && <span className={styles.healthChecking} title="Checking model health…">⟳</span>}
                            {m.contextWindow
                              ? `${Math.round(m.contextWindow / 1000)}k`
                              : ''}
                            {m.supportsTools  ? ' 🔧' : ''}
                            {m.supportsVision ? ' 👁' : ''}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {isActive && p.id !== 'rachna-cloud' && pModels.length === 0 && hasKey && (
                  <div className={styles.noModels}>
                    {vState === 'validating' ? 'Fetching models…' : 'No models found. Check key in Settings.'}
                  </div>
                )}

                {isActive && p.id !== 'rachna-cloud' && pModels.length > 0 && pHealthyModels.length === 0 && (
                  <div className={styles.noModels}>
                    {healthState === 'checking'
                      ? 'Checking model health…'
                      : 'No healthy models found for this key. Try "Show unavailable models" below.'}
                  </div>
                )}

                {isActive && showUnavailable && pUnhealthyModels.length > 0 && (
                  <div className={styles.unhealthyList}>
                    <div className={styles.unhealthyHeading}>Unavailable</div>
                    {pUnhealthyModels.map(({ model: m, health }) => (
                      <div key={m.id} className={styles.unhealthyRow} title={health.error}>
                        <span className={styles.modelPrefix}>·</span>
                        <span className={styles.modelId}>{m.displayName}</span>
                        <span className={styles.unhealthyReason}>{health.status}</span>
                      </div>
                    ))}
                  </div>
                )}

                {isActive && p.id !== 'rachna-cloud' && hasKey && pModels.length > 0 && (
                  <div className={styles.healthActions}>
                    <button
                      type="button"
                      className={styles.healthActionBtn}
                      disabled={healthState === 'checking'}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (pKey) refreshModelHealth(pKey.id, { force: true })
                      }}
                      title="Re-run health checks for every model under this key"
                    >
                      {healthState === 'checking' ? 'Refreshing…' : '↻ Refresh Model Health'}
                    </button>
                    <button
                      type="button"
                      className={styles.healthActionBtn}
                      onClick={(e) => {
                        e.stopPropagation()
                        setShowUnavailable(v => !v)
                      }}
                    >
                      {showUnavailable ? 'Hide unavailable' : 'Show unavailable models'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}

          <div className={styles.hint}>
            Manage keys in <strong>Settings → AI Providers</strong>
          </div>
        </div>
      )}
    </div>
  )
}
