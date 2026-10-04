// lib/repoScanner/embedder.ts
//
// Optional embedding generation via a local Ollama server (nomic-embed-text
// by default). This is intentionally separate from embeddingProvider.ts
// (the zero-dependency local/Gemini providers used by the vector-cache
// index): this module is the lightweight path used by `run.ts --embed` to
// attach raw embedding vectors directly onto scanner output chunks, which
// the Tauri backend then persists via `store_embedding` into sqlite-vec.
//
// Design: embedding is a "nice to have", never a hard requirement of a
// scan. If Ollama isn't running, isn't reachable, or the model isn't
// pulled, we fail silently and return an empty vector — callers should
// treat `[]` as "no embedding available" rather than retrying or crashing.

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
const DEFAULT_EMBED_MODEL = 'nomic-embed-text'

interface OllamaEmbeddingsResponse {
  embedding?: number[]
}

/**
 * Requests an embedding for `text` from a local Ollama server.
 *
 * @param text       The text to embed (typically chunk source content).
 * @param ollamaUrl  Base URL of the Ollama server, e.g. "http://localhost:11434".
 * @returns          The embedding vector, or `[]` if Ollama is unreachable
 *                    or returns an error/unexpected response.
 */
export async function getEmbedding(text: string, ollamaUrl: string): Promise<number[]> {
  if (!text || text.trim().length === 0) {
    return []
  }

  try {
    const res = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: DEFAULT_EMBED_MODEL,
        prompt: text,
      }),
    })

    if (!res.ok) {
      console.debug(`[embedder] Ollama returned ${res.status} ${res.statusText} — skipping embedding`)
      return []
    }

    const data = (await res.json()) as OllamaEmbeddingsResponse

    if (!Array.isArray(data.embedding)) {
      console.debug('[embedder] Ollama response missing `embedding` array — skipping embedding')
      return []
    }

    return data.embedding
  } catch (err) {
    // Ollama not running / network unreachable / etc. — embedding is
    // optional, so swallow the error and let the caller proceed without it.
    console.debug('[embedder] Ollama unreachable, skipping embedding:', err)
    return []
  }
}
