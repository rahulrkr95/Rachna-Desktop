// components/SettingsModal.tsx
// Production-quality multi-provider API key manager.
// - Scrollable dialog, no overflow off-screen
// - Compact provider cards
// - Grouped & sorted model selection (Text > Vision > Embedding > Other)
// - Auto-show on startup if no key or no model selected
// - Preserves all existing functionality

import React, { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import styles from './SettingsModal.module.css'
import { useApiKeyStore } from '../store/useApiKeyStore'
import { getAllProviders } from '../lib/providers/registry'
import type { StoredKey } from '../store/useApiKeyStore'
import { useGitSettingsStore } from '../store/useGitSettingsStore'
import { useTerminalSettingsStore } from '../store/useTerminalSettingsStore'
import {
  useInputActionDelayStore,
  INPUT_ACTION_DELAY_MIN_MS,
  INPUT_ACTION_DELAY_MAX_MS,
} from '../store/useInputActionDelayStore'
import {
  useMousePositionToleranceStore,
  MOUSE_POSITION_TOLERANCE_MIN_PX,
  MOUSE_POSITION_TOLERANCE_MAX_PX,
} from '../store/useMousePositionToleranceStore'
import { useActionAutoApproveStore } from '../store/useActionAutoApproveStore'
import { useIdeEntitlements } from '../store/useIdeEntitlements'
import { useAuthStore } from '../store/useAuthStore'
import { LockedBadge, LockedFeaturePanel } from './shared/FeatureUnavailableNotice'
import { useRepoIndex } from '../store/useRepoIndex'
import ConnectorsSettingsPanel from './ConnectorsSettingsPanel'
import type { ModelInfo } from '../lib/providers/types'
import {
  getLMStudioBaseUrl,
  setLMStudioBaseUrl,
  getLMStudioApiKey,
  setLMStudioApiKey,
  LM_STUDIO_DEFAULT_URL,
} from '../lib/providers/LMStudioProvider'
import {
  getOllamaBaseUrl,
  setOllamaBaseUrl,
  OLLAMA_DEFAULT_URL,
} from '../lib/providers/OllamaProvider'
import {
  getZenmuxBaseUrl,
  setZenmuxBaseUrl,
  ZENMUX_DEFAULT_URL,
  getZenmuxMode,
  setZenmuxMode,
  getZenmuxPaygKey,
  setZenmuxPaygKey,
  type ZenmuxMode,
} from '../lib/providers/ZenmuxProvider'
import {
  isSemanticSearchEnabled,
  setSemanticSearchEnabled,
  getEmbedModel,
  setEmbedModel,
  DEFAULT_EMBED_MODEL,
} from '../lib/embeddingsConfig'
import {
  loadProjectRules,
  RACHNA_RULES_RELATIVE_PATH,
  RULES_TEMPLATE,
} from '../lib/projectRules'
import { saveFile, readFile } from '../lib/tauriFs'
import GeminiUsagePanel from './GeminiUsagePanel'
import { useGeminiQuotaStatus } from './AiChat/GeminiQuotaBanner'
import McpSettingsPanel from './McpSettingsPanel'
import { keychainDelete } from '../lib/keychain'
import { clearGitHubToken } from '../connectors/github/auth'

interface Props {
  open: boolean
  onClose: () => void
  fontSize: number
  onFontSizeChange: (size: number) => void
  fontSizeMin: number
  fontSizeMax: number
  initialTab?: SettingsTab
}

type SettingsTab = 'editor' | 'providers' | 'rules' | 'permissions' | 'connectors' | 'mcp' | 'data'

async function clearNonLoginData(): Promise<void> {
  // Capture keychain identifiers before clearing the metadata that describes
  // them. Keychain deletion is best-effort in browser-only development.
  const apiKeys = useApiKeyStore.getState().keys.map(key => key.id)
  const mcpSecrets = (() => {
    try {
      const servers = JSON.parse(localStorage.getItem('rachna_ide_mcp_servers') ?? '[]') as Array<{
        id: string
        env?: Array<{ key: string; secret?: boolean }>
      }>
      return servers.flatMap(server =>
        (server.env ?? [])
          .filter(variable => variable.secret)
          .map(variable => `mcp_env_${server.id}_${variable.key}`),
      )
    } catch {
      return []
    }
  })()

  await Promise.all([
    ...apiKeys.map(keychainDelete),
    ...mcpSecrets.map(keychainDelete),
    clearGitHubToken(),
  ])

  localStorage.clear()
  sessionStorage.clear()
}

function DataSettingsTab() {
  const [confirmation, setConfirmation] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async () => {
    if (confirmation !== 'DELETE' || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await clearNonLoginData()
      window.location.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear app data.')
      setDeleting(false)
    }
  }

  return (
    <div className={styles.dataSection}>
      <div className={styles.dangerCard}>
        <div className={styles.dangerIcon} aria-hidden="true">!</div>
        <div>
          <h3 className={styles.dangerTitle}>Clear app data</h3>
          <p className={styles.dangerDescription}>
            Permanently removes conversations, settings, API keys, connector credentials, and other locally stored app data.
            Your project files and login session are preserved. Use Sign out to clear your login data. The app will restart.
          </p>
        </div>
        <label className={styles.confirmLabel} htmlFor="delete-all-data-confirmation">
          Type <strong>DELETE</strong> to confirm
        </label>
        <input
          id="delete-all-data-confirmation"
          className={styles.input}
          value={confirmation}
          onChange={event => setConfirmation(event.target.value)}
          placeholder="DELETE"
          autoComplete="off"
          disabled={deleting}
        />
        {error && <p className={styles.deleteError} role="alert">{error}</p>}
        <button
          className={styles.deleteAllButton}
          type="button"
          disabled={confirmation !== 'DELETE' || deleting}
          onClick={handleDelete}
        >
          {deleting ? 'Clearing…' : 'Clear app data'}
        </button>
      </div>
    </div>
  )
}

// ── Model category helpers ─────────────────────────────────────────────────

type ModelCategory = 'text' | 'vision' | 'embedding' | 'other'

function categorize(model: ModelInfo): ModelCategory {
  const id = model.id.toLowerCase()
  const name = model.displayName.toLowerCase()
  if (id.includes('embed') || name.includes('embed')) return 'embedding'
  if (model.supportsVision) return 'vision'
  if (id.includes('text') || id.includes('chat') || id.includes('instruct') ||
      id.includes('flash') || id.includes('pro') || id.includes('turbo') ||
      id.includes('sonnet') || id.includes('haiku') || id.includes('opus') ||
      id.includes('gpt') || id.includes('deepseek') || id.includes('gemini') ||
      id.includes('llama') || id.includes('mistral') || id.includes('qwen') ||
      id.includes('phi') || id.includes('gemma') || id.includes('hermes') ||
      id.includes('mixtral') || id.includes('wizardlm') || id.includes('openchat')) return 'text'
  return 'other'
}

const CATEGORY_ORDER: ModelCategory[] = ['text', 'vision', 'embedding', 'other']
const CATEGORY_LABEL: Record<ModelCategory, string> = {
  text: 'Text Generation',
  vision: 'Vision',
  embedding: 'Embedding',
  other: 'Other',
}

function sortModels(models: ModelInfo[]): Array<{ category: ModelCategory; models: ModelInfo[] }> {
  const groups: Partial<Record<ModelCategory, ModelInfo[]>> = {}
  for (const m of models) {
    const cat = categorize(m)
    if (!groups[cat]) groups[cat] = []
    groups[cat]!.push(m)
  }
  return CATEGORY_ORDER.filter(c => groups[c]?.length).map(c => ({ category: c, models: groups[c]! }))
}

// ── Provider icon SVGs ─────────────────────────────────────────────────────

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  gemini: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <path d="M12 2L6.5 12 12 22l5.5-10L12 2z" fill="#4285F4"/>
      <path d="M2 12h20" stroke="#EA4335" strokeWidth="1.5"/>
      <circle cx="12" cy="12" r="3" fill="#FBBC05"/>
    </svg>
  ),
  openai: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M22.28 9.33a5.47 5.47 0 00-.46-4.5 5.56 5.56 0 00-5.97-2.66A5.47 5.47 0 0011.78 0a5.56 5.56 0 00-5.3 3.86 5.47 5.47 0 00-3.65 2.64 5.56 5.56 0 00.68 6.53 5.47 5.47 0 00.46 4.5 5.56 5.56 0 005.97 2.66A5.47 5.47 0 0012.22 24a5.56 5.56 0 005.3-3.86 5.47 5.47 0 003.65-2.64 5.56 5.56 0 00-.89-6.17zm-8.28 11.6a4.12 4.12 0 01-2.64-.96l.13-.07 4.38-2.53a.73.73 0 00.37-.63v-6.18l1.85 1.07a.07.07 0 01.04.05v5.11a4.14 4.14 0 01-4.13 4.14zm-8.87-3.8a4.12 4.12 0 01-.5-2.77l.13.08 4.38 2.53a.72.72 0 00.73 0l5.35-3.09v2.13a.07.07 0 01-.03.06L10.8 18.1a4.14 4.14 0 01-5.67-1.8v.03zm-1.15-9.58a4.12 4.12 0 012.14-1.81v5.2a.73.73 0 00.37.63l5.35 3.09-1.85 1.07a.07.07 0 01-.07 0L5.5 12.6a4.14 4.14 0 01-.52-5.05zm15.24 3.55l-5.35-3.09 1.85-1.07a.07.07 0 01.07 0l4.43 2.56a4.13 4.13 0 01-.64 7.45v-5.2a.73.73 0 00-.36-.65zm1.84-2.78l-.13-.08-4.38-2.53a.72.72 0 00-.73 0L10.47 9.2V7.07a.07.07 0 01.03-.06l4.43-2.56a4.13 4.13 0 016.13 4.28v-.01zM9.3 13.19l-1.85-1.07a.07.07 0 01-.04-.05V6.96a4.13 4.13 0 016.77-3.17l-.13.07-4.38 2.53a.73.73 0 00-.37.63v6.17zm1-2.16L12 9.97l1.7.98v1.96L12 13.9l-1.7-.99v-1.88z"/>
    </svg>
  ),
  claude: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
      <path d="M17.33 11.66c-.27-.37-.65-.65-1.1-.82L9.6 8.25c-.6-.22-1.27-.08-1.73.36-.46.44-.6 1.11-.37 1.7l2.6 6.63c.18.45.52.82.96 1.02.44.2.94.2 1.38.02l4.62-2.02c.44-.19.8-.54.97-.98.18-.44.16-.93-.1-1.31l-.6-.01z"/>
      <path d="M14 4.5a9.5 9.5 0 100 15 9.5 9.5 0 000-15zM2 12C2 6.48 6.48 2 12 2s10 4.48 10 10-4.48 10-10 10S2 17.52 2 12z"/>
    </svg>
  ),
  deepseek: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <circle cx="12" cy="12" r="10" fill="#FF6B35" opacity=".15"/>
      <path d="M8 12a4 4 0 018 0 4 4 0 01-8 0z" fill="#FF6B35"/>
      <path d="M12 6v2M12 16v2M6 12H4M20 12h-2" stroke="#FF6B35" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  lmstudio: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <rect x="2" y="3" width="20" height="14" rx="2" stroke="var(--accent)" strokeWidth="1.5" fill="var(--accent)" opacity=".12"/>
      <path d="M7 21h10M12 17v4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M8 10l2.5 2.5L8 15" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13 14h3" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  openrouter: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <circle cx="12" cy="12" r="10" stroke="var(--accent)" strokeWidth="1.5" fill="var(--accent)" opacity=".12"/>
      <path d="M5 9l4 3-4 3M19 9l-4 3 4 3M9 5l3 4 3-4M9 19l3-4 3 4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  ollama: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <circle cx="9" cy="10" r="2" fill="#e5e5e5"/>
      <circle cx="15" cy="10" r="2" fill="#e5e5e5"/>
      <path d="M5 7c0-2.76 2.5-5 7-5s7 2.24 7 5v6c0 2.76-3.13 5-7 5s-7-2.24-7-5V7z" stroke="#e5e5e5" strokeWidth="1.5"/>
      <path d="M9 19l-1 3M15 19l1 3" stroke="#e5e5e5" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  zenmux: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#f59e0b" opacity=".15"/>
      <path d="M6 8h12L6 16h12" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  groq: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <circle cx="12" cy="12" r="10" fill="#F55036" opacity=".15"/>
      <path d="M13 3L6 13h5l-1 8 8-11h-5l1-7z" fill="#F55036"/>
    </svg>
  ),
  huggingface: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <circle cx="12" cy="12" r="10" fill="#FFD21E" opacity=".2"/>
      <ellipse cx="12" cy="13" rx="8" ry="7" fill="#FFD21E"/>
      <circle cx="9" cy="12" r="1.3" fill="#4A4A4A"/>
      <circle cx="15" cy="12" r="1.3" fill="#4A4A4A"/>
      <path d="M8.5 15.5c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5" stroke="#4A4A4A" strokeWidth="1.3" strokeLinecap="round" fill="none"/>
      <path d="M6 9c-.8-.4-1.2-1.2-1-2M18 9c.8-.4 1.2-1.2 1-2" stroke="#FFD21E" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  sarvam: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
      <rect x="2" y="2" width="20" height="20" rx="5" fill="#0EA25B" opacity=".15"/>
      <path d="M12 4l2.2 5.8L20 12l-5.8 2.2L12 20l-2.2-5.8L4 12l5.8-2.2L12 4z" fill="#0EA25B"/>
    </svg>
  ),
}

