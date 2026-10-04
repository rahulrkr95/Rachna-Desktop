// components/GraphDialog.tsx
//
// Renders the repo dependency graph as a D3 force-directed diagram
// inside an overlay dialog.  Opens when the user clicks the "✦ Index ready"
// chip in AiChat.
//
// Only requires graphSnapshot from useRepoIndex — no new store changes.

import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import styles from './GraphDialog.module.css'
import type { GraphSnapshot } from '../store/useRepoIndex'

// ── File tree types ─────────────────────────────────────────────────────

interface TreeNode {
  name: string
  path: string          // full path (for files) or accumulated path (for dirs)
  isFile: boolean
  degree: number
  children: Map<string, TreeNode>
}

// Build a nested tree from a flat list of file paths
function buildTree(nodeIds: string[], degree: Record<string, number>): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, degree: 0, children: new Map() }

  for (const id of nodeIds) {
    const parts = id.replace(/\\/g, '/').split('/').filter(Boolean)
    let cur = root
    let accPath = ''
    parts.forEach((part, i) => {
      accPath = accPath ? `${accPath}/${part}` : part
      const isFile = i === parts.length - 1
      let child = cur.children.get(part)
      if (!child) {
        child = { name: part, path: isFile ? id : accPath, isFile, degree: 0, children: new Map() }
        cur.children.set(part, child)
      }
      if (isFile) child.degree = degree[id] ?? 0
      cur = child
    })
  }

  return root
}

// Sort: directories first (alphabetical), then files (alphabetical)
function sortedChildren(node: TreeNode): TreeNode[] {
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

function degreeColor(degree: number): string {
  if (degree === 0) return 'rgba(255,255,255,0.35)'
  if (degree <= 3)  return 'rgba(52,211,153,0.85)'
  if (degree <= 8)  return 'rgba(251,191,36,0.9)'
  return 'rgba(239,68,68,0.95)'
}

interface FileTreeRowProps {
  node: TreeNode
  depth: number
  expanded: Set<string>
  toggle: (path: string) => void
}

function FileTreeRow({ node, depth, expanded, toggle }: FileTreeRowProps) {
  const isOpen = expanded.has(node.path)
  const children = sortedChildren(node)

  return (
    <>
      <div
        className={styles.treeRow}
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => !node.isFile && toggle(node.path)}
      >
        {!node.isFile && (
          <span className={styles.treeCaret}>{isOpen ? '▾' : '▸'}</span>
        )}
        {node.isFile && <span className={styles.treeFileIcon}>·</span>}
        <span className={node.isFile ? styles.treeFileName : styles.treeDirName}>
          {node.name}
        </span>
        {node.isFile && (
          <span
            className={styles.treeDegree}
            style={{ color: degreeColor(node.degree) }}
            title={`${node.degree} import${node.degree === 1 ? '' : 's'}/dependents`}
          >
            {node.degree}
          </span>
        )}
      </div>
      {!node.isFile && isOpen && children.map(child => (
        <FileTreeRow key={child.path} node={child} depth={depth + 1} expanded={expanded} toggle={toggle} />
      ))}
    </>
  )
}

// ── D3 loaded via CDN at runtime ──────────────────────────────────────────

declare const d3: typeof import('d3')

interface NodeDatum {
  id: string
  label: string   // basename of the file
  degree: number  // total edges in + out
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

interface LinkDatum {
  source: string | NodeDatum
  target: string | NodeDatum
}

// Shorten an absolute path to a display-friendly basename
function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path
}

interface Props {
  snapshot: GraphSnapshot
  onClose: () => void
}

