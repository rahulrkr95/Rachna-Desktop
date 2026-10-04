// store/useDesignCanvasStore.ts
//
// Live state for the Design Canvas — the infinite pan/zoom board that is
// the primary artifact of a Design Project (see components/viewers/
// DesignCanvasView.tsx for rendering). This store owns:
//
//   - opening/closing/focusing the Design Canvas *editor tab*
//     (design://canvas — see lib/designCanvasTab.ts) via `open`/`close`/
//     `toggle`. The canvas renders inside EditorPane exactly like any
//     other viewer (Monaco/PDF/Image/...); this store no longer tracks a
//     separate "is it showing" flag — that's just editor tab state.
//   - the canvas's nodes (one per generated page) + pan/zoom transform,
//     for BOTH an in-memory "unsaved" Design Project still being built by
//     the chat flow, and an on-disk saved one.
//   - live mirroring: while an unsaved session is active, this store
//     subscribes to useUnsavedProjectStore and turns every .html/.htm
//     file the (untouched) Build New Project flow writes into a canvas
//     node in real time — this is the "as each page is generated, create
//     a visual node" step of the Design Intent flow, implemented purely
//     as a presentation-layer subscriber. It never reaches into
//     services/agent/buildNewProject.ts or its tools.
//
// Flow this store implements (see task description):
//   Design Intent → beginUnsavedSession() opens/creates the canvas
//     → runBuildNewProjectFlow() (untouched) writes files
//       → this store's subscription turns each into a node, auto-arranged
//   → User saves → transferToSavedRoot() + saveManifest() write the
//     canvas itself as a .rachna_design Design Project.
//
// Kept as its own store (rather than a field on useEditorStore) for the
// same reason as before: it's a pure view concept layered on top of two
// existing, untouched stores/services (useUnsavedProjectStore for
// in-memory files, lib/tauriFs + lib/designCanvas/projectFile.ts for
// on-disk projects), not a rewrite of either.

import { create } from 'zustand'
import { readFolder } from '../lib/tauriFs'
import { collectDesignPages } from '../lib/designCanvasFiles'
import { loadDesignCanvasState as loadLegacyCanvasState } from '../lib/designCanvasPersistence'
import {
  loadDesignProjectManifestFromRoot,
  saveDesignProjectManifest,
  pickAndLoadDesignProjectFile,
  loadDesignProjectFile,
  joinProjectPath,
} from '../lib/designCanvas/projectFile'
import { gridPosition, NODE_WIDTH, NODE_HEIGHT } from '../lib/designCanvas/layout'
import type {
  DesignCanvasNode,
  DesignCanvasTransform,
  DesignProjectManifest,
} from '../lib/designCanvas/types'
import { loadRecentDesignProjects, rememberDesignProject, type RecentDesignProject } from '../lib/recentDesignProjects'
import { DESIGN_PROJECT_FORMAT } from '../lib/designCanvas/types'
import { useUnsavedProjectStore, type UnsavedProjectFile } from './useUnsavedProjectStore'
import { useEditorStore } from './useEditorStore'
import { DESIGN_CANVAS_TAB_ID, designCanvasTabDescriptor } from '../lib/designCanvasTab'

// ── Editor-tab bridge ───────────────────────────────────────────────────
// The Design Canvas now renders as a normal editor tab (design://canvas)
// inside EditorPane, exactly like Monaco/PDF/Image viewers — see
// components/EditorPane.tsx + components/viewers/ViewerRegistry.ts. This
// store no longer tracks its own "is the canvas showing" flag; `open` /
// `close` / `toggle` below just open/close/activate that tab directly, so
// every existing caller (Header's Canvas button, the chat's "🎨 Open
// Canvas" message action, beginUnsavedSession, etc.) keeps working with no
// call-site changes.
function openDesignCanvasTab() {
  useEditorStore.getState().openTab(designCanvasTabDescriptor())
}
function closeDesignCanvasTab() {
  useEditorStore.getState().closeTab(DESIGN_CANVAS_TAB_ID)
}
function isDesignCanvasTabActive(): boolean {
  const s = useEditorStore.getState()
  return s.activeKind === 'file' && s.activeId === DESIGN_CANVAS_TAB_ID
}

