// lib/llmCallLogger.ts
//
// LLMCallLogger — the single centralized entry point every LLM request in
// the app must pass through. Replaces the old lib/llmCallBus.ts, which only
// ever saw AgentLoop's two call sites (agentTurn iterations + the final
// streamed answer) and only *after* the Inspector panel had been mounted.
//
// This logger fixes both gaps:
//   1. It wraps the two AIProvider entry points (`stream` / `agentTurn`)
//      themselves, via loggedStream()/loggedAgentTurn() below — every call
//      site in the app (classifier, planner, agent loop, new-project
//      generation, run-config detection, autocomplete, …) is refactored to
//      go through these wrappers instead of calling provider.stream /
//      provider.agentTurn directly, so no request can bypass logging.
//   2. It keeps its OWN in-memory history (`records`), independent of
//      whether any UI is currently subscribed — so the Inspector always
//      replays the full session from the very first call (including
//      classification calls made before a project/panel even exists),
//      not just whatever happened to fire after it mounted.
//
// Each call gets ONE record, identified by a stable id, emitted immediately
// (status: 'pending') when the request starts, then updated in place
// (status: 'success' | 'error') when it completes — so consumers can render
// a live "in flight" row and watch it resolve, while chronological order is
// still guaranteed by (startedAt, id).

import type {
  AIProvider,
  ChatOptions,
  ProviderMessage,
  ProviderFunctionDeclaration,
  ProviderAgentTurn,
  StreamCallbacks,
  PendingFileAttachment,
} from './providers/types'

/** Strips base64 content, keeping only what the Attachments section should show. */
function toAttachmentMeta(
  attachments: PendingFileAttachment[] | undefined,
  provider: AIProvider
): LLMCallAttachmentMeta[] | undefined {
  if (!attachments || attachments.length === 0) return undefined
  const supported = provider.supportsFileAttachments?.() ?? false
  return attachments.map(a => ({
    fileId: a.fileId,
    fileName: a.fileName,
    mimeType: a.mimeType,
    size: a.size,
    purpose: a.purpose,
    providerId: supported ? provider.id : undefined,
  }))
}

// ── Stages ───────────────────────────────────────────────────────────────
//
// Every distinct place in the app an LLM gets called, so the Inspector can
// group/filter by "what kind of call was this" rather than just provider
// call shape (stream vs agentTurn).

export type LLMCallStage =
  | 'intent_classification'   // Chat/Automation refinement and routing
  | 'plan_generation'         // Specialist-scoped Task Planner
  | 'agent_reasoning'         // AgentLoop tool-calling iterations
  | 'final_response'          // AgentLoop's streamed final answer
  | 'new_project_generation'  // services/agent/buildNewProject.ts (file tree + file content)
  | 'run_config_detection'    // lib/runConfigDetector.ts
  | 'autocomplete'            // services/autocomplete/AutocompleteService.ts

export const STAGE_LABELS: Record<LLMCallStage, string> = {
  intent_classification:  'Intent Classification',
  plan_generation:        'Execution Plan Generation',
  agent_reasoning:        'Agent Reasoning',
  final_response:         'Final Response',
  new_project_generation: 'New Project Generation',
  run_config_detection:   'Run Config Detection',
  autocomplete:           'Autocomplete',
}

export type LLMCallStatus = 'pending' | 'success' | 'error'

export interface LLMTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** True when the provider didn't report real usage and this is a char-based estimate. */
  estimated: boolean
}

export interface LLMCallRequestPayload {
  messages: ProviderMessage[]
  systemInstruction?: string
  toolNames?: string[]
  /** Metadata only — never the base64 content — for files queued via add_file_to_request. */
  attachments?: LLMCallAttachmentMeta[]
}

/**
 * Attachment metadata shown by the LLM Call Inspector's Attachments section.
 * Deliberately omits the file's base64 content — see llmCallLogger.ts's file
 * header: nothing here should let the Inspector reconstruct the file itself.
 */
export interface LLMCallAttachmentMeta {
  fileId: string
  fileName: string
  mimeType: string
  size: number
  purpose?: string
  /** id of the provider this attachment was sent to, when the provider supports native file attachments. */
  providerId?: string
}

export interface LLMCallRecord {
  id: string
  stage: LLMCallStage
  providerName: string
  model?: string
  /** Iteration index — only meaningful for 'agent_reasoning'. */
  iteration?: number
  /** Omitted entirely when payload logging is disabled — see setIncludeRequestPayload(). */
  requestPayload?: LLMCallRequestPayload
  response?: string
  tokenUsage?: LLMTokenUsage
  status: LLMCallStatus
  error?: string
  startedAt: string
  completedAt?: string
  latencyMs?: number
}

type Listener = (record: LLMCallRecord) => void

// ── Core logger ──────────────────────────────────────────────────────────

class LLMCallLoggerImpl {
  private records: LLMCallRecord[] = []
  private listeners = new Set<Listener>()
  private includeRequestPayload = true

  /** Whether request payloads (messages/system prompt/tool names) are captured. Off = smaller/more private log. */
  setIncludeRequestPayload(enabled: boolean): void {
    this.includeRequestPayload = enabled
  }

