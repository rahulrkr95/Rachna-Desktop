// components/CommandPalette.tsx
//
// Monaco-style command palette — Ctrl+Shift+P.
// Aggregates every registered action (file ops, edit, view, run,
// terminal, agent, help/settings) into a single fuzzy-searchable list
// with keyboard navigation and inline shortcut hints.

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react'
import styles from './CommandPalette.module.css'
import { fuzzyMatch } from '../lib/fuzzyMatch'

// ── Command registry ───────────────────────────────────────────────────────

export interface PaletteCommand {
  id: string
  label: string
  description?: string
  shortcut?: string
  icon?: string
  category: string
  action: string
}

export const ALL_COMMANDS: PaletteCommand[] = [
  // ── File ─────────────────────────────────────────────────────────────
  { id: 'file:openFolder', label: 'Open Folder…',          shortcut: 'Ctrl+K O',     icon: '📂', category: 'File',     action: 'file:openFolder' },
  { id: 'file:new',        label: 'New File',               shortcut: 'Ctrl+N',       icon: '📄', category: 'File',     action: 'file:new'        },
  { id: 'file:save',       label: 'Save',                   shortcut: 'Ctrl+S',       icon: '💾', category: 'File',     action: 'file:save'       },
  { id: 'file:saveAs',     label: 'Save As…',               shortcut: 'Ctrl+Shift+S', icon: '💾', category: 'File',     action: 'file:saveAs'     },
  { id: 'file:saveAll',    label: 'Save All',               shortcut: 'Ctrl+Alt+S',   icon: '💾', category: 'File',     action: 'file:saveAll'    },
  { id: 'file:closeTab',   label: 'Close Tab',              shortcut: 'Ctrl+W',       icon: '✕',  category: 'File',     action: 'file:closeTab'   },
  { id: 'file:closeAll',   label: 'Close All Tabs',                                   icon: '✕',  category: 'File',     action: 'file:closeAll'   },
  { id: 'file:settings',   label: 'Open Preferences',       shortcut: 'Ctrl+,',       icon: '⚙',  category: 'File',     action: 'file:settings'   },
  { id: 'file:quit',       label: 'Quit Rachna AI Studio',        shortcut: 'Ctrl+Q',       icon: '⏻',  category: 'File',     action: 'file:quit'       },

  // ── Edit ─────────────────────────────────────────────────────────────
  { id: 'edit:undo',       label: 'Undo',                   shortcut: 'Ctrl+Z',       icon: '↩',  category: 'Edit',     action: 'edit:undo'       },
  { id: 'edit:redo',       label: 'Redo',                   shortcut: 'Ctrl+Y',       icon: '↪',  category: 'Edit',     action: 'edit:redo'       },
  { id: 'edit:cut',        label: 'Cut',                    shortcut: 'Ctrl+X',       icon: '✂',  category: 'Edit',     action: 'edit:cut'        },
  { id: 'edit:copy',       label: 'Copy',                   shortcut: 'Ctrl+C',       icon: '⎘',  category: 'Edit',     action: 'edit:copy'       },
  { id: 'edit:paste',      label: 'Paste',                  shortcut: 'Ctrl+V',       icon: '📋', category: 'Edit',     action: 'edit:paste'      },
  { id: 'edit:selectAll',  label: 'Select All',             shortcut: 'Ctrl+A',       icon: '◻',  category: 'Edit',     action: 'edit:selectAll'  },
  { id: 'edit:find',       label: 'Find',                   shortcut: 'Ctrl+F',       icon: '🔍', category: 'Edit',     action: 'edit:find'       },
  { id: 'edit:replace',    label: 'Find & Replace',         shortcut: 'Ctrl+H',       icon: '🔄', category: 'Edit',     action: 'edit:replace'    },
  { id: 'edit:findAll',    label: 'Find in Files',          shortcut: 'Ctrl+Shift+F', icon: '🔎', category: 'Edit',     action: 'edit:findAll'    },
  { id: 'edit:format',     label: 'Format Document',        shortcut: 'Alt+Shift+F',  icon: '✦',  category: 'Edit',     action: 'edit:format'     },

  // ── View ─────────────────────────────────────────────────────────────
  { id: 'view:sidebar',    label: 'Toggle Sidebar',         shortcut: 'Ctrl+B',       icon: '▏',  category: 'View',     action: 'view:sidebar'    },
  { id: 'view:aiPanel',    label: 'Toggle AI Panel',        shortcut: 'Ctrl+Shift+A', icon: '✦',  category: 'View',     action: 'view:aiPanel'    },
  { id: 'view:terminal',   label: 'Toggle Terminal',        shortcut: 'Ctrl+`',       icon: '⬛', category: 'View',     action: 'view:terminal'   },
  { id: 'view:openPath',   label: 'Open Path…',             shortcut: 'Ctrl+Shift+O', icon: '📄', category: 'View',     action: 'view:openPath'   },
  { id: 'view:zoomIn',     label: 'Zoom In',                shortcut: 'Ctrl+=',       icon: '🔎', category: 'View',     action: 'view:zoomIn'     },
  { id: 'view:zoomOut',    label: 'Zoom Out',               shortcut: 'Ctrl+-',       icon: '🔍', category: 'View',     action: 'view:zoomOut'    },
  { id: 'view:zoomReset',  label: 'Reset Zoom',             shortcut: 'Ctrl+0',       icon: '⊙',  category: 'View',     action: 'view:zoomReset'  },
  { id: 'view:theme',      label: 'Toggle Color Theme',     shortcut: 'Ctrl+Shift+T', icon: '☀',  category: 'View',     action: 'view:theme'      },
  { id: 'view:fullscreen', label: 'Toggle Full Screen',     shortcut: 'F11',          icon: '⛶',  category: 'View',     action: 'view:fullscreen' },

  { id: 'run:start',       label: 'Run Project',            shortcut: 'F5',           icon: '▶',  category: 'Run',      action: 'run:start'       },
  { id: 'run:config',      label: 'Configure Run…',                                   icon: '⚙',  category: 'Run',      action: 'run:config'      },

  // ── Run ──────────────────────────────────────────────────────────────
  { id: 'run:start',       label: 'Run Project',            shortcut: 'F5',           icon: '▶',  category: 'Run',      action: 'run:start'       },
  { id: 'run:noDebug',     label: 'Run Without Debug',      shortcut: 'Ctrl+F5',      icon: '▷',  category: 'Run',      action: 'run:noDebug'     },
  { id: 'run:stop',        label: 'Stop Execution',         shortcut: 'Shift+F5',     icon: '⏹',  category: 'Run',      action: 'run:stop'        },
  { id: 'run:stepOver',    label: 'Step Over',              shortcut: 'F10',          icon: '⤵',  category: 'Run',      action: 'run:stepOver'    },
  { id: 'run:stepInto',    label: 'Step Into',              shortcut: 'F11',          icon: '⤸',  category: 'Run',      action: 'run:stepInto'    },
  { id: 'run:stepOut',     label: 'Step Out',               shortcut: 'Shift+F11',    icon: '⤹',  category: 'Run',      action: 'run:stepOut'     },
  { id: 'run:breakpoint',  label: 'Toggle Breakpoint',      shortcut: 'F9',           icon: '⬤',  category: 'Run',      action: 'run:breakpoint'  },

  // ── Terminal ─────────────────────────────────────────────────────────
  { id: 'terminal:new',    label: 'New Terminal',           shortcut: 'Ctrl+Shift+`', icon: '⬛', category: 'Terminal', action: 'terminal:new'    },
  { id: 'terminal:clear',  label: 'Clear Terminal',         shortcut: 'Ctrl+L',       icon: '⊘',  category: 'Terminal', action: 'terminal:clear'  },
  { id: 'terminal:kill',   label: 'Kill Terminal',                                    icon: '✕',  category: 'Terminal', action: 'terminal:kill'   },

  // ── Agent ─────────────────────────────────────────────────────────────
  { id: 'agent:newChat',   label: 'New AI Conversation',                              icon: '✦',  category: 'Agent',    action: 'agent:newChat'   },
  { id: 'agent:stop',      label: 'Stop Agent',                                       icon: '⏹',  category: 'Agent',    action: 'agent:stop'      },
  { id: 'agent:compact',   label: 'Compact Conversation',                             icon: '⬡',  category: 'Agent',    action: 'agent:compact'   },

  // ── Help / Settings ───────────────────────────────────────────────────
  { id: 'help:shortcuts',  label: 'Keyboard Shortcuts Reference', shortcut: 'Ctrl+K ?', icon: '⌨', category: 'Help',  action: 'help:shortcuts'  },
  { id: 'help:doctor',     label: 'Environment Check (Doctor)…',                      icon: '🩺', category: 'Help',    action: 'help:doctor'     },
  { id: 'help:lsp-setup',  label: 'Language Servers…',                                icon: '🧩', category: 'Help',    action: 'help:lsp-setup'  },
  { id: 'help:mcp',        label: 'MCP Servers…',                                     icon: '🔌', category: 'Help',    action: 'help:mcp'        },
  { id: 'help:app-registry', label: 'Installed App Registry…',                        icon: '🗂', category: 'Help',    action: 'help:app-registry' },
  { id: 'help:updates',    label: 'Check for Updates…',                               icon: '⬆',  category: 'Help',    action: 'help:updates'    },
  { id: 'help:changelog',  label: 'Release Notes',                                    icon: '📝', category: 'Help',    action: 'help:changelog'  },
  { id: 'help:about',      label: 'About Rachna AI Studio',                                 icon: 'ℹ',  category: 'Help',    action: 'help:about'      },
  { id: 'help:issue',      label: 'Report Issue…',                                    icon: '⚑',  category: 'Help',    action: 'help:issue'      },
]

