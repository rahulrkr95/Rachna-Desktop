// components/AiChat.tsx
//
// Orchestrator — owns no business logic, no prompt strings, no retrieval code.
// It composes child components and the useChat hook.

import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './AiChat.module.css'
import type { AiContext } from '../types'
import { useRepoIndex, selectGraphReady } from '../store/useRepoIndex'
import { useAdditionalFoldersStore } from '../store/useAdditionalFoldersStore'
import { useFolderChipsStore } from '../store/useFolderChipsStore'
import { useEditStore, selectPendingCount } from '../services/edits/EditStore'
import { useAgentStatusStore } from '../store/useAgentStatusStore'
import { nudge } from '../services/notify'
import GraphDialog from './GraphDialog'
import { useCollapsibleBar, CollapseChevron } from './AiChat/useCollapsibleBar'

// Sub-components
import { ChatHeader, AutoApproveToggle } from './AiChat/ChatHeader'
import { ChatInput }           from './AiChat/ChatInput'
import { MessageList }         from './AiChat/MessageList'
import { ConversationSidebar } from './AiChat/ConversationSidebar'
import { TodoPanel }           from './AiChat/TodoPanel'
import { VerificationProgressRow } from './AiChat/VerificationProgressRow'
import { GeminiQuotaBanner, useGeminiQuotaStatus } from './AiChat/GeminiQuotaBanner'
import { TerminalPermissionModal } from './AiChat/TerminalPermissionModal'
import { BrowserPreferenceModal } from './AiChat/BrowserPreferenceModal'
import { TerminateRunConfirmModal } from './AiChat/TerminateRunConfirmModal'
import { BuildProjectDialog } from './AiChat/BuildProjectDialog'
import { AttachmentViewerPanel } from './AiChat/AttachmentViewerPanel'

// Hooks + utilities
import { useSpecialistStore } from '../store/useSpecialistStore'
import { SpecialistChipBar } from './AiChat/SpecialistChipBar'
import { useChat }       from './AiChat/useChat'
import { exportChatAsPdf } from './AiChat/ChatExport'

// ── NoKeyBanner ────────────────────────────────────────────────────────────────

