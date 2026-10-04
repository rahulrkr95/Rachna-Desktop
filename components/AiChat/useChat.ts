// components/AiChat/useChat.ts
//
// Central chat hook — owns all chat state and the send / stop / retry /
// new-chat lifecycle.  AiChat.tsx calls this hook and passes the returned
// values to child components.

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { AiContext, ChatMessage, IntentPlan } from '../../types'
import { useApiKeyStore, useActiveApiKey, useSelectedModel } from '../../store/useApiKeyStore'
import { getProvider } from '../../lib/providers/registry'
import { onRateLimitWait, type RateLimitWaitEvent } from '../../lib/providers/rateLimitEvents'
import { useRepoIndex, selectIsIndexing } from '../../store/useRepoIndex'
import { runAgentLoop } from '../../services/agent'
import type { AgentActivity, ToolContext, GitSettingKey, AgentActivityArtifact } from '../../services/agent'
import { GIT_SETTING_LABELS } from '../../services/agent'
import { useRetrieval, type EditorContextMetadata } from './useRetrieval'
import { buildSystemPrompt, assembleUserPrompt, buildRepoSummarySection } from './prompts'
import { getSystemInfo } from '../../lib/systemInfo'
import { loadProjectRules } from '../../lib/projectRules'
import { getMcpToolsSection, getRelevantConfiguredMcpServers, getRelevantConnectedMcpServers } from '../../services/agent/mcpTools'
import { useEditStore } from '../../services/edits/EditStore'
import { useUnsavedProjectStore } from '../../store/useUnsavedProjectStore'
import {
  saveMessage as dbSaveMessage,
  setCurrentLeaf as dbSetCurrentLeaf,
  updateMessage as dbUpdateMessage,
  loadConversationById,
  listAllConversations,
  listConversations,
  deleteConversation,
  saveRejectedEdit,
  getRejectedEdits,
  NO_PROJECT_KEY,
  type Conversation,
} from '../../lib/conversationMemory'
import {
  buildChildrenMap,
  buildPathToLeaf,
  getVersionInfo,
  switchVersion as computeSwitchVersion,
  type GraphNode,
} from '../../lib/chatGraph'
import { compressContext, getBudgetsForModel } from '../../lib/contextCompression'
import type { PendingChatImage } from './ChatInput'
import {
  compactConversation,
  shouldCompact,
  estimateChatTokens,
  type CompactionMetadata,
} from '../../lib/conversationCompaction'
import { buildConversationHistory } from '../../lib/conversationContext'
import { useTodoStore, formatTodosForPrompt } from '../../store/useTodoStore'
import { useDiskViewerStore } from '../../store/useDiskViewerStore'
import { useGitSettingsStore } from '../../store/useGitSettingsStore'
import { selectIdeEntitlements } from '../../store/useIdeEntitlements'
import { useAuthStore } from '../../store/useAuthStore'
import { useTerminalPermissionStore } from '../../store/useTerminalPermissionStore'
import { useBrowserPreferenceStore } from '../../store/useBrowserPreferenceStore'
import { nudge } from '../../services/notify'
import {
  intentNeedsSystemInfo,
  BROWSER_TASK_UNSUPPORTED,
  type ChatIntent,
  type AgentSubIntent,
  type TopIntent,
} from '../../lib/intentClassifier'
import {
  runPromptCorrectionClassifier,
  getPromptCorrectionSystemPrompt,
  runAutomationClassifier,
} from '../../lib/agenticClassifier'
import { generateExecutionPlan, type TaskPlannerResult } from '../../lib/planGenerator'
import { runExecutionSteps, orderSteps, formatTaskStateForPrompt, type StepExecutionResult } from '../../services/agent/TaskExecutor'
import { createInitialTaskState, type ExecutionStep, type TaskState, type StepStatus } from '../../types'
import { open as openInDefaultBrowser } from '@tauri-apps/plugin-shell'
import { openFolder, pickDirectory, createProject } from '../../lib/tauriFs'
import { setPendingStepResume, takePendingStepResume } from '../../lib/pendingChatSend'
import { runBuildNewProjectFlow } from '../../services/agent/buildNewProject'
import { useMcpStore } from '../../store/useMcpStore'
import { useRepoContextModeStore } from '../../store/useRepoContextModeStore'
import { useAdditionalFoldersStore } from '../../store/useAdditionalFoldersStore'
import { useFolderChipsStore } from '../../store/useFolderChipsStore'
import { buildFolderTreeText } from '../../lib/folderSummary'
import { suggestMcpForRequest } from '../../lib/mcpCatalog'
import { useChatAppContextStore, buildAppContextBlock } from '../../store/useChatAppContextStore'
import { useAutomationStore } from '../../store/useAutomationStore'
import { describeSchedule, parseSchedule, buildExecutionPrompt, buildSteps, buildTriggeredPrompt, type AutomationJob } from '../../lib/automationScheduler'
import { registerAutomationExecutor } from '../../services/automationService'
import { useSpecialistStore } from '../../store/useSpecialistStore'
import { SPECIALIST_TOP_INTENT, SPECIALIST_META } from '../../lib/specialistMapping'


// ── CHAT-005: full-fidelity message persistence ────────────────────────────
//
// Only `role` + `body` used to survive a reload — every other ChatMessage
// field (the generated IntentPlan, its live per-step statuses, agent
// activity/"api call" chips, retrieval + compression stats, attached
// images, pending login/toggle cards, etc.) lived in React state only and
// was silently lost the moment the app restarted or the user switched to a
// different conversation and back. These two helpers round-trip that extra
// state through the `messages.metadata` column (an opaque JSON string as
// far as the Rust/SQLite side is concerned — see lib/conversationMemory.ts)
// so a restored conversation looks exactly like it did before reload.
//
// Deliberately NOT included:
//   - `resumable` — the actual resumable state (`ResumeState`, provider
//     function-calling history) lives only in `resumeStatesRef`, in memory,
//     and is never persisted. Restoring `resumable: true` after a reload
//     would show a "Retry" button that has nothing to resume, so it's
//     always dropped/left `false` on restore.
//   - `versionInfo` — re-derived from the live message graph every time
//     (see pathToChatMessages), not stored data.
//   - id/dbId/parentDbId/role/name/initials/time/body — already columns,
//     or derived/regenerated on load.
type PersistableMetadata = Pick<
  ChatMessage,
  | 'codeBlock'
  | 'actions'
  | 'retrieval'
  | 'agentActivities'
  | 'compressionMetrics'
  | 'images'
  | 'intentPlan'
  | 'planApproved'
  | 'planCancelled'
  | 'stepStatuses'
  | 'executionCancelled'
  | 'autoApproved'
  | 'pendingToggle'
  | 'clarification'
  | 'isDesign'
  | 'isRateLimitNotice'
  | 'hiddenByCompaction'
  | 'isCompactionSummary'
  | 'compactionKeptMessageIds'
>

/** Builds the JSON blob to persist alongside a message's plain-text body. Returns `null` when there's nothing extra to save (the common case). */
function extractMessageMetadata(msg: ChatMessage): string | null {
  const meta: Partial<PersistableMetadata> = {}
  if (msg.codeBlock) meta.codeBlock = msg.codeBlock
  if (msg.actions && msg.actions.length > 0) meta.actions = msg.actions
  if (msg.retrieval) meta.retrieval = msg.retrieval
  if (msg.agentActivities && msg.agentActivities.length > 0) meta.agentActivities = msg.agentActivities
  if (msg.compressionMetrics) meta.compressionMetrics = msg.compressionMetrics
  if (msg.images && msg.images.length > 0) meta.images = msg.images
  if (msg.intentPlan) meta.intentPlan = msg.intentPlan
  if (msg.planApproved) meta.planApproved = msg.planApproved
  if (msg.planCancelled) meta.planCancelled = msg.planCancelled
  if (msg.stepStatuses && Object.keys(msg.stepStatuses).length > 0) meta.stepStatuses = msg.stepStatuses
  if (msg.executionCancelled) meta.executionCancelled = msg.executionCancelled
  if (msg.autoApproved) meta.autoApproved = msg.autoApproved
  if (msg.pendingToggle) meta.pendingToggle = msg.pendingToggle
  if (msg.clarification) meta.clarification = msg.clarification
  if (msg.isDesign) meta.isDesign = msg.isDesign
  if (msg.isRateLimitNotice) meta.isRateLimitNotice = msg.isRateLimitNotice
  if (msg.hiddenByCompaction) meta.hiddenByCompaction = msg.hiddenByCompaction
  if (msg.isCompactionSummary) meta.isCompactionSummary = msg.isCompactionSummary
  if (msg.compactionKeptMessageIds?.length) meta.compactionKeptMessageIds = msg.compactionKeptMessageIds

  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
}

/** Inverse of extractMessageMetadata — parses a stored blob back into ChatMessage fields to spread onto the restored message. Tolerant of `null`/malformed data (older rows, or a future format this build doesn't know). */
function parseMessageMetadata(raw: string | null | undefined): Partial<ChatMessage> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Partial<ChatMessage>) : {}
  } catch {
    return {}
  }
}

/**
 * Removed: AgentMode ('agentic' | 'chat') used to be a separate Action Bar
 * toggle that pre-set a turn's routing. It's superseded by the specialist
 * chip (store/useSpecialistStore.ts) — selecting the CHAT specialist does
 * exactly what agentMode:'chat' used to do (straight to the model, no
 * tools, no plan), and every other specialist replaces 'agentic'. See the
 * specialist-chip block in executeSend below.
 */

export interface UseChatReturn {
  messages:            ChatMessage[]
  chatHydrated:        boolean
  chatOpen:            boolean
  input:               string
  streaming:           boolean
  exporting:           boolean
  failoverNotice:      string | null
  /** CHAT-002: set while a message is sent before repo indexing has finished. */
  repoIndexWarning:    string | null
  repoContextNotice:   string | null
  streamingMsgId:      string | null
  textareaRef:         React.RefObject<HTMLTextAreaElement>
  messagesEndRef:      React.RefObject<HTMLDivElement>
  setInput:            (v: string | ((prev: string) => string)) => void
  setExporting:        (v: boolean) => void
  handleInput:         (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown:       (e: React.KeyboardEvent) => void
  handleSend:          (images?: PendingChatImage[]) => void
  handleStop:          () => void
  /**
   * Set to 'send' | 'retry' | 'edit' whenever handleSend/handleRetry/
   * handleEditMessage is invoked while a run is already active — the
   * action is queued rather than run immediately. AiChat.tsx renders a
   * confirm modal while this is non-null; confirmTerminateRun stops the
   * current run and fires the queued action, cancelTerminateConfirm just
   * drops it.
   */
  pendingTerminateConfirm: 'send' | 'retry' | 'edit' | null
  confirmTerminateRun:     () => void
  cancelTerminateConfirm:  () => void
  handleNewChat:       () => void
  handleRetry:         (msgId: string) => void
  /**
   * Resumes a turn that failed mid-way (e.g. API timeout) after at least one
   * tool call already succeeded. Continues from the exact point of failure
   * instead of re-running the whole turn from scratch. No-op if there's no
   * saved resume state for msgId (see MessageList's `resumable` flag).
   */
  handleContinue:      (msgId: string) => void
  handleEditMessage:   (msgId: string, newBody: string) => void
  /**
   * CHAT-004: navigates to the previous/next sibling version of a message
   * that has multiple branches (an edit or regeneration created siblings).
   * No-op if the message has no dbId yet or only one version. Updates the
   * visible path only — never deletes or mutates any branch.
   */
  handleSwitchVersion: (msgId: string, direction: -1 | 1) => void
  provider:            ReturnType<typeof getProvider>
  apiKey:              string | undefined
  /** Provider id of the currently active provider (e.g. 'gemini') — used by GeminiQuotaBanner. */
  activeProviderId:    string
  /** Currently selected model id for the active provider — used by GeminiQuotaBanner. */
  selectedModel:       string | undefined
  /** Estimated token count for the current chat history. */
  chatTokenEstimate:   number
  /** Metadata from the most recent compaction pass (null if never compacted). */
  lastCompactionMeta:  CompactionMetadata | null
  /** How many compaction passes have occurred on this conversation. */
  compactionPassCount: number
  // ── Conversation memory ────────────────────────────────────────────────
  // Chats persist whether or not a project folder is open: when no project
  // is open, conversations are scoped under the NO_PROJECT_KEY sentinel
  // (see lib/conversationMemory.ts) instead of a real project_root, so
  // nothing is lost switching between the welcome screen and a project.
  /** The active conversation id (null until first message is saved). */
  activeConversationId: string | null
  /** Past conversations for the CURRENTLY ACTIVE scope only (this project, or the no-project scope). */
  conversationHistory:  Conversation[]
  /** No-project ("User Chats") conversations — always shown as a flat list in the sidebar. */
  noProjectConversations: Conversation[]
  /** One entry per project that has chat history, each with its own list — rendered as expandable groups in the sidebar. */
  projectConversationGroups: Array<{ projectRoot: string; label: string; conversations: Conversation[] }>
  /**
   * Restores a past conversation. If it belongs to a different scope than
   * the one currently active (a different project, or the no-project
   * scope), this hands off to `onSwitchProject` (see useChat's opts) to
   * open the right project / return to the welcome screen first, then
   * hydrates this exact conversation once that scope becomes active.
   */
  restoreConversation:  (conversation: Conversation) => Promise<void>
  /** Delete a conversation from history. */
  deleteConversation:   (conversationId: string) => Promise<void>
  /** Refresh the sidebar conversation list (all projects + no-project scope). */
  refreshHistory:       () => Promise<void>
  // ── Plan mode ─────────────────────────────────────────────────────────────
  /** Whether plan-before-execute mode is active. */
  planMode:    boolean
  setPlanMode: (v: boolean) => void
  /** Approve a pending plan message and continue execution. */
  approvePlan: (planMsgId: string) => void
  modifyPlan:  (planMsgId: string, feedback: string) => void
  /** Reject a pending IntentPlan before it's approved — no step ever executes. */
  cancelPlan:  (planMsgId: string) => void
  /** Failure Handling: re-runs ONLY the 'failed' step (previously-successful steps are untouched); continues on into later steps if it now succeeds. */
  retryStep:   (planMsgId: string) => void
  /** Failure Handling: user override — marks the 'failed' step completed_manual (without re-running it) and continues with whatever comes after it. */
  markStepDone: (planMsgId: string) => void
  /** Failure Handling: cancels the whole execution from the 'failed' step onward — marks it (and everything after it) 'cancelled'; already-completed steps are untouched. */
  cancelExecution: (planMsgId: string) => void
  /**
   * Flips a Settings → Git safety toggle (from the in-chat PendingToggleCard)
   * and automatically resumes the git_action call that was blocked by it —
   * bypassing intent classification entirely so the follow-up doesn't get
   * misrouted as an unrelated new request.
   */
  resolvePendingToggle: (msgId: string, settingKey: GitSettingKey) => void
  /**
   * Fired when the user resolves a ClarificationCard (see
   * presentClarificationOrPlan / ClarificationCard.tsx) — either the
   * "did you mean...?" correction Yes/No, submitted clarifying answers, or
   * both at once. Marks the card resolved and continues straight into
   * Task Planner with the finalized text without repeating refinement.
   */
  resolveClarification: (msgId: string, result: { useCorrection: boolean; answers?: string[] }) => void

  // ── Intent classification (only active while no project is open) ───────
  /** True while a send is being routed through intent classification. */
  classifyingIntent: boolean
  /** Whether the "Build New Project" name/location dialog is open. */
  buildDialogOpen:       boolean
  /**
   * 'design' when this dialog was opened by a DESIGN-classified request
   * (see lib/intentClassifier.ts) — a brand-new project either way, but
   * the resulting build runs through the Tailwind + Lucide static-HTML
   * design prompts instead of the normal coding ones. 'code' otherwise.
   */
  buildDialogMode:       'code' | 'design'
  /** True while createProject() is running for the build dialog. */
  buildDialogSubmitting: boolean
  /** Error message from the last failed build-dialog submission, if any. */
  buildDialogError:      string | null
  /**
   * Default "location" value to pre-fill the build dialog with:
   * `{Rachna AI Studio install dir}/projects` (see
   * lib/tauriFs.ts::getDefaultProjectsDir). Null while still resolving or
   * if it couldn't be resolved — the field just starts empty in that case.
   */
  buildDialogDefaultLocation: string | null
  /** Opens a native folder picker for the build dialog's "location" field. */
  browseBuildLocation:   () => Promise<string | null>
  /** Creates the new project folder and starts building inside it. */
  confirmBuildDialog:    (location: string, projectName: string) => Promise<void>
  /** Closes the build dialog and restores the user's original message. */
  cancelBuildDialog:     () => void
}

function waitForIndexReady(signal: AbortSignal): Promise<boolean> {
  if (!selectIsIndexing(useRepoIndex.getState())) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    const unsub = useRepoIndex.subscribe(state => {
      if (!selectIsIndexing(state)) { cleanup(); resolve(true) }
    })
    const onAbort = () => { cleanup(); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    function cleanup() {
      unsub()
      signal.removeEventListener('abort', onAbort)
    }
  })
}