const DEFAULT_TRANSFORM: DesignCanvasTransform = { x: 40, y: 40, scale: 1 }

function isDesignPageName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

function fileTypeOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx === -1 ? 'file' : name.slice(idx + 1).toLowerCase()
}

function makeNode(
  filePath: string,
  name: string,
  pos: { x: number; y: number },
  status: DesignCanvasNode['status'] = 'ready',
): DesignCanvasNode {
  return {
    id: filePath,
    kind: 'file',
    filePath,
    name,
    fileType: fileTypeOf(name),
    x: pos.x,
    y: pos.y,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    status,
  }
}

interface DesignCanvasState {
  /** Real on-disk folder for a saved Design Project, or null while it's
   *  still an in-memory "unsaved" project. */
  projectRoot: string | null
  projectName: string | null
  /** Absolute path of the last-loaded/saved .rachna_design manifest, if any. */
  manifestPath: string | null
  transform: DesignCanvasTransform
  nodes: DesignCanvasNode[]
  recentProjects: RecentDesignProject[]

  /** Opens (or focuses, if already open) the Design Canvas editor tab. */
  open: () => void
  /** Closes the Design Canvas editor tab. */
  close: () => void
  /** Opens/focuses the tab if it isn't the active tab; if it IS the active
   *  tab, switches back to whatever was open before ("back to editor"). */
  toggle: () => void

  /** Step 2 of the Design Intent flow: open (or reset) the canvas for a
   *  brand-new, not-yet-saved design project, and start mirroring every
   *  page useUnsavedProjectStore receives from the (untouched) Build New
   *  Project flow as a canvas node, live. */
  beginUnsavedSession: (projectName: string) => void
  /** Opens the canvas for an on-disk project, restoring node positions +
   *  viewport from its .rachna_design manifest (or the legacy per-project
   *  localStorage board, for projects saved before this file format
   *  existed) if present; otherwise auto-arranges freshly-discovered pages. */
  openForSavedProject: (projectRoot: string) => Promise<void>
  /** Re-scans `projectRoot` on disk for pages, adding nodes for any new
   *  ones (existing node positions are always preserved). No-op for an
   *  unsaved session, which stays in sync automatically via subscription. */
  rescan: () => Promise<void>
  /** Opens a native file picker for a `.rachna_design` file and loads it.
   *  Returns the resolved project root (to hand to the caller for
   *  indexing/opening as the active project), or null if cancelled. */
  openFromFilePicker: () => Promise<string | null>
  /** Reopens a project selected from the persisted empty-canvas list. */
  openRecentProject: (manifestPath: string) => Promise<string>

  setTransform: (t: DesignCanvasTransform) => void
  setNodePosition: (id: string, x: number, y: number) => void
  /** Resizes a single node's frame (dragged from its bottom-right corner
   *  handle in DesignCanvasView). Width/height are clamped by the caller
   *  before this is invoked. */
  setNodeSize: (id: string, width: number, height: number) => void
  /** Re-flows every node back into the default grid. */
  autoArrange: () => void

  /** Remaps every `unsaved://...` node onto its real on-disk path right
   *  after services/projects/saveUnsavedProject.ts has written the files
   *  to `projectRoot` — called once, at the moment of Save, so the same
   *  Save action that writes the files can also persist the canvas. */
  transferToSavedRoot: (projectRoot: string) => void
  /** Writes `{projectRoot}/design.rachna_design`. Returns the path
   *  written, or null if there's no on-disk projectRoot yet (an unsaved
   *  session's underlying files must be saved first — see
   *  transferToSavedRoot). */
  saveManifest: () => Promise<string | null>

  reset: () => void
}

/** Live subscription to useUnsavedProjectStore, active only while an
 *  unsaved session is open. Module-scoped (not store state) since it's an
 *  unsubscribe function, not serializable UI state. */