function NoKeyBanner() {
  return (
    <div className={styles.noKeyBanner}>
      <span className={styles.noKeyIcon}>⚠</span>
      <span>No API key configured. Open <strong>Settings → AI Providers</strong> to add one.</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  context: AiContext
  welcomeMode?: boolean
  onOpenFolder?: () => void
  /**
   * Switches to a different chat scope: pass a project path to open that
   * project, or null to return to the "no project open" (welcome) scope.
   * Used when restoring a chat from the sidebar that belongs to a
   * different scope than the one currently active.
   */
  onSwitchProject?: (root: string | null) => void
  /** True only when rendered inside the Chat View dialog (see IDELayout's
   *  chatDialogMode); used purely to switch ChatHeader's toolbar layout. */
  chatDialogMode?: boolean
  /**
   * DOM node owned by IDELayout's left panel — mounted only while its
   * "Chat" tab is the active one (see IDELayout's activity bar). When
   * present, the conversation history list is portaled into it instead of
   * rendering inline, so it shares the same swappable panel as File
   * Explorer / Git / Design Canvas rather than always taking up its own
   * strip of width next to the messages.
   */
  chatHistoryContainer?: HTMLDivElement | null
  /**
   * Fired right after a past conversation is picked from the history list
   * (ConversationSidebar) and its restore has been kicked off — used by
   * IDELayout to close that panel/overlay automatically so the loaded
   * conversation is what's actually visible next, instead of leaving the
   * history list sitting open on top of it.
   */
  onConversationRestored?: () => void
  /**
   * Fired right after "New Chat" is triggered (from the header button or
   * the Chat History panel's own "+ New chat" button) — used by IDELayout
   * to retract the left panel (the docked sidebar in the normal IDE, or
   * the Chat View overlay in the dialog window), the same way
   * onConversationRestored already does for restoring a past chat, so
   * starting a fresh chat is what's actually visible afterward instead of
   * leaving the history list sitting open on top of it.
   */
  onNewChatStarted?: () => void
}

export default function AiChat({ context, welcomeMode = false, onOpenFolder, onSwitchProject, chatDialogMode = false, chatHistoryContainer = null, onConversationRestored, onNewChatStarted }: Props) {
  const {
    messages,
    chatOpen,
    input,
    streaming,
    exporting,
    failoverNotice,
    repoIndexWarning,
    repoContextNotice,
    streamingMsgId,
    textareaRef,
    messagesEndRef,
    chatHydrated,
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
    chatTokenEstimate,
    lastCompactionMeta,
    compactionPassCount,
    activeConversationId,
    conversationHistory,
    noProjectConversations,
    projectConversationGroups,
    restoreConversation,
    deleteConversation,
    refreshHistory,
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
    classifyingIntent,
    buildDialogOpen,
    buildDialogMode,
    buildDialogSubmitting,
    buildDialogError,
    buildDialogDefaultLocation,
    browseBuildLocation,
    confirmBuildDialog,
    cancelBuildDialog,
  } = useChat(context, { welcomeMode, onSwitchProject })

  // ── Entitlements ───────────────────────────────────────────────────────────
  // Restricted seats keep the Action Bar visible with its current/default
  // state, but cannot toggle Agentic/Chat mode or Plan Mode/Auto-Approve —
  // those are the only two "modify" affordances in this bar. The graph
  // chip's click just opens the (read-only) dependency graph viewer, which
  // is *using* an already-available action rather than configuring the
  // bar, so it stays clickable regardless of this entitlement.
  const { collapsed: actionsCollapsed, toggle: toggleActionsCollapsed } = useCollapsibleBar('rachna:actionsBarCollapsed')

  // Read-only reflection of the specialist chip (source of truth lives in
  // store/useSpecialistStore.ts; the chip itself renders in ChatInput's
  // footer via SpecialistChipBar). Used just below to label the indicator
  // pill and to gate the Plan Mode chip the same way the old (now removed)
  // agentMode toggle used to.
  const specialist = useSpecialistStore(s => s.specialist)

  // ── Repo index ─────────────────────────────────────────────────────────────
  const graphReady    = useRepoIndex(selectGraphReady)
  const graphSnapshot = useRepoIndex(s => s.graphSnapshot)
  const indexStatus   = useRepoIndex(s => s.status)
  const lastIndexedAt = useRepoIndex(s => s.lastIndexedAt)
  const currentProjectRoot = useRepoIndex(s => s.projectRoot)
  const [showGraph, setShowGraph] = React.useState(false)

  // ── Open-folder chips (primary project + additional folders) ────────────
  // One selectable chip per currently-open folder, shown in the ACTIONS
  // bar below. Selecting a chip is a per-turn override handled in
  // useChat.ts's executeSend — see store/useFolderChipsStore.ts.
  const additionalFolders = useAdditionalFoldersStore(s => s.folders)
  const selectedFolderPaths = useFolderChipsStore(s => s.selectedPaths)
  const toggleFolderChip = useFolderChipsStore(s => s.toggleFolder)
  const primaryFolderName = currentProjectRoot
    ? currentProjectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? currentProjectRoot
    : undefined
  const folderChips = [
    ...(currentProjectRoot
      ? [{ path: currentProjectRoot, name: primaryFolderName ?? currentProjectRoot }]
      : []),
    ...additionalFolders.map(f => ({ path: f.path, name: f.name })),
  ]

  // Drop selections for folders that are no longer open (project switched,
  // or an additional folder removed from the File Explorer) whenever the
  // open-folder set changes.
  useEffect(() => {
    useFolderChipsStore.getState().pruneToKnownPaths(folderChips.map(f => f.path))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectRoot, additionalFolders])

  // ── Pending edits ──────────────────────────────────────────────────────────
  const pendingEditCount = useEditStore(selectPendingCount)
  const acceptAll = useEditStore(s => s.acceptAll)
  const rejectAll = useEditStore(s => s.rejectAll)

  // ── Gemini daily quota (FEATURE-001) ────────────────────────────────────────
  const quotaStatus = useGeminiQuotaStatus(activeProviderId, apiKey, selectedModel)
  const quotaBlocked = !!quotaStatus?.isExhausted

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Global status mirror + completion nudge ─────────────────────────────
  // Keeps store/useAgentStatusStore in sync so the compact-mode widget
  // (components/CompactView.tsx) — which renders outside this component
  // tree while the full chat UI is hidden — can still show a live status
  // line. Also nudges the user with an OS notification when a run finishes
  // while they aren't looking at the app.
  const wasStreamingRef = React.useRef(false)
  useEffect(() => {
    const streamingMsg = streaming && streamingMsgId ? messages.find(m => m.id === streamingMsgId) : undefined
    const activities = streamingMsg?.agentActivities ?? []
    const latest = activities[activities.length - 1]

    if (streaming) {
      useAgentStatusStore.getState().setStatus(true, latest?.label ?? 'Working…')
    } else {
      useAgentStatusStore.getState().setStatus(false, 'Idle')
    }

    if (wasStreamingRef.current && !streaming) {
      nudge('Rachna AI Studio', 'Finished working on your request.')
    }
    wasStreamingRef.current = streaming
  }, [streaming, streamingMsgId, messages])

  // ── Graph chip label ───────────────────────────────────────────────────────
  const graphChipLabel =
    indexStatus === 'indexing'   ? '⟳ Indexing repo…' :
    indexStatus === 'refreshing' ? '⟳ Refreshing…'    :
    indexStatus === 'ready'      ? '✦ Index ready'     :
    indexStatus === 'error'      ? '⚠ Index error'     :
    null

  // Wraps handleNewChat so starting a fresh chat also retracts whatever
  // left panel is currently showing (docked sidebar or Chat View overlay)
  // — see onNewChatStarted's doc comment above.
  const handleNewChatAndRetract = () => {
    handleNewChat()
    onNewChatStarted?.()
  }

  // ── PDF export handler ─────────────────────────────────────────────────────
  const handleExport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      await exportChatAsPdf(messages)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── Conversation history — now lives in IDELayout's left panel
          (activity bar "Chat" tab, alongside File Explorer / Git / Design
          Canvas) instead of its own permanently-docked rail here. Portaled
          into that panel's slot so this component (which owns the actual
          history data via useChat) doesn't have to move up the tree. When
          the slot isn't mounted (panel not open, or not available in this
          render — e.g. before IDELayout registers it) nothing renders. ── */}
      {chatHistoryContainer && createPortal(
        <ConversationSidebar
          noProjectConversations={noProjectConversations}
          projectConversationGroups={projectConversationGroups}
          currentProjectRoot={currentProjectRoot}
          activeConversationId={activeConversationId}
          runningConversationId={streaming ? activeConversationId : null}
          onRestore={conversation => { restoreConversation(conversation); onConversationRestored?.() }}
          onDelete={deleteConversation}
          onNewChat={handleNewChatAndRetract}
          onRefresh={refreshHistory}
          embedded
        />,
        chatHistoryContainer,
      )}

      {/* ── Main chat panel ───────────────────────────────────────────────── */}
      <div className={styles.panel} style={{ flex: 1, minWidth: 0 }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <ChatHeader
        pendingEditCount={pendingEditCount}
        messageCount={messages.length}
        chatOpen={chatOpen}
        exporting={exporting}
        onExport={handleExport}
        onNewChat={handleNewChatAndRetract}
        chatTokenEstimate={chatTokenEstimate}
        compactionPassCount={compactionPassCount}
        lastCompactionMeta={lastCompactionMeta}
        geminiQuota={activeProviderId === 'gemini' ? quotaStatus : null}
        compactDialogLayout={chatDialogMode}
        projectOpen={!!currentProjectRoot}
        folderChips={folderChips}
        selectedFolderPaths={selectedFolderPaths}
        onToggleFolderChip={toggleFolderChip}
      />

      {/* ── Context/action bar (CHAT-001: shown in a new/empty chat too, not
          only once a conversation has started) — pinned directly below the
          header (new-chat bar) rather than scrolling away with the message
          list, so Auto-Approve/file context stay visible at all times. ─── */}
      {chatOpen && (
        <div className={`${styles.contextBar} ${actionsCollapsed ? styles.contextBarCollapsed : ''}`}>
          <div
            className={styles.contextBarHeader}
            onClick={toggleActionsCollapsed}
            role="button"
            aria-expanded={!actionsCollapsed}
            title={actionsCollapsed ? 'Expand actions' : 'Collapse actions'}
          >
            <div className={styles.contextLabel}>
              ACTIONS
            </div>
            <button
              type="button"
              className={`${styles.collapseToggle} ${actionsCollapsed ? styles.collapseToggleCollapsed : ''}`}
              onClick={e => { e.stopPropagation(); toggleActionsCollapsed() }}
              aria-label={actionsCollapsed ? 'Expand actions bar' : 'Collapse actions bar'}
            >
              <CollapseChevron />
            </button>
          </div>
          {!actionsCollapsed && (
          <div className={styles.chips}>
            {/* Specialist selector — moved here from ChatInput's footer so
                the Coding/Design/Desktop/… picker lives inside the same
                ACTIONS bar as the rest of the run configuration (Plan
                Mode, folder/file context, etc). Still backed by
                store/useSpecialistStore.ts; see SpecialistChipBar.tsx. */}
            {/* Plan Mode toggle — PLAN-001: an execution plan is always
                generated first when one is required, regardless of this
                toggle. This only controls whether that plan waits for
                your manual approval, or is approved automatically so
                execution continues right away. Not applicable when the
                CHAT specialist is selected (no classification/plan
                happens there at all). */}
            <span
              className={`${styles.chip} ${planMode ? styles.chipPlanActive : styles.chipPlan}`}
              title={specialist === 'CHAT'
                  ? 'Not applicable under the Chat specialist — messages skip planning entirely.'
                  : planMode
                    ? 'Manual approval ON — plans will be shown and wait for you to click Approve before anything runs. Click to switch to auto-approve.'
                    : 'Auto-approve ON — plans are generated and approved automatically so execution continues right away. Click to require manual approval before execution.'}
              onClick={() => specialist !== 'CHAT' && setPlanMode(!planMode)}
              aria-disabled={specialist === 'CHAT'}
              style={{
                cursor: specialist === 'CHAT' ? 'default' : 'pointer',
                userSelect: 'none',
                opacity: specialist === 'CHAT' ? 0.5 : 1,
              }}
            >
              {planMode ? '📋 Manual Approval' : '⚡ Auto-Approve'}
            </span>
            {/* Open-folder chips moved to the header's retractable,
                horizontally scrollable FolderChipsBar (see ChatHeader.tsx)
                — selection is still backed by the same
                store/useFolderChipsStore.ts and useChat.ts's executeSend. */}
            {context.file && (
              <span className={`${styles.chip} ${styles.chipFile}`}>
                📄 {context.file}
              </span>
            )}
            {context.selection && (
              <span className={`${styles.chip} ${styles.chipSel}`}>
                ⌗ {context.selection.split('\n').length} lines
              </span>
            )}
            {graphChipLabel && (
              <span
                className={`${styles.chip} ${styles.chipGraph} ${graphReady ? styles.chipGraphClickable : ''}`}
                data-status={indexStatus}
                title={
                  graphReady
                    ? 'Click to view dependency graph'
                    : lastIndexedAt
                      ? `Last indexed: ${new Date(lastIndexedAt).toLocaleTimeString()}`
                      : 'Repo search index'
                }
                onClick={graphReady ? () => setShowGraph(true) : undefined}
              >
                {graphChipLabel}
              </span>
            )}
          </div>
          )}
          {/* Auto-approve pills (Terminal / Screenshots / Mouse & Keys) —
              a second row directly below the chips above, so the
              permission toggles live inside the same ACTIONS bar instead
              of the chat header. Follows the same collapsed/expanded
              state as the rest of the Actions bar. */}
          {!actionsCollapsed && (
          <div className={styles.chips}>
            <AutoApproveToggle />
          </div>
          )}
        </div>
      )}

      {/* ── Failover notice ──────────────────────────────────────────────── */}
      {failoverNotice && (
        <div className={styles.failoverNotice}>
          🔄 {failoverNotice}
        </div>
      )}

      {/* ── Repository indexing warning (CHAT-002) ────────────────────────── */}
      {repoIndexWarning && (
        <div className={styles.failoverNotice}>
          ⚠ {repoIndexWarning}
        </div>
      )}

      {/* ── Repo Context chip: manual toggle / auto-enable warning ────────── */}
      {repoContextNotice && (
        <div className={styles.failoverNotice}>
          ⌂ {repoContextNotice}
        </div>
      )}

      {/* ── Intent classification notice (no project open yet) ───────────── */}
      {classifyingIntent && (
        <div className={styles.failoverNotice}>
          ✦ Figuring out how to start…
        </div>
      )}

      {/* ── Scrollable content region ─────────────────────────────────────
          Everything of variable height (welcome screen, messages, agent
          activity, etc.) lives in here with its own scroll, so the header,
          action bar, and ChatInput below always stay pinned and visible
          even when the window is very short (e.g. the compact overlay). ── */}
      <div className={styles.scrollRegion}>

      {/* ── Welcome screen: shown when welcomeMode is active and no messages ─ */}
      {welcomeMode && messages.length === 0 && (
        <div className={styles.welcomeScreen}>
          <div className={styles.welcomeGem} />
          <div className={styles.welcomeTitle}>Rachna AI Studio</div>
          <div className={styles.welcomeSubtitle}>Your AI coding companion. How would you like to start?</div>
          <div className={styles.welcomeChips}>
            <button
              className={styles.welcomeChip}
              onClick={() => setInput('Build an app that ')}
            >
              <span className={styles.welcomeChipIcon}>🚀</span>
              <span className={styles.welcomeChipLabel}>Build an app</span>
              <span className={styles.welcomeChipHint}>Start from scratch</span>
            </button>
            <button
              className={styles.welcomeChip}
              onClick={() => setInput('Create a website that ')}
            >
              <span className={styles.welcomeChipIcon}>🌐</span>
              <span className={styles.welcomeChipLabel}>Create a website</span>
              <span className={styles.welcomeChipHint}>Generate a full site</span>
            </button>
            <button
              className={styles.welcomeChip}
              onClick={() => setInput('Design a ')}
            >
              <span className={styles.welcomeChipIcon}>🎨</span>
              <span className={styles.welcomeChipLabel}>Create a Design</span>
              <span className={styles.welcomeChipHint}>Static Tailwind pages</span>
            </button>
            <button
              className={styles.welcomeChip}
              onClick={() => onOpenFolder?.()}
            >
              <span className={styles.welcomeChipIcon}>📂</span>
              <span className={styles.welcomeChipLabel}>Open a folder</span>
              <span className={styles.welcomeChipHint}>Work on existing code</span>
            </button>
          </div>
        </div>
      )}

      {chatOpen && (
        <>
          {/* ── Pending Edits Global Actions ─────────────────────────── */}
          {pendingEditCount > 0 && (
            <div className={styles.pendingEditsSection}>
              <div className={styles.pendingEditsHeader}>Pending Edits ({pendingEditCount})</div>
              <div className={styles.editActionButtons}>
                <button className={styles.editActionBtn} onClick={acceptAll}>
                  ✓ Merge All
                </button>
                <button className={styles.editActionBtn} onClick={rejectAll}>
                  ✕ Reject All
                </button>
              </div>
            </div>
          )}

          {/* ── No key warning ─────────────────────────────────────────── */}
          {!apiKey && <NoKeyBanner />}

          {/* ── Messages (hidden in welcome mode when chat is empty) ────── */}
          {chatHydrated && !(welcomeMode && messages.length === 0) && (
          <MessageList
            messages={messages}
            streaming={streaming}
            streamingMsgId={streamingMsgId}
            hasKey={!!apiKey}
            onRetry={handleRetry}
            onContinue={handleContinue}
            onEditMessage={handleEditMessage}
            onSwitchVersion={handleSwitchVersion}
            onApprovePlan={approvePlan}
            onModifyPlan={(payload: string) => {
              // payload = "planMsgId::user feedback text"
              const sep      = payload.indexOf('::')
              const planMsgId = sep >= 0 ? payload.slice(0, sep) : payload
              const feedback  = sep >= 0 ? payload.slice(sep + 2) : ''
              modifyPlan(planMsgId, feedback)
            }}
            onCancelPlan={cancelPlan}
            onRetryStep={retryStep}
            onMarkStepDone={markStepDone}
            onCancelExecution={cancelExecution}
            onResolveToggle={resolvePendingToggle}
            onResolveClarification={resolveClarification}
            endRef={messagesEndRef}
          />
          )}

          {/* ── Agent Execution Timeline (UX-001) ─────────────────────────
              Plan/todo progress and live verification checks, rendered
              together so the user can follow the whole turn at a glance
              instead of hunting across separate panels. ─────────────── */}
          <TodoPanel />
          <VerificationProgressRow />

          {/* ── Gemini daily quota warning / block (FEATURE-001) ─────────── */}
          <GeminiQuotaBanner providerId={activeProviderId} apiKey={apiKey} model={selectedModel} />
        </>
      )}

      </div>{/* end scrollRegion */}

      {/* ── Input area — always pinned below the scroll region, including
          in a brand-new/empty chat, so it's never pushed out of view ──── */}
      {chatOpen && (
        <ChatInput
          input={input}
          streaming={streaming}
          hasKey={!!apiKey}
          quotaBlocked={quotaBlocked}
          quotaMessage={quotaStatus?.isExhausted ? `Daily limit reached for ${quotaStatus.model} — switch models or wait for reset.` : undefined}
          indexStatus={indexStatus}
          textareaRef={textareaRef}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onSend={handleSend}
          onStop={handleStop}
          onHintClick={(h: string) => setInput((v: string) => v + h + ' ')}
          visionSupported={!!provider?.supportsVision()}
          classifying={classifyingIntent}
          compactDialogLayout={chatDialogMode}
        />
      )}

      {/* Specialist selection is independent from Actions: Actions controls
          how a task runs, while this panel chooses which specialist gets it. */}
      {chatOpen && (
        <div className={styles.specialistPanel} aria-label="Specialist">
          <SpecialistChipBar />
        </div>
      )}

      {/* ── Permanent disclaimer — always visible at the foot of the chat
          window, regardless of chat state, so it's never mistaken for a
          dismissible notice. ─────────────────────────────────────────── */}
      {chatOpen && (
        <div className={styles.aiDisclaimer}>
          Rachna AI can make mistakes. Please monitor the task it does.
        </div>
      )}

      {/* ── Graph dialog ─────────────────────────────────────────────────── */}
      {showGraph && graphSnapshot && (
        <GraphDialog
          snapshot={graphSnapshot}
          onClose={() => setShowGraph(false)}
        />
      )}

      {/* ── Terminal permission prompt ────────────────────────────────────── */}
      <TerminalPermissionModal />

      {/* ── Browser/profile picker for openDefaultBrowser ───────────────────── */}
      <BrowserPreferenceModal />
      {pendingTerminateConfirm && (
        <TerminateRunConfirmModal
          kind={pendingTerminateConfirm}
          onConfirm={confirmTerminateRun}
          onCancel={cancelTerminateConfirm}
        />
      )}

      {/* ── Code attachment viewer (long code blocks open here, not inline) ── */}
      <AttachmentViewerPanel />

      {/* ── Build New Project dialog (intent classification → BUILD_NEW_PROJECT) ── */}
      <BuildProjectDialog
        open={buildDialogOpen}
        mode={buildDialogMode}
        submitting={buildDialogSubmitting}
        error={buildDialogError}
        defaultLocation={buildDialogDefaultLocation}
        onBrowse={browseBuildLocation}
        onConfirm={confirmBuildDialog}
        onCancel={cancelBuildDialog}
      />

    </div>{/* end main chat panel */}
  </div>
  )
}
