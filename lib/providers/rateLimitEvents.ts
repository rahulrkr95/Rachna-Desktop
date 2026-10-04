// lib/providers/rateLimitEvents.ts
//
// Deliberately NOT threaded through ChatOptions/StreamCallbacks: the call
// path from useChat.ts down to GeminiProvider.fetchGemini crosses AgentLoop,
// TaskExecutor, and ToolExecutor, several of which fan out into concurrent
// tool calls. Piping one more optional callback through all of those
// signatures just to reach a single UI notice isn't worth the churn — a
// tiny global pub/sub is the same pattern already used elsewhere in this
// codebase for cross-cutting, low-frequency signals (see services/notify.ts).
//
// Emitters: lib/providers/GeminiProvider.ts (both the proactive RPM guard
// and the reactive 429/RetryInfo wait use the same underlying
// waitForGeminiRateLimit, so both paths funnel through here).
// Subscriber: components/AiChat/useChat.ts, which turns each event into a
// one-off "Waiting for Xs..." chat message (see ChatMessage.isRateLimitNotice).

export interface RateLimitWaitEvent {
  providerId: string
  model:      string
  waitMs:     number
  reason:     string
}

type Listener = (event: RateLimitWaitEvent) => void

const listeners = new Set<Listener>()

export function emitRateLimitWait(event: RateLimitWaitEvent): void {
  listeners.forEach(listener => {
    try {
      listener(event)
    } catch {
      // A subscriber blowing up must never break the actual rate-limit wait.
    }
  })
}

/** Returns an unsubscribe function — call it from a useEffect cleanup. */
export function onRateLimitWait(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