let unsubscribeUnsavedFiles: (() => void) | null = null

function stopMirroring() {
  unsubscribeUnsavedFiles?.()
  unsubscribeUnsavedFiles = null
}

export const useDesignCanvasStore = create<DesignCanvasState>((set, get) => ({
  projectRoot: null,
  projectName: null,
  manifestPath: null,
  transform: DEFAULT_TRANSFORM,
  nodes: [],
  recentProjects: loadRecentDesignProjects(),

  open: () => openDesignCanvasTab(),
  close: () => closeDesignCanvasTab(),
  toggle: () => {
    if (!isDesignCanvasTabActive()) {
      openDesignCanvasTab()
      return
    }
    // Already the active tab — "back to editor": hand focus to whatever
    // other tab is open, same as clicking that tab directly. If nothing
    // else is open, just close the canvas tab (nothing left to show).
    const es = useEditorStore.getState()
    const otherFile = es.tabs.find(t => t.id !== DESIGN_CANVAS_TAB_ID)
    if (otherFile) {
      es.setActiveTab(otherFile.id)
    } else if (es.diffTabs.length > 0) {
      es.setActiveDiffTab(es.diffTabs[es.diffTabs.length - 1].id)
    } else {
      closeDesignCanvasTab()
    }
  },

  beginUnsavedSession: (projectName) => {
    stopMirroring()
    set({
      projectRoot: null,
      projectName,
      manifestPath: null,
      transform: DEFAULT_TRANSFORM,
      nodes: [],
    })
    openDesignCanvasTab()

    const syncFromUnsavedFiles = (files: Record<string, UnsavedProjectFile>) => {
      set((state) => {
        const existingByPath = new Map(state.nodes.map(n => [n.filePath, n]))
        const nextNodes: DesignCanvasNode[] = []
        for (const file of Object.values(files)) {
          if (!isDesignPageName(file.name)) continue
          const existing = existingByPath.get(file.path)
          if (existing) {
            // Keep the user's arrangement; just keep name/fileType current
            // (a generated file's name never actually changes post-hoc,
            // but this keeps the node honest if it ever does).
            nextNodes.push({ ...existing, name: file.name, fileType: fileTypeOf(file.name), status: 'ready' })
          } else {
            nextNodes.push(makeNode(file.path, file.name, gridPosition(nextNodes.length)))
          }
        }
        return { nodes: nextNodes }
      })
    }

    // Seed with whatever's already in the store (normally empty right
    // after createProject(), but this stays correct if called again).
    syncFromUnsavedFiles(useUnsavedProjectStore.getState().files)
    unsubscribeUnsavedFiles = useUnsavedProjectStore.subscribe(state => syncFromUnsavedFiles(state.files))
  },

  openForSavedProject: async (projectRoot) => {
    stopMirroring()
    set({ projectRoot, manifestPath: null, nodes: [], projectName: get().projectName })
    openDesignCanvasTab()
    await get().rescan()
  },

  rescan: async () => {
    const { projectRoot, nodes: currentNodes, manifestPath } = get()
    if (!projectRoot) return

    // Position priority, lowest to highest: fresh grid slot < legacy
    // localStorage board < manifest < whatever's already in memory (so
    // re-scanning after the user has been dragging nodes around never
    // snaps them back).
    const positions: Record<string, { x: number; y: number }> = {}
    let manifest: DesignProjectManifest | null = null
    const resolvedManifestPath = manifestPath

    if (!manifestPath) {
      manifest = await loadDesignProjectManifestFromRoot(projectRoot)
    }
    const legacy = manifest ? null : loadLegacyCanvasState(projectRoot)
    if (legacy) Object.assign(positions, legacy.positions)
    if (manifest) {
      for (const n of manifest.canvas.nodes) positions[n.filePath] = { x: n.x, y: n.y }
    }
    for (const n of currentNodes) positions[n.filePath] = { x: n.x, y: n.y }

    let pages: { path: string; name: string }[] = []
    try {
      const root = await readFolder(projectRoot)
      pages = collectDesignPages(root)
    } catch {
      // Folder unreadable (e.g. just deleted) — leave existing nodes as-is.
      return
    }

    const nodes = pages.map((page, i) => {
      const pos = positions[page.path] ?? gridPosition(i)
      return makeNode(page.path, page.name, pos)
    })

    set({
      nodes,
      transform: manifest?.canvas.transform ?? legacy?.transform ?? get().transform,
      projectName: manifest?.projectName ?? get().projectName,
      manifestPath: resolvedManifestPath,
    })
  },

  openFromFilePicker: async () => {
    const picked = await pickAndLoadDesignProjectFile()
    if (!picked) return null

    stopMirroring()
    set({
      projectRoot: picked.projectRoot,
      projectName: picked.manifest.projectName,
      manifestPath: picked.manifestPath,
      transform: picked.manifest.canvas.transform,
      nodes: picked.manifest.canvas.nodes,
      recentProjects: rememberDesignProject({
        manifestPath: picked.manifestPath,
        projectRoot: picked.projectRoot,
        projectName: picked.manifest.projectName,
      }),
    })
    openDesignCanvasTab()
    // Pick up any page written to the folder after the manifest was last
    // saved (e.g. edited outside the app) without disturbing loaded nodes.
    await get().rescan()
    return picked.projectRoot
  },

  openRecentProject: async (manifestPath) => {
    const picked = await loadDesignProjectFile(manifestPath)
    stopMirroring()
    set({
      projectRoot: picked.projectRoot,
      projectName: picked.manifest.projectName,
      manifestPath: picked.manifestPath,
      transform: picked.manifest.canvas.transform,
      nodes: picked.manifest.canvas.nodes,
      recentProjects: rememberDesignProject({
        manifestPath: picked.manifestPath,
        projectRoot: picked.projectRoot,
        projectName: picked.manifest.projectName,
      }),
    })
    openDesignCanvasTab()
    await get().rescan()
    return picked.projectRoot
  },

  setTransform: (t) => set({ transform: t }),

  setNodePosition: (id, x, y) =>
    set(state => ({
      nodes: state.nodes.map(n => (n.id === id ? { ...n, x, y } : n)),
    })),

  setNodeSize: (id, width, height) =>
    set(state => ({
      nodes: state.nodes.map(n => (n.id === id ? { ...n, width, height } : n)),
    })),

  autoArrange: () =>
    set(state => ({
      nodes: state.nodes.map((n, i) => ({ ...n, ...gridPosition(i) })),
    })),

  transferToSavedRoot: (projectRoot) =>
    set((state) => ({
      projectRoot,
      manifestPath: null,
      nodes: state.nodes.map((n) => {
        if (!n.filePath.startsWith('unsaved://')) return n
        const relative = n.filePath.replace(/^unsaved:\/\//, '')
        const realPath = joinProjectPath(projectRoot, relative)
        return { ...n, id: realPath, filePath: realPath }
      }),
    })),

  saveManifest: async () => {
    const state = get()
    if (!state.projectRoot) return null

    const now = Date.now()
    const manifest: DesignProjectManifest = {
      format: DESIGN_PROJECT_FORMAT,
      version: 1,
      projectName: state.projectName ?? 'Untitled Design',
      createdAt: now,
      updatedAt: now,
      canvas: {
        transform: state.transform,
        nodes: state.nodes,
        edges: [],
        comments: [],
      },
    }

    const path = await saveDesignProjectManifest(state.projectRoot, manifest)
    set({
      manifestPath: path,
      recentProjects: rememberDesignProject({
        manifestPath: path,
        projectRoot: state.projectRoot,
        projectName: manifest.projectName,
      }),
    })
    return path
  },

  reset: () => {
    stopMirroring()
    closeDesignCanvasTab()
    set({
      projectRoot: null,
      projectName: null,
      manifestPath: null,
      transform: DEFAULT_TRANSFORM,
      nodes: [],
    })
  },
}))