// ── Context-dependent commands filtered at runtime ────────────────────────

const REQUIRES_PROJECT  = new Set(['file:new','file:save','file:saveAs','file:saveAll','file:closeTab','file:closeAll'])
const REQUIRES_OPEN_TAB = new Set(['edit:undo','edit:redo','edit:cut','edit:copy','edit:paste','edit:find','edit:replace','edit:format','edit:selectAll'])

// ── Fuzzy scorer ──────────────────────────────────────────────────────────
//
// Extracted to lib/fuzzyMatch.ts so other features (e.g. the Installed App
// Registry's open_app matching — see services/appRegistry/matching.ts) can
// reuse this exact scorer instead of a second, competing implementation.
// Behavior here is unchanged.

function Highlighted({ label, indices }: { label: string; indices: number[] }) {
  const set = new Set(indices)
  return (
    <>
      {label.split('').map((ch, i) =>
        set.has(i)
          ? <mark key={i} className={styles.hl}>{ch}</mark>
          : <span key={i}>{ch}</span>
      )}
    </>
  )
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  isOpen: boolean
  onClose: () => void
  onAction: (action: string) => void
  hasProject: boolean
  hasActiveTab: boolean
}

export default function CommandPalette({ isOpen, onClose, onAction, hasProject, hasActiveTab }: Props) {
  const [query,     setQuery]     = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef  = useRef<HTMLUListElement>(null)

  const results = useMemo(() => {
    const q = query.trim()
    const filtered = ALL_COMMANDS.filter(cmd => {
      if (!hasProject  && REQUIRES_PROJECT.has(cmd.id))  return false
      if (!hasActiveTab && REQUIRES_OPEN_TAB.has(cmd.id)) return false
      return true
    })
    const scored = filtered
      .map(cmd => {
        const lm = fuzzyMatch(q, cmd.label)
        const cm = fuzzyMatch(q, cmd.category)
        if (!lm && !cm) return null
        const best = (!lm || (cm && cm.score > lm.score)) ? cm! : lm!
        return { cmd, score: best.score, indices: lm?.indices ?? [] }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    if (q) scored.sort((a, b) => b.score - a.score)
    return scored
  }, [query, hasProject, hasActiveTab])

  // Reset selection on new results
  useEffect(() => { setActiveIdx(0) }, [results])

  // Focus input when opened, clear query
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen])

  // Scroll active row into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const run = useCallback((action: string) => {
    onAction(action)
    onClose()
  }, [onAction, onClose])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter')     { e.preventDefault(); if (results[activeIdx]) run(results[activeIdx].cmd.action) }
    else if (e.key === 'Escape')    { e.preventDefault(); onClose() }
  }, [results, activeIdx, run, onClose])

  if (!isOpen) return null

  return (
    <div
      className={styles.backdrop}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={styles.palette} role="dialog" aria-label="Command Palette" aria-modal="true">

        {/* ── Search bar ── */}
        <div className={styles.inputRow}>
          <span className={styles.searchIcon}>⌘</span>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Type a command…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button className={styles.clearBtn} onMouseDown={e => { e.preventDefault(); setQuery(''); inputRef.current?.focus() }}>✕</button>
          )}
        </div>

        {/* ── Results ── */}
        <ul ref={listRef} className={styles.list} role="listbox">
          {results.length === 0 ? (
            <li className={styles.empty}>No commands match "{query}"</li>
          ) : results.map(({ cmd, indices }, i) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={i === activeIdx}
              className={`${styles.item} ${i === activeIdx ? styles.itemActive : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => { e.preventDefault(); run(cmd.action) }}
            >
              <span className={styles.itemIcon}>{cmd.icon ?? '›'}</span>

              <span className={styles.itemBody}>
                <span className={styles.itemLabel}>
                  <Highlighted label={cmd.label} indices={indices} />
                </span>
                {cmd.description && <span className={styles.itemDesc}>{cmd.description}</span>}
              </span>

              <span className={styles.itemMeta}>
                <span className={styles.itemCat}>{cmd.category}</span>
                {cmd.shortcut && (
                  <span className={styles.itemShortcut}>
                    {cmd.shortcut.split('+').map((k, ki) => (
                      <kbd key={ki} className={styles.kbd}>{k}</kbd>
                    ))}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>

        {/* ── Footer hints ── */}
        <div className={styles.footer}>
          <span className={styles.hint}><kbd className={styles.kbd}>↑↓</kbd> navigate</span>
          <span className={styles.hint}><kbd className={styles.kbd}>↵</kbd> run</span>
          <span className={styles.hint}><kbd className={styles.kbd}>Esc</kbd> close</span>
          <span className={styles.hintRight}>Ctrl+Shift+P</span>
        </div>
      </div>
    </div>
  )
}
