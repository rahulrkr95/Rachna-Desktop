// components/IDELayout.tsx
//
// Top-level IDE shell. Manages panel layout, resize handles, keyboard
// shortcuts, and wires the editor store + edit store together.
//
// AI edit proposals now open as diff tabs directly inside the editor area
// (Cursor/Windsurf-style) rather than as a floating DiffPanel below the editor.
// The old DiffPanel component is no longer rendered here.

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Header from './Header'
import ChatDialogHeader from './ChatDialogHeader'
import FileExplorer from './FileExplorer'
import GitPanel from './GitPanel/GitPanel'
import EditorPane from './EditorPane'
import AiChat from './AiChat'
import StatusBar from './StatusBar'
import SettingsModal, { SetupGate } from './SettingsModal'
import TerminalPane from './Terminal/TerminalPane'
import PathViewerBar from './PathViewer/PathViewerBar'
import { usePathViewerStore } from '../store/usePathViewerStore'
import { agentTerminalBus } from '../lib/agentTerminalBus'
import styles from './IDELayout.module.css'
import type { AiContext } from '../types'
import type { FileExplorerHandle } from './FileExplorer'
import {
  useEditorStore,
  selectActiveFile,
  selectActiveDiffTab,
} from '../store/useEditorStore'
import { extToLang } from './MonacoEditor'
import { globalEditorRef } from './MonacoEditor'
import { useRepoIndex } from '../store/useRepoIndex'
import { useFileWatcher } from '../services/useFileWatcher'
import { saveFile, saveFileAs, readFile, openFolder } from '../lib/tauriFs'
import { useEditStore } from '../services/edits/EditStore'
import { useGitStore, selectCurrentBranch } from '../store/useGitStore'
import FindInFilesModal from './FindInFilesModal'
import DiskViewerModal from './DiskViewer/DiskViewerModal'
import CommandPalette from './CommandPalette'
import DoctorPanel from './DoctorPanel'
import LspSetupPanel from './LspSetupPanel'
import UpdatePanel from './UpdatePanel'
import { listLspServers } from '../services/lsp/lspInstaller'
import { hydrateMcpSecretsFromKeychain, useMcpStore } from '../store/useMcpStore'
import { registerBuiltInConnectors } from '../connectors/registry'
import { connectorManager } from '../services/connectors/ConnectorManager'
import AppRegistryPanel from './AppRegistryPanel'
import AppManagerPanel from './AppManagerPanel'
import AutomationManager from './AutomationManager'
import { useAppRegistryStore } from '../store/useAppRegistryStore'
import { useAppManagerStore } from '../store/useAppManagerStore'
import { useAutomationStore } from '../store/useAutomationStore'
import IndexingOverlay from './IndexingOverlay'
import EditReviewBar from './EditReviewBar/EditReviewBar'
import ExternalChangesBanner from './ExternalChangesBanner/ExternalChangesBanner'
import RunConfigPanel from './RunConfigPanel'
import { useRunConfigStore, selectActiveRunConfig, selectHasAnyRunConfig } from '../store/useRunConfigStore'
import { isUnsavedProjectPath, useUnsavedProjectStore} from '../store/useUnsavedProjectStore'

import { saveUnsavedProject } from '../services/projects/saveUnsavedProject'
import { getDefaultProjectsDir, pickDirectory } from '../lib/tauriFs'
import { BuildProjectDialog } from './AiChat/BuildProjectDialog'
import DesignCanvasView from './viewers/DesignCanvasView'
import { useDesignCanvasStore } from '../store/useDesignCanvasStore'
import { DESIGN_CANVAS_TAB_ID } from '../lib/designCanvasTab'
import BrowserPanel from './Browser/BrowserPanel'
import { useBrowserStore } from '../store/useBrowserStore'
import { useAuthStore } from '../store/useAuthStore'

// ── Font size persistence ──────────────────────────────────────────────────
const FONT_SIZE_KEY     = 'rachna_ide_font_size'
const FONT_SIZE_MIN     = 10
const FONT_SIZE_MAX     = 24
const FONT_SIZE_DEFAULT = 13

// ── Panel width persistence ────────────────────────────────────────────────
// NOTE: the AI Chat panel now docks on the LEFT of the workspace (ChatGPT /
// Gemini / Claude-style layout), with the File Explorer / Git panel sitting
// between it and the editor. Naming below is by *role*, not screen side, so
// it stays sane once more "apps" (agentic OS panels) get added later.
const PANEL_WIDTHS_KEY  = 'rachna_ide_panel_widths_v2'
const EXPLORER_MIN      = 140
const EXPLORER_MAX      = 480
const EXPLORER_DEFAULT  = 220
const CHAT_MIN          = 480
const CHAT_MAX          = 900
const CHAT_DEFAULT      = 560

// ── Terminal panel height persistence ─────────────────────────────────────
const TERMINAL_HEIGHT_KEY     = 'rachna_ide_terminal_height'
const TERMINAL_HEIGHT_MIN     = 100
const TERMINAL_HEIGHT_MAX     = 800
const TERMINAL_HEIGHT_DEFAULT = 220

function loadTerminalHeight(): number {
  const raw    = localStorage.getItem(TERMINAL_HEIGHT_KEY)
  const parsed = raw ? parseInt(raw, 10) : NaN
  return isNaN(parsed)
    ? TERMINAL_HEIGHT_DEFAULT
    : Math.min(TERMINAL_HEIGHT_MAX, Math.max(TERMINAL_HEIGHT_MIN, parsed))
}

function saveTerminalHeight(h: number): void {
  localStorage.setItem(TERMINAL_HEIGHT_KEY, String(h))
}

function loadFontSize(): number {
  const raw    = localStorage.getItem(FONT_SIZE_KEY)
  const parsed = raw ? parseInt(raw, 10) : NaN
  return isNaN(parsed) ? FONT_SIZE_DEFAULT : Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parsed))
}

function saveFontSize(size: number): void {
  localStorage.setItem(FONT_SIZE_KEY, String(size))
}

function loadPanelWidths(): { explorer: number; chat: number } {
  try {
    const raw = localStorage.getItem(PANEL_WIDTHS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        explorer: Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, parsed.explorer ?? EXPLORER_DEFAULT)),
        chat:     Math.min(CHAT_MAX,     Math.max(CHAT_MIN,     parsed.chat     ?? CHAT_DEFAULT)),
      }
    }
  } catch { /* ignore */ }
  return { explorer: EXPLORER_DEFAULT, chat: CHAT_DEFAULT }
}

function savePanelWidths(explorer: number, chat: number): void {
  localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify({ explorer, chat }))
}