const PROVIDER_COLORS: Record<string, string> = {
  'rachna-cloud': 'var(--accent)',
  gemini:      '#4285f4',
  openai:      '#10a37f',
  claude:      '#c77cff',
  deepseek:    '#ff6b35',
  openrouter:  'var(--accent)',
  zenmux:      '#f59e0b',
  lmstudio:    'var(--accent)',
  ollama:      '#e5e5e5',
  groq:        '#F55036',
  huggingface: '#FFD21E',
  sarvam:      '#0EA25B',
}

// ── Free-tier providers ─────────────────────────────────────────────────
// Providers with a genuinely free API key tier (no card required to start).
// Surfaced in their own "Free AI Providers" row in the picker, each linking
// to the official page where the person can grab a key.

const FREE_PROVIDER_IDS = new Set(['rachna-cloud', 'gemini', 'openrouter', 'groq'])

const PROVIDER_KEY_URLS: Record<string, string> = {
  gemini:      'https://aistudio.google.com/apikey',
  openrouter:  'https://openrouter.ai/keys',
  groq:        'https://console.groq.com/keys',
  openai:      'https://platform.openai.com/api-keys',
  claude:      'https://console.anthropic.com/settings/keys',
  deepseek:    'https://platform.deepseek.com/api_keys',
  huggingface: 'https://huggingface.co/settings/tokens',
  sarvam:      'https://dashboard.sarvam.ai/admin',
}

/** Splits the registered providers into the free-tier row and everything else, preserving registry order within each group. */
function splitProvidersByTier<T extends { id: string }>(providers: T[]): { free: T[]; other: T[] } {
  const free: T[] = []
  const other: T[] = []
  for (const p of providers) {
    (FREE_PROVIDER_IDS.has(p.id) ? free : other).push(p)
  }
  return { free, other }
}

// ── Gemini embeddings toggle (repo semantic search) ────────────────────────
// Controls whether repo indexing/retrieval uses GeminiEmbeddingProvider
// (text-embedding-004) instead of the built-in LocalEmbeddingProvider.
// Default: on. Read by store/useRepoIndex.ts when kicking off a scan.

const USE_GEMINI_EMBEDDINGS_KEY = 'rachna_ide_use_gemini_embeddings'