export function useChat(
  context: AiContext,
  opts: {
    welcomeMode?: boolean
    /**
     * Called when the user restores a chat from a different scope than the
     * one currently active — a different project, or the "no project open"
     * scope (passed as `null`). The host (IDELayout) owns opening/closing
     * projects and app-mode switching; this hook just asks for it and waits
     * for `projectRoot` to reflect the new scope before hydrating.
     */
    onSwitchProject?: (root: string | null) => void
  } = {}
): UseChatReturn {
  const welcomeMode = !!opts.welcomeMode
  const onSwitchProject = opts.onSwitchProject
  const apiKey           = useActiveApiKey()
  const selectedModel    = useSelectedModel()
  const activeProviderId = useApiKeyStore(s => s.activeProviderId)
  const provider         = getProvider(activeProviderId)
  const projectRoot      = useRepoIndex(s => s.projectRoot)
  // Needed by the "Build New Project" hand-off effect below: a design_project
  // (or build_new_project with no folder open) creates an in-memory unsaved
  // project rather than a real projectRoot, so that effect has to key off
  // this too, not just projectRoot, to catch the hand-off.
  const unsavedProjectName = useUnsavedProjectStore(s => s.projectName)
  // "Repo Context" chip (see ChatHeader) — only shown/toggleable while a
  // project is open. When OFF, every turn is treated as fresh: no repo
  // summary, retrieval, project rules, or rejected-edit memory is built or
  // sent, even though projectRoot itself stays set and tools keep working.
  const repoContextEnabled = useRepoContextModeStore(s => s.repoContextEnabled)
  // Chats persist whether or not a project is open. `projectRoot` itself
  // stays null/real-path as-is (lots of other logic below branches on that),
  // but conversation persistence always needs a non-null key, so we resolve
  // a separate scope key here just for that.
  const chatScopeKey     = projectRoot || NO_PROJECT_KEY
  const indexFolder      = useRepoIndex(s => s.indexFolder)
  const closeProject     = useRepoIndex(s => s.closeProject)
  const setProjectRootOnly = useRepoIndex(s => s.setProjectRootOnly)
  const scanResult       = useRepoIndex(s => s.scanResult)
  const indexStatus      = useRepoIndex(s => s.status)
  const { runRetrieval } = useRetrieval()

  const [messages,       setMessages]       = useState<ChatMessage[]>([])
  const [chatHydrated,   setChatHydrated]   = useState(false)
  const [chatOpen,       setChatOpen]       = useState(true)
  const [input,          setInput]          = useState('')
  const [streaming,      setStreaming]       = useState(false)
  // Always-current mirror of `streaming`, readable synchronously from inside
  // guard checks (handleSend/handleRetry/handleEditMessage) without the
  // stale-closure risk of reading the `streaming` state variable captured
  // at a callback's own creation time. Kept in sync by the effect below;
  // handleStop also writes it directly for zero-latency correctness right
  // before it hands off to a queued confirm action.
  const streamingRef = useRef(false)
  useEffect(() => { streamingRef.current = streaming }, [streaming])
  // ── Resend/Retry/Edit while a run is active ──────────────────────────────
  // Those three entry points used to just silently no-op while streaming.
  // Now: clicking any of them mid-run queues the actual action here and
  // opens a confirm modal (rendered by AiChat.tsx) instead — confirming
  // aborts the in-flight turn (see handleStop) and then runs the queued
  // action; cancelling leaves the current run untouched.
  const pendingRunRef = useRef<(() => void) | null>(null)
  const [pendingTerminateConfirm, setPendingTerminateConfirm] =
    useState<'send' | 'retry' | 'edit' | null>(null)
  const requestOrRun = useCallback((kind: 'send' | 'retry' | 'edit', run: () => void) => {
    if (streamingRef.current) {
      pendingRunRef.current = run
      setPendingTerminateConfirm(kind)
    } else {
      run()
    }
  }, [])
  const cancelTerminateConfirm = useCallback(() => {
    pendingRunRef.current = null
    setPendingTerminateConfirm(null)
  }, [])

  // ── Gemini RPM-limit wait notice ─────────────────────────────────────────
  // lib/providers/GeminiProvider.ts pauses (rather than firing a request
  // that would blow the free-tier per-minute cap) whenever the proactive
  // guard or a 429/RetryInfo response calls for it — see
  // lib/providers/geminiRateLimiter.ts. That happens several call-layers
  // below useChat (AgentLoop → TaskExecutor/ToolExecutor → GeminiProvider),
  // so it's surfaced here via a small event bus (rateLimitEvents.ts) rather
  // than threaded through every intermediate function signature. A single
  // ephemeral chat message is reused and updated so concurrent waits do not
  // flood the conversation with duplicate rate-limit notices.
  const rpmWaitNoticeIdRef = useRef<string | null>(null)
  const persistVisibleMessageRef = useRef<((msg: ChatMessage, isNew?: boolean) => void) | null>(null)

  useEffect(() => {
    return onRateLimitWait((event: RateLimitWaitEvent) => {
      if (event.providerId !== 'gemini') return
      const waitSeconds = Math.max(1, Math.round(event.waitMs / 1000))
      setMessages(prev => {
        const existingId = rpmWaitNoticeIdRef.current

        // Update the existing RPM notice instead of creating another message.
        if (existingId) {
          const existingIndex = prev.findIndex(
            msg => msg.id === existingId && msg.isRateLimitNotice
          )

          if (existingIndex !== -1) {
            return prev.map((msg, index) => {
              if (index === existingIndex) {
                const updated = {
                    ...msg,
                    body: `Waiting for ${waitSeconds} seconds to not trigger Gemini RPM limit.`,
                    time: new Date().toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    }),
                  }
                persistVisibleMessageRef.current?.(updated)
                return updated
              }
              return msg
            })
          }
        }

        // No existing notice in the current chat, so create one.
        const noticeId = `rpm-wait-${Date.now()}`
        rpmWaitNoticeIdRef.current = noticeId

        const noticeMsg: ChatMessage = {
          id: noticeId,
          role: 'ai',
          name: provider?.displayName ?? 'Assistant',
          initials: '⏳',
          time: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
          body: `Waiting for ${waitSeconds} seconds to not trigger Gemini RPM limit.`,
          isRateLimitNotice: true,
        }

        persistVisibleMessageRef.current?.(noticeMsg, true)
        return [...prev, noticeMsg]
      })
    })
  }, [provider])
  const [exporting,      setExporting]      = useState(false)
  const [failoverNotice, setFailoverNotice] = useState<string | null>(null)
  // CHAT-002: shown (not blocking) whenever a message is sent while the
  // repo index for the open project isn't 'ready' yet — the model can
  // still answer, just without repo-aware context, so the user should
  // know why the answer might be generic instead of being left to guess.
  const [repoIndexWarning, setRepoIndexWarning] = useState<string | null>(null)
  // Warning/notice shown in chat whenever the "Repo Context" chip's state
  // changes — whether the user toggled it manually, or it flipped itself ON
  // automatically once a newly-opened project finished indexing. Auto-clears
  // after a few seconds so it doesn't linger indefinitely.
  const [repoContextNotice, setRepoContextNotice] = useState<string | null>(null)
  // Defaults to Auto-Approve (false) — plans execute without a manual
  // "Approve" click unless the user flips this back to Manual Approval.
  const [planMode,       setPlanMode]       = useState(false)

  // ── Intent classification + "Build New Project" dialog state ────────────
  // Only relevant while projectRoot is null (no folder open yet).
  const [classifyingIntent,      setClassifyingIntent]      = useState(false)
  const [buildDialogOpen,        setBuildDialogOpen]        = useState(false)
  const [buildDialogMode,        setBuildDialogMode]        = useState<'code' | 'design'>('code')
  const [buildDialogSubmitting,  setBuildDialogSubmitting]  = useState(false)
  const [buildDialogError,       setBuildDialogError]       = useState<string | null>(null)
  const [buildDialogDefaultLocation, setBuildDialogDefaultLocation] = useState<string | null>(null)
  /** Text/images queued for confirmBuildDialog/cancelBuildDialog above — see those for why this is a plain ref, not the cross-unmount module queue in lib/pendingChatSend.ts. */
  const pendingBuildDialogRef = useRef<{
    text: string
    images: PendingChatImage[]
    /** New coding projects initialize the workspace before task planning. */
    planner?: { apiKey: string; model?: string; userMsg: ChatMessage; activity: AgentActivity }
  } | null>(null)

  const streamingIdRef    = useRef<string | null>(null)
  const messagesEndRef    = useRef<HTMLDivElement>(null)
  const textareaRef       = useRef<HTMLTextAreaElement>(null)
  const abortRef          = useRef<AbortController | null>(null)
  const generationIdRef   = useRef(0)
  const compactionPassRef = useRef(0)
  const lastCompactionRef = useRef<CompactionMetadata | null>(null)

  // ── Conversation memory state ──────────────────────────────────────────────
  // activeConversationIdRef is a ref (not state) because we need to read its
  // latest value inside async callbacks without stale-closure issues.
  const activeConversationIdRef          = useRef<string | null>(null)
  const [activeConversationId,
         setActiveConversationId]        = useState<string | null>(null)
  // Every conversation across every scope (all projects + the no-project
  // scope), fetched via listAllConversations(). conversationHistory,
  // noProjectConversations, and projectConversationGroups below are all
  // just views over this one list, so a single refresh keeps everything
  // — the sidebar's per-project groups included — in sync.
  const [allConversations,
         setAllConversations]            = useState<Conversation[]>([])
  // A pending restore target set by restoreConversation() when the target
  // conversation belongs to a different scope than the one currently
  // active. The hydration effect below consumes it once chatScopeKey
  // actually changes to that scope, loading that exact conversation
  // instead of "the latest one for this scope".
  const pendingRestoreIdRef              = useRef<string | null>(null)
  // Track the last assistant message id so rejected edits can be linked to it.
  const lastAssistantMessageIdRef        = useRef<string | null>(null)

  // ── CHAT-004: message graph state ──────────────────────────────────────
  // `graphNodesRef` mirrors every message row (every branch) for the
  // active conversation, kept in sync as messages are persisted so branch
  // lookups/version nav never need a round-trip to SQLite. `tailDbIdRef`
  // is the db id of the last message on the currently-displayed path —
  // the default parent for the NEXT message persisted via a plain
  // `persistMessage()` call (linear continuation). Edit/regenerate
  // override this default explicitly to fork a sibling instead.
  const graphNodesRef = useRef<GraphNode[]>([])
  const tailDbIdRef    = useRef<string | null>(null)
  /**
   * CHAT-005 fix: keyed by a ChatMessage's client-side `id` (not `dbId`),
   * holds the in-flight `persistMessage` promise for that message. A
   * message created and then immediately mutated (e.g. an auto-approved
   * IntentPlanCard whose stepStatuses start changing within milliseconds,
   * before the initial `dbSaveMessage` round-trip has even resolved) used
   * to silently lose every one of those fast-follow updates: `persistMessageUpdate`
   * bails out whenever `msg.dbId` isn't set yet, and back then nothing
   * ever retried once it was. `persistMessage` now registers its promise
   * here immediately, and `persistMessageUpdate` awaits it when `dbId` is
   * still missing instead of dropping the update — see both below.
   */
  const pendingDbIdRef = useRef<Map<string, Promise<string | null>>>(new Map())
  // All inserts share one queue. This preserves transcript/parent ordering
  // even when user + assistant placeholders are appended in the same tick.
  const persistenceQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const retryPersistRef = useRef<((role: 'user' | 'assistant' | 'tool', msg: ChatMessage | string, toolName?: string | null, parentId?: string | null) => void) | null>(null)
  const checkpointTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const checkpointSignaturesRef = useRef<Map<string, string>>(new Map())
  const checkpointQueuesRef = useRef<Map<string, Promise<void>>>(new Map())

  /** Converts a root-to-leaf chain of graph nodes into displayed ChatMessages, attaching version info from the full node set and restoring any persisted metadata (CHAT-005). */
  const pathToChatMessages = useCallback((path: GraphNode[]): ChatMessage[] => {
    const childrenMap = buildChildrenMap(graphNodesRef.current)
    const restored = path.map(n => {
      const info = getVersionInfo(childrenMap, graphNodesRef.current, n.id)
      return {
        id: n.id,
        dbId: n.id,
        parentDbId: n.parent_id,
        role: n.role === 'user' ? 'user' : 'ai',
        name: n.role === 'user' ? 'You' : 'Rachna AI',
        initials: n.role === 'user' ? 'U' : '✦',
        time: '',
        body: n.content,
        versionInfo: info ? { index: info.index, count: info.count } : undefined,
        ...parseMessageMetadata(n.metadata),
      } as ChatMessage
    }).filter(msg => !msg.hiddenByCompaction)
    const summaryIndex = restored.findIndex(msg => msg.isCompactionSummary)
    if (summaryIndex > 0) {
      const summary = restored[summaryIndex]
      const kept = new Set(summary.compactionKeptMessageIds ?? [])
      const firstKeptIndex = restored.findIndex(msg => kept.has(msg.id))
      if (firstKeptIndex >= 0 && firstKeptIndex < summaryIndex) {
        restored.splice(summaryIndex, 1)
        restored.splice(firstKeptIndex, 0, summary)
      }
    }
    return restored
  }, [])

  /** Conversations for the CURRENTLY ACTIVE scope only (this project, or no-project). */
  const conversationHistory = useMemo(
    () => allConversations.filter(c => c.project_root === chatScopeKey),
    [allConversations, chatScopeKey]
  )
  /** No-project ("User Chats") conversations — always a flat list, regardless of active scope. */
  const noProjectConversations = useMemo(
    () => allConversations.filter(c => c.project_root === NO_PROJECT_KEY),
    [allConversations]
  )
  /** One group per project with chat history, ordered by that project's most recent activity. */
  const projectConversationGroups = useMemo(() => {
    const order: string[] = []
    const byRoot = new Map<string, Conversation[]>()
    for (const c of allConversations) {
      if (c.project_root === NO_PROJECT_KEY) continue
      if (!byRoot.has(c.project_root)) {
        byRoot.set(c.project_root, [])
        order.push(c.project_root)
      }
      byRoot.get(c.project_root)!.push(c)
    }
    return order.map(root => ({
      projectRoot: root,
      label: root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root,
      conversations: byRoot.get(root)!,
    }))
  }, [allConversations])

  // ── Resumable-turn state ──────────────────────────────────────────────────
  // When a turn fails mid-way (e.g. API timeout) after one or more tool
  // calls already succeeded, AgentLoop hands back the exact internal
  // conversation up to that point. We keep it out of React state (it's
  // provider-internal message data, not UI state) in a ref keyed by the
  // failed AI message's id, and expose only a boolean `resumable` flag on
  // the message itself so the UI can show a "Continue" button.
  interface ResumeState {
    conversation:      unknown[]
    ctx:               ToolContext
    systemInstruction: string
    model:             string | undefined
    /**
     * The intent classified for the ORIGINAL attempt. Reused as-is on
     * retry rather than reclassified — the provider's function-calling
     * history was already built against whatever tool subset that intent
     * mapped to (see ToolRegistry.getToolNamesForIntent), so switching tool
     * sets mid-turn could confuse the model or a provider that validates
     * schema consistency across a tool-call/tool-result exchange.
     */
    intent?: ChatIntent
    /** The EditSubIntent/BrowserTaskSubIntent/DesktopTaskCategory paired with `intent` above — same "reuse as-is on retry" rule applies. */
    subIntent?: AgentSubIntent
  }
  const resumeStatesRef = useRef<Map<string, ResumeState>>(new Map())

  // ── Planner layer: plan-card execution context ──────────────────────────
  // Every Master Plan is scoped to the user-selected specialist. The
  // planner attaches one intent-tagged ExecutionStep per piece of work (see
  // lib/planGenerator.ts / services/agent/TaskExecutor.ts), so approval can
  // start sequential execution immediately without any post-approval planning or
  // whole-request fallback.
  interface PlanContext {
    /** The original user question this plan was generated for. */
    originalText: string
    /** Specialist selected before planning; reused verbatim for feedback regeneration. */
    topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>
    /**
     * The generated IntentPlan itself, captured at the same time as
     * originalText (synchronously, via this ref — not via React state).
     * approvePlan reads the plan from here instead of doing a
     * `messages.find(...)` lookup: when presentOrAutoApprovePlan
     * auto-approves, it calls approvePlanRef.current() synchronously right
     * after presentIntentPlan's setMessages() call, and React hasn't
     * committed that state update yet at that point, so `messages` inside
     * approvePlan would still be the pre-plan snapshot (intentPlan
     * undefined, steps empty). Refs update immediately, so stashing the
     * plan here guarantees approvePlan always sees the plan that was just
     * generated, regardless of whether approval is automatic or manual.
     */
    intentPlan: IntentPlan
  }
  const planContextRef = useRef<Map<string, PlanContext>>(new Map())

  // ── Clarification layer: pending correction/questions context ───────────
  // Populated by presentClarificationOrPlan whenever the Agentic Classifier
  // (see lib/agenticClassifier.ts) attached a `correctedText` and/or
  // `clarifyingQuestions` to an agentic-mode result. Holds everything
  // resolveClarification needs to finish the turn — original text, the
  // proposed correction/questions, and the exact planner inputs (provider
  // context, classifier activity, repo context) captured at classification
  // time, so answering the card does not repeat refinement.
  interface ClarificationContext {
    originalText:   string
    images:         PendingChatImage[]
    correctedText?: string
    questions?:     string[]
    classifierActivity: AgentActivity
    /** Same repo-summary block already computed for the planner call — see handleSend. */
    repoContextForPlanner?: string
    /** The selected TopIntent (or CODING_TASK when forced by a folder chip). */
    topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>
  }
  const clarificationContextRef = useRef<Map<string, ClarificationContext>>(new Map())

  interface FailedStepContext {
    steps: ExecutionStep[]
    taskState: TaskState
    originalText: string
    images: PendingChatImage[]
  }
  const failedStepContextRef = useRef<Map<string, FailedStepContext>>(new Map())

  const approvePlanRef = useRef<(planMsgId: string, opts?: { auto?: boolean }) => void>(() => {})

  const runDecomposedStepsRef = useRef<(
    steps: ExecutionStep[],
    taskState: TaskState,
    originalText: string,
    images: PendingChatImage[],
    planMsgId?: string,
  ) => void>(() => {})


  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Refresh the sidebar conversation list from SQLite (all projects + no-project scope). */
  const refreshHistory = useCallback(async () => {
    try {
      const list = await listAllConversations()
      setAllConversations(list)
    } catch (err) {
      console.warn('[conversationMemory] refreshHistory failed:', err)
    }
  }, [])

  /**
   * Persist a single message as a node in the conversation's message graph
   * and update the active conversation id (CHAT-004).
   *
   * By default this is a LINEAR continuation: the new node's parent is
   * `tailDbIdRef.current` (the tip of the currently-displayed path), and
   * the tail ref advances to the new node afterwards — exactly the old
   * flat-history behavior, just expressed as a one-branch tree. Pass
   * `parentId` explicitly to fork a new version instead (see
   * handleEditMessage / handleRetry below), which does NOT change what the
   * default tail is; only a plain call advances it.
   *
   * After a successful save, patches the returned db id onto the most
   * recently added still-unpersisted message of the same role in
   * `messages` state (searching from the end) so the UI can look up
   * dbId/parentDbId for edit, retry, and version-nav — every existing
   * call site keeps working unchanged since this reconciliation is
   * automatic and needs no id passed in.
   *
   * `msg` accepts either a plain string (content only — old behavior) or
   * the full `ChatMessage` object, in which case `extractMessageMetadata`
   * (CHAT-005) pulls out everything else worth restoring on reload — the
   * generated plan, step statuses, agent activity chips, images, etc. —
   * and persists it alongside `content` in the `metadata` column. Prefer
   * passing the full message wherever it's available.
   */
  const persistMessageImpl = useCallback(async (
    role: 'user' | 'assistant' | 'tool',
    msg: ChatMessage | string,
    toolName?: string | null,
    parentId?: string | null
  ) => {
    const content  = typeof msg === 'string' ? msg : msg.body
    const metadata = typeof msg === 'string' ? null : extractMessageMetadata(msg)
    const effectiveParentId = parentId !== undefined ? parentId : tailDbIdRef.current
    const clientId = typeof msg === 'string' ? null : msg.id
    let lastError: unknown
    for (const delayMs of [0, 250, 1000]) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      try {
        const result = await dbSaveMessage({
        conversationId: activeConversationIdRef.current,
        projectRoot: chatScopeKey,
        clientMessageId: clientId,
        parentId: effectiveParentId,
        role,
        content,
        toolName: toolName ?? null,
        metadata,
      })

      // ── Update the local graph mirror ───────────────────────────────────
      graphNodesRef.current = [
        ...graphNodesRef.current,
        { id: result.messageId, parent_id: effectiveParentId, role, content, created_at: Date.now().toString(), metadata },
      ]
      // A plain (non-forking) call advances the active path's tail. A
      // forking call (explicit parentId) leaves the tail alone — the
      // *next* linear call after a fork (e.g. persisting the AI reply
      // right after a forked user edit) still needs to chain off THIS
      // node though, so we always advance the tail to the node just
      // written; forking call sites explicitly re-anchor by passing
      // parentId again on their own next call rather than relying on this.
      tailDbIdRef.current = result.messageId

      // ── Reconcile onto the matching in-flight ChatMessage ───────────────
      setMessages(prev => prev.map(m =>
          clientId && m.id === clientId
            ? { ...m, dbId: result.messageId, parentDbId: effectiveParentId, persistenceStatus: 'saved' }
            : m
        ))

      if (!activeConversationIdRef.current) {
        // First message — a new conversation was created; update both ref + state
        activeConversationIdRef.current = result.conversationId
        setActiveConversationId(result.conversationId)
        localStorage.setItem(`rachna:active-chat:${chatScopeKey}`, result.conversationId)
        // Add to sidebar immediately without a full reload
        setAllConversations(prev =>
          prev.some(c => c.id === result.conversationId)
            ? prev
            : [{ id: result.conversationId, project_root: chatScopeKey,
                 title: content.slice(0, 60), created_at: '', updated_at: '', current_leaf_id: result.messageId },
               ...prev]
        )
      } else {
        // Appending to an already-active conversation — including one the
        // user just restored from the sidebar (e.g. an older chat that's
        // getting a new message right now). Bump it to the top of the list
        // and refresh its updated_at locally so it re-sorts into "Today"
        // immediately, instead of sitting wherever it was until the next
        // full refreshHistory() call.
        const nowMs = Date.now().toString()
        setAllConversations(prev => {
          const idx = prev.findIndex(c => c.id === activeConversationIdRef.current)
          if (idx === -1) return prev
          const bumped = { ...prev[idx], updated_at: nowMs, current_leaf_id: result.messageId }
          return [bumped, ...prev.slice(0, idx), ...prev.slice(idx + 1)]
        })
      }
        return result.messageId
      } catch (err) {
        lastError = err
      }
    }
    console.warn('[conversationMemory] persistMessage failed after retries:', lastError)
    if (clientId) {
      setMessages(prev => prev.map(m =>
        m.id === clientId ? { ...m, persistenceStatus: 'unsaved' } : m
      ))
    }
    setTimeout(() => retryPersistRef.current?.(role, msg, toolName, effectiveParentId), 5000)
    return null
  }, [chatScopeKey])

  /**
   * Public wrapper around persistMessageImpl — registers the in-flight
   * promise in pendingDbIdRef BEFORE awaiting anything, so a
   * persistMessageUpdate that fires moments later (before the DB
   * round-trip resolves) can find and await it instead of dropping the
   * update on the floor. See pendingDbIdRef's doc comment above.
   */
  const persistMessage = useCallback((
    role: 'user' | 'assistant' | 'tool',
    msg: ChatMessage | string,
    toolName?: string | null,
    parentId?: string | null
  ) => {
    const clientId = typeof msg === 'string' ? null : msg.id
    if (clientId) {
      setMessages(prev => prev.map(m =>
        m.id === clientId && !m.dbId ? { ...m, persistenceStatus: 'saving' } : m
      ))
    }
    const promise = persistenceQueueRef.current
      .then(() => persistMessageImpl(role, msg, toolName, parentId))
      .catch(err => {
        console.warn('[conversationMemory] queued persist failed:', err)
        return null
      })
    persistenceQueueRef.current = promise
    if (clientId) {
      pendingDbIdRef.current.set(clientId, promise)
      promise.finally(() => {
        // Only clear if nothing newer has replaced this entry.
        if (pendingDbIdRef.current.get(clientId) === promise) {
          pendingDbIdRef.current.delete(clientId)
        }
      })
    }
    return promise
  }, [persistMessageImpl])
  retryPersistRef.current = (role, msg, toolName, parentId) => {
    persistMessage(role, msg, toolName, parentId).catch(() => {/* retried by persistMessageImpl */})
  }

  /**
   * Builds the user's own chat bubble, appends it to `messages`, and
   * persists it — used to make the user's message show up on screen the
   * INSTANT they hit Send (or resolve a clarification), before any
   * classifier/planner call has even started. Every send path (Chat,
   * Design, Coding, Web, Agentic, ...) funnels through this single helper
   * so there is exactly one place the user-message bubble is ever built;
   * none of the downstream helpers below (doSend, presentDirectChatReply,
   * presentClarificationOrPlan, runIntentPlanner, presentOrAutoApprovePlan,
   * presentIntentPlan, presentPlanningFailedNotice) create their own —
   * they only ever take the resulting ChatMessage in and build/append the
   * ASSISTANT reply.
   */
  const appendUserMessage = useCallback((text: string, images: PendingChatImage[]): ChatMessage => {
    const userMsg: ChatMessage = {
      id: Date.now().toString(), role: 'user', name: 'You', initials: 'U',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: text,
      ...(images.length > 0
        ? { images: images.map(img => ({ previewUrl: img.previewUrl, mimeType: img.mimeType })) }
        : {}),
    }
    setMessages(prev => [...prev, userMsg])
    persistMessage('user', userMsg).catch(() => {/* already warned inside */})
    return userMsg
  }, [persistMessage])

  /**
   * Re-saves the `metadata` blob for a message that was ALREADY persisted
   * (has a `dbId`) and just changed in a way `extractMessageMetadata`
   * cares about — plan approval/step-status progress, a pending
   * login/toggle card's `resolved` flag, etc (CHAT-005). Unlike
   * `persistMessage`, this never creates a new graph node: it's an
   * in-place overwrite of one row's sidecar JSON, so the conversation's
   * tail/leaf and every other message are untouched. No-op (silently) for
   * a message that hasn't been persisted yet — nothing to update — since
   * its eventual first `persistMessage` call will already capture
   * whatever the current state is by then.
   */
  const enqueueMessageCheckpoint = useCallback((dbId: string, msg: ChatMessage) => {
    const metadata = extractMessageMetadata(msg)
    const previous = checkpointQueuesRef.current.get(dbId) ?? Promise.resolve()
    const next = previous.then(async () => {
      let lastError: unknown
      for (const delayMs of [0, 250, 1000]) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
        try {
          await dbUpdateMessage(dbId, msg.body, metadata)
          return
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    }).catch(err => {
      checkpointSignaturesRef.current.delete(dbId)
      console.warn('[conversationMemory] message checkpoint failed:', err)
    })
    checkpointQueuesRef.current.set(dbId, next)
    next.finally(() => {
      if (checkpointQueuesRef.current.get(dbId) === next) checkpointQueuesRef.current.delete(dbId)
    })
  }, [])

  const persistMessageUpdate = useCallback((msg: ChatMessage) => {
    const applyUpdate = (dbId: string) => {
      const metadata = extractMessageMetadata(msg)
      // Keep the in-memory graph mirror in sync too — pathToChatMessages
      // reads from it on every version-switch within this session, not
      // just after a fresh reload from SQLite.
      graphNodesRef.current = graphNodesRef.current.map(n =>
        n.id === dbId ? { ...n, metadata } : n
      )
      enqueueMessageCheckpoint(dbId, msg)
    }

    if (msg.dbId) {
      applyUpdate(msg.dbId)
      return
    }

    // Not persisted yet — this update would previously be dropped
    // silently. If a persistMessage() call for this same message is
    // already in flight (see pendingDbIdRef), wait for its dbId instead
    // of losing the update: this is exactly what happens with
    // auto-approved plans, where stepStatuses can change within
    // milliseconds of the plan card itself being created.
    const pending = pendingDbIdRef.current.get(msg.id)
    if (!pending) return
    pending.then(dbId => { if (dbId) applyUpdate(dbId) }).catch(() => {/* already warned inside persistMessage */})
  }, [enqueueMessageCheckpoint])

  persistVisibleMessageRef.current = (msg, isNew = false) => {
    if (isNew) persistMessage('assistant', msg).catch(() => {/* already warned inside */})
    else persistMessageUpdate(msg)
  }

  // Checkpoint every persisted message whenever its visible content changes.
  // Streaming is debounced to avoid one SQLite write per token; structural
  // transitions still call persistMessageUpdate directly and are immediate.
  useEffect(() => {
    for (const msg of messages) {
      if (!msg.dbId) continue
      const metadata = extractMessageMetadata(msg)
      const signature = `${msg.body}\u0000${metadata ?? ''}`
      if (checkpointSignaturesRef.current.get(msg.dbId) === signature) continue
      checkpointSignaturesRef.current.set(msg.dbId, signature)
      const previous = checkpointTimersRef.current.get(msg.dbId)
      if (previous) clearTimeout(previous)
      const timer = setTimeout(() => {
        checkpointTimersRef.current.delete(msg.dbId!)
        enqueueMessageCheckpoint(msg.dbId!, msg)
      }, 300)
      checkpointTimersRef.current.set(msg.dbId, timer)
    }
  }, [messages, enqueueMessageCheckpoint])

  useEffect(() => () => {
    for (const timer of checkpointTimersRef.current.values()) clearTimeout(timer)
    checkpointTimersRef.current.clear()
  }, [])

  // ── On scope change: reset chat state, then hydrate the right
  // conversation ───────────────────────────────────────────────────────
  // Each scope — a project, or the "no project open" scope — has its own
  // isolated chat history, keyed by chatScopeKey. Whenever it changes we:
  //   1. Immediately clear any chat from the previous scope (no stale carry-over).
  //   2. Hydrate a specific pending conversation if one was explicitly
  //      requested (a sidebar click via restoreConversation). Otherwise,
  //      auto-load this scope's most recently updated conversation (if
  //      any) so a full app close/reopen (or reselecting an already-open
  //      folder) doesn't strand the user on a blank chat — every restored
  //      message's full CHAT-005 metadata (classifier "AI call" chips,
  //      the generated IntentPlan/Task Planner card, step statuses, etc.)
  //      comes back exactly as extractMessageMetadata saved it, via
  //      pathToChatMessages/parseMessageMetadata below. Only a genuinely
  //      empty scope (no prior conversations at all) opens on a fresh,
  //      empty chat.
  //   3. Refresh the sidebar's full cross-scope conversation list.
  // This runs even when projectRoot is null — chats from the welcome screen
  // persist under NO_PROJECT_KEY just like any project's chats do.
  useEffect(() => {
    // Reset immediately so the user never sees the previous scope's messages
    // while the async DB load is in flight.
    setChatHydrated(false)
    activeConversationIdRef.current = null
    setActiveConversationId(null)
    compactionPassRef.current = 0
    lastCompactionRef.current = null
    resumeStatesRef.current.clear()
    graphNodesRef.current = []
    tailDbIdRef.current = null

    let cancelled = false
    ;(async () => {
      try {
        let restoreId = pendingRestoreIdRef.current
        pendingRestoreIdRef.current = null

        if (!restoreId) {
          // No explicit sidebar request — fall back to this scope's most
          // recently updated conversation, if it has one, so a relaunch of
          // the app (or reopening the same folder) resumes right where the
          // user left off instead of always starting fresh.
          const scopeConversations = await listConversations(chatScopeKey)
          if (cancelled) return
          const remembered = localStorage.getItem(`rachna:active-chat:${chatScopeKey}`)
          restoreId = remembered && scopeConversations.some(c => c.id === remembered)
            ? remembered
            : scopeConversations[0]?.id ?? null
        }

        if (restoreId) {
          const { conversation, messages: nodes } = await loadConversationById(restoreId, 100)
          if (cancelled) return
          activeConversationIdRef.current = restoreId
          setActiveConversationId(restoreId)
          localStorage.setItem(`rachna:active-chat:${chatScopeKey}`, restoreId)
          graphNodesRef.current = nodes as GraphNode[]
          const leaf = conversation?.current_leaf_id ?? (nodes.length ? nodes[nodes.length - 1].id : null)
          tailDbIdRef.current = leaf
          setMessages(pathToChatMessages(buildPathToLeaf(nodes as GraphNode[], leaf)))
        }
        // No restoreId and no existing conversation for this scope ⇒
        // genuinely fresh — leave the empty chat state set above.

        // Refresh the full cross-scope list (all projects + no-project scope)
        const list = await listAllConversations()
        if (!cancelled) setAllConversations(list)
      } catch (err) {
        console.warn('[conversationMemory] hydration failed:', err)
      } finally {
        if (!cancelled) setChatHydrated(true)
      }
    })()
    return () => { cancelled = true }
  }, [chatScopeKey])

  // ── Repo Context chip: auto-enable once indexing finishes ────────────────
  // A freshly-opened project starts with the chip OFF (see
  // useRepoContextModeStore's default). Once that project's index finishes
  // ('ready'), flip the chip ON automatically — the repo is now actually
  // searchable, so there's no reason to keep answering generically — and
  // relabel it "With Repo Context". `autoFlipRef` records which project
  // root we've already auto-flipped for, so this only fires once per
  // project open (not on every re-render while status stays 'ready'), and
  // `suppressNextToggleNoticeRef` tells the manual-toggle-notice effect
  // below to skip its own generic message this one time, since we post a
  // more specific one here instead.
  const autoFlipRef = useRef<string | null>(null)
  const suppressNextToggleNoticeRef = useRef(false)
  const repoContextNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showRepoContextNotice = useCallback((text: string) => {
    setRepoContextNotice(text)
    if (repoContextNoticeTimerRef.current) clearTimeout(repoContextNoticeTimerRef.current)
    repoContextNoticeTimerRef.current = setTimeout(() => setRepoContextNotice(null), 8000)
  }, [])

  useEffect(() => {
    if (!projectRoot) {
      autoFlipRef.current = null
      return
    }
    if (
      indexStatus === 'ready' &&
      autoFlipRef.current !== projectRoot &&
      !useRepoContextModeStore.getState().repoContextEnabled
    ) {
      autoFlipRef.current = projectRoot
      suppressNextToggleNoticeRef.current = true
      useRepoContextModeStore.getState().setRepoContextEnabled(true)
      showRepoContextNotice('Repository indexed — chat switched to "With Repo Context".')
    }
  }, [projectRoot, indexStatus, showRepoContextNotice])

  // ── Repo Context chip: warn on every state change ────────────────────────
  // Fires for BOTH manual toggles (user clicked the chip) and the
  // automatic flip above, so the chip's behavior is never a silent change.
  // The automatic case already posted its own specific notice just above,
  // so it's skipped here via suppressNextToggleNoticeRef to avoid a
  // duplicate/generic message overwriting it.
  const repoContextEnabledForNotice = useRepoContextModeStore(s => s.repoContextEnabled)
  const repoContextNoticeMountedRef = useRef(false)
  useEffect(() => {
    if (!repoContextNoticeMountedRef.current) {
      // Skip the notice on first mount — this just reflects the persisted/
      // default value loading in, not a change the user made.
      repoContextNoticeMountedRef.current = true
      return
    }
    if (suppressNextToggleNoticeRef.current) {
      suppressNextToggleNoticeRef.current = false
      return
    }
    showRepoContextNotice(
      repoContextEnabledForNotice
        ? 'Repo Context turned ON — this chat will use your project (summary, retrieval, rules).'
        : 'Repo Context turned OFF — requests will be treated as fresh; no project context will be sent.'
    )
  }, [repoContextEnabledForNotice, showRepoContextNotice])

  /**
   * Restore a past conversation (called from the sidebar). If it's in the
   * scope that's already active, this hydrates it directly. If it belongs
   * to a different project (or the no-project scope), it hands off to
   * `onSwitchProject` first — the hydration effect above then picks it up
   * once chatScopeKey lands on that scope.
   */
  const restoreConversation = useCallback(async (conversation: Conversation) => {
    if (streaming) return

    if (conversation.project_root !== chatScopeKey) {
      if (!onSwitchProject) {
        console.warn('[conversationMemory] restoreConversation: cross-scope switch requested but no onSwitchProject handler was provided')
        return
      }
      pendingRestoreIdRef.current = conversation.id
      onSwitchProject(conversation.project_root === NO_PROJECT_KEY ? null : conversation.project_root)
      return
    }

    try {
      const { conversation: loadedConv, messages: nodes } = await loadConversationById(conversation.id, 100)
      graphNodesRef.current = nodes as GraphNode[]
      const leaf = loadedConv?.current_leaf_id ?? (nodes.length ? nodes[nodes.length - 1].id : null)
      tailDbIdRef.current = leaf
      activeConversationIdRef.current = conversation.id
      setActiveConversationId(conversation.id)
      localStorage.setItem(`rachna:active-chat:${conversation.project_root}`, conversation.id)
      setMessages(pathToChatMessages(buildPathToLeaf(nodes as GraphNode[], leaf)))
      setInput('')
      setFailoverNotice(null)
      compactionPassRef.current = 0
      lastCompactionRef.current = null
      resumeStatesRef.current.clear()
      setChatOpen(true)
      // Activity Bar state (Plan Mode, todo list) is per-conversation and
      // isn't persisted to SQLite, so it must be reset when switching chats
      // rather than left over from whichever conversation was open before.
      // Reset to Auto-Approve (planMode false) to match the app-wide
      // default — see handleNewChat below and the initial useState(false)
      // for this same flag. The specialist chip is a standing preference,
      // not per-conversation, so it's intentionally left as-is here.
      setPlanMode(false)
      useTodoStore.getState().clear()
    } catch (err) {
      console.warn('[conversationMemory] restoreConversation failed:', err)
    }
  }, [streaming, chatScopeKey, onSwitchProject])

  /** Delete a conversation (sidebar trash icon).
   *  Optimistically removes from local state immediately, then confirms via
   *  the Tauri invoke. If the invoke fails the row is restored to the list.
   */
  const handleDeleteConversation = useCallback(async (conversationId: string) => {
    // Optimistic remove — list feels instant
    let removedConv: Conversation | undefined
    setAllConversations(prev => {
      removedConv = prev.find(c => c.id === conversationId)
      return prev.filter(c => c.id !== conversationId)
    })

    // If the deleted conversation was active, reset to blank immediately
    const wasActive = activeConversationIdRef.current === conversationId
    if (wasActive) {
      activeConversationIdRef.current = null
      setActiveConversationId(null)
      setMessages([])
      compactionPassRef.current = 0
      lastCompactionRef.current = null
      resumeStatesRef.current.clear()
    }

    try {
      await deleteConversation(conversationId)
    } catch (err) {
      console.warn('[conversationMemory] deleteConversation failed:', err)
      // Rollback the optimistic remove
      if (removedConv) {
        setAllConversations(prev => {
          const alreadyThere = prev.some(c => c.id === conversationId)
          if (alreadyThere) return prev
          // Re-insert in sorted order (newest first by updated_at)
          return [removedConv!, ...prev].sort((a, b) =>
            Number(b.updated_at) - Number(a.updated_at)
          )
        })
      }
    }
  }, [])

  // ── Textarea auto-resize ───────────────────────────────────────────────────
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  // ── Shared agent-loop runner (fresh turns + resumed turns) ────────────────
  // Handles key failover and, on failure, stashes any resumable conversation
  // state from AgentLoop so a later "Continue" click can pick up exactly
  // where the turn left off instead of restarting it.
  const runAgentTurnWithFailover = useCallback(async (params: {
    aiId:              string
    conversation:      unknown[]
    ctx:               ToolContext
    systemInstruction: string
    model:             string | undefined
    controller:        AbortController
    thisGeneration:    number
    /** Scopes which built-in tools get sent this turn — see AgentLoopOptions.intent. */
    intent?:           ChatIntent
    /** Further narrows the tool set within `intent` — see AgentLoopOptions.subIntent. */
    subIntent?:        AgentSubIntent
  }): Promise<void> => {
    const { aiId, conversation, ctx, systemInstruction, model, controller, thisGeneration, intent, subIntent } = params
    const store = useApiKeyStore.getState()
    let currentKeyRecord = store.getActiveKey(activeProviderId)
    if (!currentKeyRecord?.value) return

    const tryWithKey = async (keyValue: string, msgs: unknown[]): Promise<void> => {
      await runAgentLoop(
        provider!,
        keyValue,
        msgs,
        ctx,
        {
          onActivityStart: (activity: AgentActivity) => {
            if (generationIdRef.current !== thisGeneration) return
            setMessages(prev =>
              prev.map(m =>
                m.id === aiId
                  ? { ...m, agentActivities: [...(m.agentActivities ?? []), activity] }
                  : m
              )
            )
          },
          onActivityEnd: (activityId: string, status: 'done' | 'error', resultSummary: string, artifact?: AgentActivityArtifact) => {
            if (generationIdRef.current !== thisGeneration) return
            setMessages(prev =>
              prev.map(m =>
                m.id === aiId
                  ? {
                      ...m,
                      agentActivities: (m.agentActivities ?? []).map(a =>
                        a.id === activityId ? { ...a, status, result: resultSummary, ...(artifact ? { artifact } : {}) } : a
                      ),
                    }
                  : m
              )
            )
          },
          onAiCallUpdate: (activityId: string, response: string) => {
            if (generationIdRef.current !== thisGeneration) return
            setMessages(prev =>
              prev.map(m =>
                m.id === aiId
                  ? {
                      ...m,
                      agentActivities: (m.agentActivities ?? []).map(a =>
                        a.id === activityId && a.aiCall
                          ? { ...a, aiCall: { ...a.aiCall, response } }
                          : a
                      ),
                    }
                  : m
              )
            )
          },
          onChunk: (chunk: string) => {
            if (generationIdRef.current !== thisGeneration) return
            setMessages(prev =>
              prev.map(m => m.id === aiId ? { ...m, body: m.body + chunk } : m)
            )
          },
          onBlockedSetting: (settingKey: GitSettingKey, label: string) => {
            if (generationIdRef.current !== thisGeneration) return
            setMessages(prev =>
              prev.map(m =>
                m.id === aiId
                  ? { ...m, pendingToggle: { settingKey, label, resolved: false } }
                  : m
              )
            )
            // AUTO-002: state the required action directly rather than a
            // generic "needs your approval" — the user should know exactly
            // what to do (flip the setting) without opening the app first.
            // Plain nudge (not nudgeWithActions): unlike a terminal
            // permission request, there's no single global "pending
            // request" this could resolve to — it's tracked per-message
            // (pendingToggle above) — so a real notification button isn't
            // wired up here, just a text nudge back to the app.
            nudge(
              'Rachna AI Studio needs your approval',
              `The agent needs "${label}" enabled to continue. (Enable)`,
            )
          },
          onDone: () => {
            resumeStatesRef.current.delete(aiId)
            if (generationIdRef.current !== thisGeneration) return
            setStreaming(false)
            streamingIdRef.current = null
          },
          onError: async (err: Error, resumeState?: unknown[]) => {
            if (generationIdRef.current !== thisGeneration) return
            if (provider!.isQuotaError(err) && currentKeyRecord) {
              const nextKey = store.failoverKey(activeProviderId, currentKeyRecord.id)
              if (nextKey) {
                store.notifyActiveKey(nextKey.id)
                currentKeyRecord = nextKey
                setFailoverNotice(`Key exhausted → switched to ${nextKey.label}`)
                await tryWithKey(nextKey.value, resumeState ?? msgs)
                return
              }
            }
            // Real (non-recoverable-by-failover) error — e.g. a request
            // timeout. If prior steps in this turn already succeeded,
            // AgentLoop hands back the conversation up to that point; stash
            // it so the user can resume instead of starting the turn over.
            if (resumeState?.length) {
              resumeStatesRef.current.set(aiId, { conversation: resumeState, ctx, systemInstruction, model, intent, subIntent })
            } else {
              resumeStatesRef.current.delete(aiId)
            }
            setMessages(prev =>
              prev.map(m =>
                m.id === aiId
                  ? { ...m, body: m.body + `\n⚠ Error: ${err.message}`, resumable: !!resumeState?.length }
                  : m
              )
            )
            setStreaming(false)
            streamingIdRef.current = null
          },
        },
        { systemInstruction, model, signal: controller.signal, intent, subIntent }
      )
    }

    await tryWithKey(currentKeyRecord.value, conversation)
  }, [activeProviderId, provider])

  /**
   * Resumes a turn that previously failed mid-way. Picks up the saved
   * conversation state (which already includes every tool call/result that
   * succeeded before the failure) and continues the same AI message rather
   * than starting a fresh user turn.
   */
  const handleContinue = useCallback((msgId: string) => {
    if (streaming || !provider) return
    const saved = resumeStatesRef.current.get(msgId)
    if (!saved) return

    resumeStatesRef.current.delete(msgId)

    // Strip the trailing "⚠ Error: ..." line we appended, and clear the
    // resumable flag while the continuation is in flight.
    setMessages(prev =>
      prev.map(m =>
        m.id === msgId
          ? { ...m, body: m.body.replace(/\n?⚠ Error:.*$/s, ''), resumable: false }
          : m
      )
    )
    setStreaming(true)
    streamingIdRef.current = msgId
    setFailoverNotice(null)

    abortRef.current?.abort()
    const controller     = new AbortController()
    abortRef.current     = controller
    const thisGeneration = ++generationIdRef.current

    runAgentTurnWithFailover({
      aiId:              msgId,
      conversation:      saved.conversation,
      ctx:               saved.ctx,
      systemInstruction: saved.systemInstruction,
      model:             saved.model,
      controller,
      thisGeneration,
      intent:            saved.intent,
      subIntent:         saved.subIntent,
    }).then(() => {
      setMessages(prev => {
        const aiMessage = prev.find(m => m.id === msgId)
        if (aiMessage) persistMessageUpdate(aiMessage)
        return prev
      })
    })
  }, [streaming, provider, runAgentTurnWithFailover, persistMessageUpdate])

  // ── Core send logic ────────────────────────────────────────────────────────
  // Extracted so it can be called from both handleSend and handleRetry.
  const sendTurn = useCallback(async (opts: {
    question:       string
    priorMessages:  ChatMessage[]   // messages to include as history
    aiId:           string
    thisGeneration: number
    controller:     AbortController
    images?:        PendingChatImage[]
    /**
     * Gates the repo-context retrieval pipeline. Only steps/turns tagged
     * CODING → Work With Repo actually need repo context — a plain CHAT
     * turn, a BUILD_NEW/BROWSER_TASK/DESKTOP_TASK turn, a retry, or an edited
     * message doesn't touch the index at all. Defaults to false: repo
     * context is opt-in per call site (see the explicit
     * `step.intent === 'work_with_repo'` check in the step executor below),
     * not something every turn gets unless it's turned off.
     */
    needsRepoContext?: boolean
    /** Classified intent for this turn — scopes which tools get sent (see AgentLoopOptions.intent). */
    intent?: ChatIntent
    /** Further narrows the tool set within `intent` — see AgentLoopOptions.subIntent. */
    subIntent?: AgentSubIntent
  }) => {
    // Repo Context chip (see ChatHeader/useRepoContextModeStore): OFF forces
    // this turn to skip repo context entirely, regardless of what the
    // caller requested — same as if no project were open.
    const { question, priorMessages, aiId, thisGeneration, controller, images, needsRepoContext: needsRepoContextRequested = false, intent, subIntent } = opts
    const needsRepoContext = needsRepoContextRequested && repoContextEnabled

    const store = useApiKeyStore.getState()
    let currentKeyRecord = store.getActiveKey(activeProviderId)
    if (!currentKeyRecord?.value) return

    // ── Environment detection (OS + shell) ────────────────────────────────────
    const systemInfo = await getSystemInfo()

    // ── Project-scoped custom rules (.rachna/rules.md / AGENTS.md) ────────────
    // Skipped entirely when the Repo Context chip is off — project rules
    // are repo context.
    const rulesResult = repoContextEnabled ? await loadProjectRules(projectRoot) : { text: null, sources: [] }
    // Keep MCP server/tool details out of every non-MCP prompt. The planner
    // must first produce an MCP_TASK executor step before the AI sees them.
    const mcpToolsSection = intent === 'mcp_task' ? getMcpToolsSection() : null

    // ── Conversation memory: rejected-edit summary ────────────────────────────
    // Load the last 3 rejected edits so the system prompt can remind the agent
    // not to repeat them. Silently skipped if DB is unavailable, and skipped
    // entirely when the Repo Context chip is off.
    let rejectedEdits: Array<{ file_path: string; description: string }> | null = null
    if (projectRoot && repoContextEnabled) {
      try {
        rejectedEdits = await getRejectedEdits(projectRoot, 3)
      } catch {
        // non-fatal — agent still works without memory
      }
    }

    // ── Build editor context metadata (paths only — no file content) ─────────
    // The current file path and open tab paths are passed to runRetrieval as
    // ranking signals. They boost retrieval scores for relevant files without
    // injecting raw content into every prompt.
    const editorContextMeta = {
      currentFilePath: context.filePath,
      openFilePaths:   [], // populated from editor store inside useRetrieval
    }

    // ── Retrieval ────────────────────────────────────────────────────────────
    // Only run the repo-context pipeline (FTS → symbols → graph expansion)
    // when the turn actually needs it — i.e. intent classification decided
    // this is WORK_WITH_REPO. A plain chat turn skips straight to an empty
    // result set so it never pays the retrieval cost or pollutes the prompt
    // with irrelevant repo context.
    const { repoContextBlock, symbolContextBlock, graphContextBlock, semanticContextBlock, stats } =
      needsRepoContext
        ? await runRetrieval(question, editorContextMeta)
        : {
            repoContextBlock:     '',
            symbolContextBlock:   '',
            graphContextBlock:    '',
            semanticContextBlock: '',
            stats: {
              originalQuery:        question,
              sanitizedQuery:       question,
              extractedTerms:       '',
              chunksFound:          0,
              symbolsFound:         0,
              filesRetrieved:       [],
              usedFilenameFallback: false,
              noContextFound:       true,
              searchMode:           undefined,
            },
          }

    // Only attach retrieval stats to the message when this turn actually
    // ran the repo-context pipeline. A plain CHAT turn (needsRepoContext
    // false) never touched the index, so surfacing its placeholder
    // "noContextFound" stats would incorrectly show a repo-context
    // warning/prompt on a normal conversational reply.
    if (needsRepoContext) {
      setMessages(prev =>
        prev.map(m => m.id === aiId ? { ...m, retrieval: stats } : m)
      )
    }

    // ── Prompt assembly ──────────────────────────────────────────────────────
    // Collect any verification failures from the most recently accepted edit
    // (build / test / lint) and surface them to the agent automatically.
    const { buildResults, testResults, lintResults, verificationNudges, edits } = useEditStore.getState()
    const lastAccepted = [...edits]
      .reverse()
      .find(e => e.status === 'accepted')
    const verificationParts: string[] = []
    if (lastAccepted) {
      // Build/test verification for a batch (or "accept all") merge is keyed
      // by the batchId / 'accept-all' sentinel, NOT the individual edit id —
      // check every key this accepted edit could have been merged under so
      // batch results actually reach the agent instead of being silently
      // dropped.
      const candidateKeys = Array.from(
        new Set([lastAccepted.id, lastAccepted.batchId, 'accept-all'].filter(Boolean) as string[])
      )
      for (const key of candidateKeys) {
        const br = buildResults[key]
        const tr = testResults[key]
        const lr = lintResults[key]
        if (br?.agentContext)   verificationParts.push(br.agentContext)
        if (tr?.agentContext)   verificationParts.push(tr.agentContext)
        if (lr?.agentContext)   verificationParts.push(lr.agentContext)
      }
      // Mandatory execution/verification nudge for frontend/backend files
      // that were just merged (see services/agent/postMergeVerification.ts).
      // Only surfaced once per merge — dedup in case both a batchId and the
      // 'accept-all' key resolved to the same nudge text.
      const seenNudges = new Set<string>()
      for (const key of candidateKeys) {
        const nudge = verificationNudges[key]
        if (nudge && !seenNudges.has(nudge)) {
          seenNudges.add(nudge)
          verificationParts.push(nudge)
        }
      }
    }
    const rawVerificationContext = verificationParts.length > 0
      ? verificationParts.join('\n\n')
      : undefined

    // ── Context Compression ──────────────────────────────────────────────────
    const compressionBudgets = getBudgetsForModel(selectedModel ?? '')
    const compressed = compressContext({
      activeFileContent:   undefined,
      activeFileLanguage:  context.language,
      repoContextBlock,
      symbolContextBlock,
      graphContextBlock,
      semanticContextBlock,
      chatHistory:         buildConversationHistory(priorMessages),
      verificationContext: rawVerificationContext,
      budgets:             compressionBudgets,
    })

    // Attach compression metrics to the AI message for optional display
    setMessages(prev =>
      prev.map(m =>
        m.id === aiId
          ? { ...m, compressionMetrics: compressed.metrics }
          : m
      )
    )

    const verificationContext = compressed.verificationContext || undefined

    // ── Multi-folder context (composite tasks across several repos) ──────────
    // Primary project's display name — used to label its retrieved-context
    // block as "Repo Context for Folder 1: <name>" once other folders are
    // in play (see assembleUserPrompt). Mirrors the name derivation in
    // FileExplorer.tsx.
    const primaryFolderName = projectRoot
      ? projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      : undefined

    // Additional folders added via the File Explorer's "Add Folder" button
    // (store/useAdditionalFoldersStore.ts) — each gets its own labeled
    // directory-listing block so the model can see what's in every
    // folder and use read_file/list_directory (absolute paths) to dig into
    // whichever one the task actually needs. Skipped entirely when the
    // Repo Context chip is off, same as the primary project's context.
    let additionalFoldersContext: string | undefined
    if (needsRepoContext) {
      const extraFolders = useAdditionalFoldersStore.getState().folders
      if (extraFolders.length > 0) {
        additionalFoldersContext = extraFolders
          .map((f, i) => {
            const treeText = buildFolderTreeText(f.root)
            return `Repo Context for Folder ${i + 2}: ${f.name} (${f.path}):\n${treeText}`
          })
          .join('\n\n')
      }
    }

    // Build prompt — context object carries only path metadata, not content
    const fullPrompt = assembleUserPrompt({
      question,
      context,
      repoContextBlock:      compressed.repoContextBlock,
      symbolContextBlock:    compressed.symbolContextBlock,
      graphContextBlock:     compressed.graphContextBlock,
      semanticContextBlock:  compressed.semanticContextBlock,
      verificationContext,
      primaryFolderName,
      additionalFoldersContext,
    })

    // ── Conversational context ─────────────────────────────────────────────
    // Build the slice of history actually sent with this request: the last
    // N user/assistant turns, with every user prompt kept verbatim and every
    // assistant reply (except the most recent) collapsed into a concise
    // summary — decisions, actions, tool/file results, and anything left
    // unresolved — rather than resending the full response text. This keeps
    // follow-up turns grounded without the per-request cost of full history,
    // and works alongside (in front of) the token-threshold-based
    // compaction above, which still guards against very long conversations.
    const history = provider!.toInternalMessages(compressed.chatHistory)

    const finalUserMessages = provider!.toInternalMessages([{ role: 'user', content: fullPrompt }])
    if (images?.length && provider!.supportsVision()) {
      const pendingImages = images.map(img => ({ base64: img.base64, mimeType: img.mimeType }))
      // Re-derive with images attached (provider-specific embedding happens inside toInternalMessages).
      const withImages = provider!.toInternalMessages([
        { role: 'user', content: fullPrompt, images: pendingImages },
      ])
      finalUserMessages.splice(0, finalUserMessages.length, ...withImages)
    }

    const newMessages = [
      ...history,
      ...finalUserMessages,
    ]

    // ── Build the agent context + system prompt for this turn ────────────────
    const gitSettings = useGitSettingsStore.getState().snapshot()
    const todoContext = formatTodosForPrompt(useTodoStore.getState().todos)
    const { requestPermission, isSessionApproved } = useTerminalPermissionStore.getState()
    const requestTerminalPermission = async (command: string) => {
      if (isSessionApproved(command)) return 'approve' as const
      return requestPermission(command)
    }
    const openDiskViewer = useDiskViewerStore.getState().open
    // Pauses agent execution and shows the in-app BrowserPreferenceModal
    // (mounted in AiChat.tsx) rather than a blocking window.prompt(), so
    // openDefaultBrowserTool genuinely waits on the user's choice — see
    // store/useBrowserPreferenceStore.ts.
    const requestBrowserPreference = () => useBrowserPreferenceStore.getState().requestPreference()

    // ── open_project_folder callback ─────────────────────────────────────────
    // Wired here (not in IDELayout) because it needs closure access to the
    // same `indexFolder` / `closeProject` stores the rest of sendTurn uses.
    // Passed into ToolContext so the open_project_folder tool can trigger a
    // full workspace switch (unload current → load new → wait for ready)
    // without the tool layer ever touching React or Zustand directly.
    const openProjectFolder = async (path: string | null): Promise<string | null> => {
      // If no path supplied, show a native folder-picker dialog.
      let folderPath: string | null = path
      if (!folderPath) {
        const picked = await openFolder()
        folderPath = picked ? picked.path : null
      }
      if (!folderPath) return null   // user cancelled

      // Unload the current workspace, then index the new folder.
      useRepoIndex.getState().closeProject()
      await useRepoIndex.getState().indexFolder(folderPath)

      // Block until indexing reaches 'ready' — subsequent agent steps may
      // need the index, so the tool must not resolve before it's done.
      const sentinel = new AbortController()
      await waitForIndexReady(sentinel.signal)

      // Return the canonical root the scan settled on (may differ from
      // folderPath if the Rust scanner normalised the path).
      return useRepoIndex.getState().projectRoot
    }

    const ctx: ToolContext = { projectRoot, systemInfo, gitSettings, requestTerminalPermission, requestBrowserPreference, openDiskViewer, openProjectFolder }
    // Two-stage pipeline: system info is only actually described to the
    // model for AGENTIC_TASK turns (plus RUN_PROJECT/TERMINAL_TASK, which
    // can't work without knowing the shell) — see intentNeedsSystemInfo.
    // `ctx.systemInfo` above is still always populated/available for tool
    // execution itself; this only controls whether it's SENT in the prompt.
    const includeSystemInfo = intentNeedsSystemInfo(intent, subIntent)
    const systemInstruction = buildSystemPrompt(systemInfo, { intent, subIntent, projectRules: rulesResult.text, mcpToolsSection, rejectedEdits, todoContext, repoSummary: repoContextEnabled ? buildRepoSummarySection(scanResult) : null, includeSystemInfo })

    await runAgentTurnWithFailover({
      aiId,
      conversation: newMessages,
      ctx,
      systemInstruction,
      model: selectedModel,
      controller,
      thisGeneration,
      intent,
      subIntent,
    })
  }, [activeProviderId, context, projectRoot, provider, selectedModel, runRetrieval, runAgentTurnWithFailover, repoContextEnabled, persistMessage])

  // ── doSend ───────────────────────────────────────────────────────────────
  // The actual "send this text to the agent" logic, extracted so it can be
  // invoked either directly (handleSend, once a project is open / intent
  // is CHAT) or automatically once a folder is created/opened as a result
  // of intent classification routing a BUILD_NEW / WORK_WITH_REPO request.
  //
  // The user-facing ChatMessage bubble is NOT created here any more — it's
  // created and appended/persisted immediately at the top of handleSend
  // (see appendUserMessage there), before refinement or planning ever
  // runs, so the user sees their own message the instant they hit Send.
  // This function only ever builds and appends the ASSISTANT reply.
  const doSend = useCallback(async (
    text: string,
    images: PendingChatImage[] = [],
    opts: { needsRepoContext?: boolean; intent?: ChatIntent; subIntent?: AgentSubIntent; initialActivity?: AgentActivity } = {},
  ) => {
    if ((!text && images.length === 0) || streaming || !provider) return

    const aiId = (Date.now() + 1).toString()

    const aiMsg: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: '',
      ...(opts.initialActivity ? { agentActivities: [opts.initialActivity] } : {}),
    }

    if (images.length > 0 && !provider.supportsVision()) {
      aiMsg.body = `${provider.displayName} does not currently support image input. Select a vision-capable direct provider to send images.`
      setMessages(prev => [...prev, aiMsg])
      persistMessage('assistant', aiMsg).catch(() => {/* already warned inside */})
      return
    }

    // ── Conversation Compaction ─────────────────────────────────────────────
    // Check if the current chat history exceeds the threshold BEFORE sending.
    // If so, compact older messages into a summary and increment pass counter.
    let priorMessages = messages  // snapshot before state update
    if (shouldCompact(messages, selectedModel ?? '')) {
      const result = compactConversation(messages, selectedModel ?? '', compactionPassRef.current)
      if (result.compacted) {
        const visibleIds = new Set(result.messages.map(m => m.id))
        for (const oldMessage of messages) {
          if (!visibleIds.has(oldMessage.id) && oldMessage.dbId) {
            persistMessageUpdate({ ...oldMessage, hiddenByCompaction: true })
          }
        }
        const summary = result.messages.find(m => m.id.startsWith('compaction-'))
        if (summary && !summary.dbId) {
          summary.isCompactionSummary = true
          summary.compactionKeptMessageIds = result.messages
            .filter(m => m.id !== summary.id)
            .map(m => m.id)
          persistMessage('assistant', summary).catch(() => {/* already warned inside */})
        }
        priorMessages          = result.messages
        compactionPassRef.current = result.metadata.passNumber
        lastCompactionRef.current = result.metadata
        setMessages(result.messages)
        console.info(
          `[compaction] Auto-compacted: saved ~${result.metadata.tokensSaved.toLocaleString()} tokens` +
          ` (${result.metadata.savingsPct}%)`
        )
      }
    }

    setMessages(prev => [...prev, aiMsg])
    persistMessage('assistant', aiMsg)
      .then(msgId => { if (msgId) lastAssistantMessageIdRef.current = msgId })
      .catch(() => {/* already warned inside */})
    setStreaming(true)
    streamingIdRef.current = aiId
    setFailoverNotice(null)

    abortRef.current?.abort()
    const controller      = new AbortController()
    abortRef.current      = controller
    const thisGeneration  = ++generationIdRef.current

    // Input was already cleared by handleSend, immediately after the user
    // message was appended/persisted — nothing left to do here for it.

    await sendTurn({
      question: text,
      priorMessages,
      aiId,
      thisGeneration,
      controller,
      images,
      needsRepoContext: opts.needsRepoContext,
      intent: opts.intent,
      subIntent: opts.subIntent,
    })

    // ── Persist assistant response once streaming completes ────────────────
    // Read the final body from state after sendTurn resolves (streaming done).
    setMessages(prev => {
      const aiMessage = prev.find(m => m.id === aiId)
      if (aiMessage) persistMessageUpdate(aiMessage)
      return prev
    })
  }, [streaming, provider, messages, selectedModel, sendTurn, persistMessage, persistMessageUpdate])

  // ── Intent-based Task Planner layer ─────────────────────────────────────
  // Shows the intent-tagged step plan generated for an AGENTIC
  // classification (see lib/agenticClassifier.ts / lib/planGenerator.ts) as
  // an IntentPlanCard instead of calling doSend/sendTurn right away — the
  // user approves or asks for changes before ANY tool call fires. Once approved,
  // execution proceeds directly through TaskExecutor on the already
  // intent-tagged step list — this only changes what happens BEFORE
  // execution starts.
  // `userMsg` is the ChatMessage already appended/persisted by the caller
  // (handleSend's appendUserMessage, or resolveClarification's equivalent)
  // — this function only ever builds and appends the ASSISTANT plan card.
  const presentIntentPlan = useCallback((
    text:             string,
    images:           PendingChatImage[],
    steps:            ExecutionStep[],
    userMsg:          ChatMessage,
    topIntent:        Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
    initialActivities: AgentActivity[] = [],
  ): string => {
    if (!provider) return ''
    const aiId = (Date.now() + 1).toString()
    const intentPlan: IntentPlan = { steps }
    const aiMsg: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      // No raw plan narrative to show — the planner's entire output is the
      // structured step list rendered by IntentPlanCard below.
      body: `Proposed a ${steps.length}-step plan.`,
      intentPlan,
      planApproved: false,
      ...(initialActivities.length ? { agentActivities: initialActivities } : {}),
    }
    // Remembered so approvePlan()/modifyPlan() below can hand the original
    // question AND the generated plan itself to the step executor once the
    // user acts on the card. Stashing intentPlan here (a ref, updated
    // synchronously) rather than relying on approvePlan reading it back out
    // of the `messages` state is what makes auto-approval race-free — see
    // the PlanContext.intentPlan doc comment above.
    planContextRef.current.set(aiId, { originalText: text, topIntent, intentPlan })
    void userMsg // already appended/persisted by the caller — nothing to do with it here
    setMessages(prev => [...prev, aiMsg])
    persistMessage('assistant', aiMsg).catch(() => {/* already warned inside */})
    return aiId
  }, [provider, persistMessage])

  /**
   * PLAN-001: shown in place of the plan card when the Agentic Classifier
   * (see lib/agenticClassifier.ts) decided this message is AGENTIC but
   * generateExecutionPlan didn't actually come back with a valid, non-empty
   * intent-tagged step list. Planning must never be silently skipped in
   * this case, so this stops the turn here — with an explanation — instead
   * of falling through to doSend/execution without a plan. Independent of
   * the Plan Mode toggle: this is a "planning failed" state, not an
   * approval decision, and there is no fallback that executes the raw
   * request instead.
   */
  const presentPlanningFailedNotice = useCallback((text: string, images: PendingChatImage[], userMsg: ChatMessage, activities: AgentActivity[] = []) => {
    if (!provider) return
    void text; void images // already reflected in userMsg, appended/persisted by the caller
    const aiId = (Date.now() + 1).toString()
    const aiMsg: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: "This needs an execution plan before I can proceed, but I wasn't able to put one together. Nothing has been run. Please try rephrasing the request or sending it again.",
      ...(activities.length ? { agentActivities: activities } : {}),
    }
    void userMsg
    setMessages(prev => [...prev, aiMsg])
    persistMessage('assistant', aiMsg).catch(() => {/* already warned inside */})
  }, [provider, persistMessage])

  const presentDirectChatReply = useCallback((
    userMsg:          ChatMessage,
    chatReply:        string,
    initialActivity?: AgentActivity | AgentActivity[],
  ): void => {
    if (!provider) return
    void userMsg // already appended/persisted by the caller (handleSend)
    const activities = !initialActivity ? [] : Array.isArray(initialActivity) ? initialActivity : [initialActivity]
    const aiId = (Date.now() + 1).toString()
    const aiMsg: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: chatReply,
      ...(activities.length ? { agentActivities: activities } : {}),
    }
    setMessages(prev => [...prev, aiMsg])
    persistMessage('assistant', aiMsg).catch(() => {/* already warned inside */})
  }, [provider, persistMessage])

  /**
   * Canonical specialist entry point: selected specialist → Task Planner
   * (see lib/planGenerator.ts, producing only an ordered,
   * intent-tagged step list — no free-text plan narrative) → approval or
   * auto-approval → TaskExecutor runs the steps directly → response. If
   * If the Task Planner does not return a valid, non-empty step list, planning
   * has failed: stop and tell the user (presentPlanningFailedNotice) rather
   * than executing blind or falling back to a single undivided turn.
   * Otherwise show the plan (presentIntentPlan): with Plan Mode ON, that's
   * where this turn stops until the user clicks Approve/Modify; with Plan
   * Mode OFF, the SAME plan is shown and then immediately auto-approved via
   * approvePlanRef — reusing the exact approve → execute pipeline a manual
   * click would trigger, so there's only one execution path either way.
   * (The CHAT branch never reaches this function at all — see
   * presentDirectChatReply above and handleSend below.)
   */
  const presentOrAutoApprovePlan = useCallback((
    text:      string,
    images:    PendingChatImage[],
    userMsg:   ChatMessage,
    topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
    steps?:    ExecutionStep[],
    activities: AgentActivity[] = [],
  ): void => {
    if (!steps || steps.length === 0) {
      presentPlanningFailedNotice(text, images, userMsg, activities)
      return
    }
    const aiId = presentIntentPlan(text, images, steps, userMsg, topIntent, activities)
    // Plan Mode OFF ⇒ auto-approve immediately: same plan, same
    // approval/execution pipeline, just no wait for a manual click.
    if (aiId && !planMode) approvePlanRef.current(aiId, { auto: true })
  }, [presentIntentPlan, presentPlanningFailedNotice, planMode])

  const createPlannerActivity = useCallback((plannerResult: TaskPlannerResult, plannerModel?: string): AgentActivity => ({
    id: `task-planner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    tool: 'task_planner',
    label: 'Task Planner',
    args: { userPrompt: plannerResult.userPrompt },
    status: plannerResult.status,
    kind: 'ai_call',
    result: plannerResult.error ?? (plannerResult.plan ? `${plannerResult.plan.steps.length} step plan` : 'Planning failed'),
    aiCall: {
      providerName: provider?.displayName ?? 'AI provider',
      model: plannerModel,
      prompt: plannerResult.userPrompt,
      systemInstruction: plannerResult.systemInstruction,
      response: plannerResult.rawResponse,
      parsedResponse: { plan: plannerResult.plan, routingCalls: plannerResult.routingCalls },
      startedAt: plannerResult.startedAt,
      completedAt: plannerResult.completedAt,
      latencyMs: plannerResult.latencyMs,
      tokenUsage: plannerResult.tokenUsage,
      error: plannerResult.error,
    },
  }), [provider])

  /**
   * Runs the Task Planner call (lib/planGenerator.ts) for a final,
   * ready-to-plan piece of text and shows/auto-approves the result — the
   * same tail end handleSend always ran, just factored out so both the
   * "no clarification needed" path (called directly from handleSend) and
   * the "clarification resolved" path (called from resolveClarification
   * below) share one implementation.
   */
  const runIntentPlanner = useCallback(async (
    text:      string,
    images:    PendingChatImage[],
    apiKeyValue: string,
    model:     string | undefined,
    userMsg:   ChatMessage,
    initialActivity: AgentActivity | undefined,
    repoContextForPlanner: string | undefined,
    topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
    workspaceContext?: string,
  ): Promise<void> => {
    if (!provider) return
    const plannerResult = await generateExecutionPlan(
      text, provider, apiKeyValue, model, topIntent, undefined, repoContextForPlanner, workspaceContext,
    )
    const plannerActivity = createPlannerActivity(plannerResult, model)
    if (plannerResult.suggestedTopIntent) {
      const labels: Record<TopIntent, string> = {
        CODING_TASK: 'Coding', DESIGN_TASK: 'Design', DESKTOP_TASK: 'Desktop',
        MCP_TASK: 'MCP', BROWSER_TASK: 'Browser', AUTOMATION: 'Automation',
        CHAT: 'Chat', TERMINAL_TASK: 'Desktop',
      }
      const target = labels[plannerResult.suggestedTopIntent]
      presentDirectChatReply(
        userMsg,
        `This request is outside the selected specialist${plannerResult.redirectReason ? `: ${plannerResult.redirectReason}` : '.'}\n\nPlease switch to the **${target}** specialist and send it again. Nothing has been run.`,
        plannerActivity,
      )
      return
    }
    presentOrAutoApprovePlan(
      text, images, userMsg, topIntent, plannerResult.plan?.steps,
      [...(initialActivity ? [initialActivity] : []), plannerActivity],
    )
  }, [provider, presentOrAutoApprovePlan, createPlannerActivity, presentDirectChatReply])

  /**
   * Shown in place of the plan card before Task Planner execution, when the
   * Agentic Classifier (see lib/agenticClassifier.ts) attached a
   * `correctedText` and/or `clarifyingQuestions` to an agentic-mode result.
   * Stops the turn here (persisted, exactly like an IntentPlanCard) until
   * the user resolves it via resolveClarification below — nothing is
   * planned or executed before that. When neither field is present, this
   * is a no-op passthrough straight into runIntentPlanner, so callers can
   * always route through here without an extra branch.
   */
  const presentClarificationOrPlan = useCallback((
    text:      string,
    images:    PendingChatImage[],
    classification: { correctedText?: string; clarifyingQuestions?: string[] },
    apiKeyValue: string,
    model:     string | undefined,
    userMsg:   ChatMessage,
    initialActivity: AgentActivity,
    repoContextForPlanner: string | undefined,
    topIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'>,
  ): void => {
    const { correctedText, clarifyingQuestions } = classification
    const needsClarification =
      (!!correctedText && correctedText.trim() && correctedText.trim() !== text.trim()) ||
      (!!clarifyingQuestions && clarifyingQuestions.length > 0)

    if (!needsClarification) {
      void runIntentPlanner(text, images, apiKeyValue, model, userMsg, initialActivity, repoContextForPlanner, topIntent)
      return
    }

    if (!provider) return
    const aiId = (Date.now() + 1).toString()
    const aiMsg: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: correctedText && clarifyingQuestions?.length
        ? "Quick check before I plan this out — see below."
        : correctedText
          ? "Did you mean something else? See below."
          : "A couple of quick questions before I plan this out.",
      clarification: {
        correctedText,
        questions: clarifyingQuestions,
        resolved: false,
      },
      ...(initialActivity ? { agentActivities: [initialActivity] } : {}),
    }
    clarificationContextRef.current.set(aiId, {
      originalText: text,
      images,
      correctedText,
      questions: clarifyingQuestions,
      classifierActivity: initialActivity,
      repoContextForPlanner,
      topIntent,
    })
    // userMsg was already appended/persisted by the caller (handleSend) —
    // only the assistant clarification card is created here.
    setMessages(prev => [...prev, aiMsg])
    persistMessage('assistant', aiMsg).catch(() => {/* already warned inside */})
  }, [provider, persistMessage, runIntentPlanner])

  /**
   * Fired when the user resolves a ClarificationCard — either the
   * correction Yes/No, the clarifying-answers submit, or both at once (see
   * ClarificationCard's onResolve). Builds the final text handed to the Task Planner
   * planning: the corrected wording (if accepted) or the original wording
   * (if declined), with any non-blank answers folded in as plain
   * "Q: ... / A: ..." context so the planner has them without a second
   * classification pass. Marks the card resolved for display, then calls
   * runIntentPlanner directly — this never goes back through the Agentic
   * Classifier.
   */
  const resolveClarification = useCallback((
    msgId:  string,
    result: { useCorrection: boolean; answers?: string[] },
  ) => {
    const ctx = clarificationContextRef.current.get(msgId)
    if (!ctx) return

    setMessages(prev => {
      const updated = prev.map(m =>
        m.id === msgId && m.clarification
          ? {
              ...m,
              clarification: {
                ...m.clarification,
                resolved: true,
                useOriginal: !result.useCorrection,
                answers: result.answers,
              },
            }
          : m
      )
      const resolvedMsg = updated.find(m => m.id === msgId)
      if (resolvedMsg) persistMessageUpdate(resolvedMsg)
      return updated
    })

    clarificationContextRef.current.delete(msgId)

    const baseText = result.useCorrection && ctx.correctedText ? ctx.correctedText : ctx.originalText

    const qaLines = (ctx.questions ?? [])
      .map((q, i) => ({ q, a: result.answers?.[i]?.trim() }))
      .filter(({ a }) => !!a)
      .map(({ q, a }) => `Q: ${q}\nA: ${a}`)

    const finalText = qaLines.length > 0
      ? `${baseText}\n\nAdditional clarification:\n${qaLines.join('\n\n')}`
      : baseText

    const store     = useApiKeyStore.getState()
    const activeKey = store.getActiveKey(activeProviderId)
    if (!activeKey?.value) return

    // Show the resolved/elaborated request as its own user bubble right
    // away, before the asynchronous Task Planner call even starts — same
    // "message appears immediately" guarantee as a normal Send.
    const userMsg = appendUserMessage(finalText, ctx.images)

    void runIntentPlanner(
      finalText, ctx.images, activeKey.value, selectedModel, userMsg,
      ctx.classifierActivity, ctx.repoContextForPlanner, ctx.topIntent,
    )
  }, [activeProviderId, selectedModel, runIntentPlanner, persistMessageUpdate, appendUserMessage])

  // ── Auto-continue once a folder becomes the project root ───────────────
  // IDELayout renders welcome-mode and IDE-mode as two SEPARATE <AiChat>
  // instances — opening/creating a folder flips appMode, unmounting the
  // welcome instance (this one, if welcomeMode) and mounting a fresh IDE
  // instance. So the queued message lives in a module-level store (see
  // lib/pendingChatSend.ts), not component state, and is only ever
  // consumed by the non-welcome instance — guaranteeing it's the instance
  // that survives and whose chat panel the user will actually see.
  useEffect(() => {
    if (welcomeMode || (!projectRoot && !unsavedProjectName)) return

    // ── Decomposed-task resume ────────────────────────────────────────────
    // Set by the step executor (see approvePlan below) when an approved
    // plan's step list hit a WORK_WITH_REPO or BUILD_NEW_PROJECT/DESIGN
    // step with no project open yet — the folder picker/scaffold had to run
    // first, and by the time a folder exists this (welcome-mode) instance
    // is already gone. Resumes the SAME task (remaining steps + TaskState)
    // in this fresh IDE-mode instance rather than losing the rest of the plan.
    const resume = takePendingStepResume()
    if (resume) runDecomposedStepsRef.current(resume.steps, resume.taskState, resume.text, resume.images)
  }, [welcomeMode, projectRoot, unsavedProjectName, doSend, provider, activeProviderId, selectedModel, persistMessage])

  // ── handleSend ─────────────────────────────────────────────────────────────
  // Non-Chat/non-Automation requests go directly from the selected specialist
  // to generateExecutionPlan. The planner validates specialist relevance and
  // produces the minimum ordered, intent-tagged steps; it does not select
  // tools or execute work. Chat and Automation retain their dedicated flows.
  const executeSend = useCallback(async (rawText: string, images: PendingChatImage[] = []) => {
    // Fold any app-context chips queued from the App Registry / App Manager
    // panels ("+ Add to chat") into this outgoing message, then clear the
    // queue — the chips are a one-shot attachment to the very next Send,
    // same lifecycle as the pendingAttachments queue used by the agent's
    // own add_file_to_request tool. Read fresh here (not at handleSend's
    // click time) so a queued-then-confirmed Send still picks up whatever
    // is in the queue at the moment it actually fires.
    const queuedAppContext = useChatAppContextStore.getState().items
    const appContextBlock = buildAppContextBlock(queuedAppContext)
    const text = appContextBlock
      ? `${rawText}${rawText ? '\n\n' : ''}${appContextBlock}`
      : rawText
    if ((!text && images.length === 0) || !provider) return
    if (queuedAppContext.length > 0) useChatAppContextStore.getState().clear()

    const store     = useApiKeyStore.getState()
    const activeKey = store.getActiveKey(activeProviderId)
    if (!activeKey?.value) return

    // ── Show the user's message right away ──────────────────────────────
    // Append and persist it before refinement or planning, so it is on
    // screen the instant Send is pressed —
    // not after the (async) classifier/planner call resolves. This is the
    // ONLY place a user-message bubble is created for a Send; every intent
    // below (Chat, Design, Coding, Web, Agentic, ...) reuses this same
    // `userMsg`, and none of the helpers it's passed to re-create one.
    const userMsg = appendUserMessage(text, images)

    // Clear the textarea immediately after — the text is preserved in the
    // pendingChatSend store and restored if the user backs out of a folder
    // picker / build dialog.
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    // ── Open-folder chip override (ACTIONS bar — see AiChat.tsx / ─────────
    // store/useFolderChipsStore.ts) ─────────────────────────────────────
    // One chip per currently-open folder (the primary project + any
    // additional folders added via the File Explorer). Selecting one or
    // more is a per-turn override that takes priority over everything
    // below, including the selected specialist: no CHAT/AUTOMATION branch
    // is possible this turn, and the Task Planner (see runIntentPlanner)
    // runs directly with CODING_TASK. Repo
    // context sent alongside is built ONLY from whichever folder chip(s)
    // are selected — the primary project's summary only if its own chip
    // is selected, each additional folder's listing only if that
    // folder's chip is selected — never the full open-folder set.
    const selectedFolderPaths = useFolderChipsStore.getState().selectedPaths
    if (selectedFolderPaths.length > 0) {
      const extraFolders = useAdditionalFoldersStore.getState().folders
      const contextParts: string[] = []
      let folderIndex = 0

      if (projectRoot && selectedFolderPaths.includes(projectRoot)) {
        folderIndex += 1
        const primaryName = projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? projectRoot
        const primarySummary = buildRepoSummarySection(scanResult)
        if (primarySummary) {
          contextParts.push(`Repo Context for Folder ${folderIndex}: ${primaryName}\n\n${primarySummary}`)
        }
      }

      for (const f of extraFolders) {
        if (!selectedFolderPaths.includes(f.path)) continue
        folderIndex += 1
        const treeText = buildFolderTreeText(f.root)
        contextParts.push(`Repo Context for Folder ${folderIndex}: ${f.name} (${f.path}):\n${treeText}`)
      }

      // ── RAG retrieval, folded in alongside the repo summary ──────────────
      // A folder chip forces this turn straight to CODING_TASK — since
      // classification is skipped entirely, this is the one place that
      // decision is made. Run the same FTS → symbols → graph retrieval
      // pipeline normally reserved for execution-time WORK_WITH_REPO turns
      // (see sendTurn's `needsRepoContext` branch above) here too, so the
      // Task Planner call itself — not just later execution — already has
      // the relevant chunks/symbols for this request, not just the coarse
      // repo summary/tree.
      let ragContextBlock = ''
      if (repoContextEnabled) {
        try {
          const { repoContextBlock, symbolContextBlock, graphContextBlock, semanticContextBlock } =
            await runRetrieval(text, { currentFilePath: context.filePath, openFilePaths: [] })
          ragContextBlock = [repoContextBlock, symbolContextBlock, graphContextBlock, semanticContextBlock]
            .filter(Boolean).join('\n\n')
        } catch {
          // non-fatal — planning still proceeds on the repo summary alone
        }
      }

      const repoContextForSelectedFolders = [contextParts.join('\n\n'), ragContextBlock]
        .filter(Boolean).join('\n\n') || undefined

      // A folder chip selects CODING_TASK and sends the request directly to
      // the same specialist-scoped Task Planner used by specialist chips.
      setClassifyingIntent(true)
      await runIntentPlanner(
        text, images, activeKey.value, selectedModel, userMsg, undefined,
        repoContextForSelectedFolders, 'CODING_TASK',
      )
      setClassifyingIntent(false)
      return

    }

    // ── Specialist chip override (store/useSpecialistStore.ts) ─────────────
    // The persisted specialist supplies the TopIntent used by the planner.
    // CHAT-002: a project is open but its index isn't ready yet — flag it
    // now, before the specialist block/sending, so the notice is visible
    // alongside the very message that triggered it. This is informational
    // only: it doesn't block or queue anything (that's handled separately
    // for the WORK_WITH_REPO/TERMINAL_TASK intents that actually require
    // the index).
    setRepoIndexWarning(
      projectRoot && repoContextEnabled && useRepoIndex.getState().status !== 'ready'
        ? 'Repository is not indexed. Chat will answer questions generically.'
        : null
    )

    // ── Specialist chip (store/useSpecialistStore.ts) ──────────────────────
    // Non-Chat/non-Automation specialists enter the scoped Task Planner
    // directly. Chat and Automation keep their own refinement/routing path.
    {
      const specialist = useSpecialistStore.getState().specialist
      const chipIntent: TopIntent = specialist === 'CHAT'
        ? 'CHAT'
        : specialist === 'AUTOMATION'
          ? 'AUTOMATION'
          : SPECIALIST_TOP_INTENT[specialist]

      // The selected specialist and Task Planner now share the first API
      // call. A clearly irrelevant request produces a switch-specialist
      // notice from runIntentPlanner instead of being silently rerouted.
      if (chipIntent !== 'CHAT' && chipIntent !== 'AUTOMATION') {
        let repoContextForPlanner: string | undefined
        if (chipIntent === 'CODING_TASK' && projectRoot && repoContextEnabled) {
          repoContextForPlanner = buildRepoSummarySection(scanResult) ?? undefined
          try {
            const retrieved = await runRetrieval(text, { currentFilePath: context.filePath, openFilePaths: [] })
            repoContextForPlanner = [
              repoContextForPlanner, retrieved.repoContextBlock, retrieved.symbolContextBlock,
              retrieved.graphContextBlock, retrieved.semanticContextBlock,
            ].filter(Boolean).join('\n\n')
          } catch {
            // Planning can still use the repository summary.
          }
        }
        setClassifyingIntent(true)
        await runIntentPlanner(
          text, images, activeKey.value, selectedModel, userMsg, undefined,
          repoContextForPlanner, chipIntent,
        )
        setClassifyingIntent(false)
        return
      }

      setClassifyingIntent(true)
      const correction = await runPromptCorrectionClassifier(
        text, provider, activeKey.value, selectedModel, chipIntent,
      )
      setClassifyingIntent(false)
      const topIntent = correction.topIntent

      if (topIntent === 'CHAT') {
        if ((correction.clarifyingQuestions?.length ?? 0) > 0) {
          const correctionLine = correction.correctedText?.trim() && correction.correctedText.trim() !== text
            ? `Did you mean: **${correction.correctedText.trim()}**\n\n`
            : ''
          presentDirectChatReply(
            userMsg,
            `${correctionLine}I need a little more information:\n\n${correction.clarifyingQuestions!.map(q => `- ${q}`).join('\n')}`,
          )
          return
        }
        await doSend(correction.correctedText?.trim() || text, images, { needsRepoContext: false, intent: 'chat' })
        return
      }

      if (topIntent === 'AUTOMATION') {
        const specialistClassifierActivity: AgentActivity = {
          id: `classify-skip-specialist-automation-${Date.now()}`,
          tool: 'classify_message',
          label: 'Clarification + Intent',
          args: { message: text },
          status: 'done',
          kind: 'ai_call',
          result: `${topIntent} — confirmed from ${chipIntent}`,
          aiCall: {
            providerName: provider.displayName,
            model: selectedModel,
            prompt: text,
            systemInstruction: getPromptCorrectionSystemPrompt(chipIntent),
            response: correction.rawResponse ?? '',
          },
        }

        if ((correction.clarifyingQuestions?.length ?? 0) > 0) {
          const correctionLine = correction.correctedText?.trim() && correction.correctedText.trim() !== text
            ? `Did you mean: **${correction.correctedText.trim()}**\n\n`
            : ''
          presentDirectChatReply(
            userMsg,
            `${correctionLine}I need the following before scheduling this automation:\n\n${correction.clarifyingQuestions!.map(q => `- ${q}`).join('\n')}`,
            specialistClassifierActivity,
          )
          return
        }

        const refinedAutomationText = correction.correctedText?.trim() || text
        const schedule = parseSchedule(refinedAutomationText)
        const executionPrompt = buildExecutionPrompt(refinedAutomationText)
        const automationClassification = await runAutomationClassifier(text, provider, activeKey.value, selectedModel)
        const automationKind = automationClassification.kind
        const steps = buildSteps(automationKind, executionPrompt)

        if (automationKind === 'no_ai') {
          const job = useAutomationStore.getState().add(text, schedule, 'no_ai', steps)
          const scheduledBody = `Automation scheduled (terminal-only, no AI at run time). **${describeSchedule(job.schedule)}**\n\nCommands:\n${steps.map(t => t.executor === 'terminal' ? `- \`${t.command}\`` : '').join('\n')}\n\nYou can pause, edit, run, or delete it from the Automation Manager.`
          presentDirectChatReply(userMsg, scheduledBody, [specialistClassifierActivity])
          return
        }

        const job = useAutomationStore.getState().add(text, schedule, 'needs_ai', steps)
        const scheduledBody = `Automation scheduled. **${describeSchedule(job.schedule)}**\n\nIts execution plan will be compiled when an underlying specialist is known. It will not run now. You can pause, edit, run, or delete it from the Automation Manager.`

        presentDirectChatReply(userMsg, scheduledBody, [specialistClassifierActivity])
        return
      }

      // Remaining five confirmed intents (CODING/DESIGN/DESKTOP/MCP/BROWSER).
      if (topIntent !== 'TERMINAL_TASK') {
        const specialistClassifierActivity: AgentActivity = {
          id: `classify-skip-specialist-${Date.now()}`,
          tool: 'classify_message',
          label: 'Clarification + Intent',
          args: { message: text, specialist },
          status: 'done',
          kind: 'ai_call',
          result: `${topIntent} — confirmed from specialist chip: ${SPECIALIST_META[specialist].label}`,
          aiCall: {
            providerName: provider.displayName,
            model: selectedModel,
            prompt: text,
            systemInstruction: getPromptCorrectionSystemPrompt(chipIntent),
            response: correction.rawResponse ?? '',
          },
        }

        // Only CODING benefits from repo context (WORK_WITH_REPO/RUN_PROJECT
        // steps need to know a real project already exists) — every other
        // specialist sends none.
        let repoContextForPlanner: string | undefined
        if (topIntent === 'CODING_TASK' && projectRoot && repoContextEnabled) {
          repoContextForPlanner = buildRepoSummarySection(scanResult) ?? undefined
          try {
            const retrieved = await runRetrieval(text, { currentFilePath: context.filePath, openFilePaths: [] })
            repoContextForPlanner = [
              repoContextForPlanner,
              retrieved.repoContextBlock,
              retrieved.symbolContextBlock,
              retrieved.graphContextBlock,
              retrieved.semanticContextBlock,
            ].filter(Boolean).join('\n\n')
          } catch {
            // non-fatal — planning still proceeds on the repo summary alone
          }
        }

        presentClarificationOrPlan(
          text, images, correction, activeKey.value, selectedModel, userMsg,
          specialistClassifierActivity, repoContextForPlanner, topIntent,
        )
        return
      }
    }
  }, [provider, activeProviderId, projectRoot, scanResult, selectedModel, doSend, presentClarificationOrPlan, presentDirectChatReply, createPlannerActivity, appendUserMessage, persistMessage, repoContextEnabled, runIntentPlanner, runRetrieval, context])

  // Public entry point (Send button / Enter key). While a run is already
  // active this used to silently do nothing — now it queues the send and
  // asks for confirmation via requestOrRun/pendingTerminateConfirm (see
  // AiChat.tsx's TerminateRunConfirmModal), since sending now means
  // terminating whatever's currently running first.
  const handleSend = useCallback((images: PendingChatImage[] = []) => {
    const rawText = input.trim()
    if (!rawText && images.length === 0) return
    requestOrRun('send', () => { executeSend(rawText, images) })
  }, [input, requestOrRun, executeSend])

  // A triggered automation loads its PRECOMPILED plan (see the AUTOMATION
  // branch of executeSend above, which generates + stores {schedule,
  // executionPrompt, executionPlan, metadata} on the job the moment it's
  // created) and submits it straight to presentOrAutoApprovePlan -- the same
  // approve/auto-approve -> TaskExecutor -> AgentLoop pipeline a live
  // AGENTIC turn uses -- as if it had just come back from the planner.
  // Specialist selection and task planning are not repeated here. The only
  // fallback path below is for a job with no stored plan
  // (created before this feature existed, or whose one-time precompile
  // attempt failed); that legacy path still runs the Task Planner.
  useEffect(() => registerAutomationExecutor(async (request: string, job: AutomationJob) => {
    const liveProvider = getProvider(useApiKeyStore.getState().activeProviderId)
    if (!liveProvider) throw new Error('No active AI provider is configured.')
    const now = Date.now()

    if (job.executionPlan && job.executionPlan.length > 0) {
      const taskText = job.executionPrompt || request
      const triggeredPrompt = buildTriggeredPrompt(taskText)
      const userMsg = appendUserMessage(`[Automation: ${job.name}]\n${taskText}`, [])
      const activity: AgentActivity = {
        id: `automation-${now}`,
        tool: 'scheduled_automation',
        label: `Scheduled automation: ${job.name}`,
        args: { automationId: job.id, request: taskText },
        status: 'done',
        result: 'Loaded precompiled plan — classification and planning were not re-run',
      }
      const firstIntent = job.executionPlan[0].intent
      const automationTopIntent: Exclude<TopIntent, 'CHAT' | 'AUTOMATION'> =
        firstIntent === 'build_new_project' || firstIntent === 'work_with_repo' ? 'CODING_TASK'
          : firstIntent === 'design_project' ? 'DESIGN_TASK'
          : firstIntent === 'terminal_task' ? 'TERMINAL_TASK'
          : firstIntent === 'desktop_task' ? 'DESKTOP_TASK'
          : firstIntent === 'browser_task' ? 'BROWSER_TASK'
          : 'MCP_TASK'
      presentOrAutoApprovePlan(triggeredPrompt, [], userMsg, automationTopIntent, job.executionPlan, [activity])
      return
    }

    // Fallback ONLY: no stored plan on this job — unchanged prior behavior,
    // aside from also wrapping the prompt actually sent to the AI so it
    // knows this is a single one-shot trigger of a recurring job (see
    // buildTriggeredPrompt) rather than free-standing scheduling advice.
    throw new Error('This automation has no execution specialist yet; task planning is deferred until one is selected.')
  }), [appendUserMessage, presentOrAutoApprovePlan])


  useEffect(() => {
    const unsub = useRepoIndex.subscribe((state) => {
      if (state.status === 'ready') {
        setRepoIndexWarning(null)
      }
    })
    return unsub
  }, [])

  // ── Build New Project dialog handlers ───────────────────────────────────

  /** Opens a native folder picker for the dialog's "location" field. */
  const browseBuildLocation = useCallback(async (): Promise<string | null> => {
    try {
      return await pickDirectory('Choose Project Location')
    } catch {
      return null
    }
  }, [])

  /**
   * Creates {location}/{projectName} on disk and activates it immediately.
   * Coding requests then continue through the shared Task Planner and
   * normal step executor with authoritative empty-workspace context and no
   * retrieval. Design requests retain their existing specialized generator.
   */
  const confirmBuildDialog = useCallback(async (location: string, projectName: string) => {
    setBuildDialogSubmitting(true)
    setBuildDialogError(null)
    try {
      const entry = await createProject(location, projectName)
      setBuildDialogOpen(false)
      setBuildDialogSubmitting(false)

      // Retrieve the pending user message (the original "build" prompt).
      const pending = pendingBuildDialogRef.current
      pendingBuildDialogRef.current = null
      const originalRequest = pending?.text ?? ''
      const pendingImages   = pending?.images ?? []

      if (!originalRequest) return

      // Activate the workspace first — WITHOUT scanning. The folder
      // is empty right now; scanning it would do nothing useful. The first
      // real index happens after the executor creates the initial files.
      setProjectRootOnly(entry.path)

      if (pending?.planner) {
        const workspaceContext = [
          'NEW_PROJECT',
          'EMPTY/NEW WORKSPACE',
          `Active project root: ${entry.path}`,
          `Project name: ${projectName}`,
          `User requirements: ${originalRequest}`,
          'Design the initial architecture exclusively from the user requirements. Do not retrieve or infer repository context; the workspace is empty.',
          'Keep every planning step SOFTWARE:NEW_PROJECT and describe only what needs to be built. Do not add artificial install, run, or verification steps: the shared coding executor automatically creates files, installs dependencies, builds/runs, verifies, and fixes the project before completion.',
        ].join('\n')
        await runIntentPlanner(
          originalRequest, pendingImages, pending.planner.apiKey, pending.planner.model,
          pending.planner.userMsg, pending.planner.activity, undefined, 'CODING_TASK', workspaceContext,
        )
        return
      }

      if (buildDialogMode !== 'design') {
        throw new Error('The new-project planner context was lost. Please retry the request.')
      }

      const store = useApiKeyStore.getState()
      const activeKey = store.getActiveKey(activeProviderId)
      if (provider && activeKey?.value) {
        const aiId = Date.now().toString()
        setMessages(prev => [...prev, {
          id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          body: `Planning the page structure for **${projectName}**…`, isDesign: true,
        }])
        void runBuildNewProjectFlow({
          originalRequest, projectName, projectPath: entry.path, provider,
          apiKey: activeKey.value, model: selectedModel, mode: 'design', autoAccept: true,
          onProgress: body => setMessages(prev => prev.map(m => m.id === aiId ? { ...m, body } : m)),
        })
      }
    } catch (err) {
      setBuildDialogSubmitting(false)
      setBuildDialogError(err instanceof Error ? err.message : String(err))
    }
  }, [setProjectRootOnly, buildDialogMode, runIntentPlanner, activeProviderId, provider, selectedModel])

  /** Closes the dialog without creating anything, restoring the typed message. */
  const cancelBuildDialog = useCallback(() => {
    setBuildDialogOpen(false)
    setBuildDialogError(null)
    const taken = pendingBuildDialogRef.current
    pendingBuildDialogRef.current = null
    if (taken) setInput(taken.text)
  }, [])

  // ── handleStop ─────────────────────────────────────────────────────────────
  const handleStop = () => {
    const stoppedId = streamingIdRef.current
    setStreaming(false)
    streamingRef.current = false
    streamingIdRef.current = null
    generationIdRef.current++
    abortRef.current?.abort()
    abortRef.current = null

    // Freeze every still-animating piece of the aborted turn. Aborting the
    // fetch stops new tokens/tool results from arriving, but anything that
    // was left in a 'running' state (an agent-activity row's ⟳ spinner, or
    // an in-progress plan step) has no future update coming to move it out
    // of that state — without this it would spin forever even though the
    // turn is actually dead.
    if (stoppedId) {
      setMessages(prev => prev.map(m => {
        if (m.id !== stoppedId) return m
        let changed = false

        let agentActivities = m.agentActivities
        if (agentActivities?.some(a => a.status === 'running')) {
          agentActivities = agentActivities.map(a =>
            a.status === 'running' ? { ...a, status: 'error' as const, result: 'Stopped by user' } : a
          )
          changed = true
        }

        let stepStatuses = m.stepStatuses
        if (stepStatuses && Object.values(stepStatuses).some(s => s === 'running' || s === 'pending')) {
          stepStatuses = Object.fromEntries(
            Object.entries(stepStatuses).map(([id, status]) =>
              [id, (status === 'running' || status === 'pending') ? ('cancelled' as const) : status]
            )
          )
          changed = true
        }

        if (!changed) return m
        const updated = {
          ...m,
          agentActivities,
          stepStatuses,
          executionCancelled: stepStatuses ? true : m.executionCancelled,
        }
        persistMessageUpdate(updated)
        return updated
      }))
    }
  }

  // Stops the current run (see handleStop above) and then fires whatever
  // resend/retry/edit action was queued by requestOrRun while it was
  // active. Cancelling instead just clears the queue — see
  // cancelTerminateConfirm above.
  const confirmTerminateRun = () => {
    const run = pendingRunRef.current
    pendingRunRef.current = null
    setPendingTerminateConfirm(null)
    handleStop()
    run?.()
  }

  // ── handleNewChat ──────────────────────────────────────────────────────────
  const handleNewChat = () => {
    setStreaming(false)
    streamingIdRef.current = null
    generationIdRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    setInput('')
    setFailoverNotice(null)
    setRepoIndexWarning(null)
    compactionPassRef.current = 0
    lastCompactionRef.current = null
    resumeStatesRef.current.clear()
    // Reset active conversation so the next message creates a new SQLite row
    activeConversationIdRef.current = null
    setActiveConversationId(null)
    localStorage.removeItem(`rachna:active-chat:${chatScopeKey}`)
    lastAssistantMessageIdRef.current = null
    graphNodesRef.current = []
    tailDbIdRef.current = null
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setChatOpen(true)
    // ── Reset chat-scoped Activity Bar state (BUG-004) ─────────────────────
    // Plan Mode and the agent's todo list are per-conversation state.
    // Without this they silently carried over into every new chat, even
    // though useTodoStore's own comment promised a "clean slate" on new
    // chat. Reset to Auto-Approve (planMode false) — the same default the
    // app starts with on first load (see the useState(false) above) —
    // rather than Manual Approval, so a fresh chat always matches the
    // app-wide default until the user toggles it. The specialist chip is a
    // standing preference, not per-conversation, so it's left as-is here.
    setPlanMode(false)
    useTodoStore.getState().clear()
  }

  // ── handleRetry ────────────────────────────────────────────────────────────
  // "Retry this message" rewinds the visible chat to immediately before the
  // selected user message, then submits that message again through executeSend.
  // This is intentionally the exact same entry point as a normal Send: mode
  // selection, classification, clarification, planning, repo retrieval, and
  // execution must all run again. Calling sendTurn directly here used to skip
  // that entire pipeline and could silently turn an agentic request into a
  // plain model response.
  const doRetry = useCallback((msgId: string) => {
    if (!provider) return
    const msgIndex = messages.findIndex(m => m.id === msgId && m.role === 'user')
    if (msgIndex === -1) return

    const msg           = messages[msgIndex]
    const priorMessages = messages.slice(0, msgIndex)
    // Re-anchor persistence before executeSend appends the retried user
    // message. It becomes an alternate branch at the selected point, while
    // the old message and its descendants remain available in the graph.
    tailDbIdRef.current = msg.parentDbId ?? priorMessages.at(-1)?.dbId ?? null
    setMessages(priorMessages)
    setFailoverNotice(null)
    setRepoIndexWarning(null)
    resumeStatesRef.current.clear()
    planContextRef.current.clear()
    clarificationContextRef.current.clear()
    useTodoStore.getState().clear()

    // Image previews are data URLs when originally attached. Restore their
    // raw payload as well so retrying a vision prompt does not drop inputs.
    const images: PendingChatImage[] = (msg.images ?? []).flatMap(image => {
      const comma = image.previewUrl.indexOf(',')
      if (comma === -1) return []
      return [{
        base64: image.previewUrl.slice(comma + 1),
        mimeType: image.mimeType,
        previewUrl: image.previewUrl,
      }]
    })

    void executeSend(msg.body, images)
  }, [messages, provider, executeSend])

  // Public entry point (the ↺ Retry button on a user message). While a run
  // is already active this used to be disabled outright — now it's
  // clickable, and queues+confirms via requestOrRun same as handleSend.
  const handleRetry = useCallback((msgId: string) => {
    requestOrRun('retry', () => doRetry(msgId))
  }, [requestOrRun, doRetry])

  // ── handleEditMessage ───────────────────────────────────────────────────
  // CHAT-004: editing a past user message forks a new BRANCH rather than
  // overwriting anything — the edited text is saved as a new sibling of
  // the original message (same parent), and the fresh AI reply is saved
  // as its child. The original message and everything under it stay in
  // the database untouched; the user can navigate back via prev/next.
  const doEditMessage = useCallback((msgId: string, newBody: string) => {
    if (!provider) return
    const msgIndex = messages.findIndex(m => m.id === msgId && m.role === 'user')
    if (msgIndex === -1) return

    const originalMsg = messages[msgIndex]
    // New sibling forks from the ORIGINAL message's own parent — not from
    // the original message itself, which would make it a child/reply
    // instead of an alternate version.
    const forkParentId = originalMsg.dbId !== undefined
      ? (originalMsg.parentDbId ?? null)
      : tailDbIdRef.current

    // Keep all messages before this user message
    const priorMessages = messages.slice(0, msgIndex)

    setMessages(priorMessages)
    setStreaming(true)
    setFailoverNotice(null)

    const now  = Date.now()
    const aiId = (now + 1).toString()
    const aiMsg: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: '',
    }

    // Build a new user message with the edited body
    const editedUserMsg: ChatMessage = {
      ...messages[msgIndex],
      id:   now.toString(),
      dbId: undefined,
      parentDbId: undefined,
      versionInfo: undefined,
      body: newBody,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setMessages(prev => [...prev, editedUserMsg, aiMsg])

    abortRef.current?.abort()
    const controller     = new AbortController()
    abortRef.current     = controller
    const thisGeneration = ++generationIdRef.current
    streamingIdRef.current = aiId

    // ── Persist the edited user message as a new branch, then the fresh
    // assistant reply as its child. The explicit `forkParentId` on the
    // user-message save is what actually creates the fork; persistMessage
    // then auto-advances the tail to it, so the assistant reply right
    // after chains normally underneath.
    persistMessage('user', editedUserMsg, null, forkParentId).catch(() => {/* already warned inside */})
    persistMessage('assistant', aiMsg)
      .then(id => { if (id) lastAssistantMessageIdRef.current = id })
      .catch(() => {/* already warned inside */})

    sendTurn({
      question:      newBody,
      priorMessages,
      aiId,
      thisGeneration,
      controller,
    }).then(() => {
      setMessages(prev => {
        const aiMessage = prev.find(m => m.id === aiId)
        if (aiMessage) persistMessageUpdate(aiMessage)
        return prev
      })
    })
  }, [messages, provider, sendTurn, persistMessage, persistMessageUpdate])

  // Public entry point (the ✎ Edit-and-resend button on a user message).
  // While a run is already active this used to be disabled outright — now
  // it's clickable, and queues+confirms via requestOrRun same as handleSend.
  const handleEditMessage = useCallback((msgId: string, newBody: string) => {
    requestOrRun('edit', () => doEditMessage(msgId, newBody))
  }, [requestOrRun, doEditMessage])

  // ── handleSwitchVersion ───────────────────────────────────────────────────
  // CHAT-004: prev/next navigation between sibling versions of a message
  // (an edited user message, or a regenerated assistant reply). Moves to
  // the deepest already-recorded descendant of the target sibling — i.e.
  // whatever was last actively viewed/authored down that branch — and
  // repoints the conversation's current_leaf_id there. Never creates,
  // deletes, or mutates a message; purely a view + pointer change.
  const handleSwitchVersion = useCallback((msgId: string, direction: -1 | 1) => {
    if (streaming) return
    const msg = messages.find(m => m.id === msgId)
    if (!msg?.dbId) return

    const childrenMap = buildChildrenMap(graphNodesRef.current)
    const newLeaf = computeSwitchVersion(childrenMap, graphNodesRef.current, msg.dbId, direction)
    if (!newLeaf) return

    tailDbIdRef.current = newLeaf
    setMessages(pathToChatMessages(buildPathToLeaf(graphNodesRef.current, newLeaf)))

    if (activeConversationIdRef.current) {
      dbSetCurrentLeaf(activeConversationIdRef.current, newLeaf).catch(err => {
        console.warn('[chatGraph] set_current_leaf failed:', err)
      })
    }
  }, [streaming, messages, pathToChatMessages])

  // ─────────────────────────────────────────────────────
  // Walks an approved ExecutionStep[] (see lib/planGenerator.ts)
  // through TaskExecutor, routing each step to the right handling for ITS
  // OWN intent — this is where per-step intent selection actually takes
  // effect (requirement: intent selection only happens during execution
  // planning, per step, never by whole-request execution). Shared
  // by approvePlan and by the step-task resume effect above (continuing a task whose step list
  // was queued across a welcome→IDE remount).
  const runDecomposedSteps = useCallback((
    steps:        ExecutionStep[],
    initialTaskState: TaskState,
    originalText: string,
    images:       PendingChatImage[],
    planMsgId?:   string,
  ) => {
    if (!provider) return

    setStreaming(true)
    setFailoverNotice(null)
    abortRef.current?.abort()
    const controller     = new AbortController()
    abortRef.current     = controller
    const thisGeneration = ++generationIdRef.current

    // Best-effort running history for this task's own sendTurn calls. When
    // resuming after a welcome→IDE remount, `messages` starts fresh for the
    // new instance — same accepted trade-off the old pendingChatSend/
    // pendingMcpSend hand-offs already made (a resumed turn doesn't carry
    // the full prior transcript across that boundary either).
    let historySoFar: ChatMessage[] = [...messages]

    const nowMsg = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    // Every message pushed here (a step's own reply, a "need a folder
    // first"/"MCP not connected" notice, etc.) is persisted immediately —
    // same as any other assistant message in the app. Before this, these
    // step-level messages only ever lived in React state: closing the app
    // (or switching to another chat and back) silently dropped every
    // agent response generated while a decomposed/agentic plan executed,
    // even though the plan CARD itself (presentIntentPlan) was saved.
    const pushMsg = (id: string, body: string, extra?: Partial<ChatMessage>) => {
      const msg: ChatMessage = { id, role: 'ai', name: provider!.displayName, initials: '✦', time: nowMsg(), body, ...extra }
      setMessages(prev => [...prev, msg])
      persistMessage('assistant', msg).catch(() => {/* already warned inside */})
      return msg
    }

    // ── Step status tracking (IntentPlanCard's live progress display) ────
    // Pure UI bookkeeping layered on top of the untouched step executor
    // below — never affects which step runs, in what order, or what tools
    // it can use. No-op when planMsgId isn't known (e.g. the welcome→IDE
    // remount resume path, which no longer has the original plan message
    // in this fresh instance's `messages`).
    const updateStepStatus = (stepId: string, status: StepStatus) => {
      if (!planMsgId) return
      setMessages(prev => prev.map(m => {
        if (m.id !== planMsgId) return m
        const updated = { ...m, stepStatuses: { ...m.stepStatuses, [stepId]: status } }
        persistMessageUpdate(updated)
        return updated
      }))
    }

    ;(async () => {
      try {
        const execResult = await runExecutionSteps(
          steps,
          async (step, ts) => {
            updateStepStatus(step.id, 'running')
            try {
              const result = await (async (): Promise<StepExecutionResult | void> => {
            const stepAiId = `${thisGeneration}_${step.id}_${Date.now()}`
            streamingIdRef.current = stepAiId

            // ── build_new_project, no project open yet ──────────────────
            // Asks for a save location FIRST — nothing is generated (no
            // in-memory files, no disk writes) until the user names the
            // project and picks/confirms a folder via BuildProjectDialog.
            // This is the same "name + location" dialog confirmBuildDialog
            // already drives from the plain-message entry point — routing
            // through it here means a real project folder always exists
            // before generation starts, instead of scaffolding straight
            // into the in-memory unsaved-project store.
            if (step.intent === 'build_new_project' && !projectRoot) {
              // ── Persist the conversation so far, before the dialog opens ──
              // Same defensive persistMessage() call used everywhere else in
              // this file — the user's request and the generated plan should
              // already be saved by appendUserMessage / presentIntentPlan,
              // but this guarantees it regardless of whatever path got us
              // here, before the dialog (and the generation it kicks off)
              // takes over.
              setMessages(prev => {
                const unpersistedUserMsg = [...prev].reverse().find(m => m.role === 'user' && !m.dbId)
                if (unpersistedUserMsg) persistMessage('user', unpersistedUserMsg).catch(() => {/* already warned inside */})
                const planMsg = planMsgId ? prev.find(m => m.id === planMsgId) : undefined
                if (planMsg && !planMsg.dbId) persistMessage('assistant', planMsg).catch(() => {/* already warned inside */})
                return prev
              })

              const keyStore  = useApiKeyStore.getState()
              const activeKey = keyStore.getActiveKey(activeProviderId)
              if (!provider || !activeKey?.value) return { stop: true, summary: 'No active API key — could not scaffold the project.' }

              // ── Open the "name + location" dialog ────────────────────────
              // Legacy fallback for classifiers that did not return the
              // workspace subtype. Current NEW_PROJECT requests open this
              // dialog before task planning so execution never reaches here.
              // Files land on disk as autoManaged edits (see EditStore's
              // autoManaged flag) as they're generated and are merged +
              // indexed automatically the instant generation finishes —
              // there's no separate Merge/Reject step for the user, and no
              // premature index of the (until-then) empty folder.
              pendingBuildDialogRef.current = { text: step.task || originalText, images }
              setBuildDialogMode('code')
              setBuildDialogError(null)
              setBuildDialogOpen(true)

              // Terminal for this task run: further steps (if any) would
              // need the newly-created project's own context, which this
              // component instance won't see once the dialog hands off and
              // this instance unmounts.
              return { stop: true, summary: 'Waiting for a project name and save location.' }
            }

            // ── design_project, no project open yet ─────────────────────
            // Now matches build_new_project above exactly: asks for a save
            // location FIRST via the same BuildProjectDialog (mode
            // 'design') — nothing is generated, no in-memory
            // unsaved-project/canvas files, and no disk writes — until the
            // user names the design and picks/confirms a folder. A real
            // project folder always exists before generation starts,
            // instead of scaffolding straight into the in-memory
            // unsaved-project store the way this used to work.
            if (step.intent === 'design_project' && !projectRoot) {
              // ── Persist the conversation so far, before the dialog opens ──
              setMessages(prev => {
                const unpersistedUserMsg = [...prev].reverse().find(m => m.role === 'user' && !m.dbId)
                if (unpersistedUserMsg) persistMessage('user', unpersistedUserMsg).catch(() => {/* already warned inside */})
                const planMsg = planMsgId ? prev.find(m => m.id === planMsgId) : undefined
                if (planMsg && !planMsg.dbId) persistMessage('assistant', planMsg).catch(() => {/* already warned inside */})
                return prev
              })

              const keyStore  = useApiKeyStore.getState()
              const activeKey = keyStore.getActiveKey(activeProviderId)
              if (!provider || !activeKey?.value) return { stop: true, summary: 'No active API key — could not scaffold the project.' }

              // ── Open the "name + location" dialog (mode: design) ─────────
              // confirmBuildDialog creates and activates the folder, then
              // runs the existing design generator in this mounted chat
              // instance. Files land on disk as autoManaged edits (see
              // EditStore's autoManaged flag) as they're generated and are
              // merged + indexed automatically the instant generation
              // finishes — there's no separate Merge/Reject step for the
              // user (design_project needs the project created first, then
              // verified, same as build_new_project — not a manual
              // per-batch review), and no premature index of the
              // (until-then) empty folder.
              pendingBuildDialogRef.current = { text: step.task || originalText, images }
              setBuildDialogMode('design')
              setBuildDialogError(null)
              setBuildDialogOpen(true)

              // Terminal for this task run: further steps (if any) would
              // need the newly-created project's own context, which this
              // component instance won't see once the dialog hands off and
              // this instance unmounts.
              return { stop: true, summary: 'Waiting for a design name and save location.' }
            }

            // ── work_with_repo, no project open yet ───────────────────────
            if (step.intent === 'work_with_repo' && !projectRoot) {
              pushMsg(stepAiId, "I'll need a project folder first — opening the picker, then I'll pick this back up.")
              // Queue the REMAINING steps (this one included) across the
              // unmount — opening a folder flips appMode, unmounting THIS
              // component instance (see lib/pendingChatSend.ts).
              const remaining = steps.slice(steps.indexOf(step))
              setPendingStepResume({ text: originalText, images, steps: remaining, taskState: ts })
              try {
                const root = await openFolder()
                if (root) { indexFolder(root.path); return { stop: true } }
                takePendingStepResume()
                return { stop: true, summary: 'Folder selection was cancelled.' }
              } catch {
                takePendingStepResume()
                return { stop: true, summary: 'Folder selection failed.' }
              }
            }

            // ── browser_task requires its only sub-intent ─────────
            if (step.intent === 'browser_task' && !step.subIntent) {
              pushMsg(stepAiId, BROWSER_TASK_UNSUPPORTED)
              return { stop: true, summary: 'Could not complete request: missing headless browser sub-intent.' }
            }

            // ── mcp_task ───────────────────────────────────────────────────
            // Only a relevant connected server qualifies. Its discovered
            // tools are merged into the executor's tool list (see
            // services/agent/mcpTools.ts); otherwise stop with stable,
            // manual navigation instructions instead of guessing tools.
            if (step.intent === 'mcp_task') {
              let relevantServerIds = getRelevantConnectedMcpServers(step.task)
              if (relevantServerIds.length === 0) {
                const configuredServerIds = getRelevantConfiguredMcpServers(step.task)
                if (configuredServerIds.length > 0) {
                  const { connectServer } = useMcpStore.getState()
                  await Promise.all(configuredServerIds.map(id => connectServer(id, projectRoot)))
                  relevantServerIds = getRelevantConnectedMcpServers(step.task)

                  if (relevantServerIds.length === 0) {
                    const { servers, runtime } = useMcpStore.getState()
                    const details = configuredServerIds
                      .map(id => runtime[id]?.error || `${servers.find(server => server.id === id)?.name ?? 'MCP server'} could not connect`)
                      .join('\n')
                    pushMsg(stepAiId, `The configured MCP server could not connect. ${details}`)
                    return { stop: true, summary: 'The configured MCP server could not connect.' }
                  }
                }
              }
              if (relevantServerIds.length === 0) {
                const suggestion = suggestMcpForRequest(step.task)
                useMcpStore.getState().openPanel({
                  quickstart: suggestion?.quickstart ?? null,
                  note: suggestion?.note ?? 'Configure an MCP server for this task.',
                })
                pushMsg(stepAiId, suggestion
                  ? `This step needs **${suggestion.note}**. I opened **Settings → MCP** so you can configure it, then retry this step.`
                  : 'This step needs an MCP server that is not configured. I opened **Settings → MCP** so you can add it, then retry this step.')
                return { stop: true, summary: 'The relevant MCP server is not configured.' }
              }
              // AgentLoop obtains the current MCP tool declarations at the
              // executor boundary, so this step receives the connected
              // server's advertised tool calls rather than the planner
              // guessing static tool names.
            }

            // ── WORK_WITH_REPO/TERMINAL_TASK: wait out an in-progress scan ──
            // Only these two step intents actually depend on a stable repo
            // index (dependency graph + SQLite chunks) or touch the
            // filesystem/terminal while a scan is mid-read — every other
            // step intent proceeds without waiting (see waitForIndexReady).
            if ((step.intent === 'work_with_repo' || step.intent === 'terminal_task') && projectRoot) {
              await waitForIndexReady(controller.signal)
            }

            // ── default: a normal agent turn, scoped to this step's own
            // intent/subIntent (see ToolRegistry.getToolNamesForIntent) ───
            const stepPlaceholder: ChatMessage = {
              id: stepAiId, role: 'ai', name: provider!.displayName, initials: '✦',
              time: nowMsg(), body: '',
            }
            setMessages(prev => [...prev, stepPlaceholder])
            persistMessage('assistant', stepPlaceholder).catch(() => {/* already warned inside */})

            const contextPrefix = formatTaskStateForPrompt(ts)
            const question = contextPrefix ? `${contextPrefix}\n\nNext step: ${step.task}` : step.task

            // ── Auto-merge setup (non-work_with_repo intents only) ──────────
            // Snapshot which edits are ALREADY pending before this step
            // runs, so that once it finishes we can identify exactly the
            // edits THIS step proposed — never sweeping up an unrelated
            // work_with_repo step's still-pending edits that happen to be
            // awaiting manual review at the same time. See the auto-merge
            // block right after sendTurn below for why this only applies
            // outside SOFTWARE:WORK_WITH_REPO.
            const pendingBeforeIds = step.intent !== 'work_with_repo'
              ? new Set(useEditStore.getState().edits.filter(e => e.status === 'pending').map(e => e.id))
              : null

            setStreaming(true)
            await sendTurn({
              question,
              priorMessages:    historySoFar,
              aiId:             stepAiId,
              thisGeneration,
              controller,
              needsRepoContext: step.intent === 'work_with_repo',
              intent:           step.intent,
              subIntent:        step.subIntent,
            })

            // ── Persist this step's response once its turn completes ────────
            // sendTurn only streams the reply into React state (setMessages)
            // — it never writes to SQLite itself (see doSend/handleContinue,
            // which persist right after their own sendTurn/
            // runAgentTurnWithFailover call; this step-executor path is the
            // same pattern). Without this, every step's actual reply — body
            // text AND its agentActivities/"AI call" chips (tool calls, the
            // AI Call Inspector data) — only ever lived in memory and was
            // lost the moment the app closed or another chat was opened,
            // even though the IntentPlanCard itself was saved. Read the
            // final message back out of state (sendTurn's onChunk/
            // onActivityEnd/onAiCallUpdate updates land there, not on the
            // stale `stepPlaceholder` closure) so the persisted row matches
            // exactly what's on screen.
            setMessages(prev => {
              const finalStepMsg = prev.find(m => m.id === stepAiId)
              if (finalStepMsg) {
                persistMessageUpdate(finalStepMsg)
              }
              return prev
            })

            // ── Auto-merge (non-work_with_repo intents only) ────────────────
            // Merge All / Reject All (and the floating EditReviewBar) exist
            // so the user can review a change before it lands — that only
            // makes sense for SOFTWARE:WORK_WITH_REPO, where the user already
            // has a working project they didn't ask to have modified this
            // way. For every other intent (build_new_project, design_project,
            // desktop_task, etc.) the file/edit IS the thing the user asked
            // for in the first place — there's no separate approval step to
            // wait on, and no way to ask again without breaking the flow —
            // so any edit this step newly proposed is merged immediately
            // instead of being left pending for the user to act on.
            if (pendingBeforeIds && !controller.signal.aborted) {
              const newlyPending = useEditStore.getState().edits.filter(
                e => e.status === 'pending' && !pendingBeforeIds.has(e.id)
              )
              if (newlyPending.length > 0) {
                await useEditStore.getState().acceptEdits(newlyPending.map(e => e.id))
              }
            }

            // Fold this step's own exchange into the running history so the
            // NEXT step's sendTurn call sees it, without waiting on React
            // state to have flushed (setMessages above is async).
            const stepUserMsg: ChatMessage = {
              id: `${stepAiId}_u`, role: 'user', name: 'You', initials: 'U',
              time: nowMsg(), body: question,
            }
            historySoFar = [...historySoFar, stepUserMsg, stepPlaceholder]

            if (controller.signal.aborted) return { stop: true }
            return { summary: step.task }
              })()
              // A `stop: true` result means this step handed off to a UI
              // flow that needs a fresh user action (folder picker, Run
              // Configuration, MCP Settings, login) before it can actually
              // finish — leave it 'running' rather than 'completed' so the
              // card still shows it as the active step once things resume.
              if (!result?.stop) updateStepStatus(step.id, 'completed')
              return result
            } catch (err) {
              updateStepStatus(step.id, 'failed')
              throw err
            }
          },
          initialTaskState,
          { signal: controller.signal },
        )

        // ── Strict Step Execution: stash/clear failed-step resume state ──
        // A clean finish or an in-place `{ stop: true }` hand-off (folder
        // picker/login/MCP connector — all resolved by the same running
        // instance) both clear any stale entry. Only a genuine step failure
        // (`execResult.failed`) leaves one behind, keyed by planMsgId, so
        // Retry/Mark Done/Cancel Execution can act on it — see
        // retryStep/markStepDone/cancelExecution below. Nothing to do when
        // planMsgId is unknown (the welcome→IDE remount resume path has no
        // plan card in this fresh instance to attach Retry/Mark Done to).
        if (planMsgId) {
          if (execResult.failed && execResult.stoppedAtStepId) {
            const ordered      = orderSteps(steps)
            const failedIdx     = ordered.findIndex(s => s.id === execResult.stoppedAtStepId)
            const remainingSteps = failedIdx >= 0 ? ordered.slice(failedIdx) : steps
            failedStepContextRef.current.set(planMsgId, {
              steps:        remainingSteps,
              taskState:    execResult.taskState,
              originalText,
              images,
            })
          } else {
            failedStepContextRef.current.delete(planMsgId)
          }
        }
      } finally {
        if (streamingIdRef.current !== null) {
          setStreaming(false)
          streamingIdRef.current = null
        }
      }
    })()
  }, [provider, sendTurn, messages, activeProviderId, projectRoot, selectedModel, indexFolder, persistMessage, persistMessageUpdate])

  // Keep runDecomposedStepsRef pointed at the latest closure every render —
  // see its declaration above approvePlanRef for why the resume effect
  // (defined earlier in this file) goes through this indirection.
  runDecomposedStepsRef.current = runDecomposedSteps


  const approvePlan = useCallback((planMsgId: string, opts?: { auto?: boolean }) => {
    if (streaming || !provider) return
    const auto = !!opts?.auto

    // Only ever set for a plan card shown by presentIntentPlan (the
    // intent-based Task Planner's output). Without this context there is
    // no approved-plan execution path, so approval is a no-op.
    const planCtx = planContextRef.current.get(planMsgId)

    const now   = Date.now()

    const approvalUserMsg: ChatMessage = {
      id:       now.toString(),
      role:     'user',
      name:     'You',
      initials: 'U',
      time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body:     auto
        ? '[Plan auto-approved] Please proceed with the execution plan.'
        : '[Plan approved] Please proceed with the execution plan.',
    }

    // The approved IntentPlan itself and the original question both live in
    // planCtx (stashed synchronously by presentIntentPlan/modifyPlan into
    // planContextRef — a ref, not React state). Deliberately NOT read back
    // via `messages.find(...)`: when Plan Mode is OFF,
    // presentOrAutoApprovePlan calls approvePlanRef.current() synchronously
    // right after presentIntentPlan's setMessages() call, before React has
    // committed that update, so `messages` here could still be the
    // pre-plan snapshot. Reading from planCtx instead means approval
    // always sees the plan that was just generated, whether approval is
    // automatic or manual. planCtx is only ever populated by
    // presentIntentPlan/modifyPlan, and both only ever set it with a
    // non-empty step list (see presentOrAutoApprovePlan) — so whenever
    // planCtx is set, intentPlan.steps is guaranteed non-empty too.
    const intentPlan = planCtx?.intentPlan

    // Seed every step 'pending' right as execution starts — IntentPlanCard
    // uses this (via stepStatuses) to render its live progress tracker.
    const initialStepStatuses = Object.fromEntries((intentPlan?.steps ?? []).map(s => [s.id, 'pending' as const]))

    setMessages(prev => prev.map(m => {
      if (m.id !== planMsgId) return m
      const updated = { ...m, planApproved: true, autoApproved: auto, stepStatuses: initialStepStatuses }
      persistMessageUpdate(updated)
      return updated
    }))
    setMessages(prev => [...prev, approvalUserMsg])
    persistMessage('user', approvalUserMsg).catch(() => {/* already warned inside */})

    if (planCtx) planContextRef.current.delete(planMsgId)

    setStreaming(true)
    setFailoverNotice(null)
    abortRef.current?.abort()
    const controller     = new AbortController()
    abortRef.current     = controller
    const thisGeneration = ++generationIdRef.current

    ;(async () => {
      if (!planCtx) {
        setStreaming(false)
        return
      }

      const steps = intentPlan?.steps ?? []
      if (steps.length === 0) {
        presentPlanningFailedNotice(planCtx.originalText, [], approvalUserMsg)
        setStreaming(false)
        return
      }
      runDecomposedSteps(steps, createInitialTaskState(), planCtx.originalText, [], planMsgId)
    })()
  }, [streaming, provider, sendTurn, runDecomposedSteps, presentPlanningFailedNotice])


  // Keep approvePlanRef pointed at the latest approvePlan closure every
  // render — see the ref's declaration above planContextRef for why
  // presentOrAutoApprovePlan goes through this indirection instead of a
  // direct reference/dependency.
  approvePlanRef.current = approvePlan

  // ── modifyPlan ───────────────────────────────────────────────────────────────
  // Re-runs the same Task Planner with the user's feedback folded into
  // the planning request. It never routes through the executor or the full
  // agent loop, so modified plans still enter the same approve → sequential
  // step execution pipeline as first-pass plans.
  const modifyPlan = useCallback((planMsgId: string, feedback: string) => {
    if (streaming || !provider || !apiKey || !feedback.trim()) return
    const planCtx = planContextRef.current.get(planMsgId)
    if (!planCtx) return

    const now  = Date.now()
    const aiId = (now + 1).toString()
    const feedbackUserMsg: ChatMessage = {
      id:       now.toString(),
      role:     'user',
      name:     'You',
      initials: 'U',
      time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body:     `[Plan feedback] ${feedback.trim()}`,
    }
    const aiPlaceholder: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: '',
    }

    setMessages(prev => [
      ...prev.map(m => {
        if (m.id !== planMsgId) return m
        const updated = { ...m, planCancelled: true }
        persistMessageUpdate(updated)
        return updated
      }),
      feedbackUserMsg,
      aiPlaceholder,
    ])
    persistMessage('user', feedbackUserMsg).catch(() => {/* already warned inside */})
    planContextRef.current.delete(planMsgId)
    setStreaming(true)
    streamingIdRef.current = aiId
    setFailoverNotice(null)

    ;(async () => {
      const revisedRequest = `${planCtx.originalText}\n\nPlan feedback: ${feedback.trim()}`
      const plannerResult = await generateExecutionPlan(revisedRequest, provider, apiKey, selectedModel, planCtx.topIntent)
      const plannerActivity = createPlannerActivity(plannerResult, selectedModel)
      if (!plannerResult.plan?.steps.length) {
        setMessages(prev => {
          const next = prev.map(m => m.id === aiId ? { ...m, body: 'I could not produce a valid execution plan from that feedback, so I did not run anything.', agentActivities: [plannerActivity] } : m)
          const failed = next.find(m => m.id === aiId)
          if (failed) persistMessage('assistant', failed).catch(() => {/* already warned inside */})
          return next
        })
        setStreaming(false)
        streamingIdRef.current = null
        return
      }
      setMessages(prev => {
        const next = prev.map(m => m.id === aiId ? { ...m, body: '', intentPlan: plannerResult.plan!, planApproved: false, agentActivities: [plannerActivity] } : m)
        const revised = next.find(m => m.id === aiId)
        if (revised) persistMessage('assistant', revised).catch(() => {/* already warned inside */})
        return next
      })
      planContextRef.current.set(aiId, { originalText: revisedRequest, topIntent: planCtx.topIntent, intentPlan: plannerResult.plan })
      setStreaming(false)
      streamingIdRef.current = null
    })()
  }, [streaming, provider, apiKey, selectedModel, persistMessage, createPlannerActivity])

  const cancelPlan = useCallback((planMsgId: string) => {
    const planMsgSnapshot = messages.find(m => m.id === planMsgId)
    if (!planMsgSnapshot || planMsgSnapshot.planApproved || planMsgSnapshot.planCancelled) return

    planContextRef.current.delete(planMsgId)

    setMessages(prev => prev.map(m => {
      if (m.id !== planMsgId) return m
      const updated = { ...m, planCancelled: true }
      persistMessageUpdate(updated)
      return updated
    }))

    const cancelMsg: ChatMessage = {
      id:       (Date.now() + 1).toString(),
      role:     'ai',
      name:     provider?.displayName ?? 'Assistant',
      initials: '✦',
      time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body:     'Plan cancelled — nothing was run. Let me know if you\'d like a different approach.',
    }
    setMessages(prev => [...prev, cancelMsg])
    persistMessage('assistant', cancelMsg).catch(() => {/* already warned inside */})
  }, [messages, provider, persistMessage])

  /** Re-executes ONLY the failed step (and, if it succeeds, continues on into whatever comes after it) — previously-successful steps are left completely untouched. */
  const retryStep = useCallback((planMsgId: string) => {
    if (streaming) return
    const ctx = failedStepContextRef.current.get(planMsgId)
    if (!ctx || ctx.steps.length === 0) return
    // Re-running will re-populate (on another failure) or clear (on
    // success) this same entry — no need to delete it up front.
    runDecomposedSteps(ctx.steps, ctx.taskState, ctx.originalText, ctx.images, planMsgId)
  }, [streaming, runDecomposedSteps])

  /**
   * User override for a 'failed' step: marks it completed_manual (recording
   * that it was a user override, not a real success) and continues with
   * whatever step comes after it — the failed step itself is NOT re-run.
   */
  const markStepDone = useCallback((planMsgId: string) => {
    if (streaming) return
    const ctx = failedStepContextRef.current.get(planMsgId)
    if (!ctx || ctx.steps.length === 0) return

    const [failedStep, ...rest] = ctx.steps

    setMessages(prev => prev.map(m => {
      if (m.id !== planMsgId) return m
      const updated = { ...m, stepStatuses: { ...m.stepStatuses, [failedStep.id]: 'completed_manual' as const } }
      persistMessageUpdate(updated)
      return updated
    }))

    const advancedTaskState: TaskState = {
      ...ctx.taskState,
      completedStepIds: [...ctx.taskState.completedStepIds, failedStep.id],
      stepSummaries: {
        ...ctx.taskState.stepSummaries,
        [failedStep.id]: `${failedStep.task} — marked done manually by the user after this step failed.`,
      },
    }

    failedStepContextRef.current.delete(planMsgId)

    if (rest.length === 0) {
      // That was the last step — nothing left to run. Leave the plan card
      // showing completed_manual as its final state; no further turn fires.
      return
    }
    runDecomposedSteps(rest, advancedTaskState, ctx.originalText, ctx.images, planMsgId)
  }, [streaming, runDecomposedSteps])

  /**
   * Cancels the entire execution from a 'failed' step onward — every
   * remaining step (the failed one included) is marked 'cancelled' and the
   * pipeline never resumes for this plan. Steps that already completed
   * keep their 'completed' status untouched.
   */
  const cancelExecution = useCallback((planMsgId: string) => {
    const ctx = failedStepContextRef.current.get(planMsgId)
    if (!ctx) return

    setMessages(prev => prev.map(m => {
      if (m.id !== planMsgId) return m
      const cancelledEntries = Object.fromEntries(ctx.steps.map(s => [s.id, 'cancelled' as const]))
      const updated = { ...m, stepStatuses: { ...m.stepStatuses, ...cancelledEntries }, executionCancelled: true }
      persistMessageUpdate(updated)
      return updated
    }))
    failedStepContextRef.current.delete(planMsgId)

    const cancelMsg: ChatMessage = {
      id:       (Date.now() + 1).toString(),
      role:     'ai',
      name:     provider?.displayName ?? 'Assistant',
      initials: '✦',
      time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body:     'Execution cancelled — remaining steps were not run.',
    }
    setMessages(prev => [...prev, cancelMsg])
    persistMessage('assistant', cancelMsg).catch(() => {/* already warned inside */})
  }, [provider, persistMessage])

  // ── resolvePendingToggle ─────────────────────────────────────────────────────
  // Handles a click on the inline toggle rendered by PendingToggleCard when a
  // git_action call was blocked by a Settings → Git safety gate.
  //
  // This is the fix for "follow-up replies lose workflow context": rather
  // than the agent asking the user, in prose, to go enable a setting and
  // reply back (which then got misrouted through intent classification as
  // a brand-new request), the blocked message now carries a `pendingToggle`
  // and the UI renders an actual toggle switch. Flipping it:
  //   1. Updates the real Settings → Git store (same store Settings uses).
  //   2. Marks the message's pendingToggle as resolved (hides the switch).
  //   3. Immediately fires a follow-up agent turn via sendTurn() directly —
  //      exactly like approvePlan() above — which completely bypasses
  //      handleSend() as a new request. There is no free-text reply
  //      to misclassify, and the existing conversation/tool-call context is
  //      preserved and passed straight through as priorMessages.
  const resolvePendingToggle = useCallback((msgId: string, settingKey: GitSettingKey) => {
    if (streaming || !provider) return

    // Defense-in-depth: this flips the exact same settings Settings → Git
    // gates on `canConfigurePermissions` — restricted seats must not be
    // able to reach the setters through this alternate (in-chat) path
    // either, even if the UI toggle were somehow still clickable.
    if (!selectIdeEntitlements(useAuthStore.getState()).canConfigurePermissions) return

    const gitSettings = useGitSettingsStore.getState()
    if (settingKey === 'autoAllowCommit')       gitSettings.setAutoAllowCommit(true)
    if (settingKey === 'autoAllowPush')         gitSettings.setAutoAllowPush(true)
    if (settingKey === 'allowDirectPushToMain') gitSettings.setAllowDirectPushToMain(true)

    const now  = Date.now()
    const aiId = (now + 1).toString()
    const label = GIT_SETTING_LABELS[settingKey]

    const confirmationUserMsg: ChatMessage = {
      id:       now.toString(),
      role:     'user',
      name:     'You',
      initials: 'U',
      time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body:     `[Setting enabled] "${label}" is now ON. Please retry the git action.`,
    }
    const aiPlaceholder: ChatMessage = {
      id: aiId, role: 'ai', name: provider.displayName, initials: '✦',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      body: '',
    }

    setMessages(prev => {
      const updated   = prev.map(m =>
        m.id === msgId && m.pendingToggle
          ? { ...m, pendingToggle: { ...m.pendingToggle, resolved: true } }
          : m
      )
      const resolvedMsg = updated.find(m => m.id === msgId)
      if (resolvedMsg) persistMessageUpdate(resolvedMsg)
      const priorMsgs = [...updated, confirmationUserMsg]

      setStreaming(true)
      streamingIdRef.current = aiId
      setFailoverNotice(null)

      abortRef.current?.abort()
      const controller     = new AbortController()
      abortRef.current     = controller
      const thisGeneration = ++generationIdRef.current

      sendTurn({
        question:      `[Setting enabled] "${label}" is now ON. Retry the git action that was just blocked — the user has explicitly approved it via the in-chat toggle.`,
        priorMessages: priorMsgs,
        aiId,
        thisGeneration,
        controller,
        needsRepoContext: false,
      })

      return [...updated, confirmationUserMsg, aiPlaceholder]
    })
  }, [streaming, provider, sendTurn]) // eslint-disable-line react-hooks/exhaustive-deps


  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return {
    messages,
    chatHydrated,
    chatOpen,
    input,
    streaming,
    exporting,
    failoverNotice,
    repoIndexWarning,
    repoContextNotice,
    streamingMsgId:  streamingIdRef.current,
    textareaRef,
    messagesEndRef,
    setInput,
    setExporting,
    handleInput,
    handleKeyDown,
    handleSend,
    handleStop,
    pendingTerminateConfirm,
    confirmTerminateRun,
    cancelTerminateConfirm,
    handleNewChat,
    handleRetry,
    handleContinue,
    handleEditMessage,
    handleSwitchVersion,
    provider,
    apiKey,
    activeProviderId,
    selectedModel,
    chatTokenEstimate:   estimateChatTokens(messages),
    lastCompactionMeta:  lastCompactionRef.current,
    compactionPassCount: compactionPassRef.current,
    // ── Conversation memory ──────────────────────────────────────────────
    activeConversationId,
    conversationHistory,
    noProjectConversations,
    projectConversationGroups,
    restoreConversation,
    deleteConversation:  handleDeleteConversation,
    refreshHistory,
    // ── Plan mode ────────────────────────────────────────────────────────
    planMode,
    setPlanMode,
    approvePlan,
    modifyPlan,
    cancelPlan,
    retryStep,
    markStepDone,
    cancelExecution,
    resolvePendingToggle,
    resolveClarification,
    // ── Intent classification / Build dialog ──────────────────────────────
    classifyingIntent,
    buildDialogOpen,
    buildDialogMode,
    buildDialogSubmitting,
    buildDialogError,
    buildDialogDefaultLocation,
    browseBuildLocation,
    confirmBuildDialog,
    cancelBuildDialog,
  }
}
