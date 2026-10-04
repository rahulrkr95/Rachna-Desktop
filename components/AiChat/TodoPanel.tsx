// components/AiChat/TodoPanel.tsx
//
// Collapsible checklist panel that renders the agent's self-managed plan list
// from useTodoStore in real time. Shown while the agent is working (or after)
// so the user can track multi-step progress at a glance.
//
// Style follows AgentActivityPanel conventions — same CSS variable palette,
// same collapsed/expanded pattern, no new design tokens introduced.

import React, { useState } from 'react'
import { useTodoStore, selectTodoProgress } from '../../store/useTodoStore'
import type { TodoItem, TodoStatus } from '../../services/agent/types'
import styles from '../AiChat.module.css'

function statusIcon(status: TodoStatus): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◎'
  return '○'
}

function statusClass(status: TodoStatus): string {
  if (status === 'completed') return styles.todoItemDone
  if (status === 'in_progress') return styles.todoItemActive
  return styles.todoItemPending
}

interface TodoItemRowProps {
  item: TodoItem
  index: number
}

function TodoItemRow({ item, index }: TodoItemRowProps) {
  return (
    <div className={`${styles.todoItem} ${statusClass(item.status)}`}>
      <span className={styles.todoItemIndex}>{index + 1}</span>
      <span className={styles.todoItemIcon}>{statusIcon(item.status)}</span>
      <span className={styles.todoItemContent}>
        {item.status === 'in_progress' ? item.activeForm : item.content}
      </span>
      {item.status === 'in_progress' && (
        <span className={styles.todoItemSpinner}>⟳</span>
      )}
    </div>
  )
}

export function TodoPanel() {
  const [expanded, setExpanded] = useState(true)
  const todos    = useTodoStore(s => s.todos)
  const progress = useTodoStore(selectTodoProgress)

  if (todos.length === 0) return null

  const inProgress = todos.find(t => t.status === 'in_progress')
  const allDone    = progress.done === progress.total && progress.total > 0

  return (
    <div className={styles.todoPanel}>
      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <button
        className={styles.todoPanelBar}
        onClick={() => setExpanded(v => !v)}
        title={expanded ? 'Collapse plan' : 'Expand plan'}
      >
        <span className={styles.todoPanelChevron}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.todoPanelIcon}>📋</span>
        <span className={styles.todoPanelLabel}>
          {inProgress
            ? inProgress.activeForm
            : allDone
            ? `Plan complete — ${progress.total} step${progress.total !== 1 ? 's' : ''}`
            : `Plan — ${progress.total} step${progress.total !== 1 ? 's' : ''}`}
        </span>
        <span className={`${styles.todoPanelChip} ${allDone ? styles.todoPanelChipDone : ''}`}>
          {progress.done}/{progress.total}
        </span>
      </button>

      {/* ── Expanded list ───────────────────────────────────────────────── */}
      {expanded && (
        <div className={styles.todoPanelList}>
          {todos.map((item, i) => (
            <TodoItemRow key={item.id} item={item} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}
