// components/DiffTab/MonacoDiffTab.tsx
//
// Renders a single pending AI edit as a Monaco DiffEditor inside a tab.
// This replaces the old DiffPanel floating panel — the diff now lives
// natively inside the editor workspace, Cursor/Windsurf-style.
//
// Layout:
//   ┌─ Toolbar ──────────────────────────────────────────────────────────────┐
//   │ ⎇ filename.ts — AI Edit Proposal   [description]   [Reject] [Accept]  │
//   └────────────────────────────────────────────────────────────────────────┘
//   ┌─ Monaco DiffEditor ────────────────────────────────────────────────────┐
//   │  Original (left)  │  Proposed (right)                                 │
//   └────────────────────────────────────────────────────────────────────────┘

import React from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useEditStore } from '../../services/edits/EditStore'
import styles from './MonacoDiffTab.module.css'

// ── Monaco diff options ────────────────────────────────────────────────────
const DIFF_OPTIONS: editor.IDiffEditorConstructionOptions = {
  renderSideBySide:        true,
  enableSplitViewResizing: true,
  ignoreTrimWhitespace:    false,
  renderIndicators:        true,
  originalEditable:        false,
  readOnly:                false,
  fontFamily:              "'JetBrains Mono', 'Fira Code', monospace",
  fontSize:                13,
  lineHeight:              22,
  minimap:                 { enabled: false },
  scrollBeyondLastLine:    false,
  padding:                 { top: 12, bottom: 12 },
  overviewRulerBorder:     false,
  scrollbar: {
    vertical:   'auto',
    horizontal: 'auto',
  },
}

// ── Props ──────────────────────────────────────────────────────────────────
interface MonacoDiffTabProps {
  editId:   string
  theme:    'dark' | 'light'
  fontSize: number
}

// ── Component ──────────────────────────────────────────────────────────────
export default function MonacoDiffTab({ editId, theme, fontSize }: MonacoDiffTabProps) {
  const edit     = useEditStore(s => s.edits.find(e => e.id === editId))
  const snapshot = useEditStore(s => s.diagnosticSnapshots[editId])

  // Monaco theme to use
  const monacoTheme = theme === 'light' ? 'vs' : 'rachnaTheme'

  if (!edit) {
    return (
      <div className={styles.missing}>
        <span>Edit proposal not found.</span>
      </div>
    )
  }

  const isNewFile = edit.originalContent === ''

  return (
    <div className={styles.root}>
      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.diffIcon}>{isNewFile ? '✦' : '⎇'}</span>
          <span className={styles.fileLabel}>{edit.fileName}</span>
          {isNewFile && <span className={styles.newBadge}>NEW FILE</span>}
          <span className={styles.separator}>·</span>
          <span className={styles.description} title={edit.description}>
            {edit.description}
          </span>
        </div>

        <div className={styles.toolbarRight}>
          {/* Diagnostic summary (if available) */}
          {snapshot && (
            <span className={styles.diagSummary}>
              <span className={styles.diagBefore}>
                {snapshot.before.filter(d => d.severity === 'error').length}e before
              </span>
              <span className={styles.diagArrow}>→</span>
              <span className={styles.diagAfter}>
                {snapshot.after.filter(d => d.severity === 'error').length}e after
              </span>
            </span>
          )}

          {edit.status === 'accepted' && (
            <span className={styles.acceptedBadge}>✓ Accepted</span>
          )}

          {edit.status === 'pending' && (
            <span className={styles.pendingBadge}>Pending review in chat</span>
          )}
        </div>
      </div>

      {/* ── Original / Proposed labels ─────────────────────────────────── */}
      <div className={styles.diffLabels}>
        <div className={styles.labelOrig}>
          <span className={styles.labelDot} style={{ background: 'var(--red)' }} />
          Original
        </div>
        <div className={styles.labelProp}>
          <span className={styles.labelDot} style={{ background: 'var(--green)' }} />
          Proposed
        </div>
      </div>

      {/* ── Monaco DiffEditor ──────────────────────────────────────────── */}
      <div className={styles.editorWrap}>
        <DiffEditor
          height="100%"
          language={edit.language ?? 'plaintext'}
          original={edit.originalContent}
          modified={edit.proposedContent}
          theme={monacoTheme}
          options={{ ...DIFF_OPTIONS, fontSize }}
          loading={
            <div className={styles.loading}>Loading diff editor…</div>
          }
        />
      </div>
    </div>
  )
}
