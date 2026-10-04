import React, { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import styles from './FileExplorer.module.css'
import FileTree from './FileTree'
import { openFolder, readFolder, readFile, type FolderEntry } from '../lib/tauriFs'
import { useRepoIndex, selectIsIndexing } from '../store/useRepoIndex'
import { useUnsavedProjectStore, isUnsavedProjectPath} from '../store/useUnsavedProjectStore'
import { useAdditionalFoldersStore } from '../store/useAdditionalFoldersStore'
import { CloseProjectConfirmModal } from './CloseProjectConfirmModal'

export interface FileExplorerHandle {
  openFolder: () => Promise<void>
}

interface Props {
  activeFilePath?: string
  onFileOpen: (info: {
    path: string
    content: string
    name: string
    kind: 'text' | 'base64' | 'binary'
    mime: string
    size: number
    modified?: number | null
  }) => void
  /** Called when the user clicks "Close Project". Parent (IDELayout) owns
   *  clearing open tabs / panel state and flipping back to welcome mode;
   *  this component only clears its own local tree state. */
  onCloseProject?: () => void
}

const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer(
  { activeFilePath = '', onFileOpen, onCloseProject },
  ref,
) {
  const [roots,   setRoots]   = useState<FolderEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const indexFolder  = useRepoIndex(s => s.indexFolder)
  const indexing     = useRepoIndex(selectIsIndexing)
  const indexStatus  = useRepoIndex(s => s.status)
  const indexError   = useRepoIndex(s => s.error)

  // Additional (secondary) folders — browsable alongside the primary
  // project so users can work across multiple repos/services at once.
  // See store/useAdditionalFoldersStore.ts.
  const additionalFolders    = useAdditionalFoldersStore(s => s.folders)
  const addAdditionalFolder  = useAdditionalFoldersStore(s => s.addFolder)
  const removeAdditionalFolder = useAdditionalFoldersStore(s => s.removeFolder)
  const [addingFolder, setAddingFolder] = useState(false)
  // Gates the actual teardown behind an explicit confirm — closing a
  // project drops all AI context for it, so a stray click on the toolbar
  // icon shouldn't be able to do that instantly (see CloseProjectConfirmModal).
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  // Derive project name from the store's authoritative projectRoot.
  // Falls back to 'NO FOLDER' when nothing is open.
  const projectRoot  = useRepoIndex(s => s.projectRoot)
  const projectName  = projectRoot
    ? projectRoot.replace(/\\\\/g, '/').split('/').filter(Boolean).pop()?.toUpperCase() ?? 'PROJECT'
    : 'NO FOLDER'

  // Track the last root we loaded the tree for, so we only reload when
  // the project actually changes (not on every re-render).
  const loadedRootRef = useRef<string | null>(null)

  // ── Refresh tree from a known path (no dialog) ────────────────────────
  const refreshTreeFromRoot = useCallback(async (root: string) => {
    try {
      const entry = await readFolder(root)
      setRoots([entry])
      loadedRootRef.current = root
    } catch (e) {
      setError(String(e))
    }
  }, [])
  const unsavedProjectName = useUnsavedProjectStore(
    (state) => state.projectName
  )

  const unsavedFiles = useUnsavedProjectStore(
    (state) => state.files
  )

  const unsavedRoot: FolderEntry | null = unsavedProjectName
  ? {
      name: 'Unsaved',
      path: 'unsaved://',
      is_dir: true,
      children: Object.values(unsavedFiles).map((file) => ({
        name: file.name,
        path: file.path,
        is_dir: false,
        children: [],
      })),
    }
  : null

  // ── Auto-refresh whenever indexing finishes or projectRoot changes ────
  // This handles: welcome→IDE mode transition (FileExplorer mounts with
  // roots=[] but projectRoot is already set), and re-index after edits.
  useEffect(() => {
    if (!projectRoot) return

    const rootChanged = loadedRootRef.current !== projectRoot
    const justFinishedIndexing = indexStatus === 'ready'

    if (rootChanged || justFinishedIndexing) {
      refreshTreeFromRoot(projectRoot)
    }
  }, [projectRoot, indexStatus, refreshTreeFromRoot])

  // ── Open folder via Tauri dialog ──────────────────────────────────────────
  const handleOpenFolder = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const root = await openFolder()
      if (root) {
        setRoots([root])
        loadedRootRef.current = root.path
        // indexFolder sets projectRoot in the store — projectName above is derived from it
        indexFolder(root.path)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [indexFolder])

  // Expose openFolder method to parent via ref
  useImperativeHandle(ref, () => ({
    openFolder: handleOpenFolder,
  }), [handleOpenFolder])

  // ── Add an additional (secondary) folder — browsable alongside the
  // primary project, but not indexed/dependency-graphed the way the
  // primary project is. Reuses the same native folder-picker as "Open
  // Folder"; the difference is purely what we do with the result. ────────
  const handleAddFolder = useCallback(async () => {
    setAddingFolder(true)
    setError(null)
    try {
      const root = await openFolder()
      if (root) addAdditionalFolder(root)
    } catch (e) {
      setError(String(e))
    } finally {
      setAddingFolder(false)
    }
  }, [addAdditionalFolder])

  // ── Close project: clear local tree state, then let the parent reset
  // everything else (tabs, panels, app mode) and clear the repo index ────
  // Actual teardown only runs once the user confirms in
  // CloseProjectConfirmModal — see handleCloseProject below and the
  // click handler wired to the toolbar's close button.
  const handleCloseProject = useCallback(() => {
    setRoots([])
    setError(null)
    loadedRootRef.current = null
    useAdditionalFoldersStore.getState().clear()
    onCloseProject?.()
  }, [onCloseProject])

  const handleConfirmCloseProject = useCallback(() => {
    setShowCloseConfirm(false)
    handleCloseProject()
  }, [handleCloseProject])

  // ── File click: read and open in editor ───────────────────────────────────
  const handleFileClick = useCallback(async (node: FolderEntry) => {
    if (node.is_dir) return

    try {
      if (isUnsavedProjectPath(node.path)) {
        const file = useUnsavedProjectStore.getState().files[node.path]
        if (!file) return

        onFileOpen({
          path: file.path,
          content: file.content,
          name: file.name,
          kind: 'text',
          mime: 'text/plain',
          size: file.content.length,
          modified: null,
        })
        return
      }

      const { content, path, kind, mime, size, modified } = await readFile(node.path)
      onFileOpen({
        path,
        content,
        name: node.name,
        kind,
        mime,
        size,
        modified,
      })
    } catch (e) {
      setError(String(e))
    }
  }, [onFileOpen])

  // ── Index status label shown in the toolbar ──────────────────────────────
  const statusLabel =
    indexStatus === 'indexing'   ? '⟳ indexing…' :
    indexStatus === 'refreshing' ? '⟳ refreshing…' :
    indexStatus === 'ready'      ? '✦ indexed' :
    indexStatus === 'error'      ? '⚠ index error' :
    null

  return (
    <div className={styles.explorer}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <span className={styles.title}>EXPLORER</span>
        {statusLabel && (
          <span
            className={styles.indexStatus}
            data-status={indexStatus}
            title={indexStatus === 'error' ? (indexError ?? 'Repo index failed') : 'Dependency graph status'}
          >
            {statusLabel}
          </span>
        )}
        {projectRoot && (
          <button
            className={styles.closeBtn}
            onClick={() => setShowCloseConfirm(true)}
            title="Close Project"
          >
            ✕
          </button>
        )}
        {projectRoot && (
          <button
            className={styles.openBtn}
            onClick={handleAddFolder}
            disabled={addingFolder}
            title="Add another folder (browse a second project/service alongside this one)"
          >
            {addingFolder ? '…' : '⊞'}
          </button>
        )}
        <button
          className={styles.openBtn}
          onClick={handleOpenFolder}
          disabled={loading || indexing}
          title="Open Folder"
        >
          {loading ? '…' : '⊕'}
        </button>
      </div>

      {additionalFolders.length > 0 && (
        <div className={styles.folderChips}>
          {additionalFolders.map(f => (
            <span key={f.path} className={styles.folderChip} title={f.path}>
              📁 {f.name}
              <button
                className={styles.folderChipRemove}
                onClick={() => removeAdditionalFolder(f.path)}
                title={`Remove ${f.name} from Explorer`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className={styles.error}>{error}</div>
      )}

      {indexStatus === 'error' && indexError && (
        <div className={styles.error} style={{ userSelect: 'text' }}>
          <strong>Index failed:</strong> {indexError}
        </div>
      )}

      <div className={styles.tree}>
        <FileTree
          roots={[
            ...(unsavedRoot ? [unsavedRoot] : []),
            ...roots,
            ...additionalFolders.map(f => f.root),
          ]}
          activePath={activeFilePath}
          onFileClick={handleFileClick}
          projectName={projectName}
        />
      </div>

      <div className={styles.outline}>
        <span className={styles.outlineLabel}>OUTLINE</span>
      </div>

      {showCloseConfirm && (
        <CloseProjectConfirmModal
          projectName={projectName}
          onConfirm={handleConfirmCloseProject}
          onCancel={() => setShowCloseConfirm(false)}
        />
      )}
    </div>
  )
})

export default FileExplorer
