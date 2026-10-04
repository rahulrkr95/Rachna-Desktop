// components/EditorPane.tsx
//
// Unified editor pane that renders both normal file tabs and AI diff tabs.
// Diff tabs appear inline in the same tab bar with a ⎇ prefix and a
// distinct amber indicator stripe — identical to how Cursor/Windsurf shows
// pending AI changes directly inside the editor workspace.

import React from 'react'
import styles from './EditorPane.module.css'
import MonacoEditor, { extToLang } from './MonacoEditor'
import MonacoDiffTab from './DiffTab/MonacoDiffTab'
import type { OpenFile, DiffTab, AiContext } from '../types'
import { resolveViewer } from './viewers/ViewerRegistry'
import ImageViewer from './viewers/ImageViewer'
import PdfViewer from './viewers/PdfViewer'
import AudioViewer from './viewers/AudioViewer'
import VideoViewer from './viewers/VideoViewer'
import BinaryInfoViewer from './viewers/BinaryInfoViewer'
import HtmlDesignView from './viewers/HtmlDesignView'
import DesignCanvasView from './viewers/DesignCanvasView'
import { useAutocompleteStore } from '../store/useAutocompleteStore'
import { isDesignCanvasTabId } from '../lib/designCanvasTab'

// ── Language-dot colours ───────────────────────────────────────────────────
const LANG_DOT: Record<string, string> = {
  tsx:  styles.dotTsx,
  ts:   styles.dotTs,
  css:  styles.dotCss,
  json: styles.dotJson,
  md:   styles.dotMd,
}

// ── File Tab ──────────────────────────────────────────────────────────────
interface FileTabProps {
  file:    OpenFile
  active:  boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
}

function FileTab({ file, active, onClick, onClose }: FileTabProps) {
  const isDesign = isDesignCanvasTabId(file.id)
  const dotClass = LANG_DOT[file.lang] ?? styles.dotTs
  return (
    <div
      className={`${styles.tab} ${active ? styles.tabActive : ''}`}
      onClick={onClick}
      title={isDesign ? 'Design Canvas' : file.id}
    >
      {isDesign ? (
        <span className={styles.diffTabIcon} aria-hidden>🎨</span>
      ) : (
        <span className={`${styles.dot} ${dotClass}`} />
      )}
      <span className={styles.tabName}>{file.name}</span>
      {file.modified && <span className={styles.tabDirty}>●</span>}
      <button className={styles.tabClose} onClick={onClose} title="Close">×</button>
    </div>
  )
}

// ── Diff Tab pill ──────────────────────────────────────────────────────────
interface DiffTabPillProps {
  tab:     DiffTab
  active:  boolean
  onClick: () => void
  onClose: (e: React.MouseEvent) => void
}

