// components/viewers/DesignCanvasView.tsx
//
// Infinite canvas for a Design Project — the dedicated presentation layer
// for the Design Intent flow. Every generated .html/.htm page appears as
// a draggable frame/card showing its name in a header bar, with a real
// *live* preview of the page rendered inline (a sandboxed iframe fed the
// page's actual markup via `resolveDesignNodeContent`) — not a static
// screenshot and not a generic placeholder node — loaded lazily once the
// frame scrolls into view.
//
// This view is intentionally NOT a code surface: there is no Monaco here
// and no editing. "Open in editor" hands a page off to EditorPane (via
// IDELayout's handleOpenDesignPage), which is where Code/Design-per-file
// toggling and actual edits still happen; this view only ever *shows* and
// *arranges* pages.
//
// State ownership: all node/transform state lives in
// store/useDesignCanvasStore.ts, which is also what mirrors newly
// generated files into nodes live and what saves/loads the
// `.rachna_design` project file. This component is a renderer over that
// store — it works identically whether the store is tracking an unsaved
// (in-memory) Design Project mid-build or an on-disk saved one; the only
// difference is `resolveDesignNodeContent` reading from
// useUnsavedProjectStore vs disk under the hood. Nothing about that
// pipeline (node discovery/mirroring, layout, persistence, save/rescan)
// changes here — this file only changes how a node is *drawn*.
//
// Panning: drag on empty canvas background. Zooming: mouse wheel (no
// modifier needed — this canvas has no vertical document to scroll) or
// the +/-/Reset controls. Nodes can be dragged individually to rearrange
// the board (from anywhere on the card — the live preview iframe has
// pointer-events disabled so drag/double-click always reach the card, not
// the page running inside it), or reflowed back into a grid with
// "Arrange". Double-clicking a frame opens its file in the editor.

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import styles from './DesignCanvasView.module.css'
import { resolveDesignNodeContent } from '../../lib/designCanvas/content'
import { saveDesignCanvasState as saveLegacyCanvasState } from '../../lib/designCanvasPersistence'
import { useDesignCanvasStore } from '../../store/useDesignCanvasStore'
import type { DesignCanvasNode, DesignCanvasTransform } from '../../lib/designCanvas/types'

const MIN_SCALE = 0.25
const MAX_SCALE = 2.5
const PERSIST_DEBOUNCE_MS = 400

// ── Frame resize constraints ────────────────────────────────────────────
// A frame's live preview iframe needs enough room to be legible — below
// this it stops being useful as a "look at the page" surface.
const MIN_FRAME_WIDTH = 240
const MIN_FRAME_HEIGHT = 160

type RenderStatus = 'pending' | 'loading' | 'ready' | 'error'

interface RenderState {
  status: RenderStatus
  /** The page's own HTML, fed straight into the preview iframe's
   *  `srcDoc` — an actual live render of the generated page, not a
   *  screenshot of one. */
  html?: string
  error?: string
}

interface Props {
  /** The currently open on-disk project's root, or null when no project —
   *  or only an in-memory unsaved one — is open. Used solely to trigger
   *  (re)loading the store from disk when it changes; all rendering reads
   *  from the store, not this prop. */
  projectRoot: string | null
  onOpenFile: (path: string) => void
  onClose: () => void
  /** Opens the existing "name + location" Save dialog (same one Ctrl+S
   *  uses for an unsaved project) — invoked when Save is clicked on a
   *  Design Project that hasn't been written to disk yet. */
  onRequestSaveProject: () => void
  onOpenRecentProject: (manifestPath: string) => void
}

