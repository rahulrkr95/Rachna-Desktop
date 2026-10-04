// App.tsx
//
// Root of the Rachna IDE renderer.
//
// No login gate:
//   • Rachna IDE opens straight to the workspace — nothing requires an
//     account. A Rachna account is needed ONLY for Rachna Cloud AI.
//   • `initAuth()` (see store/useAuthStore.ts) quietly restores a cached
//     Rachna session from the OS keychain if there is one (it never blocks
//     startup on the network, and only a real 401/403 signs it out).
//   • `<LoginScreen>` is a dialog mounted once at the root, shown on demand
//     when someone tries to use Rachna Cloud while signed out — via
//     `useAuthStore.openLoginDialog()` (RachnaCloudProvider, the model
//     picker, the account menu in Header). It signs in with email/password
//     (Rust `login`) or Google (Rust `google_sign_in`); a 426
//     UPGRADE_REQUIRED is handled inline in the dialog, not as an app-wide
//     block.
//
// Note: the app's `rachna-ide://` deep-link scheme is still used elsewhere
// (OAuth connector sign-in — see services/oauth/OAuthManager.ts).

import React, { useState, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import IDELayout from './components/IDELayout'
import LoginScreen from './components/LoginScreen'
import CompactView from './components/CompactView'
import { LLMCallInspector } from './components/LLMCallInspector'
import InputActionOverlay from './components/InputActionOverlay'
import { useAuthStore } from './store/useAuthStore'
import { useNodeSetupStore } from './store/useNodeSetupStore'
import NodeSetupScreen from './components/NodeSetupScreen'
import { useAppUpdateStore } from './store/useAppUpdateStore'
import { useViewModeStore } from './store/useViewModeStore'
import { initPermissionNotificationActions } from './store/useTerminalPermissionStore'
import { useAppRegistryStore } from './store/useAppRegistryStore'
import { attachDragClamp } from './services/viewModeWindow'
import { goToView } from './services/viewModeController'
import { initNotifyFocusTracking } from './services/notify'
import { startAutomationScheduler } from './services/automationService'
import './styles/globals.css'

// ── App ────────────────────────────────────────────────────────────────────

export default function App() {
  const { isLoading, initAuth, loginDialogOpen } = useAuthStore()
  const { status: nodeSetupStatus, runNodeSetup } = useNodeSetupStore()

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('rachna_ide_theme') as 'dark' | 'light') || 'dark'
  })
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const viewMode          = useViewModeStore(s => s.mode)

  // ── Theme sync ───────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('rachna_ide_theme', theme)
  }, [theme])

  // ── Auth init (runs once on mount) ───────────────────────────────────────
  useEffect(() => {
    initAuth()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => startAutomationScheduler(), [])

  // ── Node.js runtime setup (runs once on launch) ──────────────────────────
  // An explicit step before the IDE mounts: download/extract the managed
  // Node.js runtime from nodejs.org if it's missing, and only then let the
  // person past this screen. Needs no account. See store/useNodeSetupStore.ts.
  useEffect(() => {
    runNodeSetup()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cloud sign-in from the chat-only window ──────────────────────────────
  // The sign-in dialog is sized for the full window, so if Rachna Cloud asks
  // for sign-in while the small chat dialog is showing, widen to the full
  // IDE first (chat → full is an allowed move; see viewModeController.ts).
  useEffect(() => {
    if (loginDialogOpen && useViewModeStore.getState().mode === 'chat') {
      void goToView('full')
    }
  }, [loginDialogOpen])

  // ── Window behaviour ────────────────────────────────────────────────────
  // Native OS decorations (tauri.conf.json → decorations: true) draw the
  // title bar's minimize/maximize/close buttons, and none of them are
  // intercepted or overridden anywhere in the app — minimize goes to the
  // taskbar, maximize/restore toggles normally, close quits, in every one
  // of the app's three views (full / chat / orb). See
  // services/viewModeWindow.ts for what those three views are.
  //
  // Every transition — automatic or button-triggered — funnels through the
  // shared goToView (services/viewModeController.ts), which is the only
  // place that (a) checks the move is actually legal via isAdjacent (full
  // <-> chat <-> orb only, never full <-> orb directly) and (b) drives the
  // matching OS window change. Having one gate there means a future
  // caller — a button here, or a desktop-control tool via
  // desktopViewModeGuard.ts — can never accidentally wire up an invalid
  // jump; it would just be silently rejected and logged. Lifted out of
  // this component (rather than defined inline) specifically so
  // non-React tool code can call it too — see viewModeController.ts's
  // doc comment.

  // The one automatic transition that *is* wired up: while the full IDE is
  // showing, losing OS focus (e.g. the user clicks into a different app)
  // tucks the window into the smaller always-on-top chat view instead of
  // leaving the full window sitting behind whatever they switched to.
  // `focus: false` keeps this from stealing focus back — it just resizes
  // quietly. This only fires from 'full' (goToView's own state.mode check
  // handles that — chat/orb losing focus does nothing, since they're meant
  // to float over other apps).
  useEffect(() => {
    initNotifyFocusTracking()
    initPermissionNotificationActions()

    // Kick off the Installed App Registry scan (Win32 + Microsoft
    // Store/packaged apps) once per session, right away, so it's warm by
    // the time the agent's open_app tool needs it — see
    // services/appRegistry/appRegistryService.ts and
    // store/useAppRegistryStore.ts (which tracks loading/ready/error state
    // for the App Registry panel/status pill). Fire-and-forget: a
    // failed/slow scan just means open_app falls back to the legacy
    // resolve_app search (services/appRegistry/openApp.ts) rather than
    // blocking startup on it — the store surfaces the failure in the UI
    // instead.
    useAppRegistryStore.getState().load().catch((err) =>
      console.warn('[app-registry] initial scan failed (open_app will fall back to resolve_app):', err)
    )

    let unlistenFocus: (() => void) | undefined
    let unlistenDrag: (() => void) | undefined
    let cancelled = false

    getCurrentWindow()
      .onFocusChanged(async ({ payload: isFocused }) => {
        if (isFocused) return
        if (useViewModeStore.getState().mode !== 'full') return
        // Don't tuck the window away while the Rachna Cloud sign-in dialog
        // is up — Google sign-in sends the person to their browser and
        // they need to come back to the same dialog.
        if (useAuthStore.getState().loginDialogOpen) return
        await goToView('chat', { focus: false })
      })
      .then(fn => { if (!cancelled) unlistenFocus = fn; else fn() })
      .catch(e => console.error('[auto-chat] failed to attach focus listener:', e))

    // Keeps the orb/chat window from ever being dragged off-screen —
    // see services/viewModeWindow.ts for the clamping logic (it no-ops
    // while the real full-size IDE window is active).
    attachDragClamp()
      .then(fn => { if (!cancelled) unlistenDrag = fn; else fn() })
      .catch(e => console.error('[view-mode] failed to attach drag clamp:', e))

    return () => { cancelled = true; unlistenFocus?.(); unlistenDrag?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Orb → chat dialog (clicking the orb). */
  const handleExpandToChat = () => goToView('chat')

  /** Chat dialog → orb ('⌄' button on ChatDialogHeader). */
  const handleCollapseToOrb = () => goToView('orb')

  /** Chat dialog → full IDE ('⤢' button on ChatDialogHeader). Note there's
   *  no equivalent from the orb — it can only reach 'full' by way of 'chat'. */
  const handleExpandToFull = () => goToView('full')

  // ── Auto-updater check (runs once on mount, delayed) ──────────────────────
  // Deliberately independent of login — just "is a newer signed
  // build published". Delayed a few seconds so it never competes with
  // startup (indexing, LSP boot, etc.) for network/CPU, and is silent
  // (no UI) unless/until an update is actually found — see StatusBar.tsx.
  useEffect(() => {
    const timer = setTimeout(() => {
      useAppUpdateStore.getState().checkForUpdate()
    }, 4000)
    return () => clearTimeout(timer)
  }, [])

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'))

  // ── Loading splash (brief — local keychain read only, no network) ────────
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0d0d0f',
        color: '#44445a',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '0.85rem',
        letterSpacing: '0.04em',
      }}>
        Starting…
      </div>
    )
  }

  // ── Node.js runtime setup gate ────────────────────────────────────────────
  // Blocks until the managed Node.js runtime is confirmed installed (or the
  // person acknowledges a failure via Retry) — see the effect above.
  if (nodeSetupStatus !== 'ready') {
    return <NodeSetupScreen />
  }

  // ── Full IDE ─────────────────────────────────────────────────────────────
  // IDELayout stays mounted at all times (just visually hidden behind the
  // pill, or squeezed down to chat-only) so the agent, terminal, LSP, etc.
  // keep running in the background instead of being torn down every time
  // the widget collapses/expands/re-expands.
  const showOrb = viewMode === 'orb'
  const showChatDialog = viewMode === 'chat'

  return (
    <>
      {showOrb ? (
        <CompactView onExpandToChat={handleExpandToChat} />
      ) : null}
      <div style={{ display: showOrb ? 'none' : 'contents' }}>
        <IDELayout
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleInspector={() => setInspectorOpen(o => !o)}
          inspectorOpen={inspectorOpen}
          chatDialogMode={showChatDialog}
          onCollapseToOrb={handleCollapseToOrb}
          onExpandToFull={handleExpandToFull}
        />
        {!showChatDialog && (
          <LLMCallInspector
            open={inspectorOpen}
            onClose={() => setInspectorOpen(false)}
          />
        )}
      </div>
      {/* Always mounted above every view (orb / chat / full) — see
          components/InputActionOverlay.tsx. Purely visual feedback for the
          mouse/keyboard automation tools; never mounted per-view because it
          isn't tied to any one of them. */}
      <InputActionOverlay />
      {/* Rachna Cloud sign-in — renders nothing until requested. */}
      <LoginScreen />
    </>
  )
}
