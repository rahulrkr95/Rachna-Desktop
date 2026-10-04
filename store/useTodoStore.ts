// store/useTodoStore.ts
//
// Zustand store backing the agent's self-managed plan/task list
// (manage_todos tool). Lives in memory for the lifetime of the session —
// intentionally NOT persisted to localStorage so a new chat always starts
// with a clean slate. "Survives across agent turns in the same session"
// because the store is module-level and outlives individual React renders.

import { create } from 'zustand'
import type { TodoItem, TodoStatus } from '../services/agent/types'

interface TodoState {
  todos: TodoItem[]

  /** Replace the full list (manage_todos action: "write"). */
  setTodos: (todos: TodoItem[]) => void
  /** Patch a single item's status (manage_todos action: "update_status"). */
  updateStatus: (id: string, status: TodoStatus) => { ok: true } | { ok: false; error: string }
  /** Reorder by id list — used by drag-and-drop in TodoPanel. */
  reorder: (orderedIds: string[]) => void
  clear: () => void
}

export const useTodoStore = create<TodoState>((set, get) => ({
  todos: [],

  setTodos: (todos) => set({ todos }),

  updateStatus: (id, status) => {
    const { todos } = get()
    if (!todos.some(t => t.id === id)) {
      return {
        ok: false,
        error:
          `No todo with id "${id}" found. ` +
          'Call manage_todos(action: "read") to see current ids.',
      }
    }
    set({ todos: todos.map(t => (t.id === id ? { ...t, status } : t)) })
    return { ok: true }
  },

  reorder: (orderedIds) => {
    const { todos } = get()
    const byId = new Map(todos.map(t => [t.id, t]))
    const reordered = orderedIds
      .map(id => byId.get(id))
      .filter((t): t is TodoItem => Boolean(t))
    const missing = todos.filter(t => !orderedIds.includes(t.id))
    set({ todos: [...reordered, ...missing] })
  },

  clear: () => set({ todos: [] }),
}))

// ── Selectors ────────────────────────────────────────────────────────────────
export const selectTodoProgress = (state: TodoState): { done: number; total: number } => ({
  done: state.todos.filter(t => t.status === 'completed').length,
  total: state.todos.length,
})

/**
 * Renders the current todo list as a compact block for injection into the
 * system prompt so the model stays aware of its own plan across agent turns.
 * Returns '' when there are no todos.
 */
export function formatTodosForPrompt(todos: TodoItem[]): string {
  if (todos.length === 0) return ''

  const mark = (s: TodoStatus) =>
    s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]'

  const lines = todos.map(t => `${mark(t.status)} (${t.id}) ${t.content}`)
  return [
    '## Current Plan (manage_todos)',
    'This is your own in-progress task list from earlier in this session. ' +
      'Keep it up to date: exactly one item should be "in_progress" at a time, ' +
      'and items must be marked "completed" immediately after finishing — never batch.',
    ...lines,
  ].join('\n')
}

// Re-export type for consumers
export type { TodoItem, TodoStatus }
