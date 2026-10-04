import React, { useState, useCallback, memo } from 'react'
import styles from './FileTree.module.css'
import type { FolderEntry } from '../lib/tauriFs'

// ── Lang → dot colour ─────────────────────────────────────────────────────────
function extOf(name: string): string {
  const parts = name.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

const EXT_DOT: Record<string, string> = {
  ts:   styles.dotTs,
  tsx:  styles.dotTsx,
  css:  styles.dotCss,
  scss: styles.dotCss,
  json: styles.dotJson,
  md:   styles.dotMd,
  js:   styles.dotJs,
  jsx:  styles.dotJsx,
  rs:   styles.dotRs,
  toml: styles.dotToml,
  html: styles.dotHtml,
}

// ── File icon ─────────────────────────────────────────────────────────────────
const EXT_ICON: Record<string, string> = {
  ts:   '󰛦',  tsx:  '󰜈',  js:   '󰌞',  jsx:  '󰜈',
  css:  '󰌜',  scss: '󰌜',  json: '󰘦',  md:   '󰍔',
  rs:   '󱘗',  toml: '󰘦',  html: '󰌝',  svg:  '󰕙',
  png:  '󰋩',  jpg:  '󰋩',  gif:  '󰋩',  webp: '󰋩',
  lock: '󰌾',
}

function fileIcon(name: string): string {
  return EXT_ICON[extOf(name)] ?? '󰈚'
}

// ── TreeNode ──────────────────────────────────────────────────────────────────
interface TreeNodeProps {
  node:          FolderEntry
  depth:         number
  activePath:    string
  expanded:      Set<string>
  onToggle:      (path: string) => void
  onFileClick:   (node: FolderEntry) => void
  onContextMenu: (e: React.MouseEvent, node: FolderEntry) => void
}

const TreeNode = memo(function TreeNode({
  node,
  depth,
  activePath,
  expanded,
  onToggle,
  onFileClick,
  onContextMenu,
}: TreeNodeProps) {
  const indent = depth * 14

  if (node.is_dir) {
    const isOpen = expanded.has(node.path)

    return (
      <>
        <div
          className={styles.folderRow}
          style={{ paddingLeft: 8 + indent }}
          onClick={() => onToggle(node.path)}
          onContextMenu={e => onContextMenu(e, node)}
          role="treeitem"
          aria-expanded={isOpen}
        >
          {/* Indent guide lines */}
          {Array.from({ length: depth }).map((_, i) => (
            <span
              key={i}
              className={styles.indentGuide}
              style={{ left: 8 + i * 14 + 7 }}
            />
          ))}

          <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>
            <ChevronIcon />
          </span>

          <span className={styles.folderIcon}>
            {isOpen ? <FolderOpenIcon /> : <FolderIcon />}
          </span>

          <span className={styles.name}>{node.name}</span>
        </div>

        {isOpen && node.children.map(child => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            expanded={expanded}
            onToggle={onToggle}
            onFileClick={onFileClick}
            onContextMenu={onContextMenu}
          />
        ))}
      </>
    )
  }

  // ── File row ────────────────────────────────────────────────────────────────
  const isActive  = node.path === activePath
  const ext       = extOf(node.name)
  const dotClass  = EXT_DOT[ext] ?? styles.dotDefault
  const icon      = fileIcon(node.name)

  return (
    <div
      className={`${styles.fileRow} ${isActive ? styles.fileRowActive : ''}`}
      style={{ paddingLeft: 8 + indent + 18 /* chevron width */ }}
      onClick={() => onFileClick(node)}
      onContextMenu={e => onContextMenu(e, node)}
      role="treeitem"
      aria-selected={isActive}
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className={styles.indentGuide}
          style={{ left: 8 + i * 14 + 7 }}
        />
      ))}

      <span className={`${styles.langDot} ${dotClass}`} />
      <span className={styles.fileIconGlyph}>{icon}</span>
      <span className={styles.name}>{node.name}</span>
    </div>
  )
})

// ── FileTree ──────────────────────────────────────────────────────────────────
interface FileTreeProps {
  /** Root entries to render — usually a single project root FolderEntry */
  roots:       FolderEntry[]
  /** Absolute path of the currently active (open) file */
  activePath?: string
  /** Called when the user clicks a file */
  onFileClick: (node: FolderEntry) => void
  /** Optional: called when the user right-clicks any node */
  onContextMenu?: (e: React.MouseEvent, node: FolderEntry) => void
  /** Project name shown in the section header */
  projectName?: string
}

export default function FileTree({
  roots,
  activePath = '',
  onFileClick,
  onContextMenu,
  projectName = 'PROJECT',
}: FileTreeProps) {
  // Collect all folder paths that should start expanded
  const initialExpanded = useCallback(() => {
    const set = new Set<string>()
    function collect(nodes: FolderEntry[]) {
      for (const n of nodes) {
        if (n.is_dir) {
          set.add(n.path)
          collect(n.children)
        }
      }
    }
    // Auto-expand the first two levels
    for (const root of roots) {
      if (root.is_dir) {
        set.add(root.path)
        for (const child of root.children) {
          if (child.is_dir) set.add(child.path)
        }
      }
    }
    return set
  }, [roots])

  const [expanded,        setExpanded]        = useState<Set<string>>(initialExpanded)
  const [headerCollapsed, setHeaderCollapsed] = useState(false)

  const toggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, node: FolderEntry) => {
    e.preventDefault()
    onContextMenu?.(e, node)
  }, [onContextMenu])

  return (
    <div className={styles.tree} role="tree" aria-label="File explorer">
      {/* Section header */}
      <div
        className={styles.header}
        onClick={() => setHeaderCollapsed(c => !c)}
      >
        <span className={`${styles.chevron} ${headerCollapsed ? '' : styles.chevronOpen}`}>
          <ChevronIcon />
        </span>
        <span className={styles.headerLabel}>{projectName.toUpperCase()}</span>
      </div>

      {!headerCollapsed && (
        <div className={styles.nodes}>
          {roots.length === 0 ? (
            <div className={styles.empty}>No folder open</div>
          ) : (
            roots.map(root => (
              <TreeNode
                key={root.path}
                node={root}
                depth={0}
                activePath={activePath}
                expanded={expanded}
                onToggle={toggle}
                onFileClick={onFileClick}
                onContextMenu={handleContextMenu}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Inline SVG icons (no external deps) ──────────────────────────────────────
function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.086a1.5 1.5 0 0 1 1.06.44l.415.414A1.5 1.5 0 0 0 7.12 3.5H11.5A1.5 1.5 0 0 1 13 5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 1 10.5v-7Z"
            fill="#4d6a8a"/>
    </svg>
  )
}

function FolderOpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 4.5A1.5 1.5 0 0 1 2.5 3h2.086a1.5 1.5 0 0 1 1.06.44l.415.413A1.5 1.5 0 0 0 7.12 4.5H11.5A1.5 1.5 0 0 1 13 6v.5H1V4.5Z"
            fill="#00d4ff" opacity=".5"/>
      <path d="M1 6.5h12l-1.5 5H2.5L1 6.5Z" fill="#00d4ff" opacity=".8"/>
    </svg>
  )
}
