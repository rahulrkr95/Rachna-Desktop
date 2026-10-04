import React, { useState, useRef, useEffect, useCallback } from 'react'
import styles from './Header.module.css'
import logoIcon from '../src-tauri/icons/32x32.png'
import { useAuthStore } from '../store/useAuthStore'
import { useIdeEntitlements } from '../store/useIdeEntitlements'
import { useAppUpdateStore } from '../store/useAppUpdateStore'
import { getPlatform } from '../lib/platform'

// ── Profile dropdown helpers ────────────────────────────────────────────────

function initialsFor(email: string): string {
  const trimmed = email.trim()
  if (!trimmed || trimmed === 'unknown') return '?'
  return trimmed[0].toUpperCase()
}

// ── Menu definitions ───────────────────────────────────────────────────────

type MenuSeparator = { type: 'separator' }
type MenuItem = {
  type?: 'item'
  label: string
  shortcut?: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  action: string
}
type MenuEntry = MenuItem | MenuSeparator

interface MenuDefinition {
  label: string
  items: MenuEntry[]
}

// ── Context-aware menu builders ────────────────────────────────────────────

function buildFileMenu(hasProject: boolean, hasActiveTab: boolean): MenuDefinition {
  const items: MenuEntry[] = [
    { label: 'Open Folder…', shortcut: 'Ctrl+K Ctrl+O', icon: '📂', action: 'file:openFolder' },
    { label: 'Open Design Project…', icon: '🎨', action: 'file:openDesignProject' },
  ]

  if (hasProject) {
    items.push(
      { label: 'New File',      shortcut: 'Ctrl+N',       icon: '📄', action: 'file:new'    },
      { type: 'separator' },
      {
        label: 'Save',          shortcut: 'Ctrl+S',        icon: '💾', action: 'file:save',
        disabled: !hasActiveTab,
      },
      {
        label: 'Save As…',      shortcut: 'Ctrl+Shift+S',  icon: '💾', action: 'file:saveAs',
        disabled: !hasActiveTab,
      },
      { label: 'Save All',      shortcut: 'Ctrl+Alt+S',   icon: '💾', action: 'file:saveAll' },
      { type: 'separator' },
      {
        label: 'Close Tab',     shortcut: 'Ctrl+W',        icon: '✕',  action: 'file:closeTab',
        disabled: !hasActiveTab,
      },
      {
        label: 'Close All Tabs',                            icon: '✕',  action: 'file:closeAll',
        disabled: !hasActiveTab,
      },
    )
  }

  items.push(
    { type: 'separator' },
    { label: 'Preferences',  shortcut: 'Ctrl+,',        icon: '⚙',  action: 'file:settings' },
    { type: 'separator' },
    { label: 'Quit',         shortcut: 'Ctrl+Q',         icon: '⏻',  action: 'file:quit', danger: true },
  )

  return { label: 'File', items }
}

function buildEditMenu(hasActiveTab: boolean, hasSelection: boolean): MenuDefinition {
  return {
    label: 'Edit',
    items: [
      { label: 'Undo',            shortcut: 'Ctrl+Z',       icon: '↩',  action: 'edit:undo',      disabled: !hasActiveTab },
      { label: 'Redo',            shortcut: 'Ctrl+Y',       icon: '↪',  action: 'edit:redo',      disabled: !hasActiveTab },
      { type: 'separator' },
      { label: 'Cut',             shortcut: 'Ctrl+X',       icon: '✂',  action: 'edit:cut',       disabled: !hasSelection },
      { label: 'Copy',            shortcut: 'Ctrl+C',       icon: '⎘',  action: 'edit:copy',      disabled: !hasSelection },
      { label: 'Paste',           shortcut: 'Ctrl+V',       icon: '📋', action: 'edit:paste',     disabled: !hasActiveTab },
      { type: 'separator' },
      { label: 'Find',            shortcut: 'Ctrl+F',       icon: '🔍', action: 'edit:find',      disabled: !hasActiveTab },
      { label: 'Replace',         shortcut: 'Ctrl+H',       icon: '🔄', action: 'edit:replace',   disabled: !hasActiveTab },
      { label: 'Find in Files',   shortcut: 'Ctrl+Shift+F', icon: '🔎', action: 'edit:findAll'    },
      { type: 'separator' },
      { label: 'Select All',      shortcut: 'Ctrl+A',       icon: '◻',  action: 'edit:selectAll', disabled: !hasActiveTab },
      { label: 'Format Document', shortcut: 'Alt+Shift+F',  icon: '✦',  action: 'edit:format',    disabled: !hasActiveTab },
    ],
  }
}

