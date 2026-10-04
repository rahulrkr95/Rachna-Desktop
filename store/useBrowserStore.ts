import { create } from 'zustand'

export interface BrowserTab {
  id: string
  url: string
  title: string
  screenshotBase64?: string
  loading?: boolean
  error?: string
}

type BrowserView = 'chat' | 'code' | 'terminal' | 'browser'
interface BrowserState {
  tabs: BrowserTab[]
  activeTabId: string | null
  activeView: BrowserView
  open: (url?: string, background?: boolean) => string
  close: (id: string) => void
  activate: (id: string) => void
  navigate: (id: string, url: string) => void
  updateFromAgent: (result: { url: string; finalUrl?: string; title?: string; screenshotBase64?: string | null; navError?: string }) => void
  setView: (view: BrowserView) => void
}

const STORAGE_KEY = 'rachna_embedded_browser_tabs_v1'
const HOME = 'http://localhost:3000'
function load(): Pick<BrowserState, 'tabs' | 'activeTabId'> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (Array.isArray(saved.tabs)) return { tabs: saved.tabs, activeTabId: saved.activeTabId ?? saved.tabs[0]?.id ?? null }
  } catch { /* start with a clean browser */ }
  return { tabs: [], activeTabId: null }
}
function persist(tabs: BrowserTab[], activeTabId: string | null) {
  // Screenshots can be several MB; URLs/titles are the durable browser session.
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: tabs.map(({ screenshotBase64: _, ...tab }) => tab), activeTabId }))
}
const initial = load()

export const useBrowserStore = create<BrowserState>((set, get) => ({
  ...initial,
  activeView: 'chat',
  open(url = HOME, background = false) {
    const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const tab = { id, url, title: url === HOME ? 'New tab' : url }
    const tabs = [...get().tabs, tab]
    const activeTabId = background ? get().activeTabId : id
    persist(tabs, activeTabId)
    set({ tabs, activeTabId, activeView: background ? get().activeView : 'browser' })
    return id
  },
  close(id) {
    const old = get()
    const index = old.tabs.findIndex(tab => tab.id === id)
    const tabs = old.tabs.filter(tab => tab.id !== id)
    const activeTabId = old.activeTabId === id ? (tabs[Math.max(0, index - 1)]?.id ?? null) : old.activeTabId
    persist(tabs, activeTabId)
    set({ tabs, activeTabId })
  },
  activate(id) { persist(get().tabs, id); set({ activeTabId: id, activeView: 'browser' }) },
  navigate(id, url) {
    const tabs = get().tabs.map(tab => tab.id === id ? { ...tab, url, title: url, screenshotBase64: undefined, error: undefined } : tab)
    persist(tabs, get().activeTabId)
    set({ tabs })
  },
  updateFromAgent(result) {
    const state = get()
    const finalUrl = result.finalUrl || result.url
    let id = state.activeTabId
    let tabs = state.tabs
    if (!id) {
      id = `browser-agent-${Date.now()}`
      tabs = [...tabs, { id, url: finalUrl, title: result.title || finalUrl }]
    }
    tabs = tabs.map(tab => tab.id === id ? {
      ...tab, url: finalUrl, title: result.title || finalUrl,
      screenshotBase64: result.screenshotBase64 || undefined, error: result.navError,
    } : tab)
    persist(tabs, id)
    set({ tabs, activeTabId: id, activeView: 'browser' })
  },
  setView(activeView) { set({ activeView }) },
}))
