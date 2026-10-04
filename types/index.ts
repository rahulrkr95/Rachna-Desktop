// types/index.ts

/**
 * Structured output of the specialist-scoped Task Planner; see
 * lib/agenticClassifier.ts / lib/planGenerator.ts). The planner's ONLY job
 * is to break the request into the minimum necessary ordered steps, each
 * mapped to exactly one intent + sub-intent — it never selects tools and
 * never executes anything, so this is deliberately the ENTIRE output: no
 * goal summary, files list, risks, verification steps, or complexity
 * rating. A plan that fails to produce a valid, non-empty step list is a
 * planning failure (see generateExecutionPlan), never something callers
 * fall back on executing as a whole.
 */
export interface IntentPlan {
  /** Ordered, intent-tagged execution steps — see ExecutionStep below. */
  steps: ExecutionStep[]
}

// ── Single-intent execution planning ────────────────────────────────────
//
// An IntentPlan already arrives WITH its ordered list of ExecutionStep
// attached (`.steps`, populated by lib/planGenerator.ts in the same call
// that produced the plan). The planner picks exactly ONE top-level intent
// for the whole request and tags every step with it (see
// lib/planGenerator.ts::enforceSingleIntent) — a request is broken into the
// minimum number of ordered steps needed to carry out that one intent, not
// routed across several different specialist prompts/tool sets. A step's
// sub-intent may still differ from another step's within the same intent
// (e.g. work_with_repo's code_research then code_changes). Approving the
// plan (manually or via auto-approve — both paths are identical from here
// on) moves straight to running `.steps` — there is no separate
// post-approval planning call in between.
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'completed_manual' | 'cancelled'

export interface ExecutionStep {
  /** Stable id for this step within the plan, e.g. "step_1". Referenced by other steps' dependsOn. */
  id: string
  /** Short, concrete description of what this step accomplishes — this is what's sent as the turn's question/task. */
  task: string
  /** Which ChatIntent this step's tool set + specialist prompt should be scoped to (see lib/intentClassifier.ts). */
  intent: import('../lib/intentClassifier').ChatIntent
  /** Further narrows the tool set within `intent` — see ToolRegistry.getToolNamesForIntent. */
  subIntent?: import('../lib/intentClassifier').AgentSubIntent
  /** Ids of steps that must complete before this one starts. Empty/undefined = no dependency (can run as soon as its turn comes up in order). */
  dependsOn?: string[]
}

/**
 * Lightweight shared state threaded across ExecutionStep runs by
 * services/agent/TaskExecutor.ts, so later steps know what earlier ones
 * discovered/changed — without re-sending full transcripts or making an
 * extra LLM call just to summarize. Deliberately small: a few short strings
 * per step, not full tool-call logs.
 */
export interface TaskState {
  /** Ids of steps that have finished (successfully or with a note), in completion order. */
  completedStepIds: string[]
  /** Free-form short notes of anything a step discovered that a later step might need (e.g. "found API key in .env", "existing route is at /api/users"). */
  discoveries: string[]
  /** File paths touched (created/edited/deleted) by any step so far. */
  changedFiles: string[]
  /** Short (1-3 sentence) summary of each completed step's outcome, keyed by step id — this is what gets folded into the next step's prompt, not the raw transcript. */
  stepSummaries: Record<string, string>
}

export function createInitialTaskState(): TaskState {
  return { completedStepIds: [], discoveries: [], changedFiles: [], stepSummaries: {} }
}

export interface OpenFile {
  id:       string
  name:     string
  lang:     string
  /** Current text content of the file — drives the controlled Monaco editor (text files only) */
  content:  string
  modified: boolean
  active:   boolean
  /** "text" | "base64" | "binary" — selects which viewer renders this file.
   *  "design" marks the virtual Design Canvas tab (id === DESIGN_CANVAS_TAB_ID,
   *  see lib/designCanvasTab.ts) — it has no real on-disk content. */
  kind?:    'text' | 'base64' | 'binary' | 'design'
  /** Best-guess MIME type, e.g. "image/png" */
  mime?:    string
  /** File size on disk, in bytes */
  size?:    number
  /** Last-modified unix timestamp (seconds) */
  mtime?:   number | null
}