export function getUseGeminiEmbeddings(): boolean {
  try {
    const raw = localStorage.getItem(USE_GEMINI_EMBEDDINGS_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

export function setUseGeminiEmbeddings(value: boolean): void {
  try {
    localStorage.setItem(USE_GEMINI_EMBEDDINGS_KEY, String(value))
  } catch {
    // best-effort persistence — ignore storage errors (e.g. private mode)
  }
}

// ── Gemini per-key RPM/RPD usage badge ──────────────────────────────────────
// Shown inline on each Gemini key row (for the currently selected model) so
// "how much is used" is visible per-key, not just for the active key —
// useful when juggling multiple free-tier keys for failover.

interface GeminiKeyUsageBadgeProps {
  apiKey: string
  model: string | undefined
}

function GeminiKeyUsageBadge({ apiKey, model }: GeminiKeyUsageBadgeProps) {
  const status = useGeminiQuotaStatus('gemini', apiKey, model)
  if (!status) return null

  return (
    <span
      className={styles.keyUsageBadge}
      title={
        `${status.model} free-tier usage for this key — ` +
        `${status.rpmUsed}/${status.rpm} requests this minute, ` +
        `${status.count}/${status.rpd} requests today.`
      }
      style={
        status.isExhausted
          ? { color: 'var(--error)', borderColor: 'color-mix(in srgb, var(--error) 30%, transparent)' }
          : status.isNearLimit
          ? { color: 'var(--amber)', borderColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' }
          : undefined
      }
    >
      {status.rpmUsed}/{status.rpm} rpm · {status.count}/{status.rpd} rpd
    </span>
  )
}

// ── Add/Edit key form ──────────────────────────────────────────────────────

interface KeyFormProps {
  providerId: string
  providerName: string
  editingKey?: StoredKey
  onDone: () => void
}

function KeyForm({ providerId, providerName, editingKey, onDone }: KeyFormProps) {
  const [label, setLabel] = useState(editingKey?.label ?? '')
  const [value, setValue] = useState(editingKey?.value ?? '')
  const [masked, setMasked] = useState(true)
  const { addKey, updateKey, validationState, validationError, keys } = useApiKeyStore()

  const keyCount = keys.filter(k => k.providerId === providerId).length
  const defaultLabel = editingKey ? editingKey.label : `Key ${keyCount + 1}`

  // Category names are just key labels, reused across providers/keys so the
  // same "Personal", "Work", "Client X", etc. grouping can be applied
  // everywhere. Offer every distinct label already in use, in addition to
  // letting the user type a brand-new one — a native <input list=…> combo
  // box gives us "choose existing OR type new" for free, no extra deps.
  const existingCategories = Array.from(new Set(keys.map(k => k.label).filter(Boolean))).sort()
  const categoryListId = 'api-key-category-options'

  const handleSave = async () => {
    const val = value.trim()
    if (!val) return
    const lbl = label.trim() || defaultLabel
    if (editingKey) {
      updateKey(editingKey.id, { label: lbl, value: val })
    } else {
      addKey(providerId, lbl, val)
    }
    onDone()
  }

  const targetId = editingKey?.id ?? ''
  const vState = validationState[targetId]
  const vError = validationError[targetId]

  return (
    <div className={styles.keyForm}>
      <div className={styles.keyFormRow}>
        <label className={styles.keyFormLabel}>Category</label>
        <input
          className={styles.input}
          type="text"
          list={categoryListId}
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder={defaultLabel}
        />
        <datalist id={categoryListId}>
          {existingCategories.map(cat => <option key={cat} value={cat} />)}
        </datalist>
        <p className={styles.keyFormHint}>
          Pick an existing category or type a new one — used to group your keys and models.
        </p>
      </div>
      <div className={styles.keyFormRow}>
        <label className={styles.keyFormLabel}>API Key</label>
        <div className={styles.inputWrap}>
          <input
            className={styles.input}
            type={masked ? 'password' : 'text'}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={`${providerName} API key`}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            className={styles.toggleBtn}
            type="button"
            onClick={() => setMasked(m => !m)}
            title={masked ? 'Show key' : 'Hide key'}
          >
            {masked ? '👁' : '🙈'}
          </button>
        </div>
      </div>
      {vState === 'error' && <p className={styles.keyError}>{vError}</p>}
      <div className={styles.keyFormActions}>
        <button className={styles.btnSecondary} type="button" onClick={onDone}>Cancel</button>
        <button
          className={styles.btnPrimary}
          type="button"
          onClick={handleSave}
          disabled={!value.trim()}
        >
          {editingKey ? 'Update' : 'Add Key'}
        </button>
      </div>
    </div>
  )
}

// ── Compact model card ─────────────────────────────────────────────────────

function ModelCompactCard({ model, selected, onSelect }: {
  model: ModelInfo
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={`${styles.modelCompact} ${selected ? styles.modelCompactActive : ''}`}
      onClick={onSelect}
      title={[
        model.displayName,
        model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}k ctx` : '',
        model.supportsTools ? 'Tools' : '',
        model.supportsVision ? 'Vision' : '',
        model.supportsStreaming ? 'Streaming' : '',
      ].filter(Boolean).join(' · ')}
    >
      <span className={styles.modelCompactCheck}>
        {selected ? '●' : '○'}
      </span>
      <span className={styles.modelCompactName}>{model.displayName}</span>
      <span className={styles.modelCompactTags}>
        {model.contextWindow && (
          <span className={styles.modelTag}>{(model.contextWindow / 1000).toFixed(0)}k</span>
        )}
        {model.supportsTools && <span className={`${styles.modelTag} ${styles.modelTagGreen}`}>tools</span>}
        {model.supportsVision && <span className={`${styles.modelTag} ${styles.modelTagBlue}`}>vision</span>}
      </span>
    </button>
  )
}

// ── URL health-check helper ────────────────────────────────────────────────
// Used by all URL-based providers (LM Studio, Ollama, Zenmux self-hosted)
// to validate reachability before attempting model discovery.
//
// useTauri=true routes the request through Tauri's reqwest backend (no CORS).
// Required for Zenmux because the server doesn't whitelist the webview origin.

async function checkUrlHealth(
  baseUrl: string,
  apiKey?: string,
  useTauri = false,
): Promise<{ ok: boolean; error?: string }> {
  const url = baseUrl.replace(/\/+$/, '')

  if (useTauri) {
    // Route through Tauri (reqwest) — bypasses CORS entirely.
    // No Content-Type, no auth header (Zenmux /models is unauthenticated).
    try {
      const result = await invoke<{
        status: number; ok: boolean; body: string; timed_out: boolean
      }>('run_http_request', {
        args: {
          url:             `${url}/models`,
          method:          'GET',
          headers:         undefined,
          body:            undefined,
          timeout_seconds: 10,
        },
      })
      if (result.timed_out) return { ok: false, error: 'Connection timed out — is the server running?' }
      if (result.ok || result.status === 401) return { ok: true }
      return { ok: false, error: `Server returned ${result.status}` }
    } catch (e) {
      return { ok: false, error: `Cannot reach server: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(`${url}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    })
    // 200-299 = healthy; 401 = reachable but unauthorised (still counts as alive)
    if (res.ok || res.status === 401) return { ok: true }
    return { ok: false, error: `Server returned ${res.status} ${res.statusText}` }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('timeout') || e instanceof DOMException && e.name === 'TimeoutError') {
      return { ok: false, error: 'Connection timed out — is the server running?' }
    }
    return { ok: false, error: `Cannot reach server: ${msg}` }
  }
}

// ── Configure panel (expanded for a provider) ──────────────────────────────

interface ConfigurePanelProps {
  providerId: string
  displayName: string
  onBack: () => void
}

function ConfigurePanel({ providerId, displayName, onBack }: ConfigurePanelProps) {
  const {
    removeKey, setActiveKey, getKeysForProvider,
    getModels, validateAndFetchModels, validationState, validationError,
    selectedModels, setSelectedModel, addCustomModel,
  } = useApiKeyStore()

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null)

  // Gemini-specific: token usage & models screen
  const [usagePanelOpen, setUsagePanelOpen] = useState(false)

  // LM Studio-specific state
  const [lmUrl, setLmUrl] = useState(() => getLMStudioBaseUrl())
  const [lmKey, setLmKey] = useState(() => getLMStudioApiKey())
  const [lmConnecting, setLmConnecting] = useState(false)
  const [lmConnectErr, setLmConnectErr] = useState('')
  const [lmConnectOk, setLmConnectOk] = useState(false)

  // Ollama-specific state
  const [ollamaUrl, setOllamaUrlState] = useState(() => getOllamaBaseUrl())
  const [ollamaConnecting, setOllamaConnecting] = useState(false)
  const [ollamaConnectErr, setOllamaConnectErr] = useState('')
  const [ollamaConnectOk, setOllamaConnectOk] = useState(false)

  // ── Zenmux state ────────────────────────────────────────────────────────
  const [zenmuxUrl, setZenmuxUrlState] = useState(() => getZenmuxBaseUrl())
  const [zenmuxMode, setZenmuxModeState] = useState<ZenmuxMode>(() => getZenmuxMode())
  const [zenmuxPayg, setZenmuxPaygState] = useState(() => getZenmuxPaygKey())
  const [zenmuxPaygMasked, setZenmuxPaygMasked] = useState(true)
  const [zenmuxConnecting, setZenmuxConnecting] = useState(false)
  const [zenmuxConnectErr, setZenmuxConnectErr] = useState('')
  const [zenmuxConnectOk, setZenmuxConnectOk] = useState(false)
  const [semanticEnabled, setSemanticEnabledState] = useState(() => isSemanticSearchEnabled())
  const [embedModel, setEmbedModelState] = useState(() => getEmbedModel())
  const [embedStats, setEmbedStats] = useState<{ embedded_chunks: number; total_chunks: number; ollama_reachable: boolean } | null>(null)
  const [embedStatsLoading, setEmbedStatsLoading] = useState(false)
  const [reembedding, setReembedding] = useState(false)
  const [reembedResult, setReembedResult] = useState<string>('')
  const [lastIndexedAt, setLastIndexedAt] = useState<string>('')

  const projectRoot = useRepoIndex(s => s.projectRoot)

  const refreshEmbedStats = useCallback(async () => {
    if (!projectRoot) {
      setEmbedStats(null)
      return
    }
    setEmbedStatsLoading(true)
    try {
      const stats = await invoke<{ embedded_chunks: number; total_chunks: number; ollama_reachable: boolean }>('get_embedding_stats', { root: projectRoot })
      setEmbedStats(stats)
    } catch {
      setEmbedStats(null)
    } finally {
      setEmbedStatsLoading(false)
    }
  }, [projectRoot])
  useEffect(() => {
    refreshEmbedStats()
  }, [refreshEmbedStats])
  
  async function handleReembed() {
    if (!projectRoot) {
      setReembedResult('✗ No project open')
      return
    }
    setReembedding(true)
    setReembedResult('')
    try {
      const embedded = await invoke<number>('reembed_repo', { root: projectRoot })
      setReembedResult(`✓ Re-embedded ${embedded} chunk${embedded === 1 ? '' : 's'}`)
      setLastIndexedAt(new Date().toLocaleString())
      await refreshEmbedStats()
    } catch (e) {
      setReembedResult(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReembedding(false)
    }
  }

  const isLMStudio = providerId === 'lmstudio'
  const isCloud = providerId === 'rachna-cloud'
  const cloudSignedIn = useAuthStore(s => s.isAuthenticated)
  const cloudEmail = useAuthStore(s => s.userInfo?.email)
  const isOllama = providerId === 'ollama'
  const isZenmux = providerId === 'zenmux'
  const isLocalProvider = isLMStudio || isOllama
  const isGemini = providerId === 'gemini'
  const isHuggingFace = providerId === 'huggingface'

  const [hfCustomModel, setHfCustomModel] = useState('')
  function handleAddHfModel() {
    const trimmed = hfCustomModel.trim()
    if (!trimmed) return
    addCustomModel(providerId, trimmed)
    setHfCustomModel('')
  }

  async function handleZenmuxConnect() {
    setZenmuxConnecting(true)
    setZenmuxConnectErr('')
    setZenmuxConnectOk(false)

    // Resolve effective URL & key
    const effectiveUrl = zenmuxMode === 'cloud' ? 'https://zenmux.ai/api/v1' : zenmuxUrl
    const effectiveKey = zenmuxMode === 'cloud' ? zenmuxPayg : undefined

    // Persist
    setZenmuxBaseUrl(effectiveUrl)
    if (zenmuxMode === 'cloud') setZenmuxPaygKey(zenmuxPayg)

    // ── Step 1: health-check the URL ──────────────────────────────────────
    // Always route through Tauri (reqwest) — Zenmux doesn't allow the
    // webview's origin in CORS headers, so browser fetch always fails.
    // /models requires no auth and no Content-Type on either mode.
    const health = await checkUrlHealth(effectiveUrl, undefined, true)
    if (!health.ok) {
      setZenmuxConnectErr(health.error ?? 'Cannot reach Zenmux endpoint.')
      setZenmuxConnecting(false)
      return
    }

    // ── Step 2: ensure a key entry exists, then discover models ───────────
    const store = useApiKeyStore.getState()
    let zenmuxKeys = store.getKeysForProvider('zenmux')

    if (zenmuxMode === 'cloud') {
      // For PAYG use the actual API key
      if (zenmuxKeys.length === 0) {
        store.addKey('zenmux', 'Pay as you go', zenmuxPayg)
        zenmuxKeys = store.getKeysForProvider('zenmux')
      } else {
        // Update existing key value so model fetch uses the latest key
        store.updateKey(zenmuxKeys[0].id, { value: zenmuxPayg })
      }
    } else {
      // Self-hosted: use sentinel
      if (zenmuxKeys.length === 0) {
        store.addKey('zenmux', 'Self-hosted Gateway', '__zenmux__')
        zenmuxKeys = store.getKeysForProvider('zenmux')
      }
    }

    const keyId = zenmuxKeys[0]?.id
    if (!keyId) {
      setZenmuxConnectErr('Failed to create key entry.')
      setZenmuxConnecting(false)
      return
    }
    const result = await store.validateAndFetchModels(keyId)
    if (result.ok) {
      setZenmuxConnectOk(true)
    } else {
      setZenmuxConnectErr(result.error ?? 'Connection failed.')
    }
    setZenmuxConnecting(false)
  }

  // Gemini-specific: whether repo semantic search uses Gemini embeddings
  // (text-embedding-004) instead of the local fallback provider.
  const [useGeminiEmbeddings, setUseGeminiEmbeddingsState] = useState(() => getUseGeminiEmbeddings())

  async function handleLMStudioConnect() {
    setLmConnecting(true)
    setLmConnectErr('')
    setLmConnectOk(false)
    // Persist settings first so the provider picks them up
    setLMStudioBaseUrl(lmUrl)
    setLMStudioApiKey(lmKey)

    // ── Step 1: health-check the URL ──────────────────────────────────────
    // LM Studio native API lives at /api/v1/models, not /models
    const lmRoot = lmUrl.trim()
      .replace(/\/api\/v1\/?$/, '')
      .replace(/\/v1\/?$/, '')
      .replace(/\/api\/?$/, '')
      .replace(/\/+$/, '') || LM_STUDIO_DEFAULT_URL
    const health = await checkUrlHealth(`${lmRoot}/api/v1`, lmKey || undefined)
    if (!health.ok) {
      setLmConnectErr(health.error ?? 'Cannot reach LM Studio server.')
      setLmConnecting(false)
      return
    }

    // Use a sentinel key id — LM Studio uses its own key storage,
    // but we need an entry in the key store for model discovery to work.
    const store = useApiKeyStore.getState()
    let lmKeys = store.getKeysForProvider('lmstudio')
    if (lmKeys.length === 0) {
      store.addKey('lmstudio', 'Local Server', '__lmstudio__')
      lmKeys = store.getKeysForProvider('lmstudio')
    }
    const keyId = lmKeys[0]?.id
    if (!keyId) {
      setLmConnectErr('Failed to create key entry.')
      setLmConnecting(false)
      return
    }
    const result = await store.validateAndFetchModels(keyId)
    if (result.ok) {
      setLmConnectOk(true)
    } else {
      setLmConnectErr(result.error ?? 'Connection failed.')
    }
    setLmConnecting(false)
  }

  async function handleOllamaConnect() {
    setOllamaConnecting(true)
    setOllamaConnectErr('')
    setOllamaConnectOk(false)
    setOllamaBaseUrl(ollamaUrl)

    // ── Step 1: health-check the URL ──────────────────────────────────────
    const health = await checkUrlHealth(ollamaUrl)
    if (!health.ok) {
      setOllamaConnectErr(health.error ?? 'Cannot reach Ollama server.')
      setOllamaConnecting(false)
      return
    }

    // Use a sentinel key id — Ollama needs no API key, but we still need an
    // entry in the key store for model discovery to work.
    const store = useApiKeyStore.getState()
    let ollamaKeys = store.getKeysForProvider('ollama')
    if (ollamaKeys.length === 0) {
      store.addKey('ollama', 'Local Server', '__ollama__')
      ollamaKeys = store.getKeysForProvider('ollama')
    }
    const keyId = ollamaKeys[0]?.id
    if (!keyId) {
      setOllamaConnectErr('Failed to create key entry.')
      setOllamaConnecting(false)
      return
    }
    const result = await store.validateAndFetchModels(keyId)
    if (result.ok) {
      setOllamaConnectOk(true)
    } else {
      setOllamaConnectErr(result.error ?? 'Connection failed.')
    }
    setOllamaConnecting(false)
  }

  const providerKeys = getKeysForProvider(providerId)
  const models = getModels(providerId)
  const selectedModelId = selectedModels[providerId] ?? models[0]?.id
  const sortedGroups = sortModels(models)

  return (
    <div className={styles.configPanel}>
      <div className={styles.configHeader}>
        <button className={styles.backBtn} onClick={onBack} title="Back to providers">
          ← Back
        </button>
        <div className={styles.configTitle}>
          <div
            className={styles.configProviderIcon}
            style={{ color: PROVIDER_COLORS[providerId] ?? 'var(--text-muted)' }}
          >
            {PROVIDER_ICONS[providerId] ?? displayName[0]}
          </div>
          <span>{displayName}</span>
        </div>
      </div>

      {isCloud && (
        <>
          <p className={styles.sectionHint}>
            {cloudSignedIn
              ? <>Signed in as <strong>{cloudEmail ?? 'your Rachna account'}</strong>. Cloud AI uses your account session and server-managed coin balance; no API key is required.</>
              : <>Rachna Cloud AI is the only part of Rachna IDE that needs an account — everything else works without one. Sign in to use it, or pick another provider and add your own API key.</>}
          </p>
          <div style={{ marginTop: 8 }}>
            {cloudSignedIn ? (
              <button className={styles.btnSecondary} onClick={() => { void useAuthStore.getState().logout() }}>
                Sign out
              </button>
            ) : (
              <button className={styles.btnPrimary} onClick={() => useAuthStore.getState().openLoginDialog()}>
                Sign in to Rachna Cloud
              </button>
            )}
          </div>
        </>
      )}

      {/* LM Studio server config */}
      {isLMStudio && (
        <>
          <div className={styles.configSection}>
            <span className={styles.configSectionLabel}>LOCAL SERVER</span>
          </div>
          <p className={styles.sectionHint}>
            LM Studio runs a local server with its own native REST API (not OpenAI-compatible).
            Start the server in LM Studio → Local Server tab, then connect here. To use a remote
            LM Studio (another PC on your network, via Tailscale, etc.), set the Base URL to that
            machine's address, e.g. http://192.168.1.42:1234 — just make sure LM Studio's server
            is configured to listen on the network, not only localhost.
          </p>
          <div className={styles.keyFormRow}>
            <label className={styles.keyFormLabel}>Base URL</label>
            <input
              className={styles.input}
              type="text"
              value={lmUrl}
              onChange={e => { setLmUrl(e.target.value); setLmConnectOk(false) }}
              placeholder={LM_STUDIO_DEFAULT_URL}
              spellCheck={false}
            />
          </div>
          {/* Resolved endpoint preview — always shown so the user knows what's being hit */}
          {(() => {
            const root = (lmUrl || LM_STUDIO_DEFAULT_URL)
              .trim()
              .replace(/\/api\/v1\/?$/, '')
              .replace(/\/v1\/?$/, '')
              .replace(/\/api\/?$/, '')
              .replace(/\/+$/, '') || LM_STUDIO_DEFAULT_URL
            return (
              <div style={{
                background: 'var(--bg-base)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '8px 10px',
                marginBottom: 10,
                fontFamily: 'var(--font-code)',
                fontSize: 11,
              }}>
                <div style={{ color: 'var(--text-muted)', marginBottom: 4, fontFamily: 'var(--font-ui)', fontSize: 10, letterSpacing: '0.06em' }}>RESOLVED ENDPOINTS</div>
                <div style={{ color: 'var(--text-secondary)', lineHeight: 1.9 }}>
                  <span style={{ color: 'var(--green)' }}>Models:</span>{' '}
                  <span style={{ color: 'var(--text-code)' }}>{root}/api/v1/models</span>
                </div>
                <div style={{ color: 'var(--text-secondary)', lineHeight: 1.9 }}>
                  <span style={{ color: 'var(--cyan)' }}>Chat:&nbsp;&nbsp;</span>{' '}
                  <span style={{ color: 'var(--text-code)' }}>{root}/api/v1/chat</span>
                </div>
              </div>
            )
          })()}
          <div className={styles.keyFormRow}>
            <label className={styles.keyFormLabel}>API Key <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
            <input
              className={styles.input}
              type="password"
              value={lmKey}
              onChange={e => { setLmKey(e.target.value); setLmConnectOk(false) }}
              placeholder="Leave empty if not set"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          {lmConnectErr && <p className={styles.keyError}>{lmConnectErr}</p>}
          {lmConnectOk && <p style={{ color: 'var(--accent)', fontSize: 12, margin: '4px 0 8px' }}>✓ Connected — models discovered below</p>}
          <button
            className={styles.btnPrimary}
            type="button"
            style={{ marginBottom: 12 }}
            onClick={handleLMStudioConnect}
            disabled={lmConnecting}
          >
            {lmConnecting ? 'Connecting…' : 'Connect & Discover Models'}
          </button>
        </>
      )}

      {/* Zenmux gateway config */}
      {isZenmux && (
        <>
          <div className={styles.configSection}>
            <span className={styles.configSectionLabel}>MODE</span>
          </div>

          {/* Mode toggle */}
          <div className={styles.zenmuxModeRow}>
            <button
              className={`${styles.zenmuxModeBtn} ${zenmuxMode === 'cloud' ? styles.zenmuxModeBtnActive : ''}`}
              type="button"
              onClick={() => {
                setZenmuxModeState('cloud')
                setZenmuxMode('cloud')
                setZenmuxConnectOk(false)
                setZenmuxConnectErr('')
              }}
            >
              ☁ Cloud (Pay as you go)
            </button>
            <button
              className={`${styles.zenmuxModeBtn} ${zenmuxMode === 'selfhosted' ? styles.zenmuxModeBtnActive : ''}`}
              type="button"
              onClick={() => {
                setZenmuxModeState('selfhosted')
                setZenmuxMode('selfhosted')
                setZenmuxConnectOk(false)
                setZenmuxConnectErr('')
              }}
            >
              🔧 Self-hosted / Proxy
            </button>
          </div>

          {zenmuxMode === 'cloud' ? (
            <>
              <p className={styles.sectionHint}>
                Use Zenmux's hosted endpoint — pay per token with your Zenmux API key.
                The official endpoint <code>https://zenmux.ai/api/v1</code> is used automatically.
                No API key is needed for model discovery — only for inference.
              </p>
              <div className={styles.keyFormRow}>
                <label className={styles.keyFormLabel}>Zenmux API Key (Pay as you go)</label>
                <div className={styles.inputWrap}>
                  <input
                    className={styles.input}
                    type={zenmuxPaygMasked ? 'password' : 'text'}
                    value={zenmuxPayg}
                    onChange={e => { setZenmuxPaygState(e.target.value); setZenmuxConnectOk(false) }}
                    placeholder="zx-…"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    className={styles.toggleBtn}
                    type="button"
                    onClick={() => setZenmuxPaygMasked(m => !m)}
                    title={zenmuxPaygMasked ? 'Show key' : 'Hide key'}
                  >
                    {zenmuxPaygMasked ? '👁' : '🙈'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className={styles.sectionHint}>
                Point to your own Zenmux deployment, a local reverse-proxy, or any
                OpenAI-compatible gateway. Health is checked before model discovery.
              </p>
              <div className={styles.keyFormRow}>
                <label className={styles.keyFormLabel}>Base URL</label>
                <input
                  className={styles.input}
                  type="text"
                  value={zenmuxUrl}
                  onChange={e => { setZenmuxUrlState(e.target.value); setZenmuxBaseUrl(e.target.value); setZenmuxConnectOk(false) }}
                  placeholder={ZENMUX_DEFAULT_URL}
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {zenmuxConnectErr && <p className={styles.keyError}>{zenmuxConnectErr}</p>}
          {zenmuxConnectOk && (
            <p style={{ color: 'var(--accent)', fontSize: 12, margin: '4px 0 8px' }}>
              ✓ Connected — models discovered below
            </p>
          )}
          <button
            className={styles.btnPrimary}
            type="button"
            style={{ marginBottom: 12 }}
            onClick={handleZenmuxConnect}
            disabled={zenmuxConnecting || (zenmuxMode === 'cloud' && !zenmuxPayg.trim())}
          >
            {zenmuxConnecting ? 'Connecting…' : 'Connect & Discover Models'}
          </button>
        </>
      )}

      {/* Ollama server config */}
      {isOllama && (
        <>
          <div className={styles.configSection}>
            <span className={styles.configSectionLabel}>LOCAL SERVER</span>
          </div>
          <p className={styles.sectionHint}>
            Ollama runs a local OpenAI-compatible server. Start it with <code>ollama serve</code> and pull at least one model (<code>ollama pull llama3.1</code>), then connect here.
          </p>
          <div className={styles.keyFormRow}>
            <label className={styles.keyFormLabel}>Base URL</label>
            <input
              className={styles.input}
              type="text"
              value={ollamaUrl}
              onChange={e => { setOllamaUrlState(e.target.value); setOllamaConnectOk(false) }}
              placeholder={OLLAMA_DEFAULT_URL}
              spellCheck={false}
            />
          </div>
          {ollamaConnectErr && <p className={styles.keyError}>{ollamaConnectErr}</p>}
          {ollamaConnectOk && <p style={{ color: 'var(--accent)', fontSize: 12, margin: '4px 0 8px' }}>✓ Connected — models discovered below</p>}
          <button
            className={styles.btnPrimary}
            type="button"
            style={{ marginBottom: 12 }}
            onClick={handleOllamaConnect}
            disabled={ollamaConnecting}
          >
            {ollamaConnecting ? 'Connecting…' : 'Connect & Discover Models'}
          </button>

          {/* ── Embeddings (hybrid semantic search) ───────────────────── */}
          <div className={styles.configSection}>
            <span className={styles.configSectionLabel}>EMBEDDINGS</span>
          </div>
          <p className={styles.sectionHint}>
            Repo search blends keyword (FTS5) and semantic (vector) matching. Semantic matching uses an Ollama embedding model — if Ollama isn't reachable, search falls back to keyword-only automatically.
          </p>

          <div className={styles.keyFormRow} style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
            <label className={styles.keyFormLabel} style={{ marginBottom: 0 }}>Enable semantic search</label>
            <input
              type="checkbox"
              checked={semanticEnabled}
              onChange={e => {
                setSemanticEnabledState(e.target.checked)
                setSemanticSearchEnabled(e.target.checked)
              }}
            />
          </div>

          <div className={styles.keyFormRow}>
            <label className={styles.keyFormLabel}>Embedding model</label>
            <input
              className={styles.input}
              type="text"
              value={embedModel}
              onChange={e => {
                setEmbedModelState(e.target.value)
                setEmbedModel(e.target.value)
              }}
              placeholder={DEFAULT_EMBED_MODEL}
              spellCheck={false}
              disabled={!semanticEnabled}
            />
          </div>

          <p className={styles.sectionHint} style={{ marginTop: 0 }}>
            {embedStatsLoading
              ? 'Checking embedding status…'
              : embedStats
                ? `${embedStats.embedded_chunks} / ${embedStats.total_chunks} chunks embedded — Ollama ${embedStats.ollama_reachable ? 'reachable' : 'unreachable'}`
                : 'Embedding status unavailable.'}
            {lastIndexedAt ? ` · Last re-indexed: ${lastIndexedAt}` : ''}
          </p>

          {reembedResult && <p className={styles.sectionHint} style={{ marginTop: 0 }}>{reembedResult}</p>}

          <button
            className={styles.btnPrimary}
            type="button"
            style={{ marginBottom: 12 }}
            onClick={handleReembed}
            disabled={reembedding || !semanticEnabled}
          >
            {reembedding ? 'Re-embedding…' : 'Re-embed entire repo'}
          </button>
        </>
      )}

      {/* Keys section — hidden for local providers and Zenmux (manage keys via connect flow) */}
      {!isCloud && !isLocalProvider && !isZenmux && (
        <>

      <p className={styles.sectionHint}>
        Keys are stored locally. Click <strong>○</strong> to set active. On quota errors, the next key is tried automatically.
      </p>

      {providerKeys.map(key => {
        const isEditing = editingKeyId === key.id
        const vState = validationState[key.id]
        const vError = validationError[key.id]

        return (
          <div key={key.id} className={`${styles.keyRow} ${key.active ? styles.keyRowActive : ''}`}>
            {isEditing ? (
              <KeyForm
                providerId={providerId}
                providerName={displayName}
                editingKey={key}
                onDone={() => setEditingKeyId(null)}
              />
            ) : (
              <>
                <div className={styles.keyRowLeft}>
                  <button
                    className={`${styles.activeIndicator} ${key.active ? styles.activeIndicatorOn : ''}`}
                    onClick={() => setActiveKey(key.id)}
                    title={key.active ? 'Active key' : 'Set as active'}
                  >
                    {key.active ? '●' : '○'}
                  </button>
                  <div className={styles.keyInfo}>
                    <span className={styles.keyLabel}>{key.label}</span>
                    <span className={styles.keyValue}>
                      {key.value.slice(0, 4)}{'•'.repeat(Math.max(0, key.value.length - 8))}{key.value.slice(-4)}
                    </span>
                  </div>
                  {vState === 'validating' && <span className={styles.validating} title="Validating…">⟳</span>}
                  {vState === 'ok' && <span className={styles.valid} title="Key valid">✓</span>}
                  {vState === 'error' && <span className={styles.invalid} title={vError}>⚠</span>}
                  {isGemini && selectedModelId && (
                    <GeminiKeyUsageBadge apiKey={key.value} model={selectedModelId} />
                  )}
                </div>
                <div className={styles.keyRowActions}>
                  <button className={styles.keyBtn} title="Refresh models" onClick={() => validateAndFetchModels(key.id)}>⟳</button>
                  <button className={styles.keyBtn} title="Edit key" onClick={() => setEditingKeyId(key.id)}>✎</button>
                  <button
                    className={`${styles.keyBtn} ${styles.keyBtnDanger}`}
                    title="Delete key"
                    onClick={() => { if (confirm(`Delete "${key.label}"?`)) removeKey(key.id) }}
                  >✕</button>
                </div>
              </>
            )}
          </div>
        )
      })}

      {showAddForm && (
        <KeyForm
          providerId={providerId}
          providerName={displayName}
          onDone={() => setShowAddForm(false)}
        />
      )}

      {!showAddForm && !editingKeyId && (
        <button className={styles.addKeyBtn} onClick={() => setShowAddForm(true)}>
          + Add {displayName} Key
        </button>
      )}
        </>
      )}

      {/* Gemini-only: repo semantic search embedding provider toggle */}
      {isGemini && (
        <div className={styles.configSection} style={{ marginTop: 12, marginBottom: 4 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={useGeminiEmbeddings}
              onChange={e => {
                const next = e.target.checked
                setUseGeminiEmbeddingsState(next)
                setUseGeminiEmbeddings(next)
              }}
            />
            Use Gemini embeddings for repo search
          </label>
          <p className={styles.sectionHint} style={{ marginTop: 4 }}>
            Uses Gemini's <code>text-embedding-004</code> model for repo-wide semantic
            search (higher quality, uses API quota). When off, falls back to the
            built-in local embedding provider — no API calls, lower quality.
          </p>
          <button
            className={styles.addKeyBtn}
            style={{ marginTop: 10 }}
            onClick={() => setUsagePanelOpen(true)}
          >
            📊 View Token Usage &amp; Models
          </button>
          <GeminiUsagePanel open={usagePanelOpen} onClose={() => setUsagePanelOpen(false)} />
        </div>
      )}

      {/* Hugging Face: arbitrary Hub model id entry — discovery only returns a
          curated subset of "warm" models, so let the person type any repo id
          the Hub hosts and their token has inference access to. */}
      {isHuggingFace && providerKeys.length > 0 && (
        <>
          <div className={styles.configSection} style={{ marginTop: 16 }}>
            <span className={styles.configSectionLabel}>MODEL</span>
          </div>
          <p className={styles.sectionHint}>
            Hugging Face hosts hundreds of thousands of models — enter the exact
            Hub id, e.g. <code>bharatgenai/Param-1</code> or{' '}
            <code>meta-llama/Llama-3.1-8B-Instruct</code>.
          </p>
          <div className={styles.keyFormRow}>
            <label className={styles.keyFormLabel}>Model ID</label>
            <input
              className={styles.input}
              type="text"
              value={hfCustomModel}
              onChange={e => setHfCustomModel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddHfModel() }}
              placeholder="e.g. bharatgenai/Param-1"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button
            className={styles.addKeyBtn}
            type="button"
            onClick={handleAddHfModel}
            disabled={!hfCustomModel.trim()}
          >
            + Add Model
          </button>
        </>
      )}

      {/* Models section */}
      {models.length > 0 && (
        <>
          <div className={styles.configSection} style={{ marginTop: 16 }}>
            <span className={styles.configSectionLabel}>SELECT MODEL</span>
          </div>

          <div className={styles.modelGroups}>
            {sortedGroups.map(({ category, models: groupModels }) => (
              <div key={category} className={styles.modelGroup}>
                <div className={styles.modelGroupLabel}>{CATEGORY_LABEL[category]}</div>
                {groupModels.map(m => (
                  <ModelCompactCard
                    key={m.id}
                    model={m}
                    selected={m.id === selectedModelId}
                    onSelect={() => setSelectedModel(providerId, m.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {models.length === 0 && providerKeys.length > 0 && !isLocalProvider && !isHuggingFace && (
        <p className={styles.noModelsHint}>
          No models loaded yet. Click ⟳ on a key to fetch models.
        </p>
      )}

      {models.length === 0 && isLMStudio && (
        <p className={styles.noModelsHint}>
          No models found yet. Make sure LM Studio is running with at least one model loaded, then click "Connect &amp; Discover Models" above.
        </p>
      )}

      {models.length === 0 && isOllama && (
        <p className={styles.noModelsHint}>
          No models found yet. Make sure Ollama is running and you've pulled at least one model, then click "Connect &amp; Discover Models" above.
        </p>
      )}

      {models.length === 0 && isZenmux && (
        <p className={styles.noModelsHint}>
          No models discovered yet. {zenmuxMode === 'cloud' ? 'Enter your Pay-as-you-go API key and' : 'Set your gateway URL and'} click "Connect &amp; Discover Models" above.
        </p>
      )}
    </div>
  )
}

// ── Provider grid tile (summary view) ─────────────────────────────────────

interface ProviderCardProps {
  providerId: string
  displayName: string
  onConfigure: () => void
  /** Official page to grab an API key — shown as a small link on the card when present. */
  keyUrl?: string
}

function ProviderCard({ providerId, displayName, onConfigure, keyUrl }: ProviderCardProps) {
  const { getKeysForProvider, getModels, selectedModels } = useApiKeyStore()

  const providerKeys = getKeysForProvider(providerId)
  const models = getModels(providerId)
  const selectedModelId = selectedModels[providerId] ?? models[0]?.id
  const selectedModel = models.find(m => m.id === selectedModelId)
  const hasKeys = providerKeys.length > 0
  const isCloud = providerId === 'rachna-cloud'
  const cloudSignedIn = useAuthStore(s => s.isAuthenticated)
  const color = PROVIDER_COLORS[providerId] ?? 'var(--text-muted)'

  return (
    <div
      className={`${styles.providerTile} ${hasKeys ? styles.providerTileActive : ''}`}
      onClick={onConfigure}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onConfigure()
        }
      }}
      role="button"
      tabIndex={0}
      title={isCloud ? 'Rachna Cloud AI — requires signing in to a Rachna account' : `Configure ${displayName}`}
    >
      {/* Status dot */}
      <span
        className={styles.providerTileStatus}
        style={{ background: hasKeys ? 'var(--accent)' : 'var(--text-muted)' }}
      />

      {/* Icon */}
      <div className={styles.providerTileIcon} style={{ color, borderColor: `${color}33` }}>
        {PROVIDER_ICONS[providerId] ?? (
          <span style={{ fontSize: 18, fontWeight: 700 }}>{displayName[0]}</span>
        )}
      </div>

      {/* Name */}
      <div className={styles.providerTileName}>{displayName}</div>

      {/* Meta */}
      <div className={styles.providerTileMeta}>
        {isCloud ? (
          <span>{cloudSignedIn ? 'Signed in · no API key' : 'Sign in required'}</span>
        ) : hasKeys ? (
          <span>{providerKeys.length} key{providerKeys.length !== 1 ? 's' : ''}</span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>No keys</span>
        )}
      </div>

      {/* Selected model */}
      {selectedModel && (
        <div className={styles.providerTileModel}>{selectedModel.displayName}</div>
      )}

      {/* Get a free API key — official provider page, opens in a new tab */}
      {keyUrl && !hasKeys && (
        <a
          className={styles.providerTileKeyLink}
          href={keyUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={`Get a free ${displayName} API key on their official site`}
        >
          Get free key ↗
        </a>
      )}

      {/* Configure label */}
      <div className={styles.providerTileBtn}>{isCloud ? (cloudSignedIn ? 'Default provider' : 'Sign in') : 'Configure'}</div>
    </div>
  )
}

// ── Setup wizard (shown on startup if no key/model) ────────────────────────

interface SetupWizardProps {
  onDone: () => void
}

function SetupWizard({ onDone }: SetupWizardProps) {
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
  const allProviders = getAllProviders()
  const { free: freeProviders, other: otherProviders } = splitProvidersByTier(allProviders)
  const { getKeysForProvider, getModels, selectedModels } = useApiKeyStore()

  const hasAnyKey = allProviders.some(p => getKeysForProvider(p.id).length > 0)
  const hasAnyModel = allProviders.some(p => p.id === 'rachna-cloud' || (() => {
    const models = getModels(p.id)
    return models.length > 0 && (selectedModels[p.id] || models[0])
  })())

  if (activeProviderId) {
    const prov = allProviders.find(p => p.id === activeProviderId)!
    return (
      <div className={styles.wizardWrap}>
        <ConfigurePanel
          providerId={activeProviderId}
          displayName={prov.displayName}
          onBack={() => setActiveProviderId(null)}
        />
        {hasAnyKey && hasAnyModel && (
          <div className={styles.wizardFooter}>
            <button className={styles.btnPrimary} onClick={onDone}>
              Start using Rachna AI Studio →
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.wizardWrap}>
      <div className={styles.wizardHero}>
        <div className={styles.wizardIcon}>⚡</div>
        <h2 className={styles.wizardTitle}>Configure an AI Provider</h2>
        <p className={styles.wizardSubtitle}>
          Use Rachna Cloud AI (sign in with a Rachna account), or add your own API key / a local model — no account needed for those.
        </p>
      </div>

      <div className={styles.providerSections}>
        <div className={styles.configSection}>
          <span className={styles.configSectionLabel}>🆓 FREE AI PROVIDERS</span>
        </div>
        <div className={styles.providerGrid}>
          {freeProviders.map(p => (
            <ProviderCard
              key={p.id}
              providerId={p.id}
              displayName={p.displayName}
              keyUrl={PROVIDER_KEY_URLS[p.id]}
              onConfigure={() => setActiveProviderId(p.id)}
            />
          ))}
        </div>

        <div className={styles.configSection} style={{ marginTop: 16 }}>
          <span className={styles.configSectionLabel}>OTHER PROVIDERS</span>
        </div>
        <div className={styles.providerGrid}>
          {otherProviders.map(p => (
            <ProviderCard
              key={p.id}
              providerId={p.id}
              displayName={p.displayName}
              keyUrl={PROVIDER_KEY_URLS[p.id]}
              onConfigure={() => setActiveProviderId(p.id)}
            />
          ))}
        </div>
      </div>

      {hasAnyKey && hasAnyModel && (
        <div className={styles.wizardFooter}>
          <button className={styles.btnPrimary} onClick={onDone}>
            Start using Rachna AI Studio →
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main SettingsModal ────────────────────────────────────────────────────

// ── ProjectRulesTab ──────────────────────────────────────────────────────────
// Lets the user create / edit .rachna/rules.md directly from the Settings
// modal. The file is written via tauriFs.saveFile and the agent picks it up
// on the very next chat turn — no restart required.

function ProjectRulesTab() {
  const projectRoot = useRepoIndex(s => s.projectRoot)
  const [content,  setContent]  = useState<string>('')
  const [status,   setStatus]   = useState<'idle' | 'loading' | 'saving' | 'saved' | 'error'>('idle')
  const [errMsg,   setErrMsg]   = useState<string>('')
  const [sources,  setSources]  = useState<string[]>([])

  const sep = (projectRoot ?? '').includes('\\') && !(projectRoot ?? '').includes('/') ? '\\' : '/'
  const rulesPath = projectRoot
    ? `${projectRoot.replace(/[\\/]+$/, '')}${sep}.rachna${sep}rules.md`
    : null

  useEffect(() => {
    if (!projectRoot || !rulesPath) { setContent(''); setSources([]); return }
    setStatus('loading')
    loadProjectRules(projectRoot).then(result => {
      setSources(result.sources)
      readFile(rulesPath).then(r => {
        setContent(r.content)
        setStatus('idle')
      }).catch(() => {
        setContent(RULES_TEMPLATE)
        setStatus('idle')
      })
    }).catch(() => { setStatus('idle') })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot])

  const handleSave = useCallback(async () => {
    if (!rulesPath) return
    setStatus('saving')
    try {
      await saveFile({ path: rulesPath, content })
      setSources([RACHNA_RULES_RELATIVE_PATH])
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }, [rulesPath, content])

  if (!projectRoot) {
    return (
      <div className={styles.editorSection}>
        <p className={styles.sectionHint}>Open a project folder first to configure project rules.</p>
      </div>
    )
  }

  return (
    <div className={styles.editorSection}>
      <div className={styles.configSection}>
        <span className={styles.configSectionLabel}>PROJECT RULES</span>
      </div>
      <p className={styles.sectionHint}>
        The agent reads <code>{RACHNA_RULES_RELATIVE_PATH}</code> (and <code>AGENTS.md</code>) on every
        chat turn as binding instructions. Encode project conventions, preferred tools, files to
        never touch, etc.
        {sources.length > 0 && (
          <span> Currently loaded from: <strong>{sources.join(', ')}</strong>.</span>
        )}
      </p>
      <textarea
        style={{
          width: '100%', boxSizing: 'border-box', minHeight: 260,
          fontFamily: 'var(--font-mono)', fontSize: 12,
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 5, color: 'var(--text-primary)', padding: '8px 10px',
          outline: 'none', resize: 'vertical', lineHeight: 1.55,
        }}
        value={status === 'loading' ? 'Loading…' : content}
        onChange={e => { setContent(e.target.value); setStatus('idle') }}
        disabled={status === 'loading' || status === 'saving'}
        spellCheck={false}
      />
      <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center' }}>
        <button
          onClick={handleSave}
          disabled={status === 'saving' || status === 'loading'}
          type="button"
          style={{
            background: 'var(--cyan)', border: 'none', borderRadius: 5,
            color: 'var(--bg-base)', fontFamily: 'var(--font-ui)', fontWeight: 600,
            fontSize: 12, padding: '6px 14px', cursor: 'pointer',
          }}
        >
          {status === 'saving' ? 'Saving…' : 'Save rules'}
        </button>
        {status === 'saved' && (
          <span style={{ color: 'var(--green)', fontFamily: 'var(--font-ui)', fontSize: 12 }}>
            ✓ Saved — agent uses this on the next turn
          </span>
        )}
        {status === 'error' && (
          <span style={{ color: 'var(--error)r)', fontFamily: 'var(--font-ui)', fontSize: 12 }}>
            Error: {errMsg}
          </span>
        )}
      </div>
      <p className={styles.sectionHint} style={{ marginTop: 8 }}>
        You can also maintain <code>AGENTS.md</code> at the project root — it is read automatically
        alongside <code>{RACHNA_RULES_RELATIVE_PATH}</code>.
      </p>
    </div>
  )
}

// ── GitAgentSettingsTab ───────────────────────────────────────────────────────
// Controls what the agent's git_action tool is allowed to do automatically
// vs. what requires explicit user confirmation. This is the canonical
// "agent/tool permissions" configuration — gated on `canConfigurePermissions`.

/** Hover message shown on every permission row control for seats without
 *  `canConfigurePermissions`. Also reused by the in-chat PendingToggleCard
 *  path (see MessageList.tsx / useChat.ts), which edits these same
 *  settings through an alternate UI and must be gated identically. */
export const PERMISSIONS_LOCKED_HOVER = '🔒 Permission configuration is not available for this account'

function GitAgentSettingsTab() {
  const {
    autoAllowCommit,
    autoAllowPush,
    allowDirectPushToMain,
    setAutoAllowCommit,
    setAutoAllowPush,
    setAllowDirectPushToMain,
  } = useGitSettingsStore()

  // Restricted seats keep seeing their current (predetermined/default)
  // permissions — the section stays visible — but every control is
  // read-only and the store's setters are never reached from this path.
  const canConfigurePermissions = useIdeEntitlements().canConfigurePermissions

  const row = (label: string, hint: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px solid var(--border)',
        opacity: canConfigurePermissions ? 1 : 0.6,
      }}
      title={canConfigurePermissions ? undefined : PERMISSIONS_LOCKED_HOVER}
    >
      <input
        type="checkbox"
        id={label}
        checked={checked}
        disabled={!canConfigurePermissions}
        aria-disabled={!canConfigurePermissions}
        onChange={e => {
          // Defense-in-depth: restricted seats never reach the setter even
          // if the control is somehow re-enabled.
          if (!canConfigurePermissions) return
          onChange(e.target.checked)
        }}
        style={{
          marginTop: 3,
          accentColor: 'var(--cyan)',
          cursor: canConfigurePermissions ? 'pointer' : 'not-allowed',
          flexShrink: 0,
        }}
      />
      <label
        htmlFor={label}
        style={{ cursor: canConfigurePermissions ? 'pointer' : 'not-allowed', flex: 1 }}
        onClick={e => { if (!canConfigurePermissions) e.preventDefault() }}
      >
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {hint}
        </div>
      </label>
    </div>
  )

  return (
    <div className={styles.editorSection}>
      <div className={styles.configSection} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={styles.configSectionLabel}>GIT AGENT PERMISSIONS</span>
        {!canConfigurePermissions && <LockedBadge reason={PERMISSIONS_LOCKED_HOVER} />}
      </div>
      <p className={styles.sectionHint}>
        Control what the agent's <code>git_action</code> tool is allowed to do automatically.
        Restrictive defaults keep you in control — enable only what you trust the agent to do unsupervised.
      </p>

      {!canConfigurePermissions && (
        <LockedFeaturePanel reason="These are your account's backend-provided permissions and are shown read-only." />
      )}

      {row(
        'Auto-allow agent commits',
        'The agent may create commits without asking for confirmation. The commit message is always derived from actual staged diff content — generic messages are rejected.',
        autoAllowCommit,
        setAutoAllowCommit,
      )}

      {row(
        'Auto-allow agent push',
        'The agent may push to remote without asking for confirmation. Disabled by default — enable only for trusted automated workflows.',
        autoAllowPush,
        setAutoAllowPush,
      )}

      {row(
        'Allow direct push to main / master',
        'Permit the agent to push directly to default branches (main, master, trunk, production). Requires "Auto-allow agent push" to also be enabled. Use with extreme caution.',
        allowDirectPushToMain,
        setAllowDirectPushToMain,
      )}

      <p className={styles.sectionHint} style={{ marginTop: 12 }}>
        Every <code>git_action</code> call is logged in the Agent Activity panel and the changes are visible in the Git panel where you can review and undo them.
      </p>
    </div>
  )
}

// ── TerminalSettingsTab ──────────────────────────────────────────────────────
// Controls how links clicked inside the in-app terminal are opened.

function TerminalSettingsTab() {
  const { openLinksInBackground, setOpenLinksInBackground } = useTerminalSettingsStore()

  const row = (label: string, hint: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <input
        type="checkbox"
        id={label}
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ marginTop: 3, accentColor: 'var(--cyan)', cursor: 'pointer', flexShrink: 0 }}
      />
      <label htmlFor={label} style={{ cursor: 'pointer', flex: 1 }}>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {hint}
        </div>
      </label>
    </div>
  )

  return (
    <div className={styles.editorSection}>
      <div className={styles.configSection}>
        <span className={styles.configSectionLabel}>LINK PREVIEWS</span>
      </div>
      <p className={styles.sectionHint}>
        Clicking a link inside the terminal opens it in a Playwright-driven Chromium window inside the app.
      </p>

      {row(
        'Open links in the background',
        'By default the preview window opens in the foreground so you clearly see it. Enable this to have it open minimized instead, without stealing focus from the IDE.',
        openLinksInBackground,
        setOpenLinksInBackground,
      )}
    </div>
  )
}

// ── ActionAutoApproveTab ──────────────────────────────────────────────────────
// Controls which categories of agent actions skip the permission dialog
// entirely. On by default for all three — see useActionAutoApproveStore.ts.

/** Hover message shown on every Action row control for seats without
 *  `canConfigureActions` — mirrors the AI_CALL_LOCKED_HOVER pattern used
 *  for AI Call inspection. */
export const ACTIONS_LOCKED_HOVER = '🔒 Action customization is not available for this account'

function ActionAutoApproveTab() {
  const {
    autoApproveTerminal,
    autoApproveScreenshots,
    autoApproveInputControl,
    setAutoApproveTerminal,
    setAutoApproveScreenshots,
    setAutoApproveInputControl,
  } = useActionAutoApproveStore()

  // Restricted seats can still see the current configuration (this section
  // stays visible per the entitlement contract) but every control in it is
  // read-only — no toggle here can result in a state change. The store's
  // setters are never called on this path.
  const canConfigureActions = useIdeEntitlements().canConfigureActions

  const row = (label: string, hint: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px solid var(--border)',
        opacity: canConfigureActions ? 1 : 0.6,
      }}
      title={canConfigureActions ? undefined : ACTIONS_LOCKED_HOVER}
    >
      <input
        type="checkbox"
        id={label}
        checked={checked}
        disabled={!canConfigureActions}
        aria-disabled={!canConfigureActions}
        onChange={e => {
          // Defense-in-depth: even if something re-enables the control,
          // restricted seats never reach the setter.
          if (!canConfigureActions) return
          onChange(e.target.checked)
        }}
        style={{
          marginTop: 3,
          accentColor: 'var(--cyan)',
          cursor: canConfigureActions ? 'pointer' : 'not-allowed',
          flexShrink: 0,
        }}
      />
      <label
        htmlFor={label}
        style={{ cursor: canConfigureActions ? 'pointer' : 'not-allowed', flex: 1 }}
        onClick={e => { if (!canConfigureActions) e.preventDefault() }}
      >
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {hint}
        </div>
      </label>
    </div>
  )

  return (
    <div className={styles.editorSection}>
      <div className={styles.configSection} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={styles.configSectionLabel}>AGENT AUTO-APPROVE</span>
        {!canConfigureActions && <LockedBadge reason={ACTIONS_LOCKED_HOVER} />}
      </div>
      <p className={styles.sectionHint}>
        By default every terminal command, screenshot, and mouse/keyboard action the agent wants to
        perform runs immediately without asking. Turn off a toggle below if you'd rather approve that
        category yourself before it runs — on by default, and each is independent of the others.
      </p>

      {!canConfigureActions && (
        <LockedFeaturePanel reason="This is your backend-provided configuration and is shown read-only." />
      )}

      {row(
        'Auto-approve terminal commands',
        'Skip the confirmation dialog for run_terminal_command calls. Every command still runs and is logged in the Agent Activity panel — this only removes the "approve" click.',
        autoApproveTerminal,
        setAutoApproveTerminal,
      )}

      {row(
        'Auto-approve screenshots',
        'Skip the confirmation dialog before the agent captures your screen with take_screenshot. A screenshot can reveal whatever happens to be visible at that moment, so only enable this if you\'re comfortable with that.',
        autoApproveScreenshots,
        setAutoApproveScreenshots,
      )}

      {row(
        'Auto-approve mouse clicks & keystrokes',
        'Skip the confirmation dialog before the agent simulates mouse clicks or key presses (mouse_click / press_key). The agent still requires a recent screenshot before acting, but no longer pauses to ask first.',
        autoApproveInputControl,
        setAutoApproveInputControl,
      )}

      <p className={styles.sectionHint} style={{ marginTop: 12 }}>
        You can turn any of these back on at any time — future calls in that category will stop asking first again.
      </p>

      <InputActionDelayRow />
      <MousePositionToleranceRow />
    </div>
  )
}

// ── PermissionsSettingsTab ─────────────────────────────────────────────────
// Merges the previously separate Git / Terminal / Actions tabs into one
// "Permissions" tab (all three are, at heart, "what may the agent do
// without asking" settings). Sub-nav pills keep each section addressable
// without a long single scroll, and — unlike the old top-level tab strip —
// these pills wrap onto a second line instead of overflowing the modal
// width, so this stays usable in the narrow Chat View dialog too.

type PermissionsSubTab = 'git' | 'terminal' | 'actions'

function PermissionsSettingsTab() {
  const [subTab, setSubTab] = useState<PermissionsSubTab>('git')

  return (
    <div className={styles.editorSection}>
      <div className={styles.permissionsSubTabs}>
        <button
          className={`${styles.permissionsSubTab} ${subTab === 'git' ? styles.permissionsSubTabActive : ''}`}
          onClick={() => setSubTab('git')}
          type="button"
        >
          Git
        </button>
        <button
          className={`${styles.permissionsSubTab} ${subTab === 'terminal' ? styles.permissionsSubTabActive : ''}`}
          onClick={() => setSubTab('terminal')}
          type="button"
        >
          Terminal
        </button>
        <button
          className={`${styles.permissionsSubTab} ${subTab === 'actions' ? styles.permissionsSubTabActive : ''}`}
          onClick={() => setSubTab('actions')}
          type="button"
        >
          Actions
        </button>
      </div>

      {subTab === 'git' && <GitAgentSettingsTab />}
      {subTab === 'terminal' && <TerminalSettingsTab />}
      {subTab === 'actions' && <ActionAutoApproveTab />}
    </div>
  )
}

// ── InputActionDelayRow ──────────────────────────────────────────────────────
// Controls the pause between the click/keystroke visual cue (the ring/dot/
// key bar drawn by InputActionOverlay) becoming visible and the real
// mouse_click / press_key / press_key_sequence action actually firing. See
// store/useInputActionDelayStore.ts and waitForVisualCue() in
// services/agent/tools/inputControlTools.ts.

function InputActionDelayRow() {
  const { delayMs, setDelayMs } = useInputActionDelayStore()
  const [draft, setDraft] = useState(String(delayMs))

  useEffect(() => {
    setDraft(String(delayMs))
  }, [delayMs])

  const commit = () => {
    const parsed = Number(draft)
    if (Number.isFinite(parsed)) {
      setDelayMs(parsed)
    } else {
      setDraft(String(delayMs))
    }
  }

  return (
    <div style={{ padding: '14px 0 4px', borderTop: '1px solid var(--border)', marginTop: 8 }}>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
        Delay before clicks & keystrokes
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>
        How long the agent waits after showing where it's about to click or what it's about to
        type before actually doing it. Gives you time to see the cue and react. Set to 0 to
        disable the wait.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number"
          min={INPUT_ACTION_DELAY_MIN_MS}
          max={INPUT_ACTION_DELAY_MAX_MS}
          step={100}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          style={{
            width: 90,
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '5px 8px',
          }}
        />
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)' }}>ms</span>
      </div>
    </div>
  )
}

// ── MousePositionToleranceRow ─────────────────────────────────────────────────
// Controls how many pixels of slop mouse_click / mouse_drag_path allow
// between where a click/drag was told to land and where the OS reports the
// cursor actually is, before treating the move as verified. The check
// itself (move, read the OS cursor back, compare, retry a bounded number of
// times) always runs and is local/deterministic — this only adjusts how
// strict it is. See store/useMousePositionToleranceStore.ts and
// move_and_verify_position in src-tauri/src/input_control.rs.

function MousePositionToleranceRow() {
  const { tolerancePx, setTolerancePx } = useMousePositionToleranceStore()
  const [draft, setDraft] = useState(String(tolerancePx))

  useEffect(() => {
    setDraft(String(tolerancePx))
  }, [tolerancePx])

  const commit = () => {
    const parsed = Number(draft)
    if (Number.isFinite(parsed)) {
      setTolerancePx(parsed)
    } else {
      setDraft(String(tolerancePx))
    }
  }

  return (
    <div style={{ padding: '14px 0 4px', borderTop: '1px solid var(--border)', marginTop: 8 }}>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
        Cursor position verification tolerance
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>
        Before every click or drag, the agent moves the cursor to the target and confirms with
        the OS that it actually landed there, retrying the move a few times before giving up.
        This sets how many pixels off it's allowed to be and still count as verified — lower is
        stricter. This check is local and never skipped; it doesn't call any AI model.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number"
          min={MOUSE_POSITION_TOLERANCE_MIN_PX}
          max={MOUSE_POSITION_TOLERANCE_MAX_PX}
          step={1}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          style={{
            width: 90,
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '5px 8px',
          }}
        />
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)' }}>px</span>
      </div>
    </div>
  )
}

export default function SettingsModal({
  open,
  onClose,
  fontSize,
  onFontSizeChange,
  fontSizeMin,
  fontSizeMax,
  initialTab = 'providers',
}: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
  const [configuringProvider, setConfiguringProvider] = useState<string | null>(null)
  const canConfigureActions = useIdeEntitlements().canConfigureActions
  const canConfigurePermissions = useIdeEntitlements().canConfigurePermissions
  const connectorsProjectRoot = useRepoIndex(s => s.projectRoot)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (configuringProvider) setConfiguringProvider(null)
      else onClose()
    }
  }, [onClose, configuringProvider])

  useEffect(() => {
    if (!open) return
    setActiveTab(initialTab)
    setConfiguringProvider(null)
  }, [open, initialTab])

  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleKeyDown])

  // useEffect(() => {
  //   if (!open) return
  //   refreshEmbedStats()
  // }, [open, refreshEmbedStats])

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }

  const allProviders = getAllProviders()
  const { free: freeProviders, other: otherProviders } = splitProvidersByTier(allProviders)
  const zoomPct = Math.round(((fontSize - fontSizeMin) / (fontSizeMax - fontSizeMin)) * 100)

  if (!open) return null

  // The Connectors/MCP tab holds a tile grid that reads as cramped once the
  // modal is opened in the full-screen window (see services/viewModeWindow.ts
  // — full mode is >=1200px wide, chat mode is a fixed 400px). `.modalWide`
  // only takes effect above the CSS breakpoint chat mode can never reach, so
  // chat mode keeps today's sizing untouched.
  const isConnectorsTab = activeTab === 'connectors' || activeTab === 'mcp'

  return (
    <div className={styles.backdrop} onClick={handleBackdrop} role="dialog" aria-modal="true" aria-label="Settings">
      <div className={`${styles.modal} ${isConnectorsTab ? styles.modalWide : ''}`}>

        {/* ── Header ────────────────────────────────────────────── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.icon}>⚙</span>
            <div>
              <h2 className={styles.title}>Settings</h2>
              <p className={styles.subtitle}>Configure Rachna AI Studio</p>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close settings">×</button>
        </div>

        {/* ── Tabs ──────────────────────────────────────────────── */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === 'providers' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('providers'); setConfiguringProvider(null) }}
          >
            AI Providers
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'editor' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('editor'); setConfiguringProvider(null) }}
          >
            Editor
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'rules' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('rules'); setConfiguringProvider(null) }}
          >
            Project Rules
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'permissions' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('permissions'); setConfiguringProvider(null) }}
            title={canConfigurePermissions && canConfigureActions ? undefined : PERMISSIONS_LOCKED_HOVER}
          >
            Permissions{!(canConfigurePermissions && canConfigureActions) && <span style={{ marginLeft: 5, opacity: 0.75 }}>🔒</span>}
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'connectors' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('connectors'); setConfiguringProvider(null) }}
          >
            Connectors
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'mcp' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('mcp'); setConfiguringProvider(null) }}
          >
            MCP
          </button>
          <button
            className={`${styles.tab} ${activeTab === 'data' ? styles.tabActive : ''}`}
            onClick={() => { setActiveTab('data'); setConfiguringProvider(null) }}
          >
            Data
          </button>
        </div>

        {/* ── Body ──────────────────────────────────────────────── */}
        <div className={styles.body}>

          {activeTab === 'providers' && (
            configuringProvider ? (
              <ConfigurePanel
                providerId={configuringProvider}
                displayName={allProviders.find(p => p.id === configuringProvider)?.displayName ?? configuringProvider}
                onBack={() => setConfiguringProvider(null)}
              />
            ) : (
              <div className={styles.providerSections}>
                <p className={styles.sectionHint}>
                  Rachna Cloud AI needs a Rachna account but no API key. Every other provider works without an account — select one to add your own API key.
                  Keys are stored locally on your device.
                </p>

                <div className={styles.configSection} style={{ marginTop: 12 }}>
                  <span className={styles.configSectionLabel}>🆓 FREE AI PROVIDERS</span>
                </div>
                <div className={styles.providerGrid}>
                  {freeProviders.map(p => (
                    <ProviderCard
                      key={p.id}
                      providerId={p.id}
                      displayName={p.displayName}
                      keyUrl={PROVIDER_KEY_URLS[p.id]}
                      onConfigure={() => setConfiguringProvider(p.id)}
                    />
                  ))}
                </div>

                <div className={styles.configSection} style={{ marginTop: 16 }}>
                  <span className={styles.configSectionLabel}>OTHER PROVIDERS</span>
                </div>
                <div className={styles.providerGrid}>
                  {otherProviders.map(p => (
                    <ProviderCard
                      key={p.id}
                      providerId={p.id}
                      displayName={p.displayName}
                      keyUrl={PROVIDER_KEY_URLS[p.id]}
                      onConfigure={() => setConfiguringProvider(p.id)}
                    />
                  ))}
                </div>
              </div>
            )
          )}

          {activeTab === 'editor' && (
            <div className={styles.editorSection}>
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.editorBadge}>Aa</div>
                  <div className={styles.providerInfo}>
                    <span className={styles.providerName}>Font Size</span>
                    <span className={styles.providerStatus}>Adjust editor text size</span>
                  </div>
                </div>

                <div className={styles.fontSizeRow}>
                  <button
                    className={styles.fontSizeBtn}
                    onClick={() => onFontSizeChange(fontSize - 1)}
                    disabled={fontSize <= fontSizeMin}
                    title="Decrease font size"
                    type="button"
                  >A−</button>

                  <div className={styles.sliderWrap}>
                    <input
                      className={styles.slider}
                      type="range"
                      min={fontSizeMin}
                      max={fontSizeMax}
                      step={1}
                      value={fontSize}
                      onChange={e => onFontSizeChange(Number(e.target.value))}
                      aria-label="Editor font size"
                    />
                    <div className={styles.sliderFill} style={{ width: `${zoomPct}%` }} />
                  </div>

                  <button
                    className={styles.fontSizeBtn}
                    onClick={() => onFontSizeChange(fontSize + 1)}
                    disabled={fontSize >= fontSizeMax}
                    title="Increase font size"
                    type="button"
                  >A+</button>

                  <span className={styles.fontSizeValue}>{fontSize}px</span>
                </div>

                <div className={styles.fontPreview} style={{ fontSize }}>
                  const hello = "world" // preview
                </div>
              </div>
            </div>
          )}

          {activeTab === 'rules' && (
            <ProjectRulesTab />
          )}

          {activeTab === 'permissions' && (
            <PermissionsSettingsTab />
          )}
          {activeTab === 'connectors' && (
            <ConnectorsSettingsPanel projectRoot={connectorsProjectRoot} />
          )}
          {activeTab === 'mcp' && (
            <McpSettingsPanel open onClose={onClose} embedded />
          )}
          {activeTab === 'data' && <DataSettingsTab />}

        </div>
        <div className={styles.footer}>
          <div className={styles.statusArea} />
          <div className={styles.footerActions}>
            {configuringProvider && (
              <button className={styles.btnSecondary} onClick={() => setConfiguringProvider(null)} type="button">
                ← Back
              </button>
            )}
            <button className={styles.btnSecondary} onClick={onClose} type="button">Close</button>
          </div>
        </div>

      </div>
    </div>
  )
}

// ── Setup gate (wraps IDELayout to force setup on first launch) ─────────────

export function SetupGate({ children }: { children: React.ReactNode }) {
  const [setupDone, setSetupDone] = useState(false)
  // Signed-in Cloud is always ready; direct-provider setup is optional.
  const needsSetup = false && !setupDone

  if (needsSetup) {
    return (
      <div className={styles.setupBackdrop}>
        <div className={styles.setupModal}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <span className={styles.icon}>⚡</span>
              <div>
                <h2 className={styles.title}>Welcome to Rachna AI Studio</h2>
                <p className={styles.subtitle}>Set up an AI provider to get started</p>
              </div>
            </div>
          </div>
          <div className={styles.tabs}>
            <button className={`${styles.tab} ${styles.tabActive}`}>AI Providers</button>
          </div>
          <div className={styles.body}>
            <SetupWizard onDone={() => setSetupDone(true)} />
          </div>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

// ── Legacy hook for any code still importing useGeminiApiKey ──────────────
export function useGeminiApiKey(): string {
  const store = useApiKeyStore()
  return store.getActiveKey('gemini')?.value ?? ''
}