// ── Component ─────────────────────────────────────────────────────────────
export default function IDELayout({
  theme,
  onToggleTheme,
  onToggleInspector,
  inspectorOpen,
  chatDialogMode = false,
  onCollapseToOrb,
  onExpandToFull,
}: {
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onToggleInspector?: () => void
  inspectorOpen?: boolean
  /**
   * True while the OS window is squeezed down to the medium chat-only
   * dialog (see App.tsx / services/viewModeWindow.ts). Renders just the
   * AiChat panel — no sidebar, editor, terminal, or status bar — behind a
   * small ChatDialogHeader instead of the full toolbar.
   */
  chatDialogMode?: boolean
  onCollapseToOrb?: () => void
  onExpandToFull?: () => void
}) {
  const coins = useAuthStore(state => state.userInfo?.coins)
  const [aiContext,    setAiContext]    = useState<AiContext>({ file: '', selection: '' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [doctorOpen,   setDoctorOpen]   = useState(false)
  const [lspSetupOpen, setLspSetupOpen] = useState(false)
  const [updatesOpen,  setUpdatesOpen]  = useState(false)
  // mcpOpen is sourced from useMcpStore (like runConfigOpen below) so it
  // can be opened from outside this component (e.g. useChat.ts's MCP_TASK
  // intent routing, which may be in either of the welcome-mode / IDE-mode
  // AiChat instances).
  const mcpOpen      = useMcpStore(s => s.panelOpen)
  const openMcpPanel  = useMcpStore(s => s.openPanel)
  const closeMcpPanel = useMcpStore(s => s.closePanel)

  useEffect(() => {
    if (mcpOpen) setSettingsOpen(true)
  }, [mcpOpen])
  // appRegistryOpen is likewise sourced from useAppRegistryStore so the
  // panel can be opened from outside this component if needed later, and
  // so the status pill in StatusBar and the CommandPalette entry share
  // one source of truth for open/closed.
  const appRegistryOpen        = useAppRegistryStore(s => s.panelOpen)
  const openAppRegistryPanel   = useAppRegistryStore(s => s.openPanel)
  const closeAppRegistryPanel  = useAppRegistryStore(s => s.closePanel)

  // appManagerOpen mirrors appRegistryOpen above, backed by
  // useAppManagerStore (the *running* apps panel, as opposed to the
  // *installed* apps registry).
  const appManagerOpen         = useAppManagerStore(s => s.panelOpen)
  const openAppManagerPanel    = useAppManagerStore(s => s.openPanel)
  const closeAppManagerPanel   = useAppManagerStore(s => s.closePanel)
  const automationOpen = useAutomationStore(s => s.panelOpen)
  const openAutomation = useAutomationStore(s => s.openPanel)
  const closeAutomation = useAutomationStore(s => s.closePanel)
  // runConfigOpen is now sourced from useRunConfigStore (see below) so it
  // can be opened from outside this component (e.g. useChat.ts).
  const [fontSize,     setFontSize]     = useState<number>(loadFontSize)
  const [hasSelection, setHasSelection] = useState(false)

  React.useEffect(() => {
    if (localStorage.getItem('rachna_ide_open_doctor_after_signin') === '1') {
      localStorage.removeItem('rachna_ide_open_doctor_after_signin')
      setDoctorOpen(true)
    }
  }, [])

  // ── On every launch: run doctor silently and auto-open only if failures found ──
  // Doctor no longer tracks a "seen before" marker — it just re-checks every
  // launch and only interrupts the user with the panel if something's fail.
  React.useEffect(() => {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      // Pass the currently open project's root (if any was restored on
      // launch) so this silent check doesn't flag language toolchains
      // (Rust/Python/Go) that project doesn't even use.
      invoke<Array<{ status: string }>>('doctor_check', { projectRoot: projectRoot ?? null }).then(results => {
        const hasFail = results.some(r => r.status === 'fail')
        if (hasFail) setDoctorOpen(true)
      }).catch(() => {/* ignore */})
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  // ── App mode: 'welcome' (no folder open) vs 'ide' (folder open) ───────
  // In welcome mode the chat takes full width; IDE mode shows the normal layout.
  const [appMode, setAppMode] = useState<'welcome' | 'ide'>('welcome')

  // ── View menu: sidebar visibility + Find in Files dialog ──────────────
  const [sidebarOpen,  setSidebarOpen]  = useState(true)
  const [findOpen,     setFindOpen]     = useState(false)
  const [paletteOpen,  setPaletteOpen]  = useState(false)

  // ── Left sidebar panel: 'files' (FileExplorer), 'git' (GitPanel), or
  // 'chat' (conversation history — see chatHistorySlotEl below). The
  // sidebar always shows one of these three now — Design Canvas moved to
  // a normal editor tab (design://canvas, see EditorPane/designCanvasOpen
  // above) and no longer displaces this panel in the docked IDE layout. ──
  const [leftPanel, setLeftPanel] = useState<'files' | 'git' | 'chat'>('files')

  // ── Chat history slot ──────────────────────────────────────────────────
  // AiChat.tsx owns the actual conversation-history data (via useChat) and
  // portals its <ConversationSidebar> into whichever DOM node is
  // registered here, so the "Chat" tab above can share the exact same
  // panel real estate (and resize handle) as Files/Git/Canvas without
  // lifting that state out of AiChat.
  const [chatHistorySlotEl, setChatHistorySlotEl] = useState<HTMLDivElement | null>(null)

  // ── Chat View (chatDialogMode) side panel ──────────────────────────────
  // The chat dialog window is fixed at 400×600 (see services/viewModeWindow.ts)
  // — nowhere near enough room to dock Files/Git/Canvas/Chat permanently
  // alongside the conversation the way the full IDE does. Instead the
  // activity bar rail is always visible there too, but clicking a button
  // opens the matching panel as a full-bleed overlay on top of the chat;
  // closing it (✕ or clicking the same button again) reveals the chat again.
  const [dialogPanelOpen, setDialogPanelOpen] = useState(false)

  // ── Chat View dialog's own Design Canvas visibility ────────────────────
  // chatDialogMode never renders EditorPane (see `!chatDialogMode &&` guard
  // on the editor <main> below) — there's no tab bar to put a Design tab
  // in. So the squeezed dialog keeps its own independent overlay flag here,
  // fully decoupled from the docked IDE's tab-based `designCanvasOpen`
  // (see useDesignCanvasStore.ts / lib/designCanvasTab.ts) above.
  const [dialogDesignCanvasOpen, setDialogDesignCanvasOpen] = useState(false)
  const activeWorkspaceView = useBrowserStore(s => s.activeView)
  const setWorkspaceView = useBrowserStore(s => s.setView)

  // ── New File: untitled buffer counter (resets each session) ───────────
  const untitledCounterRef = useRef(0)

  // ── Find in Files: file path + line to reveal once the tab is open ────
  const pendingRevealRef = useRef<{ path: string; line: number } | null>(null)

  // ── Panel widths ──────────────────────────────────────────────────────
  // explorerWidth = File Explorer / Git panel. chatWidth = AI Chat panel
  // (now docked on the left of the workspace).
  const [explorerWidth, setExplorerWidth] = useState(() => loadPanelWidths().explorer)
  const [chatWidth,     setChatWidth]     = useState(() => loadPanelWidths().chat)

  // ── Terminal panel state ──────────────────────────────────────────────
  const [terminalOpen,   setTerminalOpen]   = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(loadTerminalHeight)
  const [newTerminalRequest, setNewTerminalRequest] = useState(0)

  // ── Path Viewer bar state (open any file path directly in the studio) ──
  const pathViewerOpen    = usePathViewerStore(s => s.open)
  const togglePathViewer  = usePathViewerStore(s => s.toggle)
  const closePathViewer   = usePathViewerStore(s => s.setOpen)
  const [pendingRun, setPendingRun] = useState<{ command: string; cwd?: string; nonce: number } | null>(null)
  const runNonceRef = useRef(0)
  // Bumped whenever the AI agent runs a terminal command — updates the
  // read-only "Agent Terminal" tab's content, the same way Doctor Check
  // does above. terminalTool.ts (several layers away from this component)
  // announces runs via agentTerminalBus rather than a prop callback, since
  // there's no direct component relationship between the agent tool loop
  // and IDELayout.
  //
  // Note: this intentionally does NOT auto-open the Terminal panel
  // (no setTerminalOpen(true) here) — the agent running a command should
  // not force the in-app terminal to pop open on its own. If the panel is
  // already open, the Agent Terminal tab still updates live; otherwise the
  // output is simply buffered (see agentTerminalBus's replay buffer) for
  // whenever the user opens the panel themselves.
  const [agentRunRequest, setAgentRunRequest] = useState(0)
  useEffect(() => {
    const off = agentTerminalBus.onRun(() => {
      setAgentRunRequest(r => r + 1)
    })
    return off
  }, [])
  const termDragRef = useRef<{ startY: number; startH: number } | null>(null)

  const dragRef = useRef<{
    panel: 'explorer' | 'chat'
    startX: number
    startWidth: number
  } | null>(null)

  // ── Ref to FileExplorer for menu-triggered actions ────────────────────
  const fileExplorerRef = useRef<FileExplorerHandle>(null)

  // ── Zustand: editor store ─────────────────────────────────────────────
  const tabs            = useEditorStore(s => s.tabs)
  const diffTabs        = useEditorStore(s => s.diffTabs)
  const activeId        = useEditorStore(s => s.activeId)
  const activeKind      = useEditorStore(s => s.activeKind)
  const openTab         = useEditorStore(s => s.openTab)
  // ── Design Canvas tab ──────────────────────────────────────────────────
  // The canvas now renders as a normal editor tab (design://canvas) inside
  // EditorPane, alongside Monaco/PDF/Image/etc. tabs — see
  // lib/designCanvasTab.ts, components/viewers/ViewerRegistry.ts, and
  // components/EditorPane.tsx. "Open" state is therefore just editor tab
  // state: designCanvasOpen tracks whether it's the *active* tab (drives
  // the Header/activity-bar highlight, same convention every other panel
  // button already uses).
  const designCanvasOpen    = activeKind === 'file' && activeId === DESIGN_CANVAS_TAB_ID
  const toggleDesignCanvas  = useDesignCanvasStore(s => s.toggle)

  /** Design Canvas frames are view-only screenshots — "open" hands the page
   *  off to the real editor (Code/Design toggle lives there, per-file).
   *  The Design tab itself is left open in the background so the user can
   *  switch straight back to it via its tab, same as any other tab. */
  const handleOpenDesignPage = useCallback(async (path: string) => {
    try {
      if (isUnsavedProjectPath(path)) {
        const file = useUnsavedProjectStore.getState().files[path]
        if (!file) return
        openTab({
          id: file.path,
          name: file.name,
          lang: file.name.split('.').pop() ?? 'html',
          content: file.content,
          modified: false,
          kind: 'text',
          mime: 'text/plain',
          size: file.content.length,
        })
        return
      }
      const read = await readFile(path)
      const name = path.replace(/\\/g, '/').split('/').pop() ?? path
      const ext = name.split('.').pop() ?? 'html'
      openTab({
        id: path,
        name,
        lang: ext,
        content: read.content,
        modified: false,
        kind: 'text',
        mime: read.mime,
        size: read.size,
        mtime: read.modified ?? undefined,
      })
    } catch (err) {
      console.error('Failed to open design page from canvas:', err)
    }
  }, [openTab])
  const closeTab        = useEditorStore(s => s.closeTab)
  const setActiveTab    = useEditorStore(s => s.setActiveTab)
  const setActiveDiffTab = useEditorStore(s => s.setActiveDiffTab)
  const closeDiffTab    = useEditorStore(s => s.closeDiffTab)
  const updateContent   = useEditorStore(s => s.updateContent)
  const markSaved       = useEditorStore(s => s.markSaved)
  const renameTab       = useEditorStore(s => s.renameTab)
  const currentFile     = useEditorStore(selectActiveFile)
  const currentDiffTab  = useEditorStore(selectActiveDiffTab)

  // ── Repo index store ──────────────────────────────────────────────────
  const reindexFile  = useRepoIndex(s => s.reindexFile)
  const projectRoot  = useRepoIndex(s => s.projectRoot)
  const indexFolder  = useRepoIndex(s => s.indexFolder)
  const closeProject = useRepoIndex(s => s.closeProject)
  const unsavedProjectName = useUnsavedProjectStore(s => s.projectName)
  const unsavedFiles = useUnsavedProjectStore(s => s.files)
  const repoIndexStatus = useRepoIndex(s => s.status)

  // ── Save dialog for unsaved (in-memory) projects ────────────────────────
  // Reuses BuildProjectDialog (same "name + location" UI shown for the
  // build_new_project intent) instead of jumping straight to a native
  // folder picker, so saving gets the default-path prefill + Browse UI too.
  const [saveDialogOpen,           setSaveDialogOpen]           = useState(false)
  const [saveDialogSubmitting,     setSaveDialogSubmitting]     = useState(false)
  const [saveDialogError,          setSaveDialogError]          = useState<string | null>(null)
  const [saveDialogDefaultLocation, setSaveDialogDefaultLocation] = useState<string | null>(null)

  // ── Run configuration store ─────────────────────────────────────────────
  const loadRunConfigsForProject = useRunConfigStore(s => s.loadForProject)
  const resetRunConfigs          = useRunConfigStore(s => s.reset)

  const hasAnyRunConfig          = useRunConfigStore(selectHasAnyRunConfig)
  const activeRunConfig          = useRunConfigStore(selectActiveRunConfig)
  const runConfigsList           = useRunConfigStore(s => s.configs)
  const setActiveRunConfigId     = useRunConfigStore(s => s.setActive)
  // panelOpen lives in the store (not local state) so useChat.ts's
  // RUN_PROJECT intent routing can open the panel directly.
  const runConfigOpen            = useRunConfigStore(s => s.panelOpen)
  const openRunConfigPanel       = useRunConfigStore(s => s.openPanel)
  const closeRunConfigPanel      = useRunConfigStore(s => s.closePanel)

  // Load saved run configs (build/run/env) the moment a project finishes
  // its first indexing pass, so the Run menu / toolbar has them ready.
  useEffect(() => {
    if (projectRoot && repoIndexStatus === 'ready') {
      loadRunConfigsForProject(projectRoot)
    }
  }, [projectRoot, repoIndexStatus, loadRunConfigsForProject])

  // ── Git store root tracking ──────────────────────────────────────────────
  // Point useGitStore at the open folder independently of whether the
  // Source Control panel is actually mounted, so the activity bar's Git
  // icon (below) can hide itself the moment we know there's no .git
  // folder there — not only after the user has already opened the panel.
  const setGitRoot = useGitStore(s => s.setRoot)
  useEffect(() => {
    setGitRoot(projectRoot ?? null)
  }, [projectRoot, setGitRoot])
  const isGitRepo = useGitStore(s => s.isRepo)

  // ── "No run configuration yet" banner ───────────────────────────────────
  // Purely reactive to whether the workspace currently has a valid run
  // configuration — NOT a one-time-per-project nudge. This means:
  //   - it shows as soon as a freshly-indexed project turns out to have no
  //     run config, and disappears the instant one exists (created via the
  //     panel, AI detection, chat intent, etc. — anything that lands in
  //     useRunConfigStore's `configs`);
  //   - dismissing it (✕) only suppresses it for the run configs currently
  //     in that "empty" state — creating a config resets the dismissal, so
  //     if every config is later removed the banner reappears on its own,
  //     rather than staying hidden forever from one earlier dismissal.
  const runConfigLoading = useRunConfigStore(s => s.loading)
  const [runConfigBannerDismissed, setRunConfigBannerDismissed] = useState(false)

  // A fresh project (or returning to "no project") always starts from a
  // clean slate — an earlier project's dismissal must never carry over and
  // hide this project's banner.
  useEffect(() => {
    setRunConfigBannerDismissed(false)
  }, [projectRoot])

  // Once a config exists, clear any dismissal from the prior "no config"
  // state — that's what lets the banner come back automatically if every
  // config is deleted later, instead of staying dismissed indefinitely.
  useEffect(() => {
    if (hasAnyRunConfig) setRunConfigBannerDismissed(false)
  }, [hasAnyRunConfig])

  const showRunConfigBanner =
    !!projectRoot &&
    repoIndexStatus === 'ready' &&
    !runConfigLoading &&
    !hasAnyRunConfig &&
    !runConfigBannerDismissed

  // Nudge towards the Language Servers panel once a project is open and
  // indexed — the natural next step after Doctor/run-config: a language
  // was detected, so go get hover/go-to-def/diagnostics for it. Only fires
  // once per project, and only if something detected-as-relevant is
  // actually missing (no point nudging if everything's already installed).
  const [lspSetupNudge, setLspSetupNudge] = useState(false)
  const nudgedLspProjectsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!projectRoot || repoIndexStatus !== 'ready' || nudgedLspProjectsRef.current.has(projectRoot)) {
      return
    }
    let cancelled = false
    listLspServers(projectRoot).then(servers => {
      if (cancelled) return
      nudgedLspProjectsRef.current.add(projectRoot)
      if (servers.some(s => s.relevant && s.status === 'not_installed')) {
        setLspSetupNudge(true)
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [projectRoot, repoIndexStatus])

  // Clear run-config state when the project closes so a stale project's
  // configs don't leak into the next one opened. (The run-config banner's
  // own dismissal flag is already reset by the projectRoot-keyed effect
  // above, which fires for this transition too.)
  useEffect(() => {
    if (!projectRoot) {
      resetRunConfigs()
      setLspSetupNudge(false)
    }
  }, [projectRoot, resetRunConfigs])

  // Sends `command` to a fresh embedded terminal tab and reveals the panel.
  // Used by RunConfigPanel's "Run" button and by the Run menu/toolbar.
  // `cwd` may be relative (to the project root) or absolute; relative paths
  // are resolved here so callers don't each have to know the project root.
  const handleRunCommand = useCallback((command: string, cwd?: string) => {
    let resolvedCwd = cwd
    if (cwd && projectRoot && !/^([a-zA-Z]:)?[\\/]/.test(cwd)) {
      resolvedCwd = `${projectRoot.replace(/[\\/]+$/, '')}/${cwd.replace(/^[\\/]+/, '')}`
    }
    runNonceRef.current += 1
    setPendingRun({ command, cwd: resolvedCwd, nonce: runNonceRef.current })
    setTerminalOpen(true)
  }, [projectRoot])

  // Long-running dev servers the AI agent starts (npm run dev, vite, next
  // dev, ...) don't go through run_terminal_command's execute-and-wait path
  // — terminalTool.ts detects them and announces a launch request instead,
  // which lands here and reuses the exact same fresh-tab mechanism as the
  // Run Configuration panel's "Run" button (handleRunCommand above).
  useEffect(() => {
    const off = agentTerminalBus.onLaunch(({ command, cwd }) => {
      handleRunCommand(command, cwd)
    })
    return off
  }, [handleRunCommand])

  // Run menu / toolbar entry point: executes the active run config's build
  // then run command, or opens the panel if nothing is configured yet.
  const handleRunProject = useCallback(() => {
    if (!activeRunConfig || !activeRunConfig.run_command.trim()) {
      openRunConfigPanel()
      return
    }
    const envEntries = (() => {
      try {
        const parsed = JSON.parse(activeRunConfig.env_json || '{}')
        return Object.entries(parsed).map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
      } catch {
        return []
      }
    })()
    const prefix = envEntries.length ? `${envEntries.join(' && ')} && ` : ''
    handleRunCommand(`${prefix}${activeRunConfig.run_command}`, activeRunConfig.cwd ?? undefined)
  }, [activeRunConfig, handleRunCommand])

  // Toolbar "Build" button: runs the active run config's build command in
  // the embedded terminal, or opens the panel if nothing is configured yet.
  const handleBuildProject = useCallback(() => {
    if (!activeRunConfig || !activeRunConfig.build_command.trim()) {
      openRunConfigPanel()
      return
    }
    handleRunCommand(activeRunConfig.build_command, activeRunConfig.cwd ?? undefined)
  }, [activeRunConfig, handleRunCommand])

  // Switch to IDE mode as soon as a folder is opened, or a file tab is
  // opened directly (e.g. "Open in Editor" on a chat code attachment,
  // which has no project associated with it).
  useEffect(() => {
    if (
      (projectRoot || tabs.length > 0 || unsavedProjectName) &&
      appMode === 'welcome'
    ) {
      setAppMode('ide')
    }
  }, [projectRoot, tabs.length, unsavedProjectName, appMode])

  useEffect(() => {
    if (!unsavedProjectName) return

    setSidebarOpen(true)
    setLeftPanel('files')
  }, [unsavedProjectName])
  
  const autoOpenedUnsavedDesignRef = useRef<string | null>(null)
  useEffect(() => {
    if (!unsavedProjectName) {
      autoOpenedUnsavedDesignRef.current = null
      return
    }

    // Design Project flow: the Design Canvas (opened by beginUnsavedSession)
    // is the intended landing view for an unsaved design session, not the
    // code editor — skip auto-opening a file tab here so the canvas stays
    // the active view instead of being covered by an auto-opened Monaco tab.
    if (designCanvasOpen) return

    const files = Object.values(unsavedFiles)
    if (files.length === 0) return

    const preferredFile =
      files.find(file => file.name.toLowerCase() === 'index.html') ??
      files.find(file => file.name.toLowerCase().endsWith('.html')) ??
      files[0]

    if (!preferredFile) return

    const existingTab = useEditorStore
      .getState()
      .tabs
      .find(tab => tab.id === preferredFile.path)

    if (existingTab) {
      if (!existingTab.modified && existingTab.content !== preferredFile.content) {
        useEditorStore.setState(state => ({
          tabs: state.tabs.map(tab =>
            tab.id === preferredFile.path
              ? {
                  ...tab,
                  content: preferredFile.content,
                  size: preferredFile.content.length,
                }
              : tab
          ),
        }))
      }
      return
    }

    const ext = preferredFile.name.split('.').pop() ?? 'txt'

    openTab({
      id: preferredFile.path,
      name: preferredFile.name,
      lang: ext,
      content: preferredFile.content,
      modified: false,
      kind: 'text',
      mime: 'text/plain',
      size: preferredFile.content.length,
    })

    autoOpenedUnsavedDesignRef.current = preferredFile.path
  }, [unsavedProjectName, unsavedFiles, openTab, designCanvasOpen])  

  // Mount the incremental file watcher.  Starts/stops automatically as the
  // open project root changes.  Emits file-changed batches to
  // useRepoIndex.reindexChangedFiles — no full re-scan on every save.
  useFileWatcher()

  // Load MCP secrets into memory, but do not start any MCP processes during
  // app startup. A matching enabled server is connected lazily when an MCP
  // task actually needs it (see useChat.ts).
  useEffect(() => {
    hydrateMcpSecretsFromKeychain().catch(err => {
      console.error('Failed to hydrate MCP secrets from OS keychain:', err)
    })
  }, [])

  // ── Connector framework startup: register built-in connectors, then
  //    auto-connect any that already have stored credentials. ──────────
  useEffect(() => {
    registerBuiltInConnectors()
    let cancelled = false
    ;(async () => {
      for (const manifest of connectorManager.list()) {
        if (cancelled) return
        const authed = await connectorManager.isAuthenticated(manifest.id)
        if (authed && !connectorManager.isConnected(manifest.id)) {
          await connectorManager.connect(manifest.id, projectRoot).catch(() => {})
        }
      }
    })()
    return () => { cancelled = true }
  }, [projectRoot])

  // ── Git store (current branch, for the status bar) ────────────────────
  const currentBranch    = useGitStore(selectCurrentBranch)
  const gitRefreshStatus = useGitStore(s => s.refreshStatus)

  // ── Edit store (for Undo-as-Reject/Revert on diff tabs) ───────────────
  const rejectEdit   = useEditStore(s => s.rejectEdit)
  const revertEdit   = useEditStore(s => s.revertEdit)
  const getEdit      = useEditStore(s => (id: string) => s.edits.find(e => e.id === id))

  // ── Track Monaco selection for Edit menu context ──────────────────────
  useEffect(() => {
    const editor = globalEditorRef.current
    if (!editor) return
    const disposable = editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection()
      setHasSelection(!!sel && !sel.isEmpty())
    })
    return () => disposable.dispose()
  })

  // ── Keep AI context in sync with the active editor tab ────────────────
  useEffect(() => {
    if (currentDiffTab) {
      // When a diff tab is active, supply its file path as context but
      // don't supply content (it's a review surface, not an editable buffer)
      setAiContext(prev => ({
        ...prev,
        file:     currentDiffTab.fileName,
        filePath: currentDiffTab.filePath,
        fileContent: undefined,
        language: currentDiffTab.language,
      }))
      return
    }

    if (!currentFile) {
      setAiContext(prev => (prev.file ? { file: '', selection: '' } : prev))
      return
    }

    setAiContext(prev => ({
      ...prev,
      file:        currentFile.name,
      filePath:    currentFile.id,
      fileContent: currentFile.content,
      language:    extToLang(currentFile.lang),
    }))
  }, [currentFile, currentDiffTab])

  // ── Persist font size whenever it changes ─────────────────────────────
  useEffect(() => { saveFontSize(fontSize) }, [fontSize])

  // ── Persist panel widths whenever they change ─────────────────────────
  useEffect(() => { savePanelWidths(explorerWidth, chatWidth) }, [explorerWidth, chatWidth])

  const handleFontSizeChange = (size: number) => {
    setFontSize(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size)))
  }

  // ── Drag-to-resize ────────────────────────────────────────────────────
  // Both panels now grow when their (shared) resize handle is dragged to the
  // right, since both the chat panel (leftmost) and the explorer panel
  // (between the activity bar and the editor) have their draggable edge on
  // their right side.
  const startResize = useCallback((panel: 'explorer' | 'chat', e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = {
      panel,
      startX: e.clientX,
      startWidth: panel === 'explorer' ? explorerWidth : chatWidth,
    }
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [explorerWidth, chatWidth])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const { panel, startX, startWidth } = dragRef.current
      const delta = e.clientX - startX

      if (panel === 'explorer') {
        const next = Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, startWidth + delta))
        setExplorerWidth(next)
      } else {
        const next = Math.min(CHAT_MAX, Math.max(CHAT_MIN, startWidth + delta))
        setChatWidth(next)
      }
    }

    const onMouseUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup',   onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup',   onMouseUp)
    }
  }, [])

  // ── Terminal vertical resize ──────────────────────────────────────────
  const startTermResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    termDragRef.current = { startY: e.clientY, startH: terminalHeight }
    document.body.style.cursor     = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [terminalHeight])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!termDragRef.current) return
      const { startY, startH } = termDragRef.current
      const delta = startY - e.clientY // drag up = taller
      const next = Math.min(TERMINAL_HEIGHT_MAX, Math.max(TERMINAL_HEIGHT_MIN, startH + delta))
      setTerminalHeight(next)
    }
    const onMouseUp = () => {
      if (!termDragRef.current) return
      saveTerminalHeight(terminalHeight)
      termDragRef.current = null
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup',   onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup',   onMouseUp)
    }
  }, [terminalHeight])

  // ── Ctrl+S / Cmd+S: save active file and trigger re-index ─────────────
  // Does nothing when a diff tab is active (saves happen via Accept button)
  const handleSave = useCallback(async () => {
    if (!currentFile) return

    if (isUnsavedProjectPath(currentFile.id)) {
      setSaveDialogError(null)
      setSaveDialogOpen(true)

      getDefaultProjectsDir()
        .then(setSaveDialogDefaultLocation)
        .catch(() => setSaveDialogDefaultLocation(null))

      return
    }

    try {
      await saveFile({ path: currentFile.id, content: currentFile.content })
      markSaved(currentFile.id)
      reindexFile(currentFile.id)
      // Refresh git status so source control reflects the saved change immediately.
      gitRefreshStatus().catch(() => { /* non-fatal — git panel shows stale state */ })
    } catch {
      // Save failure doesn't crash the IDE — the tab stays "modified"
    }
  }, [currentFile, markSaved, reindexFile, gitRefreshStatus])

  // ── Design Canvas "Save Design Project" button: same Save dialog as
  // Ctrl+S above, but reachable with zero tabs open (a fresh unsaved
  // design project has nothing open in the editor yet — everything lives
  // on the canvas until the user opens a page or saves). ────────────────
  const openSaveProjectDialog = useCallback(() => {
    setSaveDialogError(null)
    setSaveDialogOpen(true)
    getDefaultProjectsDir()
      .then(setSaveDialogDefaultLocation)
      .catch(() => setSaveDialogDefaultLocation(null))
  }, [])

  // ── Save dialog (unsaved project) handlers ──────────────────────────────
  /** Opens a native folder picker for the Save dialog's "location" field. */
  const browseSaveLocation = useCallback(async (): Promise<string | null> => {
    try {
      return await pickDirectory('Choose where to save this project')
    } catch {
      return null
    }
  }, [])

  /**
   * Writes every in-memory file to {location}/{projectName} on disk,
   * repoints open tabs at their real paths, then indexes the new folder.
   */
  const confirmSaveDialog = useCallback(async (location: string, projectName: string) => {
    setSaveDialogSubmitting(true)
    setSaveDialogError(null)
    try {
      // Only rename if the user actually changed it — renameProject just
      // updates the display name and leaves in-memory files untouched.
      if (projectName !== unsavedProjectName) {
        useUnsavedProjectStore.getState().renameProject(projectName)
      }

      const root = await saveUnsavedProject({ destination: location })

      if (!root) {
        setSaveDialogError('Nothing to save.')
        return
      }

      await indexFolder(root)

      // If a Design Canvas session was in flight for this project, this
      // is the moment its underlying files just landed on disk — remap
      // its (previously unsaved://-prefixed) nodes onto their real paths
      // and write the canvas itself out as a .rachna_design Design
      // Project, right alongside the files this same Save just wrote.
      const canvas = useDesignCanvasStore.getState()
      // projectName is only ever set by beginUnsavedSession/openFromFilePicker/
      // rescan (see useDesignCanvasStore.ts) — projectName set + no
      // projectRoot yet means "an unsaved design session is in flight".
      if (canvas.projectName && !canvas.projectRoot) {
        canvas.transferToSavedRoot(root)
        await canvas.saveManifest().catch(err => {
          console.error('Failed to save Design Project manifest:', err)
        })
      }

      setSaveDialogOpen(false)
    } catch (error) {
      console.error('Failed to save unsaved project:', error)
      setSaveDialogError(error instanceof Error ? error.message : 'Failed to save project.')
    } finally {
      setSaveDialogSubmitting(false)
    }
  }, [unsavedProjectName, indexFolder])

  /** Closes the Save dialog without writing anything to disk. */
  const cancelSaveDialog = useCallback(() => {
    setSaveDialogOpen(false)
    setSaveDialogError(null)
  }, [])

  // ── File > New File: opens an untitled in-memory buffer ────────────────
  // Not written to disk until Save / Save As is used on it.
  const handleNewFile = useCallback(() => {
    untitledCounterRef.current += 1
    const n = untitledCounterRef.current
    openTab({
      id:       `untitled:${n}`,
      name:     `Untitled-${n}`,
      lang:     'txt',
      content:  '',
      modified: false,
      kind:     'text',
      mime:     'text/plain',
    })
  }, [openTab])

  // ── File > Save As: writes the active tab's content to a new path ─────
  // chosen via the native Save dialog, then repoints the tab at that path.
  const handleSaveAs = useCallback(async () => {
    if (!currentFile) return
    try {
      const newPath = await saveFileAs(currentFile.content, currentFile.name)
      const newName = newPath.replace(/\\/g, '/').split('/').pop() ?? newPath
      renameTab(currentFile.id, newPath, newName)
      reindexFile(newPath)
    } catch {
      // User cancelled the dialog, or write failed — leave the tab as-is.
    }
  }, [currentFile, renameTab, reindexFile])

  // ── File > Save All: saves every modified tab ──────────────────────────
  // Untitled buffers (no real path yet) go through Save As individually.
  const handleSaveAll = useCallback(async () => {
    const dirtyTabs = useEditorStore.getState().tabs.filter(t => t.modified)
    for (const t of dirtyTabs) {
      try {
        if (t.id.startsWith('untitled:')) {
          const newPath = await saveFileAs(t.content, t.name)
          const newName = newPath.replace(/\\/g, '/').split('/').pop() ?? newPath
          renameTab(t.id, newPath, newName)
          reindexFile(newPath)
        } else {
          await saveFile({ path: t.id, content: t.content })
          markSaved(t.id)
          reindexFile(t.id)
        }
      } catch {
        // Skip files that fail to save (or whose dialog was cancelled)
        // so one failure doesn't block saving the rest.
      }
    }
  }, [renameTab, markSaved, reindexFile])

  // ── Edit > Find in Files: open (or focus) a result, then reveal the line ─
  const handleFindResultSelect = useCallback(async (filePath: string, line: number) => {
    const existing = useEditorStore.getState().tabs.find(t => t.id === filePath)
    if (existing) {
      setActiveTab(filePath)
    } else {
      try {
        const { content, path, kind, mime, size, modified } = await readFile(filePath)
        const ext = path.split('.').pop() ?? 'txt'
        openTab({ id: path, name: path.split(/[\\/]/).pop() ?? path, lang: ext, content, modified: false, kind, mime, size, mtime: modified })
      } catch {
        return
      }
    }
    pendingRevealRef.current = { path: filePath, line }
  }, [setActiveTab, openTab])

  // Once the target tab becomes active and Monaco mounts, scroll to + select the line.
  useEffect(() => {
    const pending = pendingRevealRef.current
    if (!pending || !currentFile || currentFile.id !== pending.path) return

    let frame = 0
    let raf: number
    const tryReveal = () => {
      const editor = globalEditorRef.current
      if (editor) {
        editor.revealLineInCenter(pending.line)
        editor.setPosition({ lineNumber: pending.line, column: 1 })
        editor.focus()
        pendingRevealRef.current = null
        return
      }
      frame += 1
      if (frame < 30) raf = requestAnimationFrame(tryReveal)
    }
    raf = requestAnimationFrame(tryReveal)
    return () => cancelAnimationFrame(raf)
  }, [currentFile])

  // ── Open folder: works in both welcome and IDE modes ─────────────────
  // In welcome mode, FileExplorer is not mounted so we handle it here directly.
  // In IDE mode, we delegate to the FileExplorer ref so its internal state stays in sync.
  const handleOpenFolderDirect = useCallback(async () => {
    if (appMode === 'ide' && fileExplorerRef.current) {
      fileExplorerRef.current.openFolder()
      return
    }
    try {
      const root = await openFolder()
      if (root) {
        indexFolder(root.path)
        // appMode switches to 'ide' automatically via the projectRoot useEffect
      }
    } catch {
      // User cancelled or dialog failed — stay in welcome mode
    }
  }, [appMode, indexFolder])

  // ── Open Design Project: picks a .rachna_design manifest, indexes its
  // parent folder as the active project, and restores the saved canvas
  // (viewport, node positions, node metadata). ─────────────────────────
  const handleOpenDesignProject = useCallback(async () => {
    try {
      const root = await useDesignCanvasStore.getState().openFromFilePicker()
      if (root) {
        indexFolder(root)
        // appMode switches to 'ide' automatically via the projectRoot
        // effect, same as handleOpenFolderDirect above; the canvas is
        // already open (openFromFilePicker sets isOpen) once it lands.
      }
    } catch (err) {
      console.error('Failed to open design project:', err)
    }
  }, [indexFolder])

  const handleOpenRecentDesignProject = useCallback(async (manifestPath: string) => {
    try {
      const root = await useDesignCanvasStore.getState().openRecentProject(manifestPath)
      indexFolder(root)
    } catch (err) {
      console.error('Failed to reopen design project:', err)
    }
  }, [indexFolder])


  // ── Close Project: tear down the open project and return to welcome mode ──
  // Closes every open file/diff tab, collapses the terminal, resets the
  // repo index (projectRoot, scan result, graph), and flips appMode back
  // to 'welcome' so the full-width chat view (new-chat-style) reappears.
  const handleCloseProject = useCallback(() => {
    tabs.forEach(t => closeTab(t.id))
    diffTabs.forEach(t => closeDiffTab(t.id))
    setTerminalOpen(false)
    setLeftPanel('files')
    closeProject()
    setAppMode('welcome')
  }, [tabs, diffTabs, closeTab, closeDiffTab, closeProject])

  // ── Switch chat scope: used when restoring a sidebar chat that belongs
  // to a different project (or the no-project scope) than the one
  // currently active. Mirrors handleCloseProject's teardown, then either
  // opens the target project or returns to the welcome screen — AiChat's
  // useChat hook picks up the resulting projectRoot change and hydrates
  // the specific conversation it was asked to restore.
  const handleSwitchProject = useCallback((root: string | null) => {
    tabs.forEach(t => closeTab(t.id))
    diffTabs.forEach(t => closeDiffTab(t.id))
    setTerminalOpen(false)
    setLeftPanel('files')
    if (root === null) {
      closeProject()
      setAppMode('welcome')
    } else {
      indexFolder(root)
      setAppMode('ide')
    }
  }, [tabs, diffTabs, closeTab, closeDiffTab, closeProject, indexFolder])

  const handleNewEmbeddedTerminal = useCallback(() => {
    if (terminalOpen) setNewTerminalRequest(request => request + 1)
    setTerminalOpen(true)
  }, [terminalOpen])

  // ── Header "⎇ main" branch chip (btnGit): opens the Source Control
  // panel — same panel as the activity-bar Git icon — making sure the
  // sidebar is visible first. No-op when no project is open yet, since
  // there's no repo to show source control for.
  const handleOpenGit = useCallback(() => {
    if (appMode !== 'ide' || !projectRoot) return
    setSidebarOpen(true)
    setLeftPanel('git')
  }, [appMode, projectRoot])

  // ── Header "🎨 Canvas" button ────────────────────────────────────────────
  // The Design Canvas now renders as a normal editor tab (design://canvas)
  // inside EditorPane — see useDesignCanvasStore.ts / lib/designCanvasTab.ts
  // — so toggling it is purely editor-tab state (open/focus it, or hand
  // focus back to whatever else was open, exactly like clicking a tab).
  // The File Explorer stays put in the left sidebar regardless; it's no
  // longer displaced by Canvas the way it used to be.
  const handleToggleDesignCanvas = useCallback(() => {
    toggleDesignCanvas()
  }, [toggleDesignCanvas])

  // ── Left panel activity bar — shared between the docked IDE sidebar and
  // the Chat View overlay (see dialogPanelOpen above). In the docked case
  // a click just switches which panel is showing (it's always visible).
  // In Chat View there's no room to dock anything permanently, so a click
  // instead opens that panel as a full-bleed overlay on top of the
  // conversation — and clicking the SAME button again (or the overlay's
  // own ✕) closes it back down to the chat, like a mobile nav drawer.
  const handleActivityCanvasClick = useCallback(() => {
    if (chatDialogMode) {
      if (dialogDesignCanvasOpen && dialogPanelOpen) {
        setDialogPanelOpen(false)
        setDialogDesignCanvasOpen(false)
      } else {
        setDialogDesignCanvasOpen(true)
        setDialogPanelOpen(true)
      }
      return
    }
    handleToggleDesignCanvas()
  }, [chatDialogMode, dialogDesignCanvasOpen, dialogPanelOpen, handleToggleDesignCanvas])

  const handleActivityPanelClick = useCallback((panel: 'files' | 'git' | 'chat') => {
    if (chatDialogMode) {
      if (dialogPanelOpen && !dialogDesignCanvasOpen && leftPanel === panel) {
        setDialogPanelOpen(false)
      } else {
        if (dialogDesignCanvasOpen) setDialogDesignCanvasOpen(false)
        setLeftPanel(panel)
        setDialogPanelOpen(true)
      }
      return
    }
    setLeftPanel(panel)
    setSidebarOpen(true)
  }, [chatDialogMode, dialogPanelOpen, dialogDesignCanvasOpen, leftPanel])

  // Fired once a past conversation has been picked from the "Chat History"
  // panel (ConversationSidebar) and its messages are loading. The history
  // list is a pick-one-and-go view, not something to stay pinned open like
  // File Explorer — so, mirroring how FileExplorer/DesignCanvasView already
  // close the Chat View overlay on navigation (finishOverlayNavigation in
  // renderLeftPanelBody), this closes that overlay in chatDialogMode, and
  // falls back to the docked sidebar's default (Explorer) panel otherwise,
  // so the loaded conversation is what's actually visible afterward.
  const closeChatHistoryPanel = useCallback(() => {
    if (chatDialogMode) {
      setDialogPanelOpen(false)
      onExpandToFull?.()
      return
    }
    setLeftPanel('files')
  }, [chatDialogMode, onExpandToFull])

  // Fired after "New Chat" is triggered from either the ChatHeader button
  // or the Chat History panel's own "+ New chat" button (see AiChat's
  // onNewChatStarted) — retracts whatever left panel is currently open,
  // the same way closeChatHistoryPanel does after restoring a past chat.
  // In the docked IDE this fully collapses the sidebar (setSidebarOpen
  // false) rather than just switching its tab, since "New Chat" should
  // read as "get the panel out of the way", not "show me Explorer".
  const handleNewChatRetract = useCallback(() => {
    if (chatDialogMode) {
      setDialogPanelOpen(false)
      onExpandToFull?.()
      return
    }
    setSidebarOpen(false)
  }, [chatDialogMode, onExpandToFull])

  // ── View > Zoom: adjusts the shared editor font size ───────────────────
  const handleZoomIn    = useCallback(() => handleFontSizeChange(fontSize + 1), [fontSize])
  const handleZoomOut   = useCallback(() => handleFontSizeChange(fontSize - 1), [fontSize])
  const handleZoomReset = useCallback(() => handleFontSizeChange(FONT_SIZE_DEFAULT), [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault()
        e.stopPropagation()
        handleNewEmbeddedTerminal()
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === '`' || e.code === 'Backquote')) {
        e.preventDefault()
        e.stopPropagation()
        setTerminalOpen(prev => !prev)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault()
        setFindOpen(true)
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault()
        togglePathViewer()
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault()
        setPaletteOpen(prev => !prev)
      }
      // Ctrl+Z / Cmd+Z when a diff tab is active → Reject (pending) or Revert (accepted)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        const { activeKind: kind, activeId: aid, diffTabs: dts } = useEditorStore.getState()
        if (kind === 'diff' && aid) {
          const diffTab = dts.find(t => t.id === aid)
          if (diffTab) {
            const edit = useEditStore.getState().edits.find(ed => ed.id === diffTab.editId)
            if (edit?.status === 'accepted') {
              e.preventDefault()
              useEditStore.getState().revertEdit(diffTab.editId)
            } else if (edit?.status === 'pending') {
              e.preventDefault()
              useEditStore.getState().rejectEdit(diffTab.editId)
              useEditorStore.getState().closeDiffTab(aid)
            }
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSave, handleNewEmbeddedTerminal, togglePathViewer])

  // ── Left panel body — shared between the docked IDE sidebar (aside,
  // always visible) and the Chat View overlay (see dialogPanelOpen). The
  // docked sidebar only ever shows Explorer/Git/Chat History now — Design
  // Canvas moved to a normal editor tab (see EditorPane/designCanvasOpen
  // above) instead of occupying this space. The chatDialogMode overlay has
  // no editor pane to put a tab in, so it still renders DesignCanvasView
  // directly here, gated on its own `dialogDesignCanvasOpen` flag.
  const renderLeftPanelBody = useCallback((opts: { inDialogOverlay?: boolean } = {}) => {
    const { inDialogOverlay = false } = opts
    const finishOverlayNavigation = () => {
      if (!inDialogOverlay) return
      setDialogPanelOpen(false)
      onExpandToFull?.()
    }

    if (inDialogOverlay && dialogDesignCanvasOpen && (projectRoot || unsavedProjectName)) {
      return (
        <DesignCanvasView
          projectRoot={projectRoot}
          onOpenFile={(path) => { handleOpenDesignPage(path); finishOverlayNavigation() }}
          onClose={() => { setDialogDesignCanvasOpen(false); setDialogPanelOpen(false) }}
          onOpenRecentProject={handleOpenRecentDesignProject}
          onRequestSaveProject={openSaveProjectDialog}
        />
      )
    }
    if (leftPanel === 'files') {
      return (
        <FileExplorer
          ref={fileExplorerRef}
          activeFilePath={currentFile?.id ?? ''}
          onCloseProject={handleCloseProject}
          onFileOpen={({ path, content, name, kind, mime, size, modified }) => {
            const ext = name.split('.').pop() ?? 'txt'
            openTab({
              id: path,
              name,
              lang: ext,
              content,
              modified: false,
              kind,
              mime,
              size,
              mtime: modified,
            })
            finishOverlayNavigation()
          }}
        />
      )
    }
    if (leftPanel === 'git') {
      return <GitPanel />
    }
    // 'chat' — the actual conversation-history UI lives in AiChat.tsx
    // (it owns the data via useChat) and portals itself into this slot;
    // registering the DOM node here is all this panel needs to do.
    return <div ref={setChatHistorySlotEl} className={styles.chatHistorySlot} />
  }, [
    dialogDesignCanvasOpen, projectRoot, unsavedProjectName, handleOpenDesignPage,
    openSaveProjectDialog, leftPanel, currentFile, handleCloseProject, openTab, onExpandToFull,
  ])

  return (
    <SetupGate>
    <div className={styles.root}>
      {chatDialogMode ? (
        <ChatDialogHeader
          onCollapseToOrb={() => onCollapseToOrb?.()}
          onExpandToFull={() => onExpandToFull?.()}
        />
      ) : (
      <Header
        onSettingsClick={() => setSettingsOpen(true)}
        theme={theme}
        onToggleTheme={onToggleTheme}
        hasProject={!!projectRoot}
        hasActiveTab={!!currentFile}
        hasSelection={hasSelection}
        onToggleInspector={onToggleInspector}
        inspectorOpen={inspectorOpen}
        onOpenGit={handleOpenGit}
        isGitRepo={!!isGitRepo}
        runConfigs={runConfigsList}
        activeRunConfigId={activeRunConfig?.id ?? null}
        onSelectRunConfig={setActiveRunConfigId}
        onConfigureRun={() => openRunConfigPanel()}
        onBuild={handleBuildProject}
        onRun={handleRunProject}
        onToggleDesignCanvas={handleToggleDesignCanvas}
        designCanvasOpen={designCanvasOpen}
        onMenuAction={(action) => {
          const editor = globalEditorRef.current

          switch (action) {
            // ── File ────────────────────────────────────────────────
            case 'file:openFolder':
              handleOpenFolderDirect()
              break
            case 'file:openDesignProject':
              handleOpenDesignProject()
              break
            case 'file:new':
              handleNewFile()
              break
            case 'file:save':
              handleSave()
              break
            case 'file:saveAs':
              handleSaveAs()
              break
            case 'file:saveAll':
              handleSaveAll()
              break
            case 'file:closeTab':
              if (activeId) closeTab(activeId)
              break
            case 'file:closeAll':
              tabs.forEach(t => closeTab(t.id))
              break

            // ── Edit — Monaco trigger commands ───────────────────────
            case 'edit:undo':
              // If a diff tab is active, treat Undo as Reject (pending) or Revert (accepted)
              if (activeKind === 'diff' && activeId) {
                const diffTab = diffTabs.find(t => t.id === activeId)
                if (diffTab) {
                  const edit = getEdit(diffTab.editId)
                  if (edit?.status === 'accepted') {
                    revertEdit(diffTab.editId)
                  } else if (edit?.status === 'pending') {
                    rejectEdit(diffTab.editId)
                    closeDiffTab(activeId)
                  }
                  break
                }
              }
              editor?.trigger('menu', 'undo', null)
              editor?.focus()
              break
            case 'edit:redo':
              editor?.trigger('menu', 'redo', null)
              editor?.focus()
              break
            case 'edit:cut':
              editor?.trigger('menu', 'editor.action.clipboardCutAction', null)
              editor?.focus()
              break
            case 'edit:copy':
              editor?.trigger('menu', 'editor.action.clipboardCopyAction', null)
              editor?.focus()
              break
            case 'edit:paste':
              editor?.trigger('menu', 'editor.action.clipboardPasteAction', null)
              editor?.focus()
              break
            case 'edit:selectAll':
              editor?.trigger('menu', 'editor.action.selectAll', null)
              editor?.focus()
              break
            case 'edit:find':
              editor?.trigger('menu', 'actions.find', null)
              break
            case 'edit:replace':
              editor?.trigger('menu', 'editor.action.startFindReplaceAction', null)
              break
            case 'edit:format':
              editor?.trigger('menu', 'editor.action.formatDocument', null)
              editor?.focus()
              break
            case 'edit:findAll':
              setFindOpen(true)
              break

            // ── View ──────────────────────────────────────────────────
            case 'view:sidebar':
              setSidebarOpen(prev => !prev)
              break
            case 'view:terminal':
              setTerminalOpen(prev => !prev)
              break
            case 'terminal:new':
              handleNewEmbeddedTerminal()
              break
            case 'view:zoomIn':
              handleZoomIn()
              break
            case 'view:zoomOut':
              handleZoomOut()
              break
            case 'view:zoomReset':
              handleZoomReset()
              break

            // ── Help ──────────────────────────────────────────────────
            case 'help:palette':
              setPaletteOpen(true)
              break
            case 'view:theme':
              onToggleTheme()
              break
            case 'file:settings':
              setSettingsOpen(true)
              break
            case 'help:doctor':
              setDoctorOpen(true)
              break
            case 'help:lsp-setup':
              setLspSetupOpen(true)
              break
            case 'help:mcp':
              openMcpPanel()
              break
            case 'help:app-registry':
              openAppRegistryPanel()
              break
            case 'help:updates':
              setUpdatesOpen(true)
              break

            // ── Run ───────────────────────────────────────────────────
            case 'run:config':
              openRunConfigPanel()
              break
            case 'run:start':
            case 'run:noDebug':
              handleRunProject()
              break
            case 'run:stop':
              // No-op for now — stopping means closing the terminal tab
              // the run is executing in; there's no single "the" run
              // process to track yet.
              break

            default:
              console.debug('[MenuAction]', action)
          }
        }}
      />
      )}

      {!chatDialogMode && <ExternalChangesBanner />}

      {!chatDialogMode && showRunConfigBanner && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 16px',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border)',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            color: 'var(--text-muted)',
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1 }}>
            This project doesn't have a run configuration yet — set a build command, run command, and env vars so you can run it from here.
          </span>
          <button
            onClick={() => { setRunConfigBannerDismissed(true); openRunConfigPanel() }}
            style={{
              background: 'var(--cyan)', color: 'var(--bg-base)', border: 'none',
              borderRadius: 5, fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600,
              padding: '4px 10px', cursor: 'pointer',
            }}
          >
            Configure Run
          </button>
          <button
            onClick={() => setRunConfigBannerDismissed(true)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 13, padding: '2px 6px',
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {lspSetupNudge && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '7px 16px',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border)',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            color: 'var(--text-muted)',
            flexShrink: 0,
          }}
        >
          <span style={{ flex: 1 }}>
            This project has a language server available that isn't set up yet — install it for hover, go-to-definition, and diagnostics.
          </span>
          <button
            onClick={() => { setLspSetupNudge(false); setLspSetupOpen(true) }}
            style={{
              background: 'var(--cyan)', color: 'var(--bg-base)', border: 'none',
              borderRadius: 5, fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600,
              padding: '4px 10px', cursor: 'pointer',
            }}
          >
            Set Up Language Servers
          </button>
          <button
            onClick={() => setLspSetupNudge(false)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 13, padding: '2px 6px',
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}


      <div className={styles.mainRow}>
        {/* ── Activity bar — grouped navigation rail, docked on
            the far LEFT of the window, full height. Shown in the normal
            docked IDE layout AND in the Chat View dialog (chatDialogMode) —
            in the dialog it's just the slim icon rail; clicking a button
            there opens that panel as an overlay instead of docking it,
            since the dialog window has no room to dock anything
            permanently (see dialogPanelOpen / renderLeftPanelBody above). ── */}
        {(chatDialogMode || appMode === 'ide' || appMode === 'welcome') && (
          <nav className={`${styles.activityBar} ${chatDialogMode ? styles.activityBarDialog : ''}`}>
            {typeof coins === 'number' && (
              <div
                className={styles.activityCoins}
                title={`${coins.toLocaleString()} coins available`}
                aria-label={`${coins.toLocaleString()} coins available`}
              >
                <span className={styles.activityCoinCount}>{coins.toLocaleString()}</span>
                <span aria-hidden="true">🪙</span>
              </div>
            )}
            <div className={styles.activityDivider} aria-hidden="true" />
            <button
              className={`${styles.activityBtn} ${!(chatDialogMode ? dialogDesignCanvasOpen : designCanvasOpen) && leftPanel === 'chat' && (!chatDialogMode || dialogPanelOpen) ? styles.activityBtnActive : ''}`}
              title="Chat History"
              onClick={() => handleActivityPanelClick('chat')}
            >
              💬
            </button>
            <div className={styles.activityDivider} aria-hidden="true" />
            <button
              className={`${styles.activityBtn} ${(chatDialogMode ? dialogDesignCanvasOpen && dialogPanelOpen : designCanvasOpen) ? styles.activityBtnActive : ''}`}
              title="Design Canvas"
              onClick={handleActivityCanvasClick}
            >
              🎨
            </button>
            <button
              className={`${styles.activityBtn} ${settingsOpen && mcpOpen ? styles.activityBtnActive : ''}`}
              title={settingsOpen && mcpOpen ? 'Close MCP Settings' : 'Open MCP Settings'}
              aria-label={settingsOpen && mcpOpen ? 'Close MCP settings' : 'Open MCP settings'}
              onClick={() => {
                if (settingsOpen && mcpOpen) {
                  setSettingsOpen(false)
                  closeMcpPanel()
                } else {
                  openMcpPanel()
                }
              }}
            >
              🔌
            </button>
            <button className={`${styles.activityBtn} ${automationOpen ? styles.activityBtnActive : ''}`} title="Automation Manager" onClick={() => automationOpen ? closeAutomation() : openAutomation()}>⏱</button>
            <div className={styles.activityDivider} aria-hidden="true" />
            {!!projectRoot && (
              <button
                className={`${styles.activityBtn} ${!(chatDialogMode ? dialogDesignCanvasOpen : designCanvasOpen) && leftPanel === 'files' && (!chatDialogMode || dialogPanelOpen) ? styles.activityBtnActive : ''}`}
                title="Explorer"
                onClick={() => handleActivityPanelClick('files')}
              >
                📁
              </button>
            )}
            {!!projectRoot && <div className={styles.activityDivider} aria-hidden="true" />}
            <button
              className={`${styles.activityBtn} ${appManagerOpen ? styles.activityBtnActive : ''}`}
              title={appManagerOpen ? 'Close App Manager' : 'Open App Manager'}
              onClick={() => (appManagerOpen ? closeAppManagerPanel() : openAppManagerPanel())}
            >
              🗔
            </button>
            <button
              className={`${styles.activityBtn} ${appRegistryOpen ? styles.activityBtnActive : ''}`}
              title={appRegistryOpen ? 'Close Installed App Registry' : 'Open Installed App Registry'}
              onClick={() => (appRegistryOpen ? closeAppRegistryPanel() : openAppRegistryPanel())}
            >
              🧩
            </button>
          </nav>
        )}

        {!chatDialogMode && sidebarOpen && (appMode === 'ide' || (appMode === 'welcome' && leftPanel === 'chat')) && (
          <aside className={styles.sidebarLeft} style={{ width: explorerWidth }}>
            {/* Retract button — collapses the docked left panel (Explorer /
                Git / Chat History) out of the way entirely. Previously the
                only way to hide it was the "view:sidebar" command/shortcut;
                clicking the already-active activity-bar icon does NOT close
                it (it just re-opens the same panel), so there was no
                visible affordance for this at all. Re-opening is done via
                any activity-bar icon (each sets sidebarOpen back to true). */}
            <button
              className={styles.sidebarRetractBtn}
              onClick={() => setSidebarOpen(false)}
              title="Retract panel"
              aria-label="Retract panel"
            >
              ◀
            </button>
            {renderLeftPanelBody()}
          </aside>
        )}

        {/* Explorer resize handle */}
        {!chatDialogMode && sidebarOpen && (appMode === 'ide' || (appMode === 'welcome' && leftPanel === 'chat')) && (
          <div
            className={styles.resizeHandle}
            onMouseDown={(e) => startResize('explorer', e)}
          />
        )}

        {/* ── Right column: editor row on top, terminal docked below it.
            Its width is naturally (window width − explorer width) since
            it's a flex sibling of the explorer above, so the terminal —
            being full-width *within this column* — ends up exactly
            (current width − file-explorer width) instead of spanning
            under the explorer like before. ── */}
        <div className={styles.rightColumn}>
          {!chatDialogMode && appMode === 'ide' && (
            <nav className={styles.workspaceSwitcher} aria-label="Workspace views">
              {(['chat', 'browser'] as const).map(view => (
                <button
                  key={view}
                  className={activeWorkspaceView === view ? styles.workspaceSwitcherActive : ''}
                  onClick={() => {
                    setWorkspaceView(view)
                  }}
                >
                  {view === 'chat' ? '✦' : '◎'} {view[0].toUpperCase() + view.slice(1)}
                </button>
              ))}
            </nav>
          )}
          <div className={styles.workspace}>
            {!chatDialogMode && appMode === 'ide' && activeWorkspaceView === 'browser' && <BrowserPanel />}
            {/* Keep one chat instance mounted while welcome mode becomes IDE
                mode. New-project creation can therefore activate its folder
                and continue planning/execution without a module-level handoff. */}
            {activeWorkspaceView !== 'browser' && (
              <div
                className={appMode === 'welcome' ? styles.welcomeWorkspace : styles.sidebarChat}
                style={appMode === 'welcome'
                  ? (chatDialogMode ? { position: 'relative', zIndex: 20 } : undefined)
                  : chatDialogMode
                    ? { flex: 1, flexShrink: 1, width: 'auto', minWidth: 0, zIndex: 20 }
                    : (tabs.length === 0 && diffTabs.length === 0)
                      ? { flex: 1, flexShrink: 1, width: 'auto', minWidth: 0 }
                      : { width: chatWidth }}
              >
                <AiChat
                  context={aiContext}
                  welcomeMode={appMode === 'welcome'}
                  onOpenFolder={handleOpenFolderDirect}
                  onSwitchProject={handleSwitchProject}
                  chatDialogMode={chatDialogMode}
                  chatHistoryContainer={chatHistorySlotEl}
                  onConversationRestored={closeChatHistoryPanel}
                  onNewChatStarted={handleNewChatRetract}
                />
              </div>
            )}

            {/* ── IDE MODE: chat + editor ────────────────────────────── */}
            {appMode === 'ide' && activeWorkspaceView !== 'browser' && (
              <>
                {/* Chat resize handle — only shown when editor is visible */}
                {!chatDialogMode && (tabs.length > 0 || diffTabs.length > 0) && (
                  <div
                    className={styles.resizeHandle}
                    onMouseDown={(e) => startResize('chat', e)}
                  />
                )}

                {/* Editor — hidden when no file is open (chat expands to fill space), and always hidden in the chat-only dialog.
                    Design Canvas now renders in the LEFT sidebar (in place of the File Explorer/Git panel — see
                    handleToggleDesignCanvas / sidebarLeft above) instead of overriding this area, so this is unconditionally
                    the Monaco tab editor whenever it's shown. */}
                {!chatDialogMode && (tabs.length > 0 || diffTabs.length > 0) && (
                  <main className={styles.editorArea}>
                    <EditorPane
                      openFiles={tabs}
                      diffTabs={diffTabs}
                      activeId={activeId}
                      activeKind={activeKind}
                      onTabClick={setActiveTab}
                      onTabClose={closeTab}
                      onDiffTabClick={setActiveDiffTab}
                      onDiffTabClose={closeDiffTab}
                      onFileChange={updateContent}
                      onContextChange={setAiContext}
                      fontSize={fontSize}
                      theme={theme}
                      designProjectRoot={projectRoot}
                      onOpenDesignPage={handleOpenDesignPage}
                      onCloseDesignCanvas={() => closeTab(DESIGN_CANVAS_TAB_ID)}
                      onRequestSaveDesignProject={openSaveProjectDialog}
                      onOpenRecentDesignProject={handleOpenRecentDesignProject}
                    />
                  </main>
                )}
              </>
            )}
          </div>

          {/* StatusBar reads index state directly from useRepoIndex */}
          {/* Note: DiffPanel is intentionally removed — edits are reviewed in tabs */}

          {/* Path Viewer — open any file path directly in the studio, docked like Terminal */}
          {!chatDialogMode && pathViewerOpen && (
            <PathViewerBar onClose={() => closePathViewer(false)} />
          )}

          {/* Terminal resize handle — only shown when terminal is open */}
          {!chatDialogMode && terminalOpen && (
            <div
              className={styles.terminalResizeHandle}
              onMouseDown={startTermResize}
            />
          )}

          {/* Interactive PTY terminal panel — width is implicitly
              (window width − explorer width) since this whole block lives
              inside .rightColumn, a flex sibling of the explorer. Hidden
              entirely in the chat-only dialog, regardless of terminalOpen. */}
          {!chatDialogMode && terminalOpen && (
            <TerminalPane
              theme={theme}
              cwd={projectRoot ?? undefined}
              height={terminalHeight}
              newTerminalRequest={newTerminalRequest}
              pendingRun={pendingRun}
              agentRunRequest={agentRunRequest}
            />
          )}

          {/* ── Chat View side panel overlay ─────────────────────────────
              The dialog window (400×600, see services/viewModeWindow.ts)
              has no room to dock Design Canvas / Explorer / Git / Chat
              History permanently the way the full IDE does — so instead
              this covers the conversation on demand, opened via the
              activity bar above and dismissed with ✕ (or clicking the
              same activity button again). Sits on top of .sidebarChat
              (zIndex 20 in dialog mode, see above) via a higher zIndex. ── */}
          {chatDialogMode && dialogPanelOpen && (
            <div className={styles.dialogPanelOverlay}>
              <div className={styles.dialogPanelHeader}>
                <span className={styles.dialogPanelTitle}>
                  {dialogDesignCanvasOpen
                    ? '🎨 Design Canvas'
                    : leftPanel === 'files'
                      ? '📁 Explorer'
                      : leftPanel === 'git'
                        ? '⎇ Source Control'
                        : '💬 Chat History'}
                </span>
                <button
                  className={styles.dialogPanelClose}
                  onClick={() => { setDialogPanelOpen(false); if (dialogDesignCanvasOpen) setDialogDesignCanvasOpen(false) }}
                  title="Back to chat"
                >
                  ✕
                </button>
              </div>
              <div className={styles.dialogPanelBody}>
                {renderLeftPanelBody({ inDialogOverlay: true })}
              </div>
            </div>
          )}
        </div>
      </div>

      {!chatDialogMode && (
        <StatusBar
          branch={currentBranch?.name ?? 'main'}
          language={currentFile?.lang ?? currentDiffTab?.language ?? ''}
          onTerminalToggle={() => setTerminalOpen(prev => !prev)}
          terminalOpen={terminalOpen}
          onPathViewerToggle={togglePathViewer}
          pathViewerOpen={pathViewerOpen}
        />
      )}

      {/* Disk Viewer — opened programmatically by desktop_task's open_path
          action when the target resolves to a directory (see
          store/useDiskViewerStore.ts). No props needed; it reads its own
          open/path state from the store. */}
      <DiskViewerModal />

      {/* Save (unsaved project) dialog — same "name + location" UI shown
          when the build_new_project intent fires, reused here so Ctrl+S on
          an in-memory design project doesn't jump straight to a native
          folder picker. Confirming writes every in-memory file to disk and
          indexes the resulting folder (see confirmSaveDialog above). */}
      <BuildProjectDialog
        open={saveDialogOpen}
        mode="design"
        submitting={saveDialogSubmitting}
        error={saveDialogError}
        defaultLocation={saveDialogDefaultLocation}
        initialProjectName={unsavedProjectName ?? undefined}
        headingOverride="Save project"
        descriptionOverride="Name your project and choose where it should be saved. We'll create the folder and save your files there."
        confirmLabelOverride="✓ Save Project"
        onBrowse={browseSaveLocation}
        onConfirm={confirmSaveDialog}
        onCancel={cancelSaveDialog}
      />

      {/* Find in Files modal */}
      <FindInFilesModal
        open={findOpen}
        onClose={() => setFindOpen(false)}
        hasProject={!!projectRoot}
        projectRoot={projectRoot}
        onResultSelect={handleFindResultSelect}
      />

      {/* Settings modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); closeMcpPanel() }}
        initialTab={mcpOpen ? 'mcp' : 'providers'}
        fontSize={fontSize}
        onFontSizeChange={handleFontSizeChange}
        fontSizeMin={FONT_SIZE_MIN}
        fontSizeMax={FONT_SIZE_MAX}
      />

      {/* Environment Doctor panel */}
      <DoctorPanel
        open={doctorOpen}
        onClose={() => setDoctorOpen(false)}
        onOpenMcp={() => { setDoctorOpen(false); openMcpPanel() }}
      />

      {/* Language Servers — download/manage LSP servers for the open project */}
      {/* Software update — same panel whether opened from the toolbar
          Update button or Help > Check for Updates…; both just set
          updatesOpen, and all update logic lives in useAppUpdateStore. */}
      <UpdatePanel
        open={updatesOpen}
        onClose={() => setUpdatesOpen(false)}
      />

      <LspSetupPanel
        open={lspSetupOpen}
        onClose={() => setLspSetupOpen(false)}
        projectRoot={projectRoot}
      />

      {/* Edit review bar — shown when AI proposes file changes. After a
          merge completes it also offers an optional, human-triggered
          "Verify" action that runs the project's active run config
          locally (or opens Run Configuration if none is set up yet) —
          see handleRunProject above. */}
      <EditReviewBar onVerify={handleRunProject} chatDialogMode={chatDialogMode} />

      <AppRegistryPanel open={appRegistryOpen} onClose={closeAppRegistryPanel} />
      <AppManagerPanel open={appManagerOpen} onClose={closeAppManagerPanel} />
      <AutomationManager open={automationOpen} onClose={closeAutomation} />

      {/* Run Configuration — build command / run command / env vars */}
      <RunConfigPanel
        open={runConfigOpen}
        onClose={() => closeRunConfigPanel()}
        projectRoot={projectRoot}
        onRunCommand={handleRunCommand}
      />

      {/* Project Understanding Overlay — shown during initial folder index */}
      <IndexingOverlay />

      {/* Command Palette — Ctrl+Shift+P */}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        hasProject={!!projectRoot}
        hasActiveTab={!!currentFile}
        onAction={(action) => {
          // Reuse the exact same inline handler Header uses
          const syntheticEvent = { action }
          // Dispatch through the existing onMenuAction prop pathway by
          // calling the same handler body directly:
          const editor = globalEditorRef.current
          switch (action) {
            case 'file:settings':   setSettingsOpen(true);            break
            case 'view:theme':      onToggleTheme();                   break
            case 'help:palette':    setPaletteOpen(true);              break
            case 'help:doctor':     setDoctorOpen(true);               break
            case 'help:lsp-setup':  setLspSetupOpen(true);             break
            case 'help:mcp':        openMcpPanel();                    break
            case 'help:app-registry': openAppRegistryPanel();          break
            case 'help:updates':    setUpdatesOpen(true);              break
            case 'run:config':      openRunConfigPanel();            break
            case 'run:start':
            case 'run:noDebug':     handleRunProject();                break
            case 'view:sidebar':    setSidebarOpen(prev => !prev);     break
            case 'view:terminal':   setTerminalOpen(prev => !prev);    break
            case 'view:openPath':   togglePathViewer();                break
            case 'terminal:new':     handleNewEmbeddedTerminal();       break
            case 'edit:findAll':    setFindOpen(true);                 break
            case 'view:zoomIn':     handleZoomIn();                    break
            case 'view:zoomOut':    handleZoomOut();                   break
            case 'view:zoomReset':  handleZoomReset();                 break
            case 'file:openFolder': handleOpenFolderDirect();          break
            case 'file:openDesignProject': handleOpenDesignProject(); break
            case 'file:new':        handleNewFile();                   break
            case 'file:save':       handleSave();                      break
            case 'file:saveAs':     handleSaveAs();                    break
            case 'file:saveAll':    handleSaveAll();                   break
            case 'file:closeTab':   if (activeId) closeTab(activeId); break
            case 'file:closeAll':   tabs.forEach(t => closeTab(t.id)); break
            case 'edit:undo':       editor?.trigger('palette', 'undo', null); editor?.focus(); break
            case 'edit:redo':       editor?.trigger('palette', 'redo', null); editor?.focus(); break
            case 'edit:cut':        editor?.trigger('palette', 'editor.action.clipboardCutAction', null); editor?.focus(); break
            case 'edit:copy':       editor?.trigger('palette', 'editor.action.clipboardCopyAction', null); editor?.focus(); break
            case 'edit:paste':      editor?.trigger('palette', 'editor.action.clipboardPasteAction', null); editor?.focus(); break
            case 'edit:selectAll':  editor?.trigger('palette', 'editor.action.selectAll', null); editor?.focus(); break
            case 'edit:find':       editor?.trigger('palette', 'actions.find', null); break
            case 'edit:replace':    editor?.trigger('palette', 'editor.action.startFindReplaceAction', null); break
            case 'edit:format':     editor?.trigger('palette', 'editor.action.formatDocument', null); editor?.focus(); break
            default:                console.debug('[CommandPalette]', action)
          }
        }}
      />
    </div>
    </SetupGate>
  )
}
