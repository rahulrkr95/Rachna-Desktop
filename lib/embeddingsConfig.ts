// lib/embeddingsConfig.ts
//
// Persistence for the "Embeddings" section in Settings — whether hybrid
// (FTS5 + Ollama-embedding) semantic search is enabled, and which Ollama
// model to use for embeddings. Read at call-time from localStorage,
// mirroring the OllamaProvider / LMStudioProvider config pattern.

export const SEMANTIC_SEARCH_ENABLED_KEY = 'rachna_ide_semantic_search_enabled'
export const EMBED_MODEL_KEY = 'rachna_ide_embed_model'

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text'

/**
 * Whether semantic search is enabled. Defaults to `true` — the backend
 * already falls back to FTS5-only silently when Ollama is unreachable, so
 * "on by default" is safe even if the user has never set up Ollama.
 */
export function isSemanticSearchEnabled(): boolean {
  try {
    const raw = localStorage.getItem(SEMANTIC_SEARCH_ENABLED_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

export function setSemanticSearchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SEMANTIC_SEARCH_ENABLED_KEY, String(enabled))
  } catch { /* ignore */ }
}

export function getEmbedModel(): string {
  try {
    return localStorage.getItem(EMBED_MODEL_KEY) || DEFAULT_EMBED_MODEL
  } catch {
    return DEFAULT_EMBED_MODEL
  }
}

export function setEmbedModel(model: string): void {
  try {
    localStorage.setItem(EMBED_MODEL_KEY, model.trim() || DEFAULT_EMBED_MODEL)
  } catch { /* ignore */ }
}