  /** Full history so far, in chronological order — used to hydrate the Inspector on mount. */
  getAll(): LLMCallRecord[] {
    return this.records
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(record: LLMCallRecord): void {
    this.listeners.forEach(fn => {
      try { fn(record) } catch { /* never let a UI listener crash a live call */ }
    })
  }

  /** Emitted immediately, before the request starts. Returns the id used to complete()/fail() it later. */
  start(params: {
    stage: LLMCallStage
    providerName: string
    model?: string
    iteration?: number
    requestPayload?: LLMCallRequestPayload
  }): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const record: LLMCallRecord = {
      id,
      stage: params.stage,
      providerName: params.providerName,
      model: params.model,
      iteration: params.iteration,
      requestPayload: this.includeRequestPayload ? params.requestPayload : undefined,
      status: 'pending',
      startedAt: new Date().toISOString(),
    }
    this.records.push(record)
    this.notify(record)
    return id
  }

  /** Updates a pending record to 'success' once the response completes. */
  complete(id: string, params: { response: string; tokenUsage?: LLMTokenUsage }): void {
    const record = this.records.find(r => r.id === id)
    if (!record) return
    record.status = 'success'
    record.response = params.response
    record.tokenUsage = params.tokenUsage
    record.completedAt = new Date().toISOString()
    record.latencyMs = Date.parse(record.completedAt) - Date.parse(record.startedAt)
    this.notify(record)
  }

  /** Updates a pending record to 'error' if the request fails. */
  fail(id: string, error: unknown): void {
    const record = this.records.find(r => r.id === id)
    if (!record) return
    record.status = 'error'
    record.error = error instanceof Error ? error.message : String(error)
    record.completedAt = new Date().toISOString()
    record.latencyMs = Date.parse(record.completedAt) - Date.parse(record.startedAt)
    this.notify(record)
  }

  clear(): void {
    this.records = []
  }
}

export const llmCallLogger = new LLMCallLoggerImpl()

// ── Token estimation ─────────────────────────────────────────────────────
//
// The AIProvider interface (lib/providers/types.ts) doesn't surface real
// provider-reported usage — that would mean plumbing a new field through
// every one of the ~13 provider implementations. Until that lands, we
// estimate with the same ~4-chars-per-token heuristic already used
// elsewhere in the app (see lib/conversationCompaction.ts's totalTokens),
// and mark the record `estimated: true` so the Inspector can label it
// honestly rather than implying a billed/exact figure.

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function estimateUsage(promptText: string, completionText: string): LLMTokenUsage {
  const promptTokens = estimateTokens(promptText)
  const completionTokens = estimateTokens(completionText)
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true }
}

// ── Wrapped provider entry points ────────────────────────────────────────
//
// Every direct call site in the app calls these instead of
// provider.stream()/provider.agentTurn() directly, so every LLM request —
// from the very first classification call through the final response —
// is guaranteed to go through llmCallLogger.

export async function loggedStream(
  stage: LLMCallStage,
  provider: AIProvider,
  apiKey: string,
  messages: ProviderMessage[],
  callbacks: StreamCallbacks,
  opts?: ChatOptions,
  iteration?: number,
): Promise<void> {
  const id = llmCallLogger.start({
    stage,
    providerName: provider.displayName,
    model: opts?.model,
    iteration,
    requestPayload: {
      messages,
      systemInstruction: opts?.systemInstruction,
      attachments: toAttachmentMeta(opts?.attachments, provider),
    },
  })

  let accumulated = ''
  try {
    await provider.stream(
      apiKey,
      messages,
      {
        onChunk: (chunk) => { accumulated += chunk; callbacks.onChunk(chunk) },
        onDone: (fullText) => {
          const finalText = fullText || accumulated
          llmCallLogger.complete(id, {
            response: finalText,
            tokenUsage: estimateUsage(messages.map(m => m.content).join('\n'), finalText),
          })
          callbacks.onDone(fullText)
        },
        onError: (err) => {
          llmCallLogger.fail(id, err)
          callbacks.onError(err)
        },
      },
      opts,
    )
  } catch (err) {
    llmCallLogger.fail(id, err)
    throw err
  }
}

export async function loggedAgentTurn(
  stage: LLMCallStage,
  provider: AIProvider,
  apiKey: string,
  history: unknown[],
  tools: ProviderFunctionDeclaration[],
  opts: ChatOptions | undefined,
  iteration?: number,
): Promise<ProviderAgentTurn> {
  const messages = provider.fromInternalMessages(history)
  const id = llmCallLogger.start({
    stage,
    providerName: provider.displayName,
    model: opts?.model,
    iteration,
    requestPayload: {
      messages,
      systemInstruction: opts?.systemInstruction,
      toolNames: tools.map(t => t.name),
      attachments: toAttachmentMeta(opts?.attachments, provider),
    },
  })

  try {
    const turn = await provider.agentTurn(apiKey, history, tools, opts)
    const responseText = turn.text
      || (turn.functionCalls.length
        ? `[requested ${turn.functionCalls.length} tool call(s): ${turn.functionCalls.map(c => c.name).join(', ')}]`
        : '')
    llmCallLogger.complete(id, {
      response: responseText,
      tokenUsage: estimateUsage(messages.map(m => m.content).join('\n'), responseText),
    })
    return turn
  } catch (err) {
    llmCallLogger.fail(id, err)
    throw err
  }
}
