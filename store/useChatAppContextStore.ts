// store/useChatAppContextStore.ts
//
// Queues "app context" chips added from the App Registry (installed apps)
// or App Manager (running apps) panels onto the NEXT outgoing chat message.
// Mirrors the shape of lib/pendingAttachments.ts (a small queue that
// useChat.ts's handleSend drains and clears), but is a reactive Zustand
// store rather than a plain module store, since ChatInput.tsx needs to
// re-render live as chips are added/removed — this is what the action bar
// renders as "added currently running app : <name>" / "added currently
// installed app : <name>" chips.
//
// Selecting an app card's "Add to chat" button never sends anything by
// itself — it only queues a chip. The chip's full details are folded into
// the user's message text the moment they actually hit Send (see
// buildAppContextBlock below, consumed from components/AiChat/useChat.ts).

import { create } from 'zustand'
import type { RunningApp } from '../services/appManager/appManager'
import type { InstalledApp } from '../services/appRegistry/types'

export interface ChatAppContextItem {
  id: string
  kind: 'running' | 'installed'
  /** Short display name shown in the chip, e.g. "ABCD". */
  name: string
  /** Full human-readable block folded into the outgoing message text. */
  details: string
}

interface ChatAppContextState {
  items: ChatAppContextItem[]
  addRunningApp: (app: RunningApp) => void
  addInstalledApp: (app: InstalledApp) => void
  remove: (id: string) => void
  clear: () => void
}

function runningAppDetails(app: RunningApp): string {
  const lines = [
    `App: ${app.title || app.exeName} (currently running)`,
    `Executable: ${app.exeName}`,
  ]
  if (app.exePath) lines.push(`Path: ${app.exePath}`)
  lines.push(`PID: ${app.pid}`)
  lines.push(`Visible: ${app.isVisible ? 'yes' : 'no'}, Focused: ${app.isFocused ? 'yes' : 'no'}`)
  return lines.join('\n')
}

function installedAppDetails(app: InstalledApp): string {
  const lines = [
    `App: ${app.name} (installed, not necessarily running)`,
    `Kind: ${app.kind === 'packaged' ? 'Packaged/Store app' : 'Win32 app'}`,
    `Launch target: ${app.launchTarget}`,
  ]
  if (app.appUserModelId) lines.push(`AppUserModelId: ${app.appUserModelId}`)
  lines.push(`Source: ${app.source}`)
  return lines.join('\n')
}

export const useChatAppContextStore = create<ChatAppContextState>((set, get) => ({
  items: [],

  addRunningApp: (app) => {
    const id = `running:${app.pid}`
    if (get().items.some(i => i.id === id)) return
    set(s => ({
      items: [
        ...s.items,
        {
          id,
          kind: 'running',
          name: app.title || app.exeName,
          details: runningAppDetails(app),
        },
      ],
    }))
  },

  addInstalledApp: (app) => {
    const id = `installed:${app.launchTarget}`
    if (get().items.some(i => i.id === id)) return
    set(s => ({
      items: [
        ...s.items,
        {
          id,
          kind: 'installed',
          name: app.name,
          details: installedAppDetails(app),
        },
      ],
    }))
  },

  remove: (id) => set(s => ({ items: s.items.filter(i => i.id !== id) })),

  clear: () => set({ items: [] }),
}))

/** Chip label text shown in the action bar, per the item's kind. */
export function appContextChipLabel(item: ChatAppContextItem): string {
  return item.kind === 'running'
    ? `added currently running app : ${item.name}`
    : `added currently installed app : ${item.name}`
}

/**
 * Folds all queued app-context items into a single block appended to the
 * outgoing message text. Returns '' when there's nothing queued (callers
 * should skip appending in that case).
 */
export function buildAppContextBlock(items: ChatAppContextItem[]): string {
  if (items.length === 0) return ''
  const body = items.map(i => i.details).join('\n\n')
  return `[Attached app context]\n${body}`
}
