// components/DiskViewer/DiskViewerModal.tsx
//
// Lightweight, unindexed folder browser for arbitrary disk locations —
// distinct from FileExplorer.tsx, which is bound to the current project
// root and drives repo indexing. This modal is opened programmatically
// (see store/useDiskViewerStore.ts) whenever desktop_task's open_path action
// resolves to a directory, so the agent can say "open R:/SomeFolder" and
// land the user directly on that folder without shelling out to the OS's
// own file manager.
//
// Reuses the existing readFolder() IPC call and FileTree component — both
// already work with any absolute path, not just the project root.

import React, { useEffect, useState, useCallback } from 'react'
import FileTree from '../FileTree'
import { readFolder, readFile, type FolderEntry } from '../../lib/tauriFs'
import { useDiskViewerStore } from '../../store/useDiskViewerStore'
import { useEditorStore } from '../../store/useEditorStore'
import styles from './DiskViewerModal.module.css'

const DiskViewerModal: React.FC = () => {
  const isOpen   = useDiskViewerStore(s => s.isOpen)
  const rootPath = useDiskViewerStore(s => s.rootPath)
  const close    = useDiskViewerStore(s => s.close)
  const openTab  = useEditorStore(s => s.openTab)

  const [root,    setRoot]    = useState<FolderEntry | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // Load (or reload) the tree whenever the modal opens at a new path.
  useEffect(() => {
    if (!isOpen || !rootPath) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setRoot(null)

    readFolder(rootPath)
      .then(entry => { if (!cancelled) setRoot(entry) })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [isOpen, rootPath])

  const handleFileClick = useCallback(async (node: FolderEntry) => {
    if (node.is_dir) return // FileTree already handles expand/collapse for dirs
    try {
      const result = await readFile(node.path)
      const name = node.path.replace(/\\/g, '/').split('/').pop() ?? node.name
      const ext  = name.split('.').pop() ?? 'txt'
      openTab({
        id:       node.path,
        name,
        lang:     ext,
        content:  result.kind === 'text' ? result.content : '',
        modified: false,
        kind:     result.kind,
        mime:     result.mime,
        size:     result.size,
        mtime:    result.modified,
      })
    } catch (e) {
      setError(String(e))
    }
  }, [openTab])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }, [close])

  if (!isOpen) return null

  const displayName = rootPath
    ? rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? rootPath
    : 'Disk Viewer'

  return (
    <div
      className={styles.overlay}
      onClick={close}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Disk Viewer"
    >
      <div className={styles.panel} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title} title={rootPath ?? ''}>{rootPath}</span>
          <button className={styles.closeBtn} onClick={close} aria-label="Close Disk Viewer">×</button>
        </div>

        <div className={styles.body}>
          {loading && <div className={styles.status}>Loading {displayName}…</div>}
          {error && <div className={styles.error}>{error}</div>}
          {!loading && !error && root && (
            <FileTree
              roots={[root]}
              onFileClick={handleFileClick}
              projectName={displayName}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default DiskViewerModal