/**
 * A diff tab representing a pending AI edit proposal.
 * Opens in the editor area alongside normal file tabs.
 */
export interface DiffTab {
  /** Stable id matching the PendingEdit id */
  id:       string
  /** Display name shown in the tab bar */
  name:     string
  /** The pending edit id this tab is reviewing */
  editId:   string
  /** File path being edited */
  filePath: string
  /** Short file name (last path segment) */
  fileName: string
  /** Monaco language id */
  language: string
  active:   boolean
}

/** Union type for anything that can live in the tab bar */
export type AnyTab =
  | ({ tabType: 'file' } & OpenFile)
  | ({ tabType: 'diff' } & DiffTab)

export interface FileNode {
  id:        string
  name:      string
  type:      'file' | 'folder'
  lang?:     string
  modified?: boolean
  expanded?: boolean
  children?: FileNode[]
}

export interface AiContext {
  file:      string
  /** Absolute path of the active file, used for file-aware retrieval/active-file context */
  filePath?: string
  /** Current content of the active file (used for Active File Context) */
  fileContent?: string
  selection: string
  language?: string
}

export interface ChatMessage {
  id:        string
  role:      'user' | 'ai'
  name:      string
  initials:  string
  time:      string
  body:      string
  /** Renderer-only durability state. Never serialized into message metadata. */
  persistenceStatus?: 'saving' | 'saved' | 'unsaved'
  /** Persisted display-state markers used by durable context compaction. */
  hiddenByCompaction?: boolean
  isCompactionSummary?: boolean
  compactionKeptMessageIds?: string[]
  /**
   * CHAT-004: id of the corresponding row in the SQLite message graph, once
   * persisted (undefined for a brand-new message that hasn't been saved
   * yet — e.g. still streaming). Used to look up branch/version info and
   * to drive prev/next navigation and edit/regenerate forking.
   */
  dbId?: string
  /** CHAT-004: `dbId` of this message's parent in the graph (null = root). Undefined until `dbId` is set. */
  parentDbId?: string | null
  /**
   * CHAT-004: prev/next version info when this message has sibling
   * branches (an edited/regenerated version exists). Undefined when there's
   * only one version — MessageList hides the nav in that case.
   */
  versionInfo?: { index: number; count: number }
  codeBlock?: {
    lang:    string
    content: string
  }
  actions?: string[]
  /** Retrieval diagnostics for this turn (set on the 'ai' message). */
  retrieval?: import('../lib/chunkSearch').RetrievalStats
  /** Tool-call activity events shown before/alongside the final response. */
  agentActivities?: import('../services/agent').AgentActivity[]
  /** Compression metrics for this turn — token reduction stats. */
  compressionMetrics?: import('../lib/contextCompression').CompressionMetrics
  /** Images attached to this (user) message — preview only, for display. */
  images?: { previewUrl: string; mimeType: string }[]
  /**
   * Set on the assistant message pushed for a design_project step (see
   * useChat.ts's build_new_project/design_project handling). Drives the
   * "DESIGN" badge + "Open Canvas" button in MessageList — clicking it
   * opens components/viewers/DesignCanvasView.tsx via useDesignCanvasStore.
   */
  isDesign?: boolean
  /**
   * Structured, intent-tagged plan produced by the intent-based Task
   * Planner (selected specialist → Task Planner, see
   * lib/planGenerator.ts). When present and planApproved is false, agent is
   * paused awaiting approval,.
   */
  intentPlan?: IntentPlan
  /** Set to true once the plan has been approved — manually or automatically. */
  planApproved?: boolean
  /**
   * Set to true when the user clicks "Cancel Plan" on an IntentPlanCard
   * before approving it. Mutually exclusive with planApproved — a
   * cancelled plan is never executed, and its planContextRef entry is
   * dropped so a later approval attempt is a no-op (see useChat's
   * cancelPlan). Purely a display flag: hides the Approve/Cancel/Modify
   * actions and shows a "Cancelled" badge in their place.
   */
  planCancelled?: boolean
  /**
   * Live per-step state for an approved intentPlan, keyed by ExecutionStep
   * id — see StepStatus. Populated once approvePlan starts executing the
   * step list and updated as each step's executor runs; absent entries are
   * treated as 'pending'.
   */
  stepStatuses?: Record<string, StepStatus>
  /**
   * Set when the user clicks "Cancel Execution" on a 'failed' step —
   * distinct from planCancelled above, which only applies BEFORE approval.
   * Once true, the remaining (not-yet-run) steps are marked 'cancelled' in
   * stepStatuses and the execution pipeline never resumes for this plan —
   * see useChat's cancelExecution.
   */
  executionCancelled?: boolean
  /**
   * PLAN-001: set alongside planApproved when the plan was approved
   * automatically (Plan Mode OFF — see useChat.ts::presentOrAutoApprovePlan)
   * rather than via the user clicking "Approve Plan" on the card. Purely a
   * display flag for IntentPlanCard's approved badge; every other part
   * of the approval/execution flow behaves identically either way.
   */
  autoApproved?: boolean
  /**
   * True when this turn ended in an error (e.g. API timeout, network
   * failure) that AgentLoop was able to hand back a resumable conversation
   * state for — which is effectively always, whether or not any tool call
   * had already completed successfully. The actual resumable conversation
   * state lives outside React state (see useChat's resumeStatesRef) — this
   * flag just controls whether the "Retry" button renders. Clicking it can
   * be done repeatedly: each failed retry re-sets this flag so the button
   * reappears.
   */
  resumable?: boolean
  /**
   * Set on an 'ai' message when a git_action tool call was blocked by a
   * Settings → Git safety toggle (commit/push/direct-push-to-main). Renders
   * an inline toggle (PendingToggleCard) so the user can flip the setting
   * and automatically resume the pending action with one click, instead of
   * typing a free-text reply like "done" / "enabled" — which used to get
   * routed through intent classification as a brand-new request instead of
   * being recognized as a confirmation of this pending workflow.
   */
  pendingToggle?: {
    settingKey: 'autoAllowCommit' | 'autoAllowPush' | 'allowDirectPushToMain'
    label:      string
    /** True once the user has flipped it on from this card (hides the toggle, shows a confirmation). */
    resolved?:  boolean
  }
  /**
   * Shown BEFORE the intent-based Task Planner runs, when the Agentic
   * Classifier (see lib/agenticClassifier.ts) flagged this turn's raw
   * message as needing confirmation first — either because it looked like
   * a typo'd/garbled version of an automatable task ("did you mean...?"),
   * or because the task is genuinely ambiguous and needs up to 3 short
   * clarifying answers before it can be planned. Rendered as a
   * ClarificationCard in place of the plan card until resolved — see
   * useChat's resolveClarification. `correctedText` and `questions` can
   * both be present at once (a single card covers both); either may be
   * omitted on its own. `intentPlan` is never generated/attached to this
   * message until this is resolved.
   */
  clarification?: {
    /** The corrected/cleaned-up rewrite of the user's message, if the classifier proposed one. */
    correctedText?: string
    /** Up to 3 clarifying questions the classifier needs answered before planning, if any. */
    questions?:     string[]
    /** The user's typed answers, in the same order as `questions`, once submitted. */
    answers?:       string[]
    /** True once the user has approved/declined the correction and (if applicable) submitted answers. */
    resolved:       boolean
    /** True if the user declined the proposed correction and asked to proceed with their original wording instead. */
    useOriginal?:   boolean
  }
  /**
   * Set on an ephemeral 'ai' message pushed while the app is deliberately
   * pausing a request to respect a provider's requests-per-minute limit
   * (currently only Gemini free-tier keys — see
   * lib/providers/geminiRateLimiter.ts / lib/providers/rateLimitEvents.ts).
   * Purely a display flag: MessageList renders it with a lighter, non-avatar
   * "system notice" treatment instead of a normal assistant bubble. Never
   * persisted to SQLite — it's operational status, not part of the actual
   * conversation.
   */
  isRateLimitNotice?: boolean
}

export interface EditorConfig {
  initialValue: string
  language?:    string
  theme?:       string
}
