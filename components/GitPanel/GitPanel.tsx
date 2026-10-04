// components/GitPanel/GitPanel.tsx
//
// Source control panel: staged/unstaged file lists, inline unified-diff
// viewer, commit box, push/pull, and a branch selector with create-branch
// support. Mounted in IDELayout's left sidebar in place of FileExplorer
// when the Git activity-bar icon is active.

import React, { useEffect, useRef, useState } from 'react'
import styles from './GitPanel.module.css'
import {
  useGitStore,
  selectStagedFiles,
  selectUnstagedFiles,
  selectCurrentBranch,
} from '../../store/useGitStore'
import { useRepoIndex } from '../../store/useRepoIndex'

// ── Diff line renderer ───────────────────────────────────────────────────────
function DiffViewer({ text }: { text: string }) {
  if (!text.trim()) {
    return <div className={styles.diffEmpty}>No changes to show.</div>
  }

  const lines = text.split('\n')

  return (
    <div className={styles.diffViewer}>
      {lines.map((line, i) => {
        let cls = styles.diffCtx
        if (line.startsWith('+++') || line.startsWith('---')) {
          cls = styles.diffFileHeader
        } else if (line.startsWith('@@')) {
          cls = styles.diffHunk
        } else if (line.startsWith('+')) {
          cls = styles.diffAdd
        } else if (line.startsWith('-')) {
          cls = styles.diffDel
        } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
          cls = styles.diffMeta
        }
        return (
          <div key={i} className={`${styles.diffLine} ${cls}`}>
            {line.length === 0 ? '\u00A0' : line}
          </div>
        )
      })}
    </div>
  )
}

// ── File row ─────────────────────────────────────────────────────────────────
function statusLabel(status: string): string {
  switch (status) {
    case 'M': return 'M'
    case 'A': return 'A'
    case 'D': return 'D'
    case 'R': return 'R'
    case 'C': return 'C'
    case 'U': return 'U'
    case 'T': return 'T'
    case '??': return 'U'
    default: return status
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'M': return styles.statusM
    case 'A': return styles.statusA
    case '??': return styles.statusA
    case 'D': return styles.statusD
    case 'R': return styles.statusR
    case 'U': return styles.statusU
    default: return styles.statusM
  }
}

interface FileRowProps {
  path: string
  status: string
  staged: boolean
  selected: boolean
  onSelect: () => void
  onToggleStage: () => void
}

