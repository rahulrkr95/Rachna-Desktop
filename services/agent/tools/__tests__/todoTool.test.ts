// services/agent/tools/__tests__/todoTool.test.ts
//
// Unit tests for the manage_todos agent tool.
// These test the tool's execute() function directly (no Tauri, no React).
// The useTodoStore is imported as a real Zustand store — Zustand works fine in
// plain Node/vitest without a DOM because stores are just closures.

import { describe, it, expect, beforeEach } from 'vitest'
import { manageTodosTool } from '../todoTool'
import { useTodoStore } from '../../../../store/useTodoStore'
import type { ToolContext } from '../../types'

// Minimal ToolContext — todoTool doesn't use projectRoot or systemInfo
const ctx: ToolContext = { projectRoot: '/fake/root' }

// Reset store state before each test so tests are isolated
beforeEach(() => {
  useTodoStore.getState().clear()
})

// ── Helper ────────────────────────────────────────────────────────────────────

function makeTodo(id: string, status: 'pending' | 'in_progress' | 'completed' = 'pending') {
  return { id, content: `Task ${id}`, status, activeForm: `Doing task ${id}` }
}

// ── write ─────────────────────────────────────────────────────────────────────

describe('manage_todos — write', () => {
  it('saves a valid plan to the store', async () => {
    const todos = [makeTodo('1'), makeTodo('2'), makeTodo('3')]
    const result = await manageTodosTool.execute({ action: 'write', todos }, ctx)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.todos).toHaveLength(3)
    expect(useTodoStore.getState().todos).toHaveLength(3)
  })

  it('allows exactly one in_progress item', async () => {
    const todos = [makeTodo('1', 'in_progress'), makeTodo('2'), makeTodo('3')]
    const result = await manageTodosTool.execute({ action: 'write', todos }, ctx)
    expect(result.ok).toBe(true)
  })

  it('rejects plan with two in_progress items', async () => {
    const todos = [makeTodo('1', 'in_progress'), makeTodo('2', 'in_progress')]
    const result = await manageTodosTool.execute({ action: 'write', todos }, ctx)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/in_progress/i)
    // Store must remain empty — no partial writes
    expect(useTodoStore.getState().todos).toHaveLength(0)
  })

  it('rejects plan with duplicate ids', async () => {
    const todos = [makeTodo('1'), makeTodo('1')]
    const result = await manageTodosTool.execute({ action: 'write', todos }, ctx)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/duplicate/i)
  })

  it('rejects unknown action schema', async () => {
    const result = await manageTodosTool.execute({ action: 'write' /* missing todos */ }, ctx)
    // Zod will reject: todos is required for write
    // Actually discriminated union will allow missing optional field — but our schema doesn't require todos as zod field
    // The action is 'write' with no todos array — Zod should catch missing required array
    // Our ManageTodosArgsSchema has todos as z.array() on TodoWriteArgsSchema which makes it required
    expect(result.ok).toBe(false)
  })
})

// ── update_status ─────────────────────────────────────────────────────────────

describe('manage_todos — update_status', () => {
  beforeEach(async () => {
    await manageTodosTool.execute(
      { action: 'write', todos: [makeTodo('1'), makeTodo('2'), makeTodo('3')] },
      ctx
    )
  })

  it('marks a pending item as in_progress', async () => {
    const result = await manageTodosTool.execute(
      { action: 'update_status', id: '1', status: 'in_progress' },
      ctx
    )
    expect(result.ok).toBe(true)
    const store = useTodoStore.getState()
    expect(store.todos.find(t => t.id === '1')?.status).toBe('in_progress')
  })

  it('marks an in_progress item as completed', async () => {
    await manageTodosTool.execute({ action: 'update_status', id: '1', status: 'in_progress' }, ctx)
    const result = await manageTodosTool.execute(
      { action: 'update_status', id: '1', status: 'completed' },
      ctx
    )
    expect(result.ok).toBe(true)
    const store = useTodoStore.getState()
    expect(store.todos.find(t => t.id === '1')?.status).toBe('completed')
  })

  it('refuses to mark a second item in_progress while one is already active', async () => {
    await manageTodosTool.execute({ action: 'update_status', id: '1', status: 'in_progress' }, ctx)
    const result = await manageTodosTool.execute(
      { action: 'update_status', id: '2', status: 'in_progress' },
      ctx
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/in_progress/i)
    // Item 2 must still be pending
    expect(useTodoStore.getState().todos.find(t => t.id === '2')?.status).toBe('pending')
  })

  it('returns an error for a non-existent id', async () => {
    const result = await manageTodosTool.execute(
      { action: 'update_status', id: 'no-such-id', status: 'completed' },
      ctx
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/no-such-id/)
  })
})

// ── read ──────────────────────────────────────────────────────────────────────

describe('manage_todos — read', () => {
  it('returns empty list when nothing written yet', async () => {
    const result = await manageTodosTool.execute({ action: 'read' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.todos).toHaveLength(0)
  })

  it('returns the current plan after write', async () => {
    const todos = [makeTodo('a'), makeTodo('b')]
    await manageTodosTool.execute({ action: 'write', todos }, ctx)

    const result = await manageTodosTool.execute({ action: 'read' }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.todos).toHaveLength(2)
    expect(result.data.todos[0].id).toBe('a')
  })
})