function DiffTabPill({ tab, active, onClick, onClose }: DiffTabPillProps) {
  return (
    <div
      className={`${styles.tab} ${styles.tabDiff} ${active ? styles.tabDiffActive : ''}`}
      onClick={onClick}
      title={`AI edit proposal: ${tab.filePath}`}
    >
      <span className={styles.diffTabIcon}>⎇</span>
      <span className={styles.tabName}>{tab.fileName}</span>
      <span className={styles.diffTabBadge}>AI</span>
      <button className={styles.tabClose} onClick={onClose} title="Reject & close">×</button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────
interface Props {
  openFiles:       OpenFile[]
  diffTabs:        DiffTab[]
  activeId:        string
  activeKind:      'file' | 'diff'
  onTabClick:      (id: string) => void
  onTabClose:      (id: string) => void
  onDiffTabClick:  (id: string) => void
  onDiffTabClose:  (id: string) => void
  onFileChange:    (id: string, content: string) => void
  onContextChange: (ctx: AiContext) => void
  fontSize:        number
  theme:           'dark' | 'light'
  // ── Design Canvas tab (design://canvas) ──────────────────────────────
  // The canvas itself is stateless here — its nodes/transform/projectRoot
  // all live in useDesignCanvasStore — but it still needs a few things
  // only IDELayout knows about (the active project root, and how to hand
  // a page off to a real file tab / the Save Project dialog).
  designProjectRoot?:      string | null
  onOpenDesignPage?:       (path: string) => void
  onCloseDesignCanvas?:    () => void
  onRequestSaveDesignProject?: () => void
  onOpenRecentDesignProject?: (manifestPath: string) => void
}

export default function EditorPane({
  openFiles,
  diffTabs,
  activeId,
  activeKind,
  onTabClick,
  onTabClose,
  onDiffTabClick,
  onDiffTabClose,
  onFileChange,
  onContextChange,
  fontSize,
  theme,
  designProjectRoot = null,
  onOpenDesignPage,
  onCloseDesignCanvas,
  onRequestSaveDesignProject,
  onOpenRecentDesignProject,
}: Props) {
  const activeFile    = activeKind === 'file'
    ? openFiles.find(f => f.id === activeId)
    : undefined
  const activeDiffTab = activeKind === 'diff'
    ? diffTabs.find(t => t.id === activeId)
    : undefined

  const acEnabled = useAutocompleteStore(s => s.enabled)

  const activeIsDesignCanvas = !!activeFile && isDesignCanvasTabId(activeFile.id)

  const pathParts = activeIsDesignCanvas
    ? []
    : activeFile
      ? ['src', 'components', activeFile.name]
      : activeDiffTab
        ? [activeDiffTab.filePath]
        : []

  const handleChange = (value: string) => {
    if (!activeFile) return
    onFileChange(activeFile.id, value)
    onContextChange({
      file:        activeFile.name,
      filePath:    activeFile.id,
      fileContent: value,
      selection:   '',
      language:    extToLang(activeFile.lang),
    })
  }

  const hasTabs = openFiles.length > 0 || diffTabs.length > 0

  return (
    <div className={styles.pane}>
      {/* ── Unified Tab Bar ── */}
      <div className={styles.tabBar}>
        {/* File tabs first */}
        {openFiles.map(file => (
          <FileTab
            key={file.id}
            file={file}
            active={activeKind === 'file' && file.id === activeId}
            onClick={() => onTabClick(file.id)}
            onClose={e => { e.stopPropagation(); onTabClose(file.id) }}
          />
        ))}

        {/* Diff tabs (AI edit proposals) */}
        {diffTabs.map(tab => (
          <DiffTabPill
            key={tab.id}
            tab={tab}
            active={activeKind === 'diff' && tab.id === activeId}
            onClick={() => onDiffTabClick(tab.id)}
            onClose={e => { e.stopPropagation(); onDiffTabClose(tab.id) }}
          />
        ))}
      </div>

      {/* ── Breadcrumb (hidden when showing diff, or the Design Canvas — it has its own toolbar) ── */}
      {activeKind === 'file' && !activeIsDesignCanvas && (
        <div className={styles.breadcrumb}>
          {pathParts.map((part, i) => (
            <React.Fragment key={`${part}-${i}`}>
              {i > 0 && <span className={styles.sep}>/</span>}
              <span className={i === pathParts.length - 1 ? styles.breadcrumbLast : styles.breadcrumbPart}>
                {part}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* ── Content surface ── */}
      <div className={styles.surface}>
        {activeDiffTab ? (
          // Render the Monaco DiffEditor for active diff tab
          <MonacoDiffTab
            key={activeDiffTab.id}
            editId={activeDiffTab.editId}
            theme={theme}
            fontSize={fontSize}
          />
        ) : activeIsDesignCanvas ? (
          <DesignCanvasView
            key={activeFile!.id}
            projectRoot={designProjectRoot}
            onOpenFile={(path) => onOpenDesignPage?.(path)}
            onClose={() => onCloseDesignCanvas?.()}
            onRequestSaveProject={() => onRequestSaveDesignProject?.()}
            onOpenRecentProject={(path) => onOpenRecentDesignProject?.(path)}
          />
        ) : activeFile ? (
          renderViewer(activeFile, handleChange, fontSize, theme, acEnabled)
        ) : (
          <div className={styles.emptyState}>
            {hasTabs
              ? 'Select a tab to continue editing'
              : 'Open a file from the explorer to start editing'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Viewer dispatch ────────────────────────────────────────────────────────
function renderViewer(
  file: OpenFile,
  handleChange: (value: string) => void,
  fontSize: number,
  theme: 'dark' | 'light',
  autocompleteEnabled = true,
) {
  const viewer = resolveViewer({ id: file.id, name: file.name, mime: file.mime, kind: file.kind })

  switch (viewer) {
    // The Design Canvas tab is intercepted earlier (see the main render
    // above, which needs projectRoot/onOpenFile/onClose/onRequestSaveProject
    // props this function doesn't have) — this case only exists so the
    // switch is exhaustive over ViewerKind.
    case 'design':
      return null

    case 'image':
      return <ImageViewer name={file.name} mime={file.mime ?? ''} content={file.content} />

    case 'pdf':
      return <PdfViewer name={file.name} mime={file.mime ?? ''} content={file.content} />

    case 'audio':
      return <AudioViewer name={file.name} mime={file.mime ?? ''} content={file.content} size={file.size} />

    case 'video':
      return <VideoViewer name={file.name} mime={file.mime ?? ''} content={file.content} />

    case 'html':
      return (
        <HtmlDesignView
          key={file.id}
          filePath={file.id}
          content={file.content}
          onChange={handleChange}
          fontSize={fontSize}
          theme={theme}
          autocompleteEnabled={autocompleteEnabled}
        />
      )

    case 'binary':
      return (
        <BinaryInfoViewer
          name={file.name}
          mime={file.mime ?? ''}
          size={file.size}
          modified={file.mtime}
          path={file.id}
        />
      )

    case 'text':
    default:
      return (
        <MonacoEditor
          key={file.id}
          value={file.content}
          language={extToLang(file.lang)}
          filePath={file.id}
          onChange={handleChange}
          fontSize={fontSize}
          theme={theme}
          autocompleteEnabled={autocompleteEnabled}
        />
      )
  }
}