export default function GraphDialog({ snapshot, onClose }: Props) {
  const svgRef    = useRef<SVGSVGElement>(null)
  const d3Loaded  = useRef(false)
  const [view, setView] = useState<'graph' | 'files'>('graph')

  // Tree built from snapshot, once per snapshot
  const tree = useMemo(() => {
    const degreeMap: Record<string, number> = {}
    snapshot.nodes.forEach(n => { degreeMap[n] = 0 })
    snapshot.edges.forEach(e => {
      degreeMap[e.from] = (degreeMap[e.from] ?? 0) + 1
      degreeMap[e.to]   = (degreeMap[e.to]   ?? 0) + 1
    })
    return buildTree(snapshot.nodes, degreeMap)
  }, [snapshot])

  // All directory paths, expanded by default
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const dirs = new Set<string>()
    const walk = (n: TreeNode) => {
      if (!n.isFile && n.path) dirs.add(n.path)
      n.children.forEach(walk)
    }
    walk(tree)
    return dirs
  })

  const toggleDir = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const buildGraph = useCallback(() => {
    if (!svgRef.current || !window.d3) return
    const { nodes: nodeIds, edges, stats } = snapshot

    // Degree map
    const degree: Record<string, number> = {}
    nodeIds.forEach(n => { degree[n] = 0 })
    edges.forEach(e => {
      degree[e.from] = (degree[e.from] ?? 0) + 1
      degree[e.to]   = (degree[e.to]   ?? 0) + 1
    })

    const nodeData: NodeDatum[] = nodeIds.map(id => ({
      id,
      label: basename(id),
      degree: degree[id] ?? 0,
    }))

    const linkData: LinkDatum[] = edges.map(e => ({
      source: e.from,
      target: e.to,
    }))

    const svg   = d3.select(svgRef.current)
    const W     = svgRef.current.clientWidth  || 640
    const H     = svgRef.current.clientHeight || 480

    svg.selectAll('*').remove()

    // ── Arrow marker ──────────────────────────────────────────────────────
    svg.append('defs').append('marker')
      .attr('id',          'gd-arrow')
      .attr('viewBox',     '0 0 10 10')
      .attr('refX',        18)
      .attr('refY',        5)
      .attr('markerWidth', 5)
      .attr('markerHeight',5)
      .attr('orient',      'auto-start-reverse')
      .append('path')
        .attr('d',           'M2 1L8 5L2 9')
        .attr('fill',        'none')
        .attr('stroke',      'var(--green, var(--accent))')
        .attr('stroke-width','1.5')
        .attr('stroke-linecap','round')
        .attr('stroke-linejoin','round')

    const container = svg.append('g')

    // ── Zoom + pan ────────────────────────────────────────────────────────
    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .on('zoom', (event) => {
        container.attr('transform', event.transform)
      })
    svg.call(zoom)

    // ── Force simulation ──────────────────────────────────────────────────
    const sim = d3.forceSimulation<NodeDatum>(nodeData)
      .force('link', d3.forceLink<NodeDatum, LinkDatum>(linkData)
        .id(d => d.id)
        .distance(90)
        .strength(0.4))
      .force('charge', d3.forceManyBody().strength(-160))
      .force('center',  d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide<NodeDatum>(d => nodeRadius(d) + 6))

    // ── Links ─────────────────────────────────────────────────────────────
    const link = container.append('g')
      .attr('stroke', 'rgba(52,211,153,0.18)')
      .attr('stroke-width', 1)
      .selectAll<SVGLineElement, LinkDatum>('line')
      .data(linkData)
      .enter().append('line')
        .attr('marker-end', 'url(#gd-arrow)')

    // ── Nodes (group: circle + label) ─────────────────────────────────────
    const nodeGroup = container.append('g')
      .selectAll<SVGGElement, NodeDatum>('g')
      .data(nodeData)
      .enter().append('g')
        .style('cursor', 'grab')
        .call(
          d3.drag<SVGGElement, NodeDatum>()
            .on('start', (event, d) => {
              if (!event.active) sim.alphaTarget(0.3).restart()
              d.fx = d.x; d.fy = d.y
            })
            .on('drag', (event, d) => {
              d.fx = event.x; d.fy = event.y
            })
            .on('end', (event, d) => {
              if (!event.active) sim.alphaTarget(0)
              d.fx = null; d.fy = null
            })
        )

    // Circle
    nodeGroup.append('circle')
      .attr('r',    d => nodeRadius(d))
      .attr('fill', d => nodeFill(d))
      .attr('stroke', d => nodeStroke(d))
      .attr('stroke-width', 1)

    // Degree badge (centre of node)
    nodeGroup.append('text')
      .text(d => d.degree)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', d => Math.max(9, Math.min(13, nodeRadius(d) * 0.8)))
      .attr('font-family', 'var(--font-code, monospace)')
      .attr('font-weight', '500')
      .attr('fill', d => d.degree > 0 ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.4)')
      .style('pointer-events', 'none')
      .style('user-select', 'none')

    // Filename label below node
    nodeGroup.append('text')
      .text(d => d.label)
      .attr('text-anchor', 'middle')
      .attr('y', d => nodeRadius(d) + 12)
      .attr('font-size', 9)
      .attr('font-family', 'var(--font-code, monospace)')
      .attr('fill', 'rgba(255,255,255,0.55)')
      .style('pointer-events', 'none')
      .style('user-select', 'none')

    // ── Tick handler ──────────────────────────────────────────────────────
    sim.on('tick', () => {
      link
        .attr('x1', d => (d.source as NodeDatum).x ?? 0)
        .attr('y1', d => (d.source as NodeDatum).y ?? 0)
        .attr('x2', d => (d.target as NodeDatum).x ?? 0)
        .attr('y2', d => (d.target as NodeDatum).y ?? 0)

      nodeGroup.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    return () => sim.stop()
  }, [snapshot])

  // ── Load D3 once, then build (only when graph view is active) ─────────
  useEffect(() => {
    if (view !== 'graph') return
    if (d3Loaded.current) {
      buildGraph()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'
    script.onload = () => {
      d3Loaded.current = true
      buildGraph()
    }
    document.head.appendChild(script)
    return () => { /* leave d3 loaded for next open */ }
  }, [buildGraph, view])

  const { stats, cycles } = snapshot

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className={styles.header}>
          <span className={styles.title}>✦ Dependency graph</span>
          <div className={styles.stats}>
            <span className={styles.stat}>{stats.nodeCount} files</span>
            <span className={styles.statDot}>·</span>
            <span className={styles.stat}>{stats.edgeCount} imports</span>
            {cycles.length > 0 && (
              <>
                <span className={styles.statDot}>·</span>
                <span className={styles.statWarn}>⚠ {cycles.length} cycle{cycles.length > 1 ? 's' : ''}</span>
              </>
            )}
          </div>
          <div className={styles.tabs}>
            <button
              className={view === 'graph' ? styles.tabActive : styles.tab}
              onClick={() => setView('graph')}
            >
              Graph
            </button>
            <button
              className={view === 'files' ? styles.tabActive : styles.tab}
              onClick={() => setView('files')}
            >
              Files
            </button>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close graph">✕</button>
        </div>

        {/* ── Legend (graph view only) ─────────────────────────────────── */}
        {view === 'graph' && (
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: 'rgba(52,211,153,0.5)' }} />
              low degree
            </span>
            <span className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: 'rgba(251,191,36,0.7)' }} />
              medium
            </span>
            <span className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: 'rgba(239,68,68,0.8)' }} />
              high degree
            </span>
            <span className={styles.legendHint}>Drag · Scroll to zoom</span>
          </div>
        )}

        {/* ── Graph canvas / File tree ─────────────────────────────────── */}
        {view === 'graph' ? (
          <svg ref={svgRef} className={styles.canvas} />
        ) : (
          <div className={styles.treeWrap}>
            {sortedChildren(tree).map(child => (
              <FileTreeRow key={child.path} node={child} depth={0} expanded={expanded} toggle={toggleDir} />
            ))}
          </div>
        )}

      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────

function nodeRadius(d: NodeDatum): number {
  return Math.max(10, Math.min(26, 10 + d.degree * 2.2))
}

function nodeFill(d: NodeDatum): string {
  if (d.degree === 0) return 'rgba(52,211,153,0.15)'
  if (d.degree <= 3)  return 'rgba(52,211,153,0.50)'
  if (d.degree <= 8)  return 'rgba(251,191,36,0.70)'
  return 'rgba(239,68,68,0.80)'
}

function nodeStroke(d: NodeDatum): string {
  if (d.degree === 0) return 'rgba(52,211,153,0.3)'
  if (d.degree <= 3)  return 'rgba(52,211,153,0.8)'
  if (d.degree <= 8)  return 'rgba(251,191,36,0.9)'
  return 'rgba(239,68,68,1)'
}