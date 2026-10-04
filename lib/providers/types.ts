// lib/providers/types.ts
// Provider-agnostic AI interface.
// The UI, agent loop, and streaming layer depend ONLY on these types —
// never on Gemini-specific APIs or other provider SDKs.

// ── Model metadata ─────────────────────────────────────────────────────────

export interface ModelInfo {
  /** Provider-specific model ID, e.g. "gemini-2.5-flash" or "gpt-4o" */
  id: string
  /** Human display name */
  displayName: string
  /** Max context window (total tokens in + out) */
  contextWindow?: number
  /** Max input tokens */
  inputTokenLimit?: number
  /** Max output tokens */
  outputTokenLimit?: number
  /** Whether this model supports function/tool calling */
  supportsTools: boolean
  /** Whether this model supports image input */
  supportsVision: boolean
  /** Whether this model supports streaming */
  supportsStreaming: boolean
}

// ── Message format ─────────────────────────────────────────────────────────

/** A single base64-encoded image to be attached to a user message. */
export interface PendingImage {
  /** Raw base64 payload (no "data:...;base64," prefix). */
  base64:   string
  /** MIME type, e.g. "image/png". */
  mimeType: string
}

// ── File attachments (add_file_to_request tool) ────────────────────────────
//
// Distinct from PendingImage above: images are attached inline on a
// ProviderMessage as part of normal chat/vision flows, while
// PendingFileAttachment represents an arbitrary non-text file (PDF, DOCX,
// XLSX, PPTX, audio, video, ZIP, etc.) queued by the agent's
// `add_file_to_request` tool (see services/agent/tools/addFileToRequestTool.ts)
// to be attached to the *next* LLM API request only. Held in
// lib/pendingAttachments.ts's module-level store between the tool call and
// the following agentTurn()/stream() call, then cleared — see AgentLoop.ts.

export interface PendingFileAttachment {
  /** Identifier the agent used to reference the file (currently: its resolved path). */
  fileId: string
  /** Display name for the file, e.g. "invoice.pdf". */
  fileName: string
  /** MIME type, e.g. "application/pdf". */
  mimeType: string
  /** Raw base64 payload (no "data:...;base64," prefix). */
  base64: string
  /** File size on disk, in bytes. */
  size: number
  /** Optional free-text hint from the agent about why this file was attached, e.g. "reference doc for formatting". */
  purpose?: string
}

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string
  /** Optional images attached to this (user) message — vision-capable providers only. */
  images?: PendingImage[]
}

// ── Tool / function calling ────────────────────────────────────────────────

/** Schema for the items of an array-typed parameter. Allows one extra level of
 *  nesting so tools can declare arrays of arrays (e.g. a "sequence" of "chords"). */
export interface ProviderFunctionParameterItems {
  type: string
  items?: { type: string }
}

export interface ProviderFunctionDeclaration {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
      items?: ProviderFunctionParameterItems
    }>
    required?: string[]
  }
}

export interface ProviderFunctionCall {
  name: string
  args: Record<string, unknown>
}

export interface ProviderAgentTurn {
  text: string
  functionCalls: ProviderFunctionCall[]
  /** Opaque model turn — re-appended to conversation history each loop iteration */
  modelTurn: unknown
}

// ── Streaming callbacks ────────────────────────────────────────────────────

export interface StreamCallbacks {
  onChunk: (chunk: string) => void
  onDone: (fullText: string) => void
  onError: (error: Error) => void
}

// ── Request options ────────────────────────────────────────────────────────

export interface ChatOptions {
  model?: string
  systemInstruction?: string
  temperature?: number
  maxOutputTokens?: number
  signal?: AbortSignal
  /**
   * Non-text files (PDF, DOCX, XLSX, PPTX, images, audio, video, ZIP, etc.)
   * queued by the `add_file_to_request` tool to be attached to THIS request
   * only — see lib/pendingAttachments.ts and AgentLoop.ts, which populate
   * this field from the pending-attachment store immediately before calling
   * stream()/agentTurn() and clear the store right after. Providers that
   * don't implement mapFileAttachment()/supportsFileAttachments() below
   * simply never read this field, which is what makes them ignore it
   * gracefully rather than needing an explicit no-op per provider.
   */
  attachments?: PendingFileAttachment[]
}

// ── Provider usage (optional — not all providers expose this) ──────────────

export interface ProviderUsage {
  /** Human-readable status, e.g. "Quota OK" or "90% used" */
  status?: string
}

// ── Main interface ─────────────────────────────────────────────────────────

export interface AIProvider {
  readonly id: string
  readonly displayName: string

  /**
   * Validate API key + fetch available models.
   * Returns model list on success, throws on invalid key / network error.
   */
  listModels(apiKey: string): Promise<ModelInfo[]>

  /**
   * Stream a multi-turn conversation to the UI.
   */
  stream(
    apiKey: string,
    messages: ProviderMessage[],
    callbacks: StreamCallbacks,
    opts?: ChatOptions
  ): Promise<void>

  /**
   * One non-streaming turn that may request tool calls.
   * Used by the agent loop.
   */
  agentTurn(
    apiKey: string,
    messages: unknown[],      // provider-internal history format
    tools: ProviderFunctionDeclaration[],
    opts?: ChatOptions
  ): Promise<ProviderAgentTurn>

  /**
   * Append a tool/function-response to the provider-internal history.
   * Returns the updated history array.
   */
  appendToolResults(
    history: unknown[],
    modelTurn: unknown,
    results: Array<{ name: string; result: Record<string, unknown> }>
  ): unknown[]

  /**
   * Convert generic ProviderMessages to the internal format expected
   * by agentTurn / stream.
   */
  toInternalMessages(messages: ProviderMessage[]): unknown[]

  /**
   * Flatten provider-internal history to ProviderMessage[] for streaming
   * the final answer (tool-call parts get serialised as text).
   */
  fromInternalMessages(history: unknown[]): ProviderMessage[]

  /**
   * Optional: refresh usage/quota information for a key.
   */
  getUsage?(apiKey: string): Promise<ProviderUsage>

  /**
   * Detect if an error is due to quota/rate-limit — used for failover.
   */
  isQuotaError(err: unknown): boolean

  /**
   * Detect if an error is a deliberate user cancellation (AbortError).
   */
  isAbortError(err: unknown): boolean

  /**
   * Whether this provider can accept image input on user messages.
   */
  supportsVision(): boolean

  /** Whether this provider's current generation contract supports native tool/function calling. */
  supportsToolCalling?(): boolean

  /**
   * Whether this provider can accept arbitrary non-text file attachments
   * (PDF, DOCX, XLSX, PPTX, audio, video, ZIP, etc.) via `add_file_to_request`.
   * Optional — providers that omit this (and mapFileAttachment below) are
   * treated as unsupported and simply never see ChatOptions.attachments.
   */
  supportsFileAttachments?(): boolean

  /**
   * Maps a single PendingFileAttachment to this provider's native
   * request-part format (e.g. a Gemini inlineData part, a Claude `document`
   * content block). Returns undefined if this particular attachment can't
   * be represented (e.g. unsupported MIME type) — callers should skip it
   * rather than fail the whole request.
   */
  mapFileAttachment?(attachment: PendingFileAttachment): unknown | undefined
}