function FileRow({ path, status, staged, selected, onSelect, onToggleStage }: FileRowProps) {
  const name = path.split('/').pop() ?? path
  const dir = path.includes('/') ? path.slice(0, path.length - name.length - 1) : ''

  return (
    <div
      className={`${styles.fileRow} ${selected ? styles.fileRowActive : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
    >
      <span className={`${styles.statusBadge} ${statusClass(status)}`}>{statusLabel(status)}</span>
      <span className={styles.fileName} title={path}>
        {name}
        {dir && <span className={styles.fileDir}> {dir}</span>}
      </span>
      <button
        className={styles.stageBtn}
        title={staged ? 'Unstage' : 'Stage'}
        onClick={(e) => {
          e.stopPropagation()
          onToggleStage()
        }}
      >
        {staged ? '−' : '+'}
      </button>
    </div>
  )
}

// ── Branch dropdown ──────────────────────────────────────────────────────────
function BranchSelector() {
  const branches = useGitStore(s => s.branches)
  const current = useGitStore(selectCurrentBranch)
  const open = useGitStore(s => s.branchMenuOpen)
  const setOpen = useGitStore(s => s.setBranchMenuOpen)
  const switchBranch = useGitStore(s => s.switchBranch)
  const createBranch = useGitStore(s => s.createBranch)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open, setOpen])

  const localBranches = branches.filter(b => !b.is_remote)
  const remoteBranches = branches.filter(b => b.is_remote)

  return (
    <div className={styles.branchSelector} ref={containerRef}>
      <button className={styles.branchButton} onClick={() => setOpen(!open)}>
        <span className={styles.branchIcon}>⎇</span>
        <span className={styles.branchName}>{current?.name ?? 'no branch'}</span>
        <span className={styles.branchChevron}>{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className={styles.branchMenu}>
          {!creating && (
            <>
              <div className={styles.branchMenuSection}>Local</div>
              {localBranches.map(b => (
                <div
                  key={b.name}
                  className={`${styles.branchMenuItem} ${b.is_current ? styles.branchMenuItemActive : ''}`}
                  onClick={() => !b.is_current && switchBranch(b.name)}
                >
                  {b.is_current && <span className={styles.branchCheck}>✓</span>}
                  <span>{b.name}</span>
                </div>
              ))}
              {remoteBranches.length > 0 && (
                <>
                  <div className={styles.branchMenuSection}>Remote</div>
                  {remoteBranches.map(b => (
                    <div
                      key={b.name}
                      className={styles.branchMenuItem}
                      onClick={() => switchBranch(b.name)}
                    >
                      <span>{b.name}</span>
                    </div>
                  ))}
                </>
              )}
              <div className={styles.branchMenuDivider} />
              <div
                className={styles.branchMenuItem}
                onClick={() => setCreating(true)}
              >
                <span className={styles.branchPlus}>+</span>
                <span>Create new branch…</span>
              </div>
            </>
          )}

          {creating && (
            <div className={styles.branchCreateForm}>
              <input
                autoFocus
                className={styles.branchCreateInput}
                placeholder="new-branch-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) {
                    createBranch(newName.trim())
                    setNewName('')
                    setCreating(false)
                  }
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }}
              />
              <div className={styles.branchCreateActions}>
                <button
                  className={styles.branchCreateConfirm}
                  disabled={!newName.trim()}
                  onClick={() => {
                    if (!newName.trim()) return
                    createBranch(newName.trim())
                    setNewName('')
                    setCreating(false)
                  }}
                >
                  Create
                </button>
                <button
                  className={styles.branchCreateCancel}
                  onClick={() => { setCreating(false); setNewName('') }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Toasts ───────────────────────────────────────────────────────────────────
function Toasts() {
  const toasts = useGitStore(s => s.toasts)
  const dismiss = useGitStore(s => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div className={styles.toastStack}>
      {toasts.map(t => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.kind === 'error' ? styles.toastError : styles.toastSuccess}`}
          onClick={() => dismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ── Main panel ───────────────────────────────────────────────────────────────
export default function GitPanel() {
  const projectRoot = useRepoIndex(s => s.projectRoot)

  const setRoot = useGitStore(s => s.setRoot)
  const refreshAll = useGitStore(s => s.refreshAll)
  const staged = useGitStore(selectStagedFiles)
  const unstaged = useGitStore(selectUnstagedFiles)
  const selectedFile = useGitStore(s => s.selectedFile)
  const selectedStaged = useGitStore(s => s.selectedStaged)
  const diffText = useGitStore(s => s.diffText)
  const loadingDiff = useGitStore(s => s.loadingDiff)
  const loadingStatus = useGitStore(s => s.loadingStatus)
  const selectFile = useGitStore(s => s.selectFile)
  const stage = useGitStore(s => s.stage)
  const unstage = useGitStore(s => s.unstage)
  const stageAll = useGitStore(s => s.stageAll)
  const unstageAll = useGitStore(s => s.unstageAll)
  const commitMessage = useGitStore(s => s.commitMessage)
  const setCommitMessage = useGitStore(s => s.setCommitMessage)
  const commit = useGitStore(s => s.commit)
  const committing = useGitStore(s => s.committing)
  const push = useGitStore(s => s.push)
  const pull = useGitStore(s => s.pull)
  const pushing = useGitStore(s => s.pushing)
  const pulling = useGitStore(s => s.pulling)
  const error = useGitStore(s => s.error)

  // When the project root changes: point the store at the new root and do an
  // immediate full refresh so the panel is never stale on first open.
  useEffect(() => {
    setRoot(projectRoot ?? null)
    if (projectRoot) {
      refreshAll().catch(() => { /* non-fatal */ })
    }
  }, [projectRoot, setRoot, refreshAll])

  // Poll git status every 10 s while the panel is mounted.
  // This catches changes made by the agent (file creation / deletion via tools)
  // that don't go through Ctrl+S and therefore don't trigger a direct refresh.
  const refreshStatus = useGitStore(s => s.refreshStatus)
  useEffect(() => {
    if (!projectRoot) return
    const id = setInterval(() => {
      refreshStatus().catch(() => { /* non-fatal */ })
    }, 10_000)
    return () => clearInterval(id)
  }, [projectRoot, refreshStatus])

  if (!projectRoot) {
    return (
      <div className={styles.panel}>
        <div className={styles.emptyState}>Open a folder to use source control.</div>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      {/* ── Header: branch selector + refresh ───────────────────────── */}
      <div className={styles.header}>
        <BranchSelector />
        <button
          className={styles.iconBtn}
          title="Refresh"
          onClick={() => refreshAll()}
        >
          {loadingStatus ? '⟳' : '↻'}
        </button>
      </div>

      {/* ── Push / Pull ──────────────────────────────────────────────── */}
      <div className={styles.syncRow}>
        <button className={styles.syncBtn} onClick={() => pull()} disabled={pulling}>
          {pulling ? 'Pulling…' : '↓ Pull'}
        </button>
        <button className={styles.syncBtn} onClick={() => push()} disabled={pushing}>
          {pushing ? 'Pushing…' : '↑ Push'}
        </button>
      </div>

      {/* ── Commit box ───────────────────────────────────────────────── */}
      <div className={styles.commitBox}>
        <textarea
          className={styles.commitInput}
          placeholder="Commit message…"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          rows={2}
        />
        <button
          className={styles.commitBtn}
          disabled={!commitMessage.trim() || staged.length === 0 || committing}
          onClick={() => commit()}
          title={staged.length === 0 ? 'Stage changes first' : 'Commit staged changes'}
        >
          {committing ? 'Committing…' : `✓ Commit (${staged.length})`}
        </button>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {/* ── Changed files ────────────────────────────────────────────── */}
      <div className={styles.fileLists}>
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span>STAGED CHANGES ({staged.length})</span>
            {staged.length > 0 && (
              <button className={styles.sectionAction} onClick={() => unstageAll()}>
                Unstage all
              </button>
            )}
          </div>
          {staged.map(f => (
            <FileRow
              key={`staged:${f.path}`}
              path={f.path}
              status={f.status}
              staged
              selected={selectedFile === f.path && selectedStaged}
              onSelect={() => selectFile(f.path, true)}
              onToggleStage={() => unstage([f.path])}
            />
          ))}
          {staged.length === 0 && (
            <div className={styles.sectionEmpty}>Nothing staged.</div>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span>CHANGES ({unstaged.length})</span>
            {unstaged.length > 0 && (
              <button className={styles.sectionAction} onClick={() => stageAll()}>
                Stage all
              </button>
            )}
          </div>
          {unstaged.map(f => (
            <FileRow
              key={`unstaged:${f.path}`}
              path={f.path}
              status={f.status}
              staged={false}
              selected={selectedFile === f.path && !selectedStaged}
              onSelect={() => selectFile(f.path, false)}
              onToggleStage={() => stage([f.path])}
            />
          ))}
          {unstaged.length === 0 && (
            <div className={styles.sectionEmpty}>No changes.</div>
          )}
        </div>
      </div>

      {/* ── Inline diff viewer ───────────────────────────────────────── */}
      {selectedFile && (
        <div className={styles.diffPane}>
          <div className={styles.diffHeader}>
            <span className={styles.diffHeaderFile} title={selectedFile}>
              {selectedFile.split('/').pop()}
            </span>
            <span className={styles.diffHeaderTag}>
              {selectedStaged ? 'staged' : 'unstaged'}
            </span>
          </div>
          {loadingDiff ? (
            <div className={styles.diffEmpty}>Loading diff…</div>
          ) : (
            <DiffViewer text={diffText} />
          )}
        </div>
      )}

      <Toasts />
    </div>
  )
}