export default function DesignCanvasView({ projectRoot, onOpenFile, onClose, onRequestSaveProject, onOpenRecentProject }: Props) {
  const nodes             = useDesignCanvasStore(s => s.nodes)
  const transform         = useDesignCanvasStore(s => s.transform)
  const storeProjectRoot  = useDesignCanvasStore(s => s.projectRoot)
  const projectName       = useDesignCanvasStore(s => s.projectName)
  const manifestPath      = useDesignCanvasStore(s => s.manifestPath)
  const openForSavedProject = useDesignCanvasStore(s => s.openForSavedProject)
  const rescan             = useDesignCanvasStore(s => s.rescan)
  const setTransform       = useDesignCanvasStore(s => s.setTransform)
  const setNodePosition    = useDesignCanvasStore(s => s.setNodePosition)
  const setNodeSize        = useDesignCanvasStore(s => s.setNodeSize)
  const autoArrange        = useDesignCanvasStore(s => s.autoArrange)
  const saveManifest       = useDesignCanvasStore(s => s.saveManifest)
  const recentProjects     = useDesignCanvasStore(s => s.recentProjects)

  const [renderState, setRenderState] = useState<Record<string, RenderState>>({})
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const nodeDragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null)
  const nodeResizeRef = useRef<{ id: string; startX: number; startY: number; origW: number; origH: number } | null>(null)
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync the store to whichever on-disk project is currently open. An
  // unsaved (in-memory) session has projectRoot === null here and is
  // already populated live by useDesignCanvasStore's own subscription —
  // nothing to do in that case.
  useEffect(() => {
    if (!projectRoot) return
    if (storeProjectRoot === projectRoot) return
    setLoadErr(null)
    setRenderState({})
    openForSavedProject(projectRoot).catch(err => {
      setLoadErr(err instanceof Error ? err.message : String(err))
    })
  }, [projectRoot, storeProjectRoot, openForSavedProject])

  // Clear any pending debounce when switching away so a stale timer can't
  // write one project's legacy board under another's key.
  useEffect(() => () => { if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current) }, [storeProjectRoot])

  const schedulePersist = useCallback((nextTransform: DesignCanvasTransform, nextNodes: DesignCanvasNode[]) => {
    // Soft-autosave for an already-saved project only, as a safety net
    // between explicit "Save Design Project" clicks — same debounced
    // localStorage convention this view always used, kept purely so
    // dragging nodes around isn't lost on app restart if the user forgets
    // to hit Save. The authoritative save is still the explicit manifest
    // write (saveManifest), which the Save button below calls directly.
    if (!storeProjectRoot) return
    if (persistTimeoutRef.current) clearTimeout(persistTimeoutRef.current)
    const root = storeProjectRoot
    persistTimeoutRef.current = setTimeout(() => {
      const positions: Record<string, { x: number; y: number }> = {}
      for (const n of nextNodes) positions[n.filePath] = { x: n.x, y: n.y }
      saveLegacyCanvasState(root, { transform: nextTransform, positions })
    }, PERSIST_DEBOUNCE_MS)
  }, [storeProjectRoot])

  const markReady = useCallback((id: string, html: string) => {
    setRenderState(prev => ({ ...prev, [id]: { status: 'ready', html } }))
  }, [])
  const markError = useCallback((id: string, error: string) => {
    setRenderState(prev => ({ ...prev, [id]: { status: 'error', error } }))
  }, [])

  // ── Pan (drag on empty canvas background) ──
  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    panRef.current = { startX: e.clientX, startY: e.clientY, origX: transform.x, origY: transform.y }
  }

  // ── Drag an individual node to rearrange the board ──
  const onNodeDragStart = useCallback((id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const n = nodes.find(nn => nn.id === id)
    if (!n) return
    nodeDragRef.current = { id, startX: e.clientX, startY: e.clientY, origX: n.x, origY: n.y }
  }, [nodes])

  // ── Resize an individual node from its bottom-right corner handle ──
  // Each rendered UI (the live iframe preview) is a card the same as any
  // node — this just lets that card's box be dragged bigger/smaller,
  // independent of dragging it around the board.
  const onNodeResizeStart = useCallback((id: string, e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const n = nodes.find(nn => nn.id === id)
    if (!n) return
    nodeResizeRef.current = { id, startX: e.clientX, startY: e.clientY, origW: n.width, origH: n.height }
  }, [nodes])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (nodeResizeRef.current) {
        const { id, startX, startY, origW, origH } = nodeResizeRef.current
        const nw = Math.max(MIN_FRAME_WIDTH, origW + (e.clientX - startX) / transform.scale)
        const nh = Math.max(MIN_FRAME_HEIGHT, origH + (e.clientY - startY) / transform.scale)
        setNodeSize(id, nw, nh)
        return
      }
      if (nodeDragRef.current) {
        const { id, startX, startY, origX, origY } = nodeDragRef.current
        const nx = origX + (e.clientX - startX) / transform.scale
        const ny = origY + (e.clientY - startY) / transform.scale
        setNodePosition(id, nx, ny)
        return
      }
      if (panRef.current) {
        const { startX, startY, origX, origY } = panRef.current
        setTransform({ ...transform, x: origX + (e.clientX - startX), y: origY + (e.clientY - startY) })
      }
    }
    const onUp = () => {
      const wasDragging = nodeDragRef.current !== null || panRef.current !== null || nodeResizeRef.current !== null
      nodeDragRef.current = null
      panRef.current = null
      nodeResizeRef.current = null
      if (wasDragging) schedulePersist(useDesignCanvasStore.getState().transform, useDesignCanvasStore.getState().nodes)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [transform, setTransform, setNodePosition, setNodeSize, schedulePersist])

  // ── Zoom (wheel, centered on cursor) ──
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = canvasRef.current?.getBoundingClientRect()
    const cx = rect ? e.clientX - rect.left : 0
    const cy = rect ? e.clientY - rect.top : 0
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * (1 - e.deltaY * 0.001)))
    const ratio = next / transform.scale
    const updated = { scale: next, x: cx - (cx - transform.x) * ratio, y: cy - (cy - transform.y) * ratio }
    setTransform(updated)
    schedulePersist(updated, nodes)
  }, [transform, nodes, setTransform, schedulePersist])

  const zoomBy = (factor: number) => {
    const updated = { ...transform, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor)) }
    setTransform(updated)
    schedulePersist(updated, nodes)
  }
  const resetView = () => {
    const updated = { x: 40, y: 40, scale: 1 }
    setTransform(updated)
    schedulePersist(updated, nodes)
  }

  const handleArrange = () => {
    autoArrange()
    schedulePersist(transform, useDesignCanvasStore.getState().nodes)
  }

  const handleSaveClick = async () => {
    if (!storeProjectRoot) {
      // Files haven't been written to disk yet — hand off to the
      // existing "name + location" Save dialog (Ctrl+S's dialog), which
      // (per IDELayout's confirmSaveDialog) writes the files AND the
      // .rachna_design manifest together as one Save action.
      onRequestSaveProject()
      return
    }
    setSaveState('saving')
    try {
      await saveManifest()
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 1500)
    } catch {
      setSaveState('error')
      setTimeout(() => setSaveState('idle'), 2000)
    }
  }

  const readyCount = useMemo(
    () => nodes.filter(n => renderState[n.id]?.status === 'ready').length,
    [nodes, renderState],
  )

  const saveLabel =
    saveState === 'saving' ? 'Saving…' :
    saveState === 'saved'  ? 'Saved ✓' :
    saveState === 'error'  ? 'Save failed' :
    storeProjectRoot       ? '💾 Save Design Project' :
                              '💾 Save as Design Project…'

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.title}>🎨 {projectName ?? 'Design Canvas'}</span>
          {!storeProjectRoot && <span className={styles.frameBadge}>Unsaved</span>}
          <span className={styles.subtitle}>
            {nodes.length === 0 ? 'No pages yet' : `${readyCount}/${nodes.length} pages rendered`}
            {manifestPath ? ' · saved as Design Project' : ''}
          </span>
        </div>
        <div className={styles.toolbarRight}>
          <button className={styles.toolBtn} onClick={() => zoomBy(0.8)} title="Zoom out">−</button>
          <span className={styles.zoomLabel}>{Math.round(transform.scale * 100)}%</span>
          <button className={styles.toolBtn} onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
          <button className={styles.toolBtn} onClick={resetView} title="Reset view">Reset</button>
          <button className={styles.toolBtn} onClick={handleArrange} title="Auto-arrange every node into a grid">⊞ Arrange</button>
          {storeProjectRoot && (
            <button className={styles.toolBtn} onClick={() => rescan()} title="Rescan project for pages">⟳ Rescan</button>
          )}
          <button className={styles.toolBtnPrimary} onClick={handleSaveClick} title="Save the canvas as a .rachna_design Design Project">
            {saveLabel}
          </button>
          <button className={styles.closeBtn} onClick={onClose} title="Back to editor">Close</button>
        </div>
      </div>

      <div
        ref={canvasRef}
        className={styles.canvas}
        onMouseDown={onBackgroundMouseDown}
        onWheel={onWheel}
      >
        {loadErr && <div className={styles.loadError}>Couldn't scan project: {loadErr}</div>}
        {!loadErr && nodes.length === 0 && (
          <div className={styles.emptyState}>
            <strong>{recentProjects.length ? 'Past design projects' : 'No design projects yet'}</strong>
            {recentProjects.length > 0 ? (
              <div className={styles.recentGrid}>
                {recentProjects.map(project => (
                  <button
                    key={project.manifestPath}
                    className={styles.recentCard}
                    onClick={(event) => { event.stopPropagation(); onOpenRecentProject(project.manifestPath) }}
                    title={project.manifestPath}
                  >
                    <span className={styles.recentIcon}>🎨</span>
                    <span className={styles.recentDetails}>
                      <span className={styles.recentName}>{project.projectName}</span>
                      <span className={styles.recentPath}>{project.projectRoot}</span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <span className={styles.emptyHint}>Pages appear here as they're generated or after a Design Project is saved.</span>
            )}
          </div>
        )}
        <div
          className={styles.board}
          style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        >
          {nodes.map(node => (
            <NodeWithState
              key={node.id}
              node={node}
              renderState={renderState[node.id]}
              onReady={markReady}
              onError={markError}
              onOpen={onOpenFile}
              onDragStart={onNodeDragStart}
              onResizeStart={onNodeResizeStart}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Thin wrapper so RenderSurface (which needs the per-node render state)
 *  can be threaded through Node without every intermediate component
 *  needing to know about the status map's shape. */
function NodeWithState(props: {
  node: DesignCanvasNode
  renderState?: RenderState
  onReady: (id: string, html: string) => void
  onError: (id: string, error: string) => void
  onOpen: (path: string) => void
  onDragStart: (id: string, e: React.MouseEvent) => void
  onResizeStart: (id: string, e: React.MouseEvent) => void
}) {
  const { node, onReady, onError, onOpen, onDragStart, onResizeStart } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const startedRef = useRef(false)

  const load = useCallback(() => {
    ;(async () => {
      try {
        const { content } = await resolveDesignNodeContent(node.filePath)
        onReady(node.id, content)
      } catch (err) {
        onError(node.id, err instanceof Error ? err.message : String(err))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, node.filePath])

  // Load the page's markup lazily, once the frame scrolls into view —
  // same rootMargin/threshold convention the old screenshot pipeline
  // used, just without the round trip to a headless-browser subprocess:
  // reading the file and handing it to the iframe is effectively
  // instant, so this is what makes the preview feel "live".
  useEffect(() => {
    startedRef.current = false
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      entries => {
        if (!entries[0]?.isIntersecting || startedRef.current) return
        startedRef.current = true
        observer.disconnect()
        load()
      },
      { root: null, rootMargin: '600px', threshold: 0.01 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [load])

  const status = props.renderState?.status

  return (
    <div
      ref={ref}
      className={styles.frame}
      style={{ left: node.x, top: node.y, width: node.width }}
      onDoubleClick={() => onOpen(node.filePath)}
    >
      <div
        className={styles.frameLabel}
        title={`${node.filePath} — drag to rearrange, double-click to open`}
        onMouseDown={e => onDragStart(node.id, e)}
      >
        <span className={styles.frameName}>{node.name}</span>
        <span className={styles.frameBadge}>{node.fileType}</span>
        {status === 'ready' && (
          <button
            className={styles.refreshBtn}
            title="Reload live preview"
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); load() }}
          >
            ⟳
          </button>
        )}
      </div>
      <div
        className={styles.frameSurface}
        style={{ height: node.height }}
        onMouseDown={e => onDragStart(node.id, e)}
      >
        {status === 'ready' && props.renderState?.html !== undefined && (
          <iframe
            className={styles.frameIframe}
            srcDoc={props.renderState.html}
            title={node.name}
            sandbox="allow-scripts"
            loading="lazy"
            // The preview is for looking, not touching — pointer-events
            // stay off so clicks/drags always land on the card itself
            // (rearranging the board, or the double-click that opens the
            // real file), never on whatever the generated page does with
            // them.
            style={{ pointerEvents: 'none' }}
          />
        )}
        {(!status || status === 'pending' || status === 'loading') && (
          <div className={styles.frameStatus}>Loading live preview…</div>
        )}
        {status === 'error' && (
          <div className={styles.frameError}>{props.renderState?.error || 'Failed to load preview.'}</div>
        )}
        {/* Resize handle — bottom-right corner. Lets each rendered page's
            frame be resized independently (drag to grow/shrink), instead
            of every card being locked to its auto-arrange default size. */}
        <div
          className={styles.resizeHandle}
          title="Drag to resize"
          onMouseDown={e => onResizeStart(node.id, e)}
        />
      </div>
      <button
        className={styles.openBtn}
        onClick={e => { e.stopPropagation(); onOpen(node.filePath) }}
      >
        Open in editor →
      </button>
    </div>
  )
}