const VIEW_MENU: MenuDefinition = {
  label: 'View',
  items: [
    { label: 'Toggle Sidebar',   shortcut: 'Ctrl+B',       icon: '▏', action: 'view:sidebar'   },
    { label: 'Toggle AI Panel',  shortcut: 'Ctrl+Shift+A', icon: '✦', action: 'view:aiPanel'   },
    { label: 'Toggle Terminal',  shortcut: 'Ctrl+`',       icon: '⬛', action: 'view:terminal'  },
    { type: 'separator' },
    { label: 'Zoom In',          shortcut: 'Ctrl+=',       icon: '🔎', action: 'view:zoomIn'    },
    { label: 'Zoom Out',         shortcut: 'Ctrl+-',       icon: '🔍', action: 'view:zoomOut'   },
    { label: 'Reset Zoom',       shortcut: 'Ctrl+0',       icon: '⊙',  action: 'view:zoomReset' },
    { type: 'separator' },
    { label: 'Toggle Theme',     shortcut: 'Ctrl+Shift+T', icon: '☀', action: 'view:theme'     },
    { label: 'Full Screen',      shortcut: 'F11',          icon: '⛶',  action: 'view:fullscreen'},
  ],
}

const RUN_MENU: MenuDefinition = {
  label: 'Run',
  items: [
    { label: 'Run Project',       shortcut: 'F5',          icon: '▶', action: 'run:start'    },
    { label: 'Run Without Debug', shortcut: 'Ctrl+F5',     icon: '▷', action: 'run:noDebug'  },
    { label: 'Stop',              shortcut: 'Shift+F5',    icon: '⏹', action: 'run:stop'     },
    { type: 'separator' },
    { label: 'Configure Run…',                             icon: '⚙', action: 'run:config'   },
    { type: 'separator' },
    { label: 'Step Over',         shortcut: 'F10',         icon: '⤵', action: 'run:stepOver' },
    { label: 'Step Into',         shortcut: 'F11',         icon: '⤸', action: 'run:stepInto' },
    { label: 'Step Out',          shortcut: 'Shift+F11',   icon: '⤹', action: 'run:stepOut'  },
    { type: 'separator' },
    { label: 'Toggle Breakpoint', shortcut: 'F9',          icon: '⬤', action: 'run:breakpoint'},
  ],
}

const TERMINAL_MENU: MenuDefinition = {
  label: 'Terminal',
  items: [
    { label: 'New Terminal',   shortcut: 'Ctrl+Shift+`', icon: '⬛', action: 'terminal:new'   },
    { type: 'separator' },
    { label: 'Kill Terminal',                             icon: '✕',  action: 'terminal:kill', danger: true },
    { label: 'Clear Terminal', shortcut: 'Ctrl+L',       icon: '⊘',  action: 'terminal:clear' },
  ],
}

// updateBusy disables "Check for Updates…" while a check/download is
// already in flight (see useAppUpdateStore) rather than letting a second
// one stack on top of it.
function buildHelpMenu(updateLabel: string, updateBusy: boolean): MenuDefinition {
  return {
    label: 'Help',
    items: [
      { label: 'Command Palette',    shortcut: 'Ctrl+Shift+P', icon: '⌘', action: 'help:palette'   },
      { label: 'Documentation',                              icon: '📖', action: 'help:docs'      },
      { label: 'Keyboard Shortcuts', shortcut: 'Ctrl+K ?',  icon: '⌨',  action: 'help:shortcuts' },
      { type: 'separator' },
      { label: 'Environment Check (Doctor)…',                icon: '🩺', action: 'help:doctor'    },
      { label: 'Language Servers…',                          icon: '🧩', action: 'help:lsp-setup' },
      { label: 'MCP Servers…',                               icon: '🔌', action: 'help:mcp'       },
      { type: 'separator' },
      { label: updateLabel,                                  icon: '⬆',  action: 'help:updates', disabled: updateBusy },
      { label: 'Release Notes',                              icon: '📝', action: 'help:changelog' },
      { type: 'separator' },
      { label: 'Report Issue…',                              icon: '⚑',  action: 'help:issue'     },
      { label: 'About Rachna AI Studio',                           icon: 'ℹ',  action: 'help:about'     },
    ],
  }
}

// ── Dropdown component ─────────────────────────────────────────────────────

interface DropdownProps {
  menu: MenuDefinition
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  onAction: (action: string) => void
}

function MenuDropdown({ menu, isOpen, onOpen, onClose, onAction }: DropdownProps) {
  const btnRef = useRef<HTMLButtonElement>(null)

  return (
    <div className={styles.menuItemWrapper}>
      <button
        ref={btnRef}
        className={`${styles.menuItem} ${isOpen ? styles.menuItemActive : ''}`}
        onMouseDown={e => { e.preventDefault(); isOpen ? onClose() : onOpen() }}
        onMouseEnter={onOpen}
      >
        {menu.label}
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          {menu.items.map((entry, i) => {
            if ('type' in entry && entry.type === 'separator') {
              return <div key={i} className={styles.dropdownSep} />
            }
            const item = entry as MenuItem
            return (
              <button
                key={i}
                className={`${styles.dropdownItem} ${item.danger ? styles.dropdownItemDanger : ''} ${item.disabled ? styles.dropdownItemDisabled : ''}`}
                onClick={() => { if (!item.disabled) { onAction(item.action); onClose() } }}
                disabled={item.disabled}
              >
                <span className={styles.dropdownIcon}>{item.icon ?? ''}</span>
                <span className={styles.dropdownLabel}>{item.label}</span>
                {item.shortcut && <span className={styles.dropdownShortcut}>{item.shortcut}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Header component ───────────────────────────────────────────────────────

interface RunConfigSummary {
  id: string
  name: string
  build_command: string
  run_command: string
}

interface Props {
  onSettingsClick?: () => void
  onMenuAction?: (action: string) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  hasProject: boolean
  hasActiveTab: boolean
  hasSelection: boolean
  onToggleInspector?: () => void
  inspectorOpen?: boolean
  /** Opens the Source Control (Git) panel — wired to the branch chip (btnGit). */
  onOpenGit?: () => void
  /** True once the open project's folder is confirmed to contain a .git directory. Gates the branch chip below (hasProject alone isn't enough — plenty of open folders aren't repos). */
  isGitRepo?: boolean
  // ── Run configuration toolbar (only rendered when hasProject) ───────────
  runConfigs?: RunConfigSummary[]
  activeRunConfigId?: string | null
  onSelectRunConfig?: (id: string) => void
  onConfigureRun?: () => void
  onBuild?: () => void
  onRun?: () => void
  // ── Design Canvas toggle (view-only infinite board of design pages) ─────
  /** Only rendered when hasProject — a mid-conversation coding-only project has nothing to show here. */
  onToggleDesignCanvas?: () => void
  designCanvasOpen?: boolean
}

export default function Header({
  onSettingsClick,
  onMenuAction,
  theme,
  onToggleTheme,
  hasProject,
  hasActiveTab,
  hasSelection,
  onToggleInspector,
  inspectorOpen,
  onOpenGit,
  isGitRepo,
  runConfigs,
  activeRunConfigId,
  onSelectRunConfig,
  onConfigureRun,
  onBuild,
  onRun,
  onToggleDesignCanvas,
  designCanvasOpen,
}: Props) {
  const canInspectAiCalls = useIdeEntitlements().canInspectAiCalls
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const headerRef = useRef<HTMLElement>(null)

  // On Windows, the native (decorated) window title bar already shows the
  // app icon + "Rachna AI Studio" title. Rendering our own logo icon + name
  // directly beneath it duplicates that — the same icon and name appear
  // twice, stacked. Hide the in-app logo/name on Windows only; macOS/Linux
  // title bars don't create that visible duplicate, so they keep it.
  const [hideBrandForWindows, setHideBrandForWindows] = useState(false)
  useEffect(() => {
    let cancelled = false
    getPlatform().then(p => { if (!cancelled) setHideBrandForWindows(p === 'windows') })
    return () => { cancelled = true }
  }, [])

  const { userInfo, isAuthenticated, logout, openLoginDialog } = useAuthStore()

  // Single source of truth for update state — same store the toolbar
  // button, the Help-menu item, and UpdatePanel all read from. Nothing
  // here talks to the updater plugin directly.
  const appUpdateStatus  = useAppUpdateStore(s => s.status)
  const appUpdateVersion = useAppUpdateStore(s => s.version)
  const updateBusy = appUpdateStatus === 'checking'
  const updateMenuLabel =
    appUpdateStatus === 'checking'    ? 'Checking for Updates…' :
    appUpdateStatus === 'downloading' ? 'Downloading Update…' :
    appUpdateStatus === 'available'   ? 'Update Available…' :
    appUpdateStatus === 'ready'       ? 'Restart to Update…' :
    'Check for Updates…'
  const showUpdateToolbarButton = appUpdateStatus === 'available' || appUpdateStatus === 'downloading' || appUpdateStatus === 'ready'

  // Signed out is a normal state — a Rachna account is only for Rachna Cloud AI.
  const email = userInfo?.email ?? (isAuthenticated ? 'Rachna account' : '')

  const handleLogout = useCallback(() => {
    setOpenMenu(null)
    logout()
  }, [logout])

  const handleSignIn = useCallback(() => {
    setOpenMenu(null)
    openLoginDialog()
  }, [openLoginDialog])

  // Close on outside click
  useEffect(() => {
    if (!openMenu) return
    const handler = (e: MouseEvent) => {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenu])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleAction = useCallback((action: string) => {
    if (action === 'file:settings') { onSettingsClick?.(); return }
    if (action === 'view:theme')    { onToggleTheme();       return }
    onMenuAction?.(action)
  }, [onSettingsClick, onToggleTheme, onMenuAction])

  const menus: MenuDefinition[] = [
    buildFileMenu(hasProject, hasActiveTab),
    buildEditMenu(hasActiveTab, hasSelection),
    VIEW_MENU,
    ...(hasProject ? [RUN_MENU, TERMINAL_MENU] : []),
    buildHelpMenu(updateMenuLabel, updateBusy),
  ]

  return (
    <header ref={headerRef} className={styles.header}>
      {!hideBrandForWindows && (
        <div className={styles.logo}>
          <img
            src={logoIcon}
            alt="Rachna AI Studio"
            className={styles.logoIcon}
            style={{ width: 24, height: 24, objectFit: 'contain', imageRendering: 'auto' }}
          />
          <span className={styles.logoText}>Rachna AI Studio</span>
        </div>
      )}

      <nav className={styles.menu}>
        {menus.map(menu => (
          <MenuDropdown
            key={menu.label}
            menu={menu}
            isOpen={openMenu === menu.label}
            onOpen={() => setOpenMenu(menu.label)}
            onClose={() => setOpenMenu(null)}
            onAction={handleAction}
          />
        ))}
      </nav>

      <div className={styles.actions}>
        {hasProject && (
          <div className={styles.runBar}>
            <select
              className={styles.runConfigSelect}
              value={activeRunConfigId ?? '__none'}
              onChange={e => {
                const v = e.target.value
                if (v === '__configure') { onConfigureRun?.(); return }
                if (v !== '__none') onSelectRunConfig?.(v)
              }}
              title="Select run configuration"
              aria-label="Run configuration"
            >
              {(!runConfigs || runConfigs.length === 0) && (
                <option value="__none">No Configuration</option>
              )}
              {runConfigs?.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option disabled>──────────</option>
              <option value="__configure">Edit Configurations…</option>
            </select>
            <button
              className={styles.btnBuild}
              onClick={onBuild}
              title="Build"
              aria-label="Build project"
            >
              🔨
            </button>
            <button
              className={styles.btnRun}
              onClick={onRun}
              title="Run"
              aria-label="Run project"
            >
              ▶&nbsp;Run
            </button>
          </div>
        )}
        {hasProject && isGitRepo && (
          <button
            className={styles.btnGit}
            onClick={onOpenGit}
            title="Open Source Control"
            aria-label="Open Source Control"
          >
            ⎇&nbsp; main
          </button>
        )}
        {hasProject && (
          <button
            className={styles.btnGit}
            onClick={onToggleDesignCanvas}
            title={designCanvasOpen ? 'Back to editor' : 'Open Design Canvas — view all pages on one board'}
            aria-label="Toggle Design Canvas"
          >
            🎨&nbsp; Canvas
          </button>
        )}
        {showUpdateToolbarButton && (
          <button
            className={styles.btnUpdate}
            onClick={() => handleAction('help:updates')}
            title={
              appUpdateStatus === 'available'   ? `Update to ${appUpdateVersion ?? '…'} available — click for details` :
              appUpdateStatus === 'downloading' ? 'Downloading update…' :
              'Update downloaded — click to restart and apply'
            }
            aria-label="App update available"
          >
            {appUpdateStatus === 'available'   && <>⬆&nbsp; Update</>}
            {appUpdateStatus === 'downloading' && <>⬇&nbsp; Updating…</>}
            {appUpdateStatus === 'ready'        && <>↻&nbsp; Restart</>}
          </button>
        )}
        {canInspectAiCalls && onToggleInspector && (
          <button
            className={`${styles.btnTheme} ${inspectorOpen ? styles.btnActive : ''}`}
            onClick={onToggleInspector}
            title={inspectorOpen ? 'Close LLM Call Inspector' : 'Open LLM Call Inspector'}
            aria-label="Toggle LLM Call Inspector"
            style={inspectorOpen ? { color: 'var(--accent)', opacity: 1 } : undefined}
          >
            ⚡
          </button>
        )}
        <button
          className={styles.btnTheme}
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? (
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
              <path d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4.22 1.78a1 1 0 011.42 1.42l-.71.7a1 1 0 11-1.41-1.41l.7-.71zM17 9a1 1 0 110 2h-1a1 1 0 110-2h1zM4 9a1 1 0 110 2H3a1 1 0 010-2h1zm.34-4.36a1 1 0 011.41 1.41l-.7.71a1 1 0 11-1.42-1.42l.71-.7zM10 5a5 5 0 100 10 5 5 0 000-10zm0 13a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zm6.36-1.64a1 1 0 010 1.42l-.71.7a1 1 0 11-1.41-1.41l.7-.71a1 1 0 011.42 0zM4.34 16.36a1 1 0 11-1.41-1.42l.7-.7a1 1 0 111.42 1.41l-.71.71z" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
              <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
            </svg>
          )}
        </button>
        <button
          className={styles.btnSettings}
          onClick={onSettingsClick}
          title="Settings"
          aria-label="Open settings"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
        </button>
        <div className={styles.menuItemWrapper}>
          <div
            className={styles.avatar}
            title={isAuthenticated ? email : 'Sign in to Rachna Cloud'}
            onClick={() => setOpenMenu(openMenu === 'profile' ? null : 'profile')}
          >
            {isAuthenticated ? initialsFor(email) : '☁'}
          </div>
          {openMenu === 'profile' && (
            <div className={styles.dropdown} style={{ left: 'auto', right: 0, minWidth: 200 }}>
              {isAuthenticated ? (
                <>
                  <div style={{ padding: '8px 10px 6px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                      {email}
                    </div>
                  </div>
                  <div className={styles.dropdownSep} />
                  <button
                    className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                    onClick={handleLogout}
                  >
                    <span className={styles.dropdownIcon}>⏻</span>
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <div style={{ padding: '8px 10px 6px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                      Not signed in
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                      An account is only needed for Rachna Cloud AI.
                    </div>
                  </div>
                  <div className={styles.dropdownSep} />
                  <button className={styles.dropdownItem} onClick={handleSignIn}>
                    <span className={styles.dropdownIcon}>☁</span>
                    Sign in to Rachna Cloud
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
